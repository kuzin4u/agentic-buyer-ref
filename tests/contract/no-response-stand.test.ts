// Повтор тем же Idempotency-Key при NO_RESPONSE на стенде Платформы v0.19.0 (Р48 п. 4в): первый POST /pao/v1/mandates
// стенд исполнил, ответ до агента не дошёл (транспорт теста обрывает его после обработки) → повтор тем же ключом с
// новой подписью → тот же мандат, второго действия нет. Срок хранения ключа у агента равен стенду (Р48 п. 4б).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStand, type Stand } from "agentic-ps-platform/stand";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentCore, type AgentCore } from "../../src/agent/compose.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { generateKey } from "../../src/agent/signer/index.js";
import { parseParams } from "../../src/shared/config.js";
import { INTENT } from "../support/consents.js";
import { AGENT } from "../support/pao-stand.js";

/** Стенд в процессе теста под параллельной нагрузкой прогона бывает медленнее 5 с по умолчанию (нюанс К2.3). */
const STAND_TIMEOUT_MS = 20_000;
const MANDATES = "POST /pao/v1/mandates";

let stand: Stand | undefined;
const cores: AgentCore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) c.close();
  await stand?.close();
  stand = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

/** Стенд и ядро; lose — сколько первых ответов на маршрут стенд исполнит, а транспорт потеряет. Сборка — в файле, как
 *  в events-core и c0-platform: подмена транспорта нужна только здесь. */
async function setup() {
  const s = createStand();
  stand = s;
  const keysDir = tmp("nr-keys-");
  const { descriptor } = generateKey(keysDir);
  const decision = await s.admit(
    { agent_code: AGENT, class: "BUYER", model: "buyer-agent-ref", runtime: "node-20", alg: "ed25519", public_key: descriptor.public_key },
    "buyref-operator",
  );
  if (!decision.admitted) throw new Error("стенд не допустил агента");
  const baseUrl = await s.listen();
  /** ответы стенда на маршрут: статус, Idempotency-Key, x-nonce, id мандата; потерян ли ответ для агента */
  const served: { route: string; status: number; key: string | null; nonce: string | null; body: unknown; lost: boolean }[] = [];
  const lose = new Map<string, number>();
  const fetchImpl: typeof fetch = async (url, init) => {
    const route = `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`;
    const res = await fetch(url, init);
    const headers = new Headers(init?.headers);
    const body: unknown = route === MANDATES ? await res.clone().json() : undefined;
    const left = lose.get(route) ?? 0;
    served.push({
      route,
      status: res.status,
      key: headers.get("idempotency-key"),
      nonce: headers.get("x-nonce"),
      body,
      lost: left > 0,
    });
    if (left > 0) {
      lose.set(route, left - 1);
      throw new TypeError("fetch failed"); // стенд исполнил, ответ потерян
    }
    return res;
  };
  const journal = new MemoryJournal();
  const core = createAgentCore({ keysDir, stateDir: join(tmp("nr-state-"), "state"), journal, pao: { baseUrl, agentCode: AGENT, sleep: async () => {}, fetch: fetchImpl } });
  cores.push(core);
  return { s, core, journal, served, lose };
}

describe("NO_RESPONSE на стенде v0.19.0: повтор тем же ключом (Р48 п. 4)", { timeout: STAND_TIMEOUT_MS }, () => {
  it("POST /pao/v1/mandates исполнен, ответ потерян → повтор тем же ключом → тот же мандат, второго нет", async () => {
    const { core, journal, served, lose } = await setup();
    await core.start();
    const before = served.length;
    lose.set(MANDATES, 1);

    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem-lost-1" });

    // полный журнал обращений после старта: ровно два POST, других обращений нет (ревью reviewer К2 № 5)
    const after = served.slice(before);
    expect(after.map(({ route, status, key, lost }) => ({ route, status, key, lost }))).toEqual([
      { route: MANDATES, status: 201, key: "idem-lost-1", lost: true },
      { route: MANDATES, status: 201, key: "idem-lost-1", lost: false },
    ]);
    const [first, second] = after;
    // второго действия нет: повтор отдал сохранённый ответ целиком — тот же мандат с тем же временем создания и статусом
    // на момент первого ответа (ПАО §1: в течение 24 ч — сохранённый ответ); id один и при повторном исполнении
    // (вычисляется из кода агента и ключа), поэтому сравниваются тела (ревью reviewer К2 № 4)
    expect(second!.body).toEqual(first!.body);
    expect((first!.body as { id: string }).id).toBe(m.id);
    // повтор — новой подписью (Р21)
    expect(second!.nonce).not.toBe(first!.nonce);
    expect(journal.entries.filter((e) => e.kind === "pao.call" && e.method === MANDATES).map((e) => [e.attempt, e.result, e.reason])).toEqual([
      [1, "unknown", "NO_RESPONSE"],
      [2, "ok", undefined],
    ]);
  });

  it("срок хранения ключа идемпотентности у агента равен стенду; бюджет повторов в него укладывается (Р48 п. 4б)", async () => {
    const { s } = await setup();
    const agent = JSON.parse(readFileSync("config/params.stand.json", "utf8")) as Record<string, unknown>;
    expect(agent.idempotency_ttl_sec).toBe(s.params.idempotency_ttl_sec);
    // то же правило, что при загрузке (config.ts), со сроком стенда: попытки, тайм-ауты и потолок Retry-After (ревью К2 № 10)
    expect(() => parseParams({ ...agent, idempotency_ttl_sec: s.params.idempotency_ttl_sec })).not.toThrow();
  });

  it("предел задержки события итога операции у агента равен стенду (Р49 п. 1; #57 п. 4)", async () => {
    const { s } = await setup();
    const agent = JSON.parse(readFileSync("config/params.stand.json", "utf8")) as Record<string, unknown>;
    expect(agent.operation_outcome_max_delay_sec).toBe(s.params.operation_outcome_max_delay_sec);
  });
});
