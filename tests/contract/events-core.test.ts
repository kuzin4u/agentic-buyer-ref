// Ядро агента и события на стенде v0.5.0 (Р34 п. 2, 4, 8, 10): подписка при старте, push эмулятору получателя стенда →
// его тело и x-event-id — в acceptPush ядра → чтение ленты; курсор в каталоге состояния переживает перезапуск.
// Push на стенде получает эмулятор stand.agentReceiver, а не агент (РП40 п. 8) — тело передаётся вручную.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStand, type Stand } from "agentic-ps-platform/stand";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentCore, type AgentCore } from "../../src/agent/compose.js";
import { CURSOR_FILE } from "../../src/agent/events/index.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { generateKey } from "../../src/agent/signer/index.js";
import { INTENT } from "../support/consents.js";
import { AGENT } from "../support/pao-stand.js";


/** Стенд в процессе теста под параллельной нагрузкой прогона бывает медленнее 5 с по умолчанию (нюанс К2.3). */
const STAND_TIMEOUT_MS = 20_000;
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

async function setup() {
  const s = createStand();
  stand = s;
  const keysDir = tmp("ev-keys-");
  const stateDir = join(tmp("ev-state-"), "state");
  const { descriptor } = generateKey(keysDir);
  const decision = s.admit(
    { agent_code: AGENT, class: "BUYER", model: "buyer-agent-ref", runtime: "node-20", alg: "ed25519", public_key: descriptor.public_key },
    "buyref-operator",
  );
  if (!decision.admitted) throw new Error("стенд не допустил агента");
  const baseUrl = await s.listen();
  const host = s.params.event_subscription_allow_hosts[0];
  /** журнал обращений агента: метод и путь без query, статус, Idempotency-Key; тела не сохраняются (инвариант 1) */
  const calls: { route: string; status: number; key: string | null }[] = [];
  /** подмена ответа Платформы на маршрут (метод и путь) — для отказов, которых стенд сам не даёт */
  const replace = new Map<string, () => Response>();
  const fetchLog: typeof fetch = async (url, init) => {
    const route0 = `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`;
    const fake = replace.get(route0);
    const res = fake ? fake() : await fetch(url, init);
    const u = new URL(String(url));
    calls.push({ route: `${init?.method ?? "GET"} ${u.pathname}`, status: res.status, key: new Headers(init?.headers).get("idempotency-key") });
    return res;
  };
  const core = (pushUrl?: string) => {
    const journal = new MemoryJournal();
    const c = createAgentCore({ keysDir, stateDir, journal, ...(pushUrl && { pushUrl }), pao: { baseUrl, agentCode: AGENT, sleep: async () => {}, fetch: fetchLog } });
    cores.push(c);
    return { c, journal };
  };
  return { s, core, stateDir, calls, replace, host, pushUrl: `https://${host}/pao/events` };
}

