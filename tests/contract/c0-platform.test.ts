// Точка сверки С0 (Р24, вариант А): подпись агента принимается настоящей Платформой — стенд agentic-ps-platform
// v0.5.0 (РП25: среда dev в процессе теста, контур ключей sandbox; не песочница, без mTLS — РП27, PS-05).
// Только допуск (GET /pao/v1/agent): регистрацию ключа (POST /pao/v1/agent/keys) стенд v0.5.0 обслуживает, но С0 её не
// проверяет — ротация на PaoStub (tests/unit/signer-*.ts); перевод тестов на стенд — STATUS «Открыто».
// П01 в профиле contour (Р23) против кода Платформы; Т1, A2 п. 3–5, SPEC §7а.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStand, type Stand } from "agentic-ps-platform/stand";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentCore } from "../../src/agent/compose.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { SignerStopped, generateKey, kidOf, listKeys } from "../../src/agent/signer/index.js";
import { readMeta } from "../../src/agent/signer/keystore.js";
import { PlatformFailure } from "../../src/shared/domain.js";
import { AGENT } from "../support/pao-stand.js";

const OPERATOR = "buyref-operator";

/** Заявление оператора о допуске (РП21 п. 2): только открытый ключ, закрытый остаётся в хранилище агента (инвариант 2). */
const application = (public_key: string, cls = "BUYER") => ({
  agent_code: AGENT,
  class: cls,
  model: "buyer-agent-ref",
  runtime: "node-20",
  alg: "ed25519",
  public_key,
});

let stand: Stand | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await stand?.close();
  stand = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function keysDir(): string {
  const d = mkdtempSync(join(tmpdir(), "c0-keys-"));
  dirs.push(d);
  return d;
}

interface Call {
  route: string;
  status: number;
  nonce: string | undefined;
}

/** Стенд с журналом всех обращений (хук Fastify до listen): маршрут, статус, x-nonce; тела не сохраняются.
 *  Полный список — чтобы видеть и обход: обращение агента к любому другому методу (ревью 3d № 1). */
async function platform() {
  const s = createStand();
  const log: Call[] = [];
  s.app.addHook("onResponse", async (req, reply) => {
    const nonce = req.headers["x-nonce"];
    log.push({ route: `${req.method} ${req.url.split("?")[0]}`, status: reply.statusCode, nonce: typeof nonce === "string" ? nonce : undefined });
  });
  stand = s;
  const calls = () => log.map(({ route, status }) => ({ route, status }));
  return { s, calls, log };
}

const SELF = "GET /pao/v1/agent";
/** Р33 п. 10: конфигурация читается на стадии 0; стенд её не отдаёт до PS-05 — 404, версия не определена. */
const CONF = { route: "GET /.well-known/pao-configuration", status: 404 };

/** Отказ подписи на допуске (SPEC §7а): один повтор с новой подписью (новый x-nonce, Р21), затем остановка. */
async function expectSignatureStop(core: Awaited<ReturnType<typeof coreAt>>["core"], journal: MemoryJournal, log: Call[]) {
  const err = (await core.start().catch((e: unknown) => e)) as SignerStopped;
  expect(err).toBeInstanceOf(SignerStopped);
  expect(err.reason).toBe("SIGNATURE_INVALID");
  expect(err.cause).toMatchObject({ code: "SIGNATURE_INVALID", httpStatus: 401 });
  expect(log.map(({ route, status }) => ({ route, status }))).toEqual([CONF, { route: SELF, status: 401 }, { route: SELF, status: 401 }]);
  expect(log[1]!.nonce).toBeTruthy();
  expect(log[2]!.nonce).not.toBe(log[1]!.nonce);
  expect(journal.entries.at(-1)).toMatchObject({ kind: "agent.stopped", reason: "SIGNATURE_INVALID" });
  // остановка, а не «ещё не допущен»: повторный допуск — та же причина и ни одного обращения
  await expect(core.start()).rejects.toMatchObject({ reason: "SIGNATURE_INVALID" });
  await expect(core.platform.agentSelf()).rejects.toThrow(SignerStopped);
  expect(log).toHaveLength(3);
}

async function coreAt(s: Stand, dir: string) {
  const baseUrl = await s.listen();
  const journal = new MemoryJournal();
  const core = createAgentCore({ keysDir: dir, journal, now: () => new Date(), pao: { baseUrl, agentCode: AGENT, sleep: async () => {} } });
  return { core, journal };
}

