// Р33 п. 10 (К2.3): версия ПАО Платформы — при подключении (конфигурация) и, пока не определена, по первому ответу с
// мандатом. Ниже 1.4.0 — PLATFORM_PROTOCOL_UNSUPPORTED и остановка агента целиком; не определена — предупреждение
// PLATFORM_VERSION_UNKNOWN в журнал и работа дальше; после подтверждения ответ без порядка отзыва —
// MANDATE_REVOCATION_ORDER_MISSING на этом мандате.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PAO_MIN_PLATFORM_VERSION, highestPaoVersion, protocolUnsupportedText } from "../../src/agent/adapters/pao/adapter.js";
import { mandateDraftToPao } from "../../src/agent/adapters/pao/map.js";
import { MandateRefused } from "../../src/agent/mandates/index.js";
import { SignerStopped } from "../../src/agent/signer/index.js";
import { loadParams } from "../../src/shared/config.js";
import { PlatformFailure } from "../../src/shared/domain.js";
import { Consents, INTENT } from "../support/consents.js";
import { coreOn } from "../support/core.js";
import { AGENT, PaoStand, type StandOptions } from "../support/pao-stand.js";

const CONFIG = "GET /.well-known/pao-configuration";
const EVIDENCE = "GET /pao/v1/mandates/{id}/evidence";
/** Тайм-аут обращения в тесте тайм-аута конфигурации: действует на весь прогон, в т. ч. на допуск к заглушке — с запасом
 *  для загруженного CI (ревью К2.3а № 4); не стендовое значение. */
const SHORT_TIMEOUT_MS = 300;

/** Нарушения схемы у заглушки — только в испорченном тестом ответе конфигурации (по записи на ошибку); запросы агента —
 *  без нарушений. */
function expectOnlyConfigViolation(s: PaoStand) {
  expect(s.stub.violations.length).toBeGreaterThan(0);
  for (const v of s.stub.violations) expect(v).toContain(CONFIG);
}

let stand: PaoStand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

async function setup(o: Pick<StandOptions, "configuration" | "handlers"> = {}) {
  const consents: Consents = new Consents(() => s.clock);
  const s = new PaoStand({ ...o, handlers: { ...consents.handlers(), ...o.handlers } });
  stand = s;
  const { core, journal } = await coreOn(s);
  const ops = () => s.stub.calls.map((c) => c.op);
  const kinds = (kind: string) => journal.entries.filter((e) => e.kind === kind);
  return { core, journal, consents, stand: s, ops, kinds };
}

/** Ответ без порядка отзыва — Платформа старше ПАО 1.4.0 (поле в схеме необязательно). */
function withoutOrder(consents: Consents) {
  consents.tamper = (m) => {
    const r = { ...m };
    delete r.revocation_order;
    return r;
  };
}

describe("версия ПАО в конфигурации — наибольшее 1.x.y", () => {
  it.each([
    [["1.4.0"], "1.4.0"],
    [["1.3.0", "1.4.0"], "1.4.0"],
    [["1.10.0", "1.9.9"], "1.10.0"],
    [["v1", "1.3.2"], "1.3.2"],
    [["v1"], null],
    [["1.4", "1.4.0-rc1", " 1.4.0", "01.4.0x"], null],
    [[], null],
  ])("%j → %s", (versions, want) => {
    expect(highestPaoVersion(versions)).toBe(want);
  });

  it("описание для оператора — версия или «версия не определена», граница 1.4.0", () => {
    expect(PAO_MIN_PLATFORM_VERSION).toBe("1.4.0");
    expect(protocolUnsupportedText("1.3.0")).toBe(
      "Платформа работает по ПАО 1.3.0, агенту нужна не ниже 1.4.0: в мандатах нет порядка отзыва (A7 п. 2.2). Обновите Платформу или подключите совместимую",
    );
    expect(protocolUnsupportedText(null)).toContain("версия не определена; ответ мандата без порядка отзыва");
  });
});

