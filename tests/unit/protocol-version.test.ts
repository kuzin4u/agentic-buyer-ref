// Р33 п. 10 (К2.3): версия ПАО Платформы — при подключении (конфигурация) и, пока не определена, по первому ответу с
// мандатом. Ниже 1.4.0 — PLATFORM_PROTOCOL_UNSUPPORTED и остановка агента целиком; не определена — предупреждение
// PLATFORM_VERSION_UNKNOWN в журнал и работа дальше; после подтверждения ответ без порядка отзыва —
// MANDATE_REVOCATION_ORDER_MISSING на этом мандате.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaoCallError, PaoClient } from "@kuzin4u/agentic-core/pao";
import { PAO_MIN_PLATFORM_VERSION, highestPaoVersion, protocolUnsupportedText } from "../../src/agent/adapters/pao/adapter.js";
import { mandateDraftToPao } from "../../src/agent/adapters/pao/map.js";
import { AgentNotReady } from "../../src/agent/declines/index.js";
import { MandateRefused } from "../../src/agent/mandates/index.js";
import { SignerStopped } from "../../src/agent/signer/index.js";
import { loadParams } from "../../src/shared/config.js";
import { PlatformFailure } from "../../src/shared/domain.js";
import { Consents, INTENT } from "../support/consents.js";
import { coreOn, startCause } from "../support/core.js";
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
    const err = (await startCause(core.start()).catch((e: unknown) => e)) as PlatformFailure;
    expect(err).toBeInstanceOf(PlatformFailure);
    expect(err.code).toBe("PLATFORM_PROTOCOL_UNSUPPORTED");
    expect(err.message).toContain(protocolUnsupportedText("1.3.0"));
    expect(kinds("agent.stopped")).toEqual([expect.objectContaining({ reason: "PLATFORM_PROTOCOL_UNSUPPORTED", detail: "1.3.0" })]);
    expect(kinds("platform.protocol_unsupported")).toEqual([
      expect.objectContaining({ reason: "PLATFORM_PROTOCOL_UNSUPPORTED", detail: "CONFIGURATION" }),
    ]);
    // остановка, а не «не допущен»: ни повторный допуск, ни мандат не обращаются к Платформе
    await expect(startCause(core.start())).rejects.toThrow(SignerStopped);
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
    await expect(startCause(core.start())).rejects.toMatchObject({ code: "PLATFORM_PROTOCOL_UNSUPPORTED" });
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
    await expect(startCause(core.start())).rejects.toBeInstanceOf(PlatformFailure);
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

  it("Р-620 (Р58 нюанс К1.3): сбой записи platform.protocol_unsupported — агент всё равно остановлен, наружу ошибка журнала", async () => {
    const { core, journal, consents, kinds } = await setup();
    await core.start();
    withoutOrder(consents);
    const record = journal.record.bind(journal);
    journal.record = (e) => {
      if (e.kind === "platform.protocol_unsupported") throw new Error("журнал недоступен");
      record(e);
    };
    const err = (await core.mandates.request(INTENT, { idempotencyKey: "idem_u1" }).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("журнал недоступен"); // не UNKNOWN операции
    expect(kinds("agent.stopped")).toEqual([expect.objectContaining({ reason: "PLATFORM_PROTOCOL_UNSUPPORTED" })]);
    await expect(core.platform.agentSelf()).rejects.toThrow(SignerStopped);
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

  it("после подтверждения мандат без agent_code — BAD_RESPONSE на этом обращении, агент работает", async () => {
    const { core, consents, kinds } = await setup({ configuration: { versions: ["1.4.0"] } });
    await core.start();
    consents.tamper = (m) => {
      const r = { ...m };
      delete r.revocation_order;
      delete (r as { agent_code?: string }).agent_code;
      return r;
    };
    await expect(core.mandates.request(INTENT, { idempotencyKey: "idem_n2" })).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    expect(kinds("agent.stopped")).toEqual([]);
    expect(kinds("platform.protocol_unsupported")).toEqual([]);
  });

  it("первый мандат с порядком отзыва подтверждает версию; дальше без порядка — код мандата, агент работает", async () => {
    const { core, consents, kinds } = await setup();
    await core.start();
    await core.mandates.request(INTENT, { idempotencyKey: "idem_c1" });
    withoutOrder(consents);
    await expect(core.mandates.request(INTENT, { idempotencyKey: "idem_c2" })).rejects.toMatchObject({ reason: "MANDATE_REVOCATION_ORDER_MISSING" });
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
    expect(err).toMatchObject({ reason: "MANDATE_REVOCATION_ORDER_MISSING" });
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

// Р37 п. 1–2 (ядро v0.9.0, передача #34): клиент ПАО перенаправлениям не следует. Свой fetch адаптера передаёт init
// целиком, вместе с redirect: "manual" — иначе fetch прошёл бы на второй адрес раньше, чем клиент откажет.
describe("перенаправления 3xx (Р37 п. 1–2)", () => {
  /** Второй адрес (куда указывает Location) считает обращения; перенаправляющий адрес отвечает 302 на него. */
  async function redirector() {
    const hits = { redirector: 0, foreign: 0 };
    const foreign = createServer((_, res) => {
      hits.foreign++;
      res.writeHead(200, { "content-type": "application/json" }).end('{"versions":["1.4.0"]}');
    });
    const from = createServer((_, res) => {
      hits.redirector++;
      res.writeHead(302, { location: `http://127.0.0.1:${(foreign.address() as AddressInfo).port}/` }).end();
    });
    await Promise.all([foreign, from].map((srv) => new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok))));
    const url = `http://127.0.0.1:${(from.address() as AddressInfo).port}/`;
    const close = () => Promise.all([foreign, from].map((srv) => new Promise((ok) => srv.close(ok))));
    return { hits, url, close };
  }

  it("3xx у конфигурации — platform.protocol: fail PAO_CLIENT_REDIRECT, агент не стартует; на второй адрес ничего не ушло; подписант не остановлен — старт повторяется", async () => {
    const r = await redirector();
    try {
      const consents: Consents = new Consents(() => s.clock);
      const s: PaoStand = (stand = new PaoStand({ handlers: consents.handlers() }));
      let redirect = true;
      const fetchImpl: typeof fetch = (url, init) =>
        redirect && String(url).endsWith(CONFIG.slice(4)) ? fetch(r.url, init) : fetch(url, init);
      const { core, journal } = await coreOn(s, { fetch: fetchImpl });
      const err = await core.start().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentNotReady);
      const report = (err as AgentNotReady).report;
      expect(report.checks.filter((c) => c.status === "fail")).toEqual([{ check: "platform.protocol", status: "fail", code: "PAO_CLIENT_REDIRECT" }]);
      expect((err as AgentNotReady).cause).toMatchObject({ code: "PAO_CLIENT_REDIRECT", retry: "after_fix", httpStatus: 302 });
      expect(r.hits).toEqual({ redirector: 1, foreign: 0 });
      expect(s.stub.calls).toEqual([]);
      // журнал — отказ внутри допуска (нюанс Р37: запись общая для ring.start, ключ не виноват) и отчёт; больше ничего
      expect(journal.entries.filter((e) => e.kind !== "agent.selfcheck").map((e) => [e.kind, e.reason])).toEqual([
        ["key.loaded", undefined],
        ["events.cursor_initial", undefined],
        ["pao.call", "PAO_CLIENT_REDIRECT"],
        ["admission.failed", "PAO_CLIENT_REDIRECT"],
      ]);
      expect(journal.entries.find((e) => e.kind === "pao.call")).toMatchObject({ method: CONFIG, attempt: 1, result: "refused", detail: "302" });
      // адрес исправлен — тот же агент стартует (after_fix, Р36 доп. 2 п. 2)
      redirect = false;
      await core.start();
      expect(core.selfCheck()?.ready).toBe(true);
      expect(s.stub.calls.map((c) => [c.op, c.status])).toEqual([[CONFIG, 200], ["GET /pao/v1/agent", 200]]);
      expect(s.stub.violations).toEqual([]);
    } finally {
      await r.close();
    }
  });

  it("3xx у подписанного метода — отказ PAO_CLIENT_REDIRECT без повтора; на второй адрес ничего не ушло; агент работает дальше", async () => {
    const r = await redirector();
    try {
      const consents: Consents = new Consents(() => s.clock);
      const s: PaoStand = (stand = new PaoStand({ handlers: consents.handlers() }));
      let redirect = false;
      const fetchImpl: typeof fetch = (url, init) =>
        redirect && String(url).endsWith("/pao/v1/agent") ? fetch(r.url, init) : fetch(url, init);
      const { core, journal } = await coreOn(s, { fetch: fetchImpl });
      await core.start();
      redirect = true;
      const err = await core.platform.agentSelf().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlatformFailure);
      expect(err).toMatchObject({ code: "PAO_CLIENT_REDIRECT", retry: "after_fix", httpStatus: 302 });
      expect(r.hits).toEqual({ redirector: 1, foreign: 0 });
      expect(journal.entries.filter((e) => e.kind === "agent.stopped")).toEqual([]);
      redirect = false;
      await expect(core.platform.agentSelf()).resolves.toMatchObject({ status: "ACTIVE" });
      // перенаправленный запрос до заглушки не дошёл: допуск и одно чтение после возврата адреса
      expect(s.stub.calls.map((c) => [c.op, c.status])).toEqual([[CONFIG, 200], ["GET /pao/v1/agent", 200], ["GET /pao/v1/agent", 200]]);
      expect(s.stub.violations).toEqual([]);
    } finally {
      await r.close();
    }
  });

  it("3xx у изменяющего метода — отказ с прежним Idempotency-Key, без второго запроса; после возврата адреса — тот же ключ (ревью К0 № 4)", async () => {
    const r = await redirector();
    try {
      const consents: Consents = new Consents(() => s.clock);
      const s: PaoStand = (stand = new PaoStand({ handlers: consents.handlers() }));
      let redirect = false;
      const fetchImpl: typeof fetch = (url, init) =>
        redirect && String(url).endsWith("/pao/v1/mandates") ? fetch(r.url, init) : fetch(url, init);
      const { core } = await coreOn(s, { fetch: fetchImpl });
      await core.start();
      redirect = true;
      const err = await core.platform.requestMandate(INTENT, { idempotencyKey: "idem_m_redirect" }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "PAO_CLIENT_REDIRECT", retry: "after_fix", httpStatus: 302, idempotencyKey: "idem_m_redirect" });
      expect(r.hits).toEqual({ redirector: 1, foreign: 0 });
      redirect = false;
      await expect(core.platform.requestMandate(INTENT, { idempotencyKey: "idem_m_redirect" })).resolves.toMatchObject({ status: "PENDING_SIGNATURE" });
      const posts = s.stub.calls.filter((c) => c.op === "POST /pao/v1/mandates");
      expect(posts.map((c) => [c.status, c.idempotencyKey])).toEqual([[201, "idem_m_redirect"]]);
      expect(s.stub.violations).toEqual([]);
    } finally {
      await r.close();
    }
  });

  it("PAO_CLIENT_SIGNER_MISSING на конфигурации — дефект агента: fail, а не «адрес не отвечает» (ревью К0 № 1)", async () => {
    const consents: Consents = new Consents(() => s.clock);
    const s: PaoStand = (stand = new PaoStand({ handlers: consents.handlers() }));
    const { core, journal } = await coreOn(s);
    const spy = vi
      .spyOn(PaoClient.prototype, "call")
      .mockRejectedValueOnce(new PaoCallError(0, undefined, 0, undefined, { clientCode: "PAO_CLIENT_SIGNER_MISSING" }));
    try {
      const err = await core.start().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentNotReady);
      expect((err as AgentNotReady).report.checks.filter((c) => c.status === "fail")).toEqual([
        { check: "platform.protocol", status: "fail", code: "PAO_CLIENT_SIGNER_MISSING" },
      ]);
      expect(journal.entries.filter((e) => e.kind === "platform.version_unknown")).toEqual([]);
      expect(s.stub.calls).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