describe("С0 — подпись агента принимается Платформой (agentic-ps-platform v0.5.0)", () => {
  it("П01: допуск своим public_key; подписанный GET /pao/v1/agent — 200, ACTIVE, kid совпадает с вычисленным агентом", async () => {
    const { s, calls } = await platform();
    const dir = keysDir();
    const { descriptor } = generateKey(dir);
    const decision = s.admit(application(descriptor.public_key), OPERATOR);
    expect(decision).toMatchObject({ admitted: true });
    const { core, journal } = await coreAt(s, dir);

    const self = await core.start();

    expect(self).toMatchObject({ agentCode: AGENT, status: "ACTIVE", agentClass: "BUYER" });
    expect(self.keys.map((k) => k.kid)).toEqual([kidOf(descriptor.public_key)]);
    expect(descriptor.kid).toBe(kidOf(descriptor.public_key));
    if (!decision.admitted) throw new Error("недостижимо");
    expect(decision.key.kid).toBe(descriptor.kid); // kid присвоен Платформой независимо от агента (RFC 7638)
    expect(calls()).toEqual([CONF, { route: SELF, status: 200 }]);
    expect(journal.entries).toContainEqual(expect.objectContaining({ kind: "request.signed", kid: descriptor.kid }));
    expect(JSON.stringify(journal.entries)).not.toContain(descriptor.public_key);
  });

  it("расхождение № 10: у ACTIVE-ключа Платформа отдаёт valid_to; сроки — в метаданных хранилища (Р25 п. 3)", async () => {
    const { s, calls } = await platform();
    const dir = keysDir();
    const { descriptor } = generateKey(dir);
    s.admit(application(descriptor.public_key), OPERATOR);
    const { core } = await coreAt(s, dir);

    const [key] = (await core.start()).keys;
    expect(key).toMatchObject({ kid: descriptor.kid, status: "ACTIVE" });
    expect(typeof key!.validFrom).toBe("string");
    expect(typeof key!.validTo).toBe("string");
    expect(Date.parse(key!.validTo!)).toBeGreaterThan(Date.parse(key!.validFrom!));
    expect(readMeta(dir)[descriptor.kid]).toEqual({ valid_from: key!.validFrom, valid_to: key!.validTo });
    expect(calls()).toEqual([CONF, { route: SELF, status: 200 }]);
  });

  it("чужой ключ: в реестре ключ B, у агента ключ A — SIGNATURE_INVALID, один повтор, остановка; ключ A не отозван", async () => {
    const { s, log } = await platform();
    const dir = keysDir();
    const own = generateKey(dir).descriptor;
    const foreign = generateKey(keysDir()).descriptor;
    expect(s.admit(application(foreign.public_key), OPERATOR)).toMatchObject({ admitted: true });
    const { core, journal } = await coreAt(s, dir);

    await expectSignatureStop(core, journal, log);
    expect(journal.entries.filter((e) => e.kind === "request.signed").map((e) => e.kid)).toEqual([own.kid, own.kid]);
    expect(listKeys(dir)).toEqual([{ kid: own.kid, state: "active" }]); // отзыв — только по AGENT_KEY_REVOKED
  });

  it("свой ключ, часы Платформы вне окна signature_skew_sec — SIGNATURE_INVALID, один повтор, остановка (ревью 3d № 2)", async () => {
    const { s, log } = await platform();
    const dir = keysDir();
    const { descriptor } = generateKey(dir);
    expect(s.admit(application(descriptor.public_key), OPERATOR)).toMatchObject({ admitted: true });
    s.setClock(new Date(Date.now() + (s.params.signature_skew_sec + 60) * 1000));
    const { core, journal } = await coreAt(s, dir);

    await expectSignatureStop(core, journal, log);
    expect(listKeys(dir)).toEqual([{ kid: descriptor.kid, state: "active" }]);
  });

  // Р27: стенд допускает заявление любого класса из перечня — агент, допущенный как SELLER, останавливается сам.
  it("Р27: агент допущен как SELLER — 200 от Платформы, остановка AGENT_CLASS_MISMATCH, без повтора", async () => {
    const { s, calls } = await platform();
    const dir = keysDir();
    const { descriptor } = generateKey(dir);
    expect(s.admit(application(descriptor.public_key, "SELLER"), OPERATOR)).toMatchObject({ admitted: true });
    const { core, journal } = await coreAt(s, dir);

    await expect(core.start()).rejects.toMatchObject({ reason: "AGENT_CLASS_MISMATCH" });
    expect(calls()).toEqual([CONF, { route: SELF, status: 200 }]);
    expect(journal.entries.filter((e) => e.kind === "agent.stopped")).toEqual([
      expect.objectContaining({ reason: "AGENT_CLASS_MISMATCH", detail: "SELLER" }),
    ]);
  });

  it("агента нет в реестре: 401 AGENT_UNKNOWN; без повтора, остановка (П03 по Р23)", async () => {
    const { s, calls } = await platform();
    const dir = keysDir();
    generateKey(dir);
    const { core, journal } = await coreAt(s, dir);

    const err = await core.start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformFailure);
    expect(err).toMatchObject({ code: "AGENT_UNKNOWN", retry: "never", httpStatus: 401 });
    expect(calls()).toEqual([CONF, { route: SELF, status: 401 }]);
    expect(journal.entries.at(-1)).toMatchObject({ kind: "agent.stopped", reason: "AGENT_UNKNOWN" });
  });
});