describe("ядро и события на стенде v0.5.0 (Р34)", { timeout: STAND_TIMEOUT_MS }, () => {
  it("подписка при старте, push → лента, курсор в каталоге состояния; перезапуск — без повторной обработки", async () => {
    const { s, core, stateDir, pushUrl, calls } = await setup();
    const a = core(pushUrl);
    await a.c.start();
    expect(s.registry.subscription(AGENT)).toMatchObject({ url: pushUrl });

    const m = await a.c.platform.requestMandate(INTENT, { idempotencyKey: "idem-m1" });
    await s.issuer.sign(m.id);
    expect(await s.deliverEvents()).toBe(1);
    const [got] = s.agentReceiver.received;
    if (!got) throw new Error("push не доставлен");
    expect(a.c.acceptPush(JSON.stringify(got.event), { "x-event-id": got.header_event_id })).toEqual({ status: 200 });
    await a.c.events.signal();

    expect(a.journal.entries.filter((e) => e.kind.startsWith("event"))).toEqual([
      expect.objectContaining({ kind: "events.cursor_initial" }),
      expect.objectContaining({ kind: "event.handled", ref: got.event_id, detail: "mandate.signed" }),
    ]);
    expect(existsSync(join(stateDir, CURSOR_FILE))).toBe(true);
    expect(a.c.events.cursor()).toBe(got.event_id);

    // перезапуск: тот же каталог состояния — лента с курсора, событие повторно не обрабатывается
    a.c.close();
    const b = core(pushUrl);
    await b.c.start();
    await b.c.events.signal();
    expect(b.c.events.cursor()).toBe(got.event_id);
    expect(b.journal.entries.filter((e) => e.kind.startsWith("event"))).toEqual([]);

    // полный журнал обращений: лишнего PUT или чтения ленты нет; ключ подписки у каждого запуска свой (дополнение Р34 п. 2)
    const CONF = { route: "GET /.well-known/pao-configuration", status: 404, key: null };
    const SELF = { route: "GET /pao/v1/agent", status: 200, key: null };
    const [k1, k2] = calls.filter((c) => c.route === "PUT /pao/v1/subscription").map((c) => c.key);
    expect(k1).toMatch(/^sub-[0-9a-f]{32}$/);
    expect(k2).toMatch(/^sub-[0-9a-f]{32}$/);
    expect(k2).not.toBe(k1);
    expect(calls).toEqual([
      CONF,
      SELF,
      { route: "PUT /pao/v1/subscription", status: 200, key: k1 },
      { route: "POST /pao/v1/mandates", status: 201, key: "idem-m1" },
      // чтение по push: страница с событием и пустая; сигнал во время чтения — ровно одно следующее (уточнение 1)
      { route: "GET /pao/v1/events", status: 200, key: null },
      { route: "GET /pao/v1/events", status: 200, key: null },
      { route: "GET /pao/v1/events", status: 200, key: null },
      CONF,
      SELF,
      { route: "PUT /pao/v1/subscription", status: 200, key: k2 },
      { route: "GET /pao/v1/events", status: 200, key: null },
    ]);
  });

  it("адрес подписки отвергнут (400) — запись в журнал, старт состоялся, лента работает (Р34 п. 8)", async () => {
    const { s, core } = await setup();
    expect(s.params.event_subscription_allow_hosts).not.toContain("agent.example.invalid");
    const a = core("https://agent.example.invalid/pao/events");
    await expect(a.c.start()).resolves.toMatchObject({ status: "ACTIVE" });
    expect(a.journal.entries).toContainEqual(expect.objectContaining({ kind: "events.subscription_rejected", reason: "REQUEST_INVALID" }));
    await a.c.events.signal();
    expect(a.c.events.cursor()).toBeNull();
  });

  it("A → B → A тремя запусками: действует последний адрес, ключи разные (дополнение Р34 п. 2)", async () => {
    const { s, core, host, calls } = await setup();
    const urls = [`https://${host}/a`, `https://${host}/b`, `https://${host}/a`];
    for (const url of urls) {
      const r = core(url);
      await r.c.start();
      expect(s.registry.subscription(AGENT)?.url).toBe(url);
      r.c.close();
    }
    const keys = calls.filter((c) => c.route === "PUT /pao/v1/subscription").map((c) => c.key);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
  });

  it.each([
    ["503 STATE_UNAVAILABLE без Retry-After", () => Response.json({ code: "STATE_UNAVAILABLE", message: "x", norm: "x", retry: "same_key" }, { status: 503 }), "STATE_UNAVAILABLE"],
    ["ответ — не та подписка (UNKNOWN)", () => Response.json({ url: "https://evil.example/x", events: [] }, { status: 200 }), "UNKNOWN"],
  ] as const)("подписка: %s — старт успешен, events.subscription_failed без адреса, лента работает (дополнение Р34 п. 1)", async (_, reply, code) => {
    const { core, replace, pushUrl } = await setup();
    replace.set("PUT /pao/v1/subscription", reply);
    const a = core(pushUrl);
    await expect(a.c.start()).resolves.toMatchObject({ status: "ACTIVE" });
    const failed = a.journal.entries.filter((e) => e.kind === "events.subscription_failed");
    expect(failed).toEqual([{ at: expect.any(String), kind: "events.subscription_failed", reason: code }]);
    expect(JSON.stringify(a.journal.entries)).not.toContain(pushUrl);
    await a.c.events.signal();
    expect(a.c.events.cursor()).toBeNull();
  });

  it("каталог состояния совпадает с каталогом ключей или вложен (в обе стороны) — отказ сборки", async () => {
    const d = tmp("ev-same-");
    const pao = { baseUrl: "http://127.0.0.1:1", agentCode: AGENT };
    for (const [keysDir, stateDir] of [[d, d], [d, join(d, "state")], [join(d, "keys"), d], [d, `${d}/./`]]) {
      expect(() => createAgentCore({ keysDir: keysDir!, stateDir: stateDir!, pao }), `${keysDir} / ${stateDir}`).toThrow(/каталог состояния/);
    }
    // соседние каталоги с общим началом имени — не вложенность
    const c = createAgentCore({ keysDir: `${d}/keys`, stateDir: `${d}/keys-state`, pao });
    c.close();
  });
});