describe("шаг 1 — при подключении (стадия 0, до GET /pao/v1/agent)", () => {
  it("versions 1.3.0 — PLATFORM_PROTOCOL_UNSUPPORTED, агент остановлен, допуска и мандатов нет", async () => {
    const { core, ops, kinds, stand: s } = await setup({ configuration: { versions: ["1.3.0"] } });
    const err = (await core.start().catch((e: unknown) => e)) as PlatformFailure;
    expect(err).toBeInstanceOf(PlatformFailure);
    expect(err.code).toBe("PLATFORM_PROTOCOL_UNSUPPORTED");
    expect(err.message).toContain(protocolUnsupportedText("1.3.0"));
    expect(kinds("agent.stopped")).toEqual([expect.objectContaining({ reason: "PLATFORM_PROTOCOL_UNSUPPORTED", detail: "1.3.0" })]);
    expect(kinds("platform.protocol_unsupported")).toEqual([
      expect.objectContaining({ reason: "PLATFORM_PROTOCOL_UNSUPPORTED", detail: "CONFIGURATION" }),
    ]);
    // остановка, а не «не допущен»: ни повторный допуск, ни мандат не обращаются к Платформе
    await expect(core.start()).rejects.toThrow(SignerStopped);
    await expect(core.mandates.request(INTENT, { idempotencyKey: "idem_v1" })).rejects.toThrow(SignerStopped);
    expect(ops()).toEqual([CONFIG]);
    expect(s.stub.violations).toEqual([]);
  });

  it.each([[["1.4.0"]], [["1.3.0", "1.4.0"]], [["v1", "1.5.2"]]])("versions %j — подтверждено, без предупреждения", async (versions) => {
    const { core, ops, kinds } = await setup({ configuration: { versions } });
    await core.start();
    expect(ops()).toEqual([CONFIG, "GET /pao/v1/agent"]);
    expect(kinds("platform.version_unknown")).toEqual([]);
    expect(kinds("agent.stopped")).toEqual([]);
  });

  it.each([
    ["NO_VERSION", { configuration: { versions: ["v1"] } }],
    ["NO_VERSION", { configuration: {} }],
    ["NO_RESPONSE", { handlers: { [CONFIG]: () => ({ status: 404, body: {} }) } }],
    ["BAD_RESPONSE", { handlers: { [CONFIG]: () => ({ body: { versions: "1.4.0" } as never }) } }],
  ] as const)("версия не определена (%s) — предупреждение PLATFORM_VERSION_UNKNOWN, допуск идёт", async (detail, o) => {
    const { core, ops, kinds } = await setup(o as Pick<StandOptions, "configuration" | "handlers">);
    await core.start();
    expect(kinds("platform.version_unknown")).toEqual([expect.objectContaining({ reason: "PLATFORM_VERSION_UNKNOWN", detail })]);
    expect(ops()).toEqual([CONFIG, "GET /pao/v1/agent"]);
  });

  it("конфигурация — без подписи и без Idempotency-Key, один раз за допуск (ревью К2.3 № 3)", async () => {
    const { core, stand: s } = await setup({ configuration: { versions: ["1.4.0"] } });
    await core.start();
    const conf = s.stub.calls.filter((c) => c.op === CONFIG);
    expect(conf).toHaveLength(1);
    expect(conf[0]!.kid).toBeUndefined();
    expect(conf[0]!.idempotencyKey).toBeUndefined();
  });

  // CO-1 ядра v0.8.0 (AG-ДГ К1): у операции без подписи нет заголовков агента; подписанный допуск их несёт.
  it("конфигурация — без x-agent-code, x-timestamp, x-nonce и signature; GET /pao/v1/agent — с ними", async () => {
    const consents: Consents = new Consents(() => s.clock);
    const s: PaoStand = (stand = new PaoStand({ configuration: { versions: ["1.4.0"] }, handlers: consents.handlers() }));
    const sent: [string, Headers][] = [];
    const fetchImpl: typeof fetch = (url, init) => {
      sent.push([new URL(String(url)).pathname, new Headers(init?.headers)]);
      return fetch(url, init);
    };
    const { core } = await coreOn(s, { fetch: fetchImpl });
    await core.start();
    const AGENT_HEADERS = ["x-agent-code", "x-timestamp", "x-nonce", "signature", "signature-input"];
    const present = (h: Headers) => AGENT_HEADERS.filter((n) => h.has(n));
    expect(sent.map(([p, h]) => [p, present(h)])).toEqual([
      [CONFIG.slice(4), []],
      ["/pao/v1/agent", AGENT_HEADERS],
    ]);
  });

  // Ревью К2.3 № 9: по схеме — только versions; прочие поля конфигурации игнорируются (ПАО §7).
  it("versions 1.3.0 при поле вне перечня 1.4.0 — всё равно PLATFORM_PROTOCOL_UNSUPPORTED", async () => {
    const { core, ops, stand: s } = await setup({
      handlers: { [CONFIG]: () => ({ body: { versions: ["1.3.0"], algorithms: ["rsa-pss"], endpoints: 1 } as never }) },
    });
    await expect(core.start()).rejects.toMatchObject({ code: "PLATFORM_PROTOCOL_UNSUPPORTED" });
    expect(ops()).toEqual([CONFIG]);
    expectOnlyConfigViolation(s);
  });

  it.each([
    ["versions — не строки", { versions: [1, 4, 0] }],
    ["тело — массив", ["1.4.0"]],
  ])("%s — BAD_RESPONSE", async (_, body) => {
    const { core, kinds, ops, stand: s } = await setup({ handlers: { [CONFIG]: () => ({ body: body as never }) } });
    await core.start();
    expect(kinds("platform.version_unknown")).toEqual([expect.objectContaining({ detail: "BAD_RESPONSE" })]);
    expect(ops()).toEqual([CONFIG, "GET /pao/v1/agent"]);
    expectOnlyConfigViolation(s);
  });

  // Рекомендация ревью из чата к К2.3: ответы, которых PaoStub не отдаёт, — подменой транспорта адаптера.
  it("битый JSON на конфигурации — BAD_RESPONSE, допуск идёт", async () => {
    const consents: Consents = new Consents(() => s.clock);
    const s: PaoStand = (stand = new PaoStand({ handlers: consents.handlers() }));
    let served = 0;
    const fetchImpl: typeof fetch = (url, init) => {
      if (!String(url).endsWith(CONFIG.slice(4))) return fetch(url, init);
      served++;
      return Promise.resolve(new Response('{"versions": ["1.3.0"', { status: 200 }));
    };
    const { core, journal } = await coreOn(s, { fetch: fetchImpl });
    await core.start();
    expect(served).toBe(1); // без повтора: повтор пошёл бы мимо заглушки
    expect(journal.entries.filter((e) => e.kind === "platform.version_unknown")).toEqual([expect.objectContaining({ detail: "BAD_RESPONSE" })]);
    expect(s.stub.calls.map((c) => c.op)).toEqual(["GET /pao/v1/agent"]);
    expect(s.stub.violations).toEqual([]);
  });

  it("тайм-аут на конфигурации (pao_request_timeout_ms) — NO_RESPONSE, без повтора, допуск идёт", async () => {
    const dir = mkdtempSync(join(tmpdir(), "buyref-params-"));
    try {
      const paramsPath = join(dir, "params.json");
      writeFileSync(paramsPath, JSON.stringify({ ...loadParams(), pao_request_timeout_ms: SHORT_TIMEOUT_MS }));
      const consents: Consents = new Consents(() => s.clock);
      const s: PaoStand = (stand = new PaoStand({ handlers: consents.handlers() }));
      let hung = 0;
      const fetchImpl: typeof fetch = (url, init) => {
        if (!String(url).endsWith(CONFIG.slice(4))) return fetch(url, init);
        hung++;
        return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
      };
      const { core, journal } = await coreOn(s, { fetch: fetchImpl, paramsPath });
      await core.start();
      expect(hung).toBe(1);
      expect(journal.entries.filter((e) => e.kind === "platform.version_unknown")).toEqual([expect.objectContaining({ detail: "NO_RESPONSE" })]);
      expect(s.stub.calls.map((c) => [c.op, c.status])).toEqual([["GET /pao/v1/agent", 200]]);
      expect(s.stub.violations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Ревью К2.3 № 6: повтор допуска после сбоя читает конфигурацию снова — новое предупреждение на каждый start.
  it("404 на конфигурации и 503 на допуске — повтор start читает конфигурацию снова, два предупреждения", async () => {
    const { core, ops, kinds, stand: s } = await setup({ handlers: { [CONFIG]: () => ({ status: 404, body: {} }) } });
    // все попытки адаптера (pao_max_attempts) первого допуска — 503
    const attempts = loadParams().pao_max_attempts;
    s.stub.fail("GET /pao/v1/agent", { code: "STATE_UNAVAILABLE" }, attempts);
    await expect(core.start()).rejects.toBeInstanceOf(PlatformFailure);
    await core.start();
    expect(s.stub.calls.map((c) => [c.op, c.status])).toEqual([
      [CONFIG, 404],
      ...Array.from({ length: attempts }, () => ["GET /pao/v1/agent", 503]),
      [CONFIG, 404],
      ["GET /pao/v1/agent", 200],
    ]);
    expect(kinds("platform.version_unknown")).toEqual([
      expect.objectContaining({ detail: "NO_RESPONSE" }),
      expect.objectContaining({ detail: "NO_RESPONSE" }),
    ]);
    expect(ops()).toHaveLength(attempts + 3);
  });
});

describe("шаг 2 — версия не определена: по первому ответу с мандатом", () => {
  it("первый мандат без порядка отзыва — PLATFORM_PROTOCOL_UNSUPPORTED, агент остановлен целиком", async () => {
    const { core, consents, ops, kinds, stand: s } = await setup();
    await core.start();
    withoutOrder(consents);
    const err = (await core.mandates.request(INTENT, { idempotencyKey: "idem_u1" }).catch((e: unknown) => e)) as PlatformFailure;
    expect(err).toBeInstanceOf(PlatformFailure);
    expect(err.code).toBe("PLATFORM_PROTOCOL_UNSUPPORTED");
    expect(err.message).toContain(protocolUnsupportedText(null));
    expect(kinds("platform.protocol_unsupported")).toEqual([expect.objectContaining({ detail: "MANDATE" })]);
    expect(kinds("agent.stopped")).toEqual([expect.objectContaining({ reason: "PLATFORM_PROTOCOL_UNSUPPORTED" })]);
    // код Платформы, а не код мандата
    expect(kinds("mandate.revocation_order_missing")).toEqual([]);
    consents.tamper = undefined;
    await expect(core.mandates.request(INTENT, { idempotencyKey: "idem_u2" })).rejects.toThrow(SignerStopped);
    await expect(core.platform.agentSelf()).rejects.toThrow(SignerStopped);
    expect(ops()).toEqual([CONFIG, "GET /pao/v1/agent", "POST /pao/v1/mandates"]);
    expect(s.stub.violations).toEqual([]);
  });

  it.each([
    ["GET мандата", "GET /pao/v1/mandates/{id}"],
    ["отказ от мандата", "POST /pao/v1/mandates/{id}/relinquish"],
  ] as const)("%s без порядка отзыва до подтверждения — тот же код и событие (ревью К2.3 № 1)", async (_, op) => {
    const { core, ops, kinds } = await setup({ handlers: { [op]: () => ({ body: noOrderMandate("m_9") }) } });
    await core.start();
    const call = op === "GET /pao/v1/mandates/{id}" ? core.platform.getMandate("m_9") : core.platform.relinquishMandate("m_9", { idempotencyKey: "idem_r1" });
    await expect(call).rejects.toMatchObject({ code: "PLATFORM_PROTOCOL_UNSUPPORTED" });
    expect(kinds("platform.protocol_unsupported")).toEqual([expect.objectContaining({ reason: "PLATFORM_PROTOCOL_UNSUPPORTED", detail: "MANDATE" })]);
    expect(kinds("agent.stopped")).toEqual([expect.objectContaining({ reason: "PLATFORM_PROTOCOL_UNSUPPORTED" })]);
    expect(ops()).toEqual([CONFIG, "GET /pao/v1/agent", op]);
  });

  // Ревью К2.3 № 2: в ПАО 1.3.0 agent_code мандата необязателен — ответ не по схеме 1.4.0, но признак тот же.
  it("мандат без agent_code и без порядка отзыва до подтверждения — PLATFORM_PROTOCOL_UNSUPPORTED, а не UNKNOWN", async () => {
    const { core, consents, kinds } = await setup();
    await core.start();
    consents.tamper = (m) => {
      const r = { ...m };
      delete r.revocation_order;
      delete (r as { agent_code?: string }).agent_code;
      return r;
    };
    await expect(core.mandates.request(INTENT, { idempotencyKey: "idem_n1" })).rejects.toMatchObject({ code: "PLATFORM_PROTOCOL_UNSUPPORTED" });
    expect(kinds("agent.stopped")).toEqual([expect.objectContaining({ reason: "PLATFORM_PROTOCOL_UNSUPPORTED" })]);
  });

  it("после подтверждения мандат без agent_code — UNKNOWN на этом обращении, агент работает", async () => {
    const { core, consents, kinds } = await setup({ configuration: { versions: ["1.4.0"] } });
    await core.start();
    consents.tamper = (m) => {
      const r = { ...m };
      delete r.revocation_order;
      delete (r as { agent_code?: string }).agent_code;
      return r;
    };
    await expect(core.mandates.request(INTENT, { idempotencyKey: "idem_n2" })).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(kinds("agent.stopped")).toEqual([]);
    expect(kinds("platform.protocol_unsupported")).toEqual([]);
  });

  it("первый мандат с порядком отзыва подтверждает версию; дальше без порядка — код мандата, агент работает", async () => {
    const { core, consents, kinds } = await setup();
    await core.start();
    await core.mandates.request(INTENT, { idempotencyKey: "idem_c1" });
    withoutOrder(consents);
    await expect(core.mandates.request(INTENT, { idempotencyKey: "idem_c2" })).rejects.toMatchObject({ reason: "REVOCATION_ORDER_MISSING" });
    expect(kinds("agent.stopped")).toEqual([]);
    consents.tamper = undefined;
    await expect(core.mandates.request(INTENT, { idempotencyKey: "idem_c3" })).resolves.toMatchObject({ status: "PENDING_SIGNATURE" });
  });

  it("версия 1.4.0 по конфигурации — первый же мандат без порядка: MANDATE_REVOCATION_ORDER_MISSING, без остановки", async () => {
    const { core, consents, kinds } = await setup({ configuration: { versions: ["1.4.0"] } });
    await core.start();
    withoutOrder(consents);
    const err = await core.mandates.request(INTENT, { idempotencyKey: "idem_k1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MandateRefused);
    expect(err).toMatchObject({ reason: "REVOCATION_ORDER_MISSING" });
    expect(kinds("platform.protocol_unsupported")).toEqual([]);
    expect(kinds("agent.stopped")).toEqual([]);
  });

  // Ревью К2.2: путь выписки идёт мимо MandateClient — проверка версии на нём та же (адаптер).
  it("выписка: мандат без порядка отзыва до подтверждения — PLATFORM_PROTOCOL_UNSUPPORTED; пустая цепочка не подтверждает", async () => {
    let chain: unknown[] = [];
    const { core, ops, kinds } = await setup({
      handlers: { [EVIDENCE]: () => ({ body: { mandate_chain: chain as never, operations: [], integrity: "OK" } }) },
    });
    await core.start();
    await expect(core.platform.mandateEvidence("m_0")).resolves.toMatchObject({ mandateChain: [] });
    chain = [noOrderMandate("m_9")];
    await expect(core.platform.mandateEvidence("m_9")).rejects.toMatchObject({ code: "PLATFORM_PROTOCOL_UNSUPPORTED" });
    expect(kinds("platform.protocol_unsupported")).toEqual([expect.objectContaining({ detail: "MANDATE" })]);
    await expect(core.platform.mandateEvidence("m_9")).rejects.toThrow(SignerStopped);
    expect(ops()).toEqual([CONFIG, "GET /pao/v1/agent", EVIDENCE, EVIDENCE]);
  });
});

/** Мандат ПАО без порядка отзыва — как его отдала бы Платформа старше 1.4.0. */
function noOrderMandate(id: string) {
  return { ...mandateDraftToPao(INTENT, new Set(["RUB"])), id, agent_code: AGENT, status: "ACTIVE", created_at: "2026-10-01T00:00:00Z" };
}
