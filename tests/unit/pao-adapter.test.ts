import { readFileSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { newEd25519Signer } from "@kuzin4u/agentic-core";
import { PaoStub } from "@kuzin4u/agentic-core/pao";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { Pace, PaoPlatform, assertPaoVersion } from "../../src/agent/adapters/pao/index.js";
import { mandateDraftToPao } from "../../src/agent/adapters/pao/map.js";
import { loadParams, type StandParams } from "../../src/shared/config.js";
import { PlatformFailure, type CredentialDraft } from "../../src/shared/domain.js";
import type { RequestSigning } from "../../src/agent/ports/index.js";
import { Consents, INTENT } from "../support/consents.js";

const AGENT = "nspk:agent:buyref-01:v1";
const params = loadParams();
const M1 = { id: "m_1", currency: "RUB" };
const draft: CredentialDraft = {
  mandate: M1,
  orderRef: "ord_1",
  merchantId: "shop_1",
  amountMax: { amount: 250000, currency: "RUB" },
  channel: "CARD",
};
const { signer, publicKey } = newEd25519Signer("kid_test");
/** Порт подписи с одним ключом: отказы по ключу и допуску здесь не проверяются (см. signer-ring и сценарии П01–П03). */
const signing: RequestSigning = {
  current: () => signer,
  keyRevoked: () => {
    throw new Error("в этих тестах ключ не отзывается");
  },
  stop: () => {},
  suspend: () => {},
};

/** Ограничитель частоты без интервала и без настоящего ожидания (Р59; пауза после 429 — тоже): в `sleeps` — только
 *  ожидание повторов по Retry-After; сам ограничитель — pao-pace.test.ts. */
const quietPace = () => new Pace({ fallbackPerMin: Infinity, journal: new MemoryJournal(), sleep: async () => {} });

let stub: PaoStub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

async function setup(sleeps: number[] = []) {
  stub = new PaoStub({
    agents: [{ agentCode: AGENT, keys: [{ kid: "kid_test", alg: "ed25519", publicKey, status: "ACTIVE" }] }],
    handlers: {
      "GET /pao/v1/mandates/{id}/verify": ({ path }) => ({
        body: { outcome: "CONFIRMED", amount_left: path.id === "m_1" ? 175000 : 0, valid_to: "2026-10-20T00:00:00Z" },
      }),
      "POST /pao/v1/credentials": ({ body }) => ({
        status: 201,
        body: {
          credential_ref: "cr_1",
          kind: body.kind,
          payload: { token_ref: "tok_ref_1", cryptogram: "CRYPTOGRAM_VALUE" },
          aoi: { indicator: true, agent_code: AGENT, mandate_id: body.mandate_id },
          status: "ISSUED",
        },
      }),
    },
  });
  const baseUrl = await stub.start();
  const platform = new PaoPlatform({ journal: new MemoryJournal(), baseUrl, agentCode: AGENT, signing, params, sleep: async (ms) => void sleeps.push(ms), pace: quietPace() });
  return { platform, stub };
}

/** Платформа без заглушки: ответ задаёт тест, обращения считаются. */
function fake(reply: () => Response | Promise<Response>, p: StandParams = params) {
  const calls: RequestInit[] = [];
  const platform = new PaoPlatform({
    journal: new MemoryJournal(),
    baseUrl: "http://pao.test",
    agentCode: AGENT,
    signing,
    params: p,
    sleep: async () => {},
    fetch: async (_url, init) => {
      calls.push(init ?? {});
      return reply();
    },
  });
  return { platform, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("адаптер ПАО против заглушки agentic-core", () => {
  it("заявляет возможности ПАО; события не подписаны до ПАО 1.5.0 (Р34 п. 11)", async () => {
    const { platform } = await setup();
    expect(platform.capabilities()).toMatchObject({
      platform: "pao",
      protocolVersion: "1.4.0",
      currencies: ["RUB"],
      guaranteeContour: true,
      signedEvents: false,
      conditionalSettlement: false,
    });
  });

  it("verify: остаток — от платформы (инвариант 6)", async () => {
    const { platform, stub } = await setup();
    expect((await platform.verifyMandate(M1)).amountLeft).toEqual({ amount: 175000, currency: "RUB" });
    expect(stub.violations).toEqual([]);
  });

  it("реквизит: в ядро приходит только ссылка", async () => {
    const { platform } = await setup();
    const c = await platform.issueCredential(draft, { idempotencyKey: "idem_cr_1" });
    expect(c.credentialRef).toBe("cr_1");
    expect(JSON.stringify(c)).not.toContain("CRYPTOGRAM_VALUE");
  });

  it("повтор по RATE_LIMITED: новый nonce, тот же Idempotency-Key (Р21)", async () => {
    const sleeps: number[] = [];
    const { platform, stub } = await setup(sleeps);
    stub.fail("POST /pao/v1/credentials", { code: "RATE_LIMITED", retryAfterSec: 1 }, 1);
    await platform.issueCredential(draft, { idempotencyKey: "idem_cr_2" });
    const calls = stub.calls.filter((c) => c.op === "POST /pao/v1/credentials");
    expect(calls.map((c) => c.status)).toEqual([429, 201]);
    expect(calls[0]!.idempotencyKey).toBe("idem_cr_2");
    expect(calls[1]!.idempotencyKey).toBe("idem_cr_2");
    expect(calls[0]!.nonce).toBeTruthy();
    expect(calls[1]!.nonce).not.toBe(calls[0]!.nonce);
    expect(sleeps).toEqual([1000]);
  });

  it("повторов не больше pao_max_attempts", async () => {
    const { platform, stub } = await setup();
    stub.fail("GET /pao/v1/mandates/{id}/verify", { code: "STATE_UNAVAILABLE", retryAfterSec: 0 }, 10);
    await expect(platform.verifyMandate(M1)).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    expect(stub.calls.filter((c) => c.op === "GET /pao/v1/mandates/{id}/verify")).toHaveLength(params.pao_max_attempts);
  });

  it("Retry-After больше потолка — отказ без ожидания (инвариант 4)", async () => {
    const sleeps: number[] = [];
    const { platform, stub } = await setup(sleeps);
    stub.fail("GET /pao/v1/mandates/{id}/verify", { code: "UPSTREAM_UNAVAILABLE", retryAfterSec: 31 }, 1);
    const err = await platform.verifyMandate(M1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformFailure);
    expect(err).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retry: "same_key", httpStatus: 503 });
    expect(sleeps).toEqual([]);
  });

  it.each([
    ["MANDATE_REVOKED", 500],
    ["UPSTREAM_UNAVAILABLE", 500],
    ["RATE_LIMITED", 400],
  ] as const)("код %s с чужим статусом %i: одно обращение, BAD_RESPONSE (Р48 п. 3)", async (code, status) => {
    const { platform, stub } = await setup();
    stub.fail("GET /pao/v1/mandates/{id}/verify", { code, status, retry: "same_key", retryAfterSec: 0 }, 3);
    await expect(platform.verifyMandate(M1)).rejects.toMatchObject({ code: "BAD_RESPONSE", retry: "never", platformCode: code });
    expect(stub.calls.filter((c) => c.op === "GET /pao/v1/mandates/{id}/verify")).toHaveLength(1);
  });

  // Р31: оба кода — after_fix; адаптер не повторяет и не переключает ключ (keyRevoked в этих тестах бросает).
  // Retry-After: 0 — иначе адаптер не повторил бы и по RETRY_SAME_KEY, и тест был бы пустым (ревью К0.1а № 1).
  it.each([
    ["KEY_INVALID", 422, (p: PaoPlatform) => p.registerKey({ alg: "ed25519", publicKey }, { idempotencyKey: "agent-key-k" })],
    ["REQUEST_INVALID", 400, (p: PaoPlatform) => p.verifyMandate(M1)],
  ] as const)("код %s (%i): одно обращение, отказ ядра, без перехода на другой ключ", async (code, status, call) => {
    const { platform, calls } = fake(() => json(status, { code, message: "m", retry: "after_fix" }, { "retry-after": "0" }));
    await expect(call(platform)).rejects.toMatchObject({ code, retry: "after_fix", platformCode: code });
    expect(calls).toHaveLength(1);
  });

  it("ожидание копится: 20 + 20 с больше потолка — отказ после первого ожидания", async () => {
    const sleeps: number[] = [];
    const { platform, stub } = await setup(sleeps);
    stub.fail("GET /pao/v1/mandates/{id}/verify", { code: "RATE_LIMITED", retryAfterSec: 20 }, 3);
    await expect(platform.verifyMandate(M1)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(sleeps).toEqual([20000]);
    expect(stub.calls.filter((c) => c.op === "GET /pao/v1/mandates/{id}/verify")).toHaveLength(2);
  });
});

describe("валюта — из мандата, множество платформы — допустимое (Р29)", () => {
  it.each([
    ["реквизит в USD по мандату в USD", { ...draft, mandate: { id: "m_1", currency: "USD" }, amountMax: { amount: 1, currency: "USD" } }],
    ["реквизит в USD по мандату в RUB", { ...draft, amountMax: { amount: 1, currency: "USD" } }],
    ["дробная сумма", { ...draft, amountMax: { amount: 1.5, currency: "RUB" } }],
  ])("%s — отказ до обращения", async (_, bad) => {
    const { platform, stub } = await setup();
    await expect(platform.issueCredential(bad, { idempotencyKey: "idem_cur" })).rejects.toMatchObject({ code: "UNKNOWN", httpStatus: 0 });
    expect(stub.calls).toEqual([]);
  });

  it("verify и операции по мандату в валюте вне множества — отказ до обращения", async () => {
    const { platform, stub } = await setup();
    const usd = { id: "m_1", currency: "USD" };
    await expect(platform.verifyMandate(usd)).rejects.toMatchObject({ code: "UNKNOWN", httpStatus: 0 });
    await expect(platform.listOperations(usd)).rejects.toMatchObject({ code: "UNKNOWN", httpStatus: 0 });
    await expect(platform.getOperation("op_1", usd)).rejects.toMatchObject({ code: "UNKNOWN", httpStatus: 0 });
    expect(stub.calls).toEqual([]);
  });

  it("мандат платформы в USD — BAD_RESPONSE (поломка «не RUB принят»)", async () => {
    const mandate = {
      id: "m_usd", agent_code: AGENT, revocation_order: "bank:pr_1:revocation:v1", type: "INTENT", subject: "хлеб", amount_limit: 500000, currency: "USD", valid_to: "2026-11-14T00:00:00Z",
      merchant_scope: ["shop_1"], principal_ref: "pr_1", mode: "IMMEDIATE", status: "ACTIVE",
    };
    const { platform } = fake(() => json(200, mandate));
    await expect(platform.getMandate("m_usd")).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    const rub = fake(() => json(200, { ...mandate, currency: "RUB" }));
    expect((await rub.platform.getMandate("m_usd")).amountLimit).toEqual({ amount: 500000, currency: "RUB" });
  });

  it("подтверждение в USD по мандату в RUB — отказ до обращения", async () => {
    const { platform, stub } = await setup();
    const c = { mandate: M1, merchantId: "shop_1", amount: { amount: 1, currency: "USD" }, summary: "s", channel: "UPK" as const };
    await expect(platform.requestConfirmation(c, { idempotencyKey: "idem_cf" })).rejects.toMatchObject({ code: "UNKNOWN", httpStatus: 0 });
    expect(stub.calls).toEqual([]);
  });

  it("операция чужого мандата — BAD_RESPONSE; без признака: по одной — сумма не подтверждена, в списке — валюта мандата", async () => {
    const op = { op_ref: "op_1", amount: 1000, status: "DECLINED" };
    const other = fake(() => json(200, { ...op, aoi: { indicator: true, agent_code: AGENT, mandate_id: "m_2" } }));
    await expect(other.platform.getOperation("op_1", M1)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    const bare = fake(() => json(200, op));
    expect(await bare.platform.getOperation("op_1", M1)).toMatchObject({ amount: null, indicator: null });
    const list = fake(() => json(200, [op]));
    expect(await list.platform.listOperations(M1)).toMatchObject([{ amount: { amount: 1000, currency: "RUB" }, indicator: null }]);
  });
});

describe("fail-closed без заглушки", () => {
  // «Открыто» № 4 (ревью AG-02): ответ 2xx — по схеме ПАО; значение вне перечня — BAD_RESPONSE без фрагментов тела (Р48 п. 3).
  it.each([
    ["outcome вне перечня", { outcome: "MAYBE_LATER", amount_left: 1, valid_to: "2026-10-20T00:00:00Z" }],
    ["нет обязательного amount_left", { outcome: "CONFIRMED", valid_to: "2026-10-20T00:00:00Z" }],
    ["valid_to не дата-время", { outcome: "CONFIRMED", amount_left: 1, valid_to: "MAYBE_LATER" }],
  ])("verify: %s — BAD_RESPONSE", async (_, body) => {
    const { platform, calls } = fake(() => json(200, body));
    const err = (await platform.verifyMandate(M1).catch((e: unknown) => e)) as PlatformFailure;
    expect(err).toMatchObject({ code: "BAD_RESPONSE", retry: "never", httpStatus: 200 });
    expect(err.message).not.toContain("MAYBE_LATER");
    expect(calls).toHaveLength(1);
  });

  it("лента: элемент неизвестного типа — пропуск, а не UNKNOWN всего ответа (Р34 п. 6, ПАО §7)", async () => {
    const at = "2026-10-19T09:00:00Z";
    const { platform, calls } = fake(() =>
      json(200, [
        // тип вне перечня YAML 1.4.0 (deal.* в перечне есть — Р17, у агента тоже пропуск)
        { event_id: "evt_1", type: "future.kind", at, data: {} },
        { event_id: "evt_2", type: "deal.funded", at, data: { deal_id: "d_1" } },
        { event_id: "evt_3", type: "mandate.signed", at, data: { mandate_id: "m_1" } },
      ]),
    );
    const feed = await platform.listEvents("evt_0");
    expect(feed).toEqual([
      { kind: "ignored", eventId: "evt_1", detail: "UNKNOWN_TYPE" },
      { kind: "ignored", eventId: "evt_2", detail: "UNKNOWN_TYPE" },
      { kind: "event", event: expect.objectContaining({ eventId: "evt_3", type: "mandate.signed", mandateId: "m_1" }) },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("лента: элемент без event_id — BAD_RESPONSE всего ответа (Р34 п. 6)", async () => {
    const { platform } = fake(() => json(200, [{ type: "mandate.signed", at: "2026-10-19T09:00:00Z", data: { mandate_id: "m_1" } }]));
    await expect(platform.listEvents(null)).rejects.toMatchObject({ code: "BAD_RESPONSE", httpStatus: 200 });
  });

  it("подписка: ответ с другим адресом или составом — BAD_RESPONSE без повтора (Р34 п. 8, Р48 п. 3)", async () => {
    const url = "https://agent.example/pao/events";
    for (const body of [{ url: "https://evil.example/x", events: ["mandate.signed"] }, { url, events: [] }]) {
      const { platform, calls } = fake(() => json(200, body));
      await expect(platform.subscribe(url, ["mandate.signed"], { idempotencyKey: "idem-s" })).rejects.toMatchObject({ code: "BAD_RESPONSE", httpStatus: 200 });
      expect(calls).toHaveLength(1); // 2xx изменяющего запроса не по контракту — без повтора (Р48 п. 3)
    }
    // без Idempotency-Key — отказ до обращения (инвариант 9)
    const empty = fake(() => json(200, { url, events: ["mandate.signed"] }));
    await expect(empty.platform.subscribe(url, ["mandate.signed"], { idempotencyKey: "" })).rejects.toMatchObject({ code: "AGENT_REQUEST_DEFECT" });
    expect(empty.calls).toHaveLength(0);
    const { platform, calls } = fake(() => json(200, { url, events: ["mandate.signed"] }));
    await platform.subscribe(url, ["mandate.signed"], { idempotencyKey: "idem-s" });
    expect(new Headers(calls[0]?.headers).get("idempotency-key")).toBe("idem-s");
  });

  it("неизвестные поля ответа принимаются (ПАО §7)", async () => {
    const { platform } = fake(() => json(200, { outcome: "CONFIRMED", amount_left: 7, valid_to: "2026-10-20T00:00:00Z", future_field: { x: 1 } }));
    expect((await platform.verifyMandate(M1)).amountLeft).toEqual({ amount: 7, currency: "RUB" });
  });

  it("реквизит с aoi чужого мандата или агента — BAD_RESPONSE («Открыто» № 17)", async () => {
    const cred = (aoi: object) => ({ credential_ref: "cr_1", kind: "CARD", payload: {}, aoi, status: "ISSUED" });
    for (const aoi of [
      { indicator: true, agent_code: AGENT, mandate_id: "m_2" },
      { indicator: true, agent_code: "nspk:agent:other:v1", mandate_id: "m_1" },
    ]) {
      const { platform } = fake(() => json(201, cred(aoi)));
      await expect(platform.issueCredential(draft, { idempotencyKey: "idem_aoi" })).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    }
  });

  it("П14: ответ выдачи без признака (нет aoi, aoi: null, indicator: false) — BAD_RESPONSE, пакета агентской оплаты нет (Т8; ревью КТ1 Р56 № 2)", async () => {
    const base = { credential_ref: "cr_1", kind: "CARD", payload: {}, status: "ISSUED" };
    for (const body of [base, { ...base, aoi: null }, { ...base, aoi: { indicator: false, agent_code: AGENT, mandate_id: "m_1" } }]) {
      const { platform, calls } = fake(() => json(201, body));
      await expect(platform.issuePaymentPackage(draft, { idempotencyKey: "idem_no_aoi" }), JSON.stringify(body)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
      expect(calls).toHaveLength(1);
    }
  });

  it("неизвестный код с retry same_key — ровно одно обращение, UNKNOWN, never", async () => {
    const { platform, calls } = fake(() => json(409, { code: "NEW_CODE", message: "m", retry: "same_key" }, { "retry-after": "0" }));
    await expect(platform.verifyMandate(M1)).rejects.toMatchObject({ code: "UNKNOWN", retry: "never", platformCode: "NEW_CODE" });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["без заголовка", undefined],
    ["в виде даты", "Wed, 21 Oct 2026 07:28:00 GMT"],
  ])("429 с Retry-After %s — без повтора", async (_, after) => {
    const headers: Record<string, string> = after ? { "retry-after": after } : {};
    const { platform, calls } = fake(() => json(429, { code: "RATE_LIMITED", message: "m", retry: "same_key" }, headers));
    await expect(platform.verifyMandate(M1)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(calls).toHaveLength(1);
  });

  it("503 без тела ПАО — одно обращение, BAD_RESPONSE", async () => {
    const { platform, calls } = fake(() => new Response("bad gateway", { status: 503, headers: { "retry-after": "1" } }));
    await expect(platform.verifyMandate(M1)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    expect(calls).toHaveLength(1);
  });

  it("пустое тело 2xx — BAD_RESPONSE, а не TypeError", async () => {
    const { platform } = fake(() => new Response("", { status: 200 }));
    const err = await platform.getMandate("m_1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformFailure);
    expect(err).toMatchObject({ code: "BAD_RESPONSE", retry: "never" });
  });

  it("битый ответ /credentials — в тексте отказа нет фрагментов тела (инвариант 1)", async () => {
    const { platform } = fake(() => new Response('{"credential_ref":"cr_1","payload":{"cryptogram": SECRETCRYP', { status: 201 }));
    const err = (await platform.issueCredential(draft, { idempotencyKey: "idem_cr_3" }).catch((e: unknown) => e)) as PlatformFailure;
    expect(err).toMatchObject({ code: "BAD_RESPONSE", retry: "never" });
    expect(err.message).not.toMatch(/SECRETCRYP|cryptogram|payload/);
  });

  it("тайм-аут GET — NO_RESPONSE, без повтора (Р48 п. 4а)", async () => {
    const calls: unknown[] = [];
    const platform = new PaoPlatform({
      journal: new MemoryJournal(),
      baseUrl: "http://pao.test",
      agentCode: AGENT,
      signing,
      params: { ...params, pao_request_timeout_ms: 30 },
      fetch: (_url, init) =>
        new Promise((_, reject) => {
          calls.push(init);
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    });
    await expect(platform.verifyMandate(M1)).rejects.toMatchObject({ code: "NO_RESPONSE", httpStatus: 0 });
    expect(calls).toHaveLength(1);
  });

  // Р27: ответ 2xx на GET /pao/v1/agent не по схеме — приостановка подписи; тайм-аут и 503 — нет.
  describe("GET /pao/v1/agent: ответ не по схеме — приостановка (Р27)", () => {
    const self = { agent_code: AGENT, status: "ACTIVE", class: "BUYER", keys: [] };
    const watched = (reply: () => Response | Promise<Response>, p: StandParams = params) => {
      const suspended: string[] = [];
      const stopped: string[] = [];
      const platform = new PaoPlatform({
        journal: new MemoryJournal(),
        baseUrl: "http://pao.test",
        agentCode: AGENT,
        signing: { ...signing, stop: (r: string) => void stopped.push(r), suspend: (r: string) => void suspended.push(r) },
        params: p,
        sleep: async () => {},
        fetch: async () => reply(),
      });
      return { platform, suspended, stopped };
    };
    const raw = (body: string) => () => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

    it.each([
      ["тело не JSON", raw("{")],
      ["тело null", raw("null")],
      ["пустое тело", raw("")],
      ["keys — не массив", () => json(200, { ...self, keys: {} })],
      ["элемент keys — null", () => json(200, { ...self, keys: [null] })],
      ["нет class", () => json(200, { agent_code: AGENT, status: "ACTIVE", keys: [] })],
      ["класс вне перечня", () => json(200, { ...self, class: "ADMIN" })],
      ["статус вне перечня", () => json(200, { ...self, status: "BLOCKED" })],
    ])("%s — BAD_RESPONSE с HTTP 200, подпись приостановлена", async (_n, reply) => {
      const { platform, suspended, stopped } = watched(reply);
      await expect(platform.agentSelf()).rejects.toMatchObject({ code: "BAD_RESPONSE", httpStatus: 200 });
      expect(suspended).toEqual(["AGENT_SELF_UNKNOWN"]);
      expect(stopped).toEqual([]);
    });

    it("обрыв тела после заголовков 200 — тоже приостановка (fail-closed)", async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"agent_code":'));
          c.error(new Error("соединение оборвано"));
        },
      });
      const { platform, suspended } = watched(() => new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
      await expect(platform.agentSelf()).rejects.toMatchObject({ code: "BAD_RESPONSE", httpStatus: 200 });
      expect(suspended).toEqual(["AGENT_SELF_UNKNOWN"]);
    });

    it("ответ по схеме — без приостановки", async () => {
      const { platform, suspended } = watched(() => json(200, self));
      await expect(platform.agentSelf()).resolves.toMatchObject({ agentClass: "BUYER" });
      expect(suspended).toEqual([]);
    });

    it("тайм-аут — NO_RESPONSE (HTTP 0), не приостановка", async () => {
      const suspended: string[] = [];
      const platform = new PaoPlatform({
        journal: new MemoryJournal(),
        baseUrl: "http://pao.test",
        agentCode: AGENT,
        signing: { ...signing, suspend: (r: string) => void suspended.push(r) },
        params: { ...params, pao_request_timeout_ms: 30 },
        fetch: (_url, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
      });
      await expect(platform.agentSelf()).rejects.toMatchObject({ code: "NO_RESPONSE", httpStatus: 0 });
      expect(suspended).toEqual([]);
    });

    it("503 — не приостановка", async () => {
      const { platform, suspended } = watched(() => json(503, { code: "UPSTREAM_UNAVAILABLE", message: "x", retry: "same_key" }), {
        ...params,
        pao_max_attempts: 1,
      });
      await expect(platform.agentSelf()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
      expect(suspended).toEqual([]);
    });
  });

  it("Idempotency-Key читается один раз: геттер отдаёт ключ, затем пустую строку — отправлен проверенный ключ (инвариант 9)", async () => {
    const { platform, calls } = fake(() => json(201, {}));
    let reads = 0;
    const m = { get idempotencyKey() { return ++reads === 1 ? "idem-once" : ""; } };
    await platform.issueCredential(draft, m).catch(() => undefined);
    expect(reads).toBe(1);
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.headers).get("idempotency-key")).toBe("idem-once");
  });

  it.each(["", "   "])("пустой Idempotency-Key (%j) — отказ до отправки", async (key) => {
    const { platform, calls } = fake(() => json(201, {}));
    await expect(platform.issueCredential(draft, { idempotencyKey: key })).rejects.toMatchObject({ code: "AGENT_REQUEST_DEFECT", retry: "never" });
    expect(calls).toHaveLength(0);
  });
});

// РП33 (ПАО 1.4.0): ответы 401, 403, 404, 503 у POST и GET мандата — коды из таблицы §7а, новых строк нет (Р33 п. 7).
// На PaoStub: статус и retry отказа — из x-pao-errors спецификации, мандаты — журнал согласий-обёртка (ревью К2.2 № 1).
describe("мандаты: коды отказа РП33 на PaoStub", () => {
  async function mandateStub() {
    const consents = new Consents(() => new Date("2026-10-12T09:00:00Z"), AGENT);
    stub = new PaoStub({
      agents: [{ agentCode: AGENT, keys: [{ kid: "kid_test", alg: "ed25519", publicKey, status: "ACTIVE" }] }],
      handlers: consents.handlers(),
    });
    const baseUrl = await stub.start();
    const sleeps: number[] = [];
    const platform = new PaoPlatform({ journal: new MemoryJournal(), baseUrl, agentCode: AGENT, signing, params, sleep: async (ms) => void sleeps.push(ms), pace: quietPace() });
    // мандат m_1 для GET — до отказов
    await platform.requestMandate(INTENT, { idempotencyKey: "idem_m_seed" });
    return { platform, stub, sleeps };
  }
  const ops = {
    "POST /pao/v1/mandates": (p: PaoPlatform) => p.requestMandate({ ...INTENT, subject: "молоко" }, { idempotencyKey: "idem_m_rp33" }),
    "GET /pao/v1/mandates/{id}": (p: PaoPlatform) => p.getMandate("m_1"),
  } as const;
  type Op = keyof typeof ops;
  const OPS = Object.keys(ops) as Op[];

  it.each(
    OPS.flatMap((op) =>
      ([
        ["AGENT_UNKNOWN", 401],
        ["AGENT_SUSPENDED", 403],
        ["MANDATE_NOT_FOUND", 404],
      ] as const).map(([code, http]) => [op, code, http] as const),
    ),
  )("%s: %s (%i) — код ядра, без повтора", async (op, code, http) => {
    const { platform, stub } = await mandateStub();
    stub.fail(op, { code });
    await expect(ops[op](platform)).rejects.toMatchObject({ code, httpStatus: http });
    expect(stub.calls.filter((c) => c.op === op && c.code === code)).toHaveLength(1);
    expect(stub.violations).toEqual([]);
  });

  it.each(OPS)("%s: 503 STATE_UNAVAILABLE — повтор тем же ключом после Retry-After", async (op) => {
    const { platform, stub, sleeps } = await mandateStub();
    stub.fail(op, { code: "STATE_UNAVAILABLE" }, 1);
    await expect(ops[op](platform)).resolves.toMatchObject({ revocationOrder: "bank:pr_1:revocation:v1" });
    const calls = stub.calls.filter((c) => c.op === op);
    const last2 = calls.slice(-2);
    expect(last2.map((c) => c.status)).toEqual([503, op.startsWith("POST") ? 201 : 200]);
    expect(last2[1]!.idempotencyKey).toBe(last2[0]!.idempotencyKey);
    expect(sleeps).toEqual([1000]);
  });

  it("POST: IDEMPOTENCY_CONFLICT (ключ мандата для другого запроса) — остановка без повтора", async () => {
    const { platform, stub } = await mandateStub();
    await expect(platform.requestMandate({ ...INTENT, subject: "сыр" }, { idempotencyKey: "idem_m_seed" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(stub.calls.filter((c) => c.code === "IDEMPOTENCY_CONFLICT")).toHaveLength(1);
  });
});

describe("версия ПАО", () => {
  it("версия в agentic-core должна совпасть с копией (Р20)", () => {
    expect(() => assertPaoVersion()).not.toThrow();
    expect(() => assertPaoVersion("1.3.0")).toThrow(/Р20/);
  });
});

describe("экспорт адаптера ПАО (ревью AG-02 № 19)", () => {
  it("наружу — только адаптер, ограничитель частоты, версия копии, проверка версии и реестры кодов ПАО и клиента ПАО (Р36, Р37 п. 1, Р59 п. 1); переводчики ПАО (map) не экспортируются", async () => {
    const exported = Object.keys(await import("../../src/agent/adapters/pao/index.js")).sort();
    expect(exported).toEqual(["PAO_CLIENT_CODES", "PAO_CLIENT_DIAG", "PAO_COPY_VERSION", "PAO_DIAG", "Pace", "PaoPlatform", "assertPaoVersion"]);
  });
});

// Р48 п. 4: нет ответа — повтор тем же Idempotency-Key с новой подписью, без ожидания, до pao_max_attempts — только у
// методов, где ПАО требует ключ; выдача реквизита и GET — без повтора.
describe("NO_RESPONSE: повтор тем же ключом (Р48 п. 4)", () => {
  const lost = () => Promise.reject(new TypeError("fetch failed"));

  it("перечень методов с повтором — методы YAML 1.4.0 с обязательным Idempotency-Key (SPEC §7а, Р48 п. 4а)", async () => {
    const { KEYED_OPERATIONS } = await import("../../src/agent/adapters/pao/adapter.js");
    const yaml = readFileSync("docs/core/protocol/agent-protocol.v1.4.0.yaml", "utf8");
    // по YAML: обязательный заголовок задаёт якорь &id007 (Idempotency-Key) или общий набор параметров *id009 с ним
    const keyed: string[] = [];
    let path = "";
    let method = "";
    for (const line of yaml.split("\n")) {
      const p = /^ {2}(\/pao\/[^:]+):$/.exec(line);
      if (p) path = p[1]!;
      const m = /^ {4}(get|post|put|delete):$/.exec(line);
      if (m) method = m[1]!.toUpperCase();
      if (/[&*]id007\b|parameters: \*id009\b/.test(line)) keyed.push(`${method} ${path}`);
    }
    expect(yaml).toMatch(/- &id007\n\s+\$ref: '#\/components\/parameters\/IdempotencyKey'/);
    expect([...KEYED_OPERATIONS].sort()).toEqual([...new Set(keyed)].sort());
  });

  it("PUT /pao/v1/subscription: нет ответа — повтор тем же ключом, новая подпись, до pao_max_attempts; затем NO_RESPONSE", async () => {
    const { platform, calls } = fake(lost);
    await expect(platform.subscribe("https://agent.example/pao/events", ["mandate.signed"], { idempotencyKey: "idem-nr" })).rejects.toMatchObject({
      code: "NO_RESPONSE",
      retry: "same_key",
      httpStatus: 0,
    });
    expect(calls).toHaveLength(params.pao_max_attempts);
    expect(new Set(calls.map((c) => new Headers(c.headers).get("idempotency-key")))).toEqual(new Set(["idem-nr"]));
    expect(new Set(calls.map((c) => new Headers(c.headers).get("x-nonce"))).size).toBe(params.pao_max_attempts);
  });

  it("нет ответа, затем ответ — итог второй попытки", async () => {
    let n = 0;
    const url = "https://agent.example/pao/events";
    const { platform, calls } = fake(() => (++n === 1 ? lost() : json(200, { url, events: ["mandate.signed"] })));
    await platform.subscribe(url, ["mandate.signed"], { idempotencyKey: "idem-nr2" });
    expect(calls).toHaveLength(2);
  });

  it("выдача реквизита: нет ответа — одно обращение, NO_RESPONSE never (Р45 п. 3)", async () => {
    const { platform, calls } = fake(lost);
    await expect(platform.issueCredential(draft, { idempotencyKey: "idem-nr-cr" })).rejects.toMatchObject({ code: "NO_RESPONSE", retry: "never" });
    expect(calls).toHaveLength(1);
  });

  it("GET: нет ответа — одно обращение, NO_RESPONSE never (Р48 п. 4а)", async () => {
    const { platform, calls } = fake(lost);
    await expect(platform.getMandate("m_1")).rejects.toMatchObject({ code: "NO_RESPONSE", retry: "never" });
    expect(calls).toHaveLength(1);
  });

  it("изменяющий запрос: заголовки 201 пришли, тело оборвалось — BAD_RESPONSE с HTTP 201, одно обращение (ревью reviewer К2 № 6)", async () => {
    const broken = () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"id":'));
          c.error(new Error("соединение оборвано"));
        },
      });
      return new Response(body, { status: 201, headers: { "content-type": "application/json" } });
    };
    const { platform, calls } = fake(broken);
    await expect(platform.requestMandate(INTENT, { idempotencyKey: "idem-broken" })).rejects.toMatchObject({ code: "BAD_RESPONSE", retry: "never", httpStatus: 201 });
    expect(calls).toHaveLength(1);
  });

  it("изменяющий запрос: 503 без тела ПАО — BAD_RESPONSE, одно обращение (ревью reviewer К2 № 6)", async () => {
    const { platform, calls } = fake(() => new Response("bad gateway", { status: 503, headers: { "retry-after": "0" } }));
    await expect(platform.requestMandate(INTENT, { idempotencyKey: "idem-503" })).rejects.toMatchObject({ code: "BAD_RESPONSE", httpStatus: 503 });
    expect(calls).toHaveLength(1);
  });

  it("2xx не по контракту на изменяющий запрос — BAD_RESPONSE без повтора (Р48 п. 3)", async () => {
    const { platform, calls } = fake(() => new Response("{", { status: 201 }));
    await expect(platform.requestMandate(INTENT, { idempotencyKey: "idem-bad" })).rejects.toMatchObject({ code: "BAD_RESPONSE", httpStatus: 201 });
    expect(calls).toHaveLength(1);
  });
});

describe("Р50 п. 6 (а), Р60 п. 1: 403 AGENT_SUSPENDED на GET операции — подпись агента приостановлена, не остановлена", () => {
  it("readOperation (стадия 5, событие operation.*) — приостановка подписи AGENT_SUSPENDED, без повтора и без остановки", async () => {
    const stopped: string[] = [];
    const suspended: string[] = [];
    stub = new PaoStub({ agents: [{ agentCode: AGENT, keys: [{ kid: "kid_test", alg: "ed25519", publicKey, status: "ACTIVE" }] }] });
    stub.fail("GET /pao/v1/operations/{op_ref}", { code: "AGENT_SUSPENDED" });
    const platform = new PaoPlatform({
      journal: new MemoryJournal(),
      baseUrl: await stub.start(),
      agentCode: AGENT,
      signing: { ...signing, stop: (r: string) => void stopped.push(r), suspend: (r: string) => void suspended.push(r) },
      params,
      sleep: async () => {},
    });
    await expect(platform.readOperation("op_1")).rejects.toMatchObject({ code: "AGENT_SUSPENDED", httpStatus: 403 });
    expect(suspended).toEqual(["AGENT_SUSPENDED"]);
    expect(stopped).toEqual([]);
    expect(stub.calls.filter((c) => c.op === "GET /pao/v1/operations/{op_ref}")).toHaveLength(1);
  });

  it("Р51 п. 5: readOperations (поиск по CART) — 403 AGENT_SUSPENDED приостанавливает подпись, без повтора; 404 MANDATE_NOT_FOUND — отказ без приостановки", async () => {
    for (const [code, status, halts] of [["AGENT_SUSPENDED", 403, true], ["MANDATE_NOT_FOUND", 404, false]] as const) {
      const stopped: string[] = [];
      const suspended: string[] = [];
      stub = new PaoStub({ agents: [{ agentCode: AGENT, keys: [{ kid: "kid_test", alg: "ed25519", publicKey, status: "ACTIVE" }] }] });
      stub.fail("GET /pao/v1/operations", { code });
      const platform = new PaoPlatform({
        journal: new MemoryJournal(),
        baseUrl: await stub.start(),
        agentCode: AGENT,
        signing: { ...signing, stop: (r: string) => void stopped.push(r), suspend: (r: string) => void suspended.push(r) },
        params,
        sleep: async () => {},
      });
      await expect(platform.readOperations("m_cart_1")).rejects.toMatchObject({ code, httpStatus: status });
      expect(suspended, code).toEqual(halts ? [code] : []);
      expect(stopped, code).toEqual([]);
      expect(stub.calls.filter((c) => c.op === "GET /pao/v1/operations")).toHaveLength(1);
      await stub.close();
      stub = undefined;
    }
  });
});

describe("Р51 п. 5: GET /pao/v1/operations?mandate_id — операции до привязки", () => {
  it("список — записи с признаком этого агента и суммой числом; запрос — с mandate_id; не список или чужой признак — BAD_RESPONSE", async () => {
    const op = { op_ref: "op_1", order_ref: "ord_1", amount: 1000, channel: "CARD", merchant_id: "shop_1", status: "REVERSED", reason: "REVERSAL", aoi: { indicator: true, agent_code: AGENT, mandate_id: "m_cart_1" } };
    const urls: string[] = [];
    const ok = new PaoPlatform({
      journal: new MemoryJournal(),
      baseUrl: "http://pao.test",
      agentCode: AGENT,
      signing,
      params,
      sleep: async () => {},
      fetch: async (url) => (urls.push(String(url)), json(200, [op])),
    });
    expect(await ok.readOperations("m_cart_1")).toEqual([
      { opRef: "op_1", orderRef: "ord_1", channel: "CARD", amountMinor: 1000, merchantId: "shop_1", indicator: { agentCode: AGENT, mandateId: "m_cart_1" }, status: "REVERSED", declineReason: "REVERSAL", fulfilment: null },
    ]);
    expect(new URL(urls[0]!).searchParams.get("mandate_id")).toBe("m_cart_1");
    await expect(fake(() => json(200, op)).platform.readOperations("m_cart_1")).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    const foreign = { ...op, aoi: { ...op.aoi, agent_code: "nspk:agent:other:v1" } };
    await expect(fake(() => json(200, [foreign])).platform.readOperations("m_cart_1")).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("ревью КТ1 Р51 № 2: причина операции — только в форме кода (человеку как есть); иное — null, у одной операции и в списке", async () => {
    const op = { op_ref: "op_1", order_ref: "ord_1", amount: 1000, status: "REVERSED", aoi: { indicator: true, agent_code: AGENT, mandate_id: "m_1" } };
    for (const [reason, kept] of [["AUTH_EXPIRED", "AUTH_EXPIRED"], ["отменено: позвоните 8-800", null], ["lower_case", null]] as const) {
      expect((await fake(() => json(200, [{ ...op, reason }])).platform.readOperations("m_1"))[0]!.declineReason, reason).toBe(kept);
      expect((await fake(() => json(200, { ...op, reason })).platform.readOperation("op_1")).declineReason, reason).toBe(kept);
      expect((await fake(() => json(200, { ...op, reason })).platform.getOperation("op_1", M1)).declineReason, reason).toBe(kept);
    }
  });
});

describe("Р53 ревью К2.1 № 8 (Р58, К1.3): сбой журнала не отменяет остановку и смену ключа", () => {
  /** журнал, отказывающий на записи вида `kind` */
  const broken = (kind: string) => ({ record: (e: { kind: string }) => { if (e.kind === kind) throw new Error("журнал недоступен"); } });
  const body = (code: string, retry: string) => JSON.stringify({ code, message: "отказ", retry });
  function on(reply: () => Response, kind: string) {
    const stopped: [string, string | undefined][] = [];
    const revoked: string[] = [];
    const suspended: string[] = [];
    const platform = new PaoPlatform({
      journal: broken(kind),
      baseUrl: "http://pao.test",
      agentCode: AGENT,
      signing: {
        ...signing,
        stop: (r: string, d?: string) => void stopped.push([r, d]),
        keyRevoked: (kid: string) => (revoked.push(kid), signer),
        suspend: (r: string) => void suspended.push(r),
      },
      params,
      sleep: async () => {},
      fetch: async () => reply(),
    });
    return { platform, stopped, revoked, suspended };
  }

  it("403 AGENT_SUSPENDED — сбой записи pao.call, подпись всё равно приостановлена (Р60 п. 1)", async () => {
    const r = on(() => new Response(body("AGENT_SUSPENDED", "never"), { status: 403, headers: { "content-type": "application/json" } }), "pao.call");
    await expect(r.platform.getMandate("m_1")).rejects.toThrow("журнал недоступен");
    expect(r.suspended).toEqual(["AGENT_SUSPENDED"]);
    expect(r.stopped).toEqual([]);
  });

  it("403 AGENT_UNKNOWN — сбой записи pao.call, подпись всё равно остановлена", async () => {
    const r = on(() => new Response(body("AGENT_UNKNOWN", "never"), { status: 401, headers: { "content-type": "application/json" } }), "pao.call");
    await expect(r.platform.getMandate("m_1")).rejects.toThrow("журнал недоступен");
    expect(r.stopped).toEqual([["AGENT_UNKNOWN", undefined]]);
    expect(r.suspended).toEqual([]);
  });

  it("401 AGENT_KEY_REVOKED — сбой записи pao.call, ключ всё равно отмечен отозванным (смена ключа)", async () => {
    const r = on(() => new Response(body("AGENT_KEY_REVOKED", "new_key"), { status: 401, headers: { "content-type": "application/json" } }), "pao.call");
    await expect(r.platform.getMandate("m_1")).rejects.toThrow("журнал недоступен");
    expect(r.revoked).toEqual(["kid_test"]);
    expect(r.stopped).toEqual([]);
  });

  it("SIGNATURE_INVALID второй раз — сбой записи pao.call, остановка всё равно", async () => {
    const stopped: string[] = [];
    let n = 0;
    const platform = new PaoPlatform({
      journal: { record: (e) => { if (e.kind === "pao.call" && ++n === 2) throw new Error("журнал недоступен"); } },
      baseUrl: "http://pao.test",
      agentCode: AGENT,
      signing: { ...signing, stop: (s: string) => void stopped.push(s) },
      params,
      sleep: async () => {},
      fetch: async () => new Response(body("SIGNATURE_INVALID", "after_fix"), { status: 401, headers: { "content-type": "application/json" } }),
    });
    await expect(platform.agentSelf()).rejects.toThrow("журнал недоступен");
    expect(stopped).toEqual(["SIGNATURE_INVALID"]);
  });

  it.each([
    ["EXCLUDED", "BUYER", ["AGENT_EXCLUDED", undefined]],
    ["ACTIVE", "SELLER", ["AGENT_CLASS_MISMATCH", "SELLER"]],
  ] as const)("ревью КТ1 № 1: GET /pao/v1/agent — %s / %s, сбой записи pao.call «ok» — остановка всё равно, без приостановки и UNKNOWN", async (status, cls, stop) => {
    const r = on(() => new Response(JSON.stringify({ agent_code: AGENT, status, class: cls, keys: [] }), { status: 200, headers: { "content-type": "application/json" } }), "pao.call");
    const err = (await r.platform.agentSelf().catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("журнал недоступен"); // ошибка журнала как есть, не отказ Платформы
    expect(err).not.toBeInstanceOf(PlatformFailure);
    expect(r.stopped).toEqual([stop]);
    expect(r.suspended).toEqual([]);
  });

  it("ревью КТ1 № 1: изменяющий запрос состоялся, сбой записи pao.call «ok» — наружу ошибка журнала, не BAD_RESPONSE", async () => {
    const r = on(() => new Response(JSON.stringify({ url: "https://agent.test/push", events: ["operation.settled"] }), { status: 200, headers: { "content-type": "application/json" } }), "pao.call");
    const err = (await r.platform.subscribe("https://agent.test/push", ["operation.settled"], { idempotencyKey: "idem_s1" }).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("журнал недоступен");
    expect(err).not.toBeInstanceOf(PlatformFailure);
    expect(r.stopped).toEqual([]);
  });

  it("Р33 п. 10, шаг 1: ПАО Платформы ниже 1.4.0 — сбой записи platform.protocol_unsupported, остановка всё равно", async () => {
    const r = on(() => new Response(JSON.stringify({ versions: ["1.3.0"] }), { status: 200, headers: { "content-type": "application/json" } }), "platform.protocol_unsupported");
    await expect(r.platform.checkProtocol()).rejects.toThrow("журнал недоступен");
    expect(r.stopped).toEqual([["PLATFORM_PROTOCOL_UNSUPPORTED", "1.3.0"]]);
  });

  it("КТ1 сессии 39 № 1: ПАО Платформы ниже 1.4.0 — сбой записи pao.call «ok» конфигурации, остановка всё равно", async () => {
    const r = on(() => new Response(JSON.stringify({ versions: ["1.3.0"] }), { status: 200, headers: { "content-type": "application/json" } }), "pao.call");
    await expect(r.platform.checkProtocol()).rejects.toThrow("журнал недоступен");
    expect(r.stopped).toEqual([["PLATFORM_PROTOCOL_UNSUPPORTED", "1.3.0"]]);
  });
});

describe("Р58 п. 3: SIGNATURE_INVALID — сверка времени по Date, один повтор, затем остановка (SPEC §7а)", () => {
  const rejected = { code: "SIGNATURE_INVALID", message: "подпись", retry: "after_fix" };
  /** часы адаптера (x-timestamp) — постоянные: расхождение с Date ответа точно в секундах */
  const NOW = new Date("2026-10-26T10:00:00Z");
  /** Ответы по очереди; заголовок Date — у каждого ответа свой (null — без Date). */
  function replies(list: { status: number; body: unknown; date: string | null }[], p: StandParams = params) {
    const calls: Record<string, string>[] = [];
    const stopped: [string, string | undefined][] = [];
    const journal = new MemoryJournal();
    const platform = new PaoPlatform({
      journal,
      baseUrl: "http://pao.test",
      agentCode: AGENT,
      signing: { ...signing, stop: (r: string, d?: string) => void stopped.push([r, d]) },
      params: p,
      sleep: async () => {},
      now: () => NOW,
      fetch: async (_url, init) => {
        calls.push(init?.headers as Record<string, string>);
        const r = list[calls.length - 1]!;
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (r.date !== null) headers.date = r.date;
        return new Response(JSON.stringify(r.body), { status: r.status, headers });
      },
    });
    const rejections = () => journal.entries.filter((e) => e.kind === "signature.rejected");
    return { platform, calls, stopped, rejections };
  }
  const SELF = { agent_code: AGENT, status: "ACTIVE", class: "BUYER", keys: [] };
  /** Date ответа на `sec` секунд позади x-timestamp запроса (часы агента впереди на `sec`; минус — позади). */
  const behind = (sec: number) => new Date(NOW.getTime() - sec * 1000).toUTCString();

  it("первый отказ — один повтор новой подписью; запись signature.rejected с расхождением по Date ответа", async () => {
    const r = replies([
      { status: 401, body: rejected, date: behind(-7) },
      { status: 200, body: SELF, date: behind(0) },
    ]);
    await expect(r.platform.agentSelf()).resolves.toMatchObject({ status: "ACTIVE" });
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]!["x-nonce"]).not.toBe(r.calls[0]!["x-nonce"]);
    expect(r.stopped).toEqual([]);
    expect(r.rejections()).toEqual([expect.objectContaining({ kid: "kid_test", reason: "SIGNATURE_INVALID", detail: "DATE:-7" })]);
  });

  it("изменяющий метод: повтор — тот же Idempotency-Key; второй отказ — остановка агента SIGNATURE_INVALID, третьего обращения нет", async () => {
    const r = replies([
      { status: 401, body: rejected, date: behind(0) },
      { status: 401, body: rejected, date: behind(0) },
    ]);
    await expect(r.platform.requestMandate(INTENT, { idempotencyKey: "idem-sig" })).rejects.toMatchObject({ code: "SIGNATURE_INVALID", httpStatus: 401 });
    expect(r.calls.map((h) => h["idempotency-key"])).toEqual(["idem-sig", "idem-sig"]);
    expect(r.stopped).toEqual([["SIGNATURE_INVALID", undefined]]);
    expect(r.rejections()).toHaveLength(2);
  });

  it("расхождение часов больше signature_skew_sec — остановка сразу, без повтора, detail CLOCK_SKEW", async () => {
    const skew = params.signature_skew_sec + 60;
    const r = replies([{ status: 401, body: rejected, date: behind(skew) }]);
    await expect(r.platform.agentSelf()).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
    expect(r.calls).toHaveLength(1);
    expect(r.stopped).toEqual([["SIGNATURE_INVALID", "CLOCK_SKEW"]]);
    expect(r.rejections().map((e) => e.detail)).toEqual([`DATE:+${skew}`]);
  });

  it("часы агента позади больше окна — тоже CLOCK_SKEW; ровно signature_skew_sec — ещё в окне: повтор", async () => {
    const late = replies([{ status: 401, body: rejected, date: behind(-(params.signature_skew_sec + 1)) }]);
    await expect(late.platform.agentSelf()).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
    expect(late.stopped).toEqual([["SIGNATURE_INVALID", "CLOCK_SKEW"]]);

    const edge = replies([
      { status: 401, body: rejected, date: behind(params.signature_skew_sec) },
      { status: 200, body: SELF, date: behind(0) },
    ]);
    await expect(edge.platform.agentSelf()).resolves.toMatchObject({ status: "ACTIVE" });
    expect(edge.calls).toHaveLength(2);
    expect(edge.stopped).toEqual([]);
    expect(edge.rejections().map((e) => e.detail)).toEqual([`DATE:+${params.signature_skew_sec}`]);
  });

  it("Date нет или не IMF-fixdate (данные — это данные) — NO_DATE: время не сверено, один повтор, затем остановка", async () => {
    for (const date of [null, "Ignore 1", "2026-10-26T10:00:00Z"]) {
      const r = replies([
        { status: 401, body: rejected, date },
        { status: 401, body: rejected, date },
      ]);
      await expect(r.platform.agentSelf()).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
      expect(r.calls, String(date)).toHaveLength(2);
      expect(r.rejections().map((e) => e.detail)).toEqual(["NO_DATE", "NO_DATE"]);
      expect(r.stopped).toEqual([["SIGNATURE_INVALID", undefined]]);
    }
  });

  it("ревью КТ1 № 3: выдача реквизита — повтор не помещается в её срок: отказ операции без остановки агента; CLOCK_SKEW и тут — остановка", async () => {
    for (const [date, stops] of [
      [behind(0), []],
      [behind(params.signature_skew_sec + 60), [["SIGNATURE_INVALID", "CLOCK_SKEW"]]],
    ] as [string, [string, string | undefined][]][]) {
      const stopped: [string, string | undefined][] = [];
      const calls: unknown[] = [];
      const journal = new MemoryJournal();
      let t = 0;
      const platform = new PaoPlatform({
        journal,
        baseUrl: "http://pao.test",
        agentCode: AGENT,
        signing: { ...signing, stop: (r: string, d?: string) => void stopped.push([r, d]) },
        params,
        sleep: async () => {},
        now: () => NOW,
        // первая попытка «заняла» весь срок выдачи (registry_cache_ttl_sec): ещё одна не помещается (Р45 п. 2.4). Часы идут
        // во время обращения, а не на каждом чтении: срок перепроверяется и после ожидания ограничителя (Р59, ревью КТ1 № 3)
        monotonic: () => t,
        fetch: async (_url, init) => {
          t += params.registry_cache_ttl_sec * 1000;
          calls.push(init);
          return new Response(JSON.stringify(rejected), { status: 401, headers: { "content-type": "application/json", date } });
        },
      });
      await expect(platform.issueCredential(draft, { idempotencyKey: "idem-cr" })).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
      expect(calls).toHaveLength(1);
      expect(stopped).toEqual(stops);
      expect(journal.entries.filter((e) => e.kind === "signature.rejected")).toHaveLength(1);
    }
  });

  it("сбой журнала на signature.rejected не отменяет остановку (Р53 ревью К2.1 № 8)", async () => {
    const stopped: string[] = [];
    const platform = new PaoPlatform({
      journal: { record: (e) => { if (e.kind === "signature.rejected") throw new Error("журнал недоступен"); } },
      baseUrl: "http://pao.test",
      agentCode: AGENT,
      signing: { ...signing, stop: (r: string) => void stopped.push(r) },
      params,
      sleep: async () => {},
      now: () => NOW,
      fetch: async () => new Response(JSON.stringify(rejected), { status: 401, headers: { "content-type": "application/json", date: behind(params.signature_skew_sec + 60) } }),
    });
    await expect(platform.agentSelf()).rejects.toThrow("журнал недоступен");
    expect(stopped).toEqual(["SIGNATURE_INVALID"]);
  });
});

describe("Р58 п. 5 и доп. 1: сверка одним чтением после BAD_RESPONSE на 2xx изменяющего запроса", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const KEY = { kid: "kid_new", alg: "ed25519", public_key: "pk_new", status: "ACTIVE", valid_from: "2026-10-01T00:00:00Z", valid_to: "2026-12-30T00:00:00Z" };
  const self = (keys: unknown[]) => ({ agent_code: AGENT, status: "ACTIVE", class: "BUYER", keys });
  const mandate = (status: string) => ({ ...mandateDraftToPao(INTENT, new Set(["RUB"])), id: "m_1", agent_code: AGENT, status, created_at: "2026-10-01T00:00:00Z", revocation_order: "https://bank.test/revoke" });
  /** ответы по маршруту «метод путь»; обращения — по порядку */
  function on(routes: Record<string, () => Response>) {
    const calls: string[] = [];
    const journal = new MemoryJournal();
    const platform = new PaoPlatform({
      journal,
      baseUrl: "http://pao.test",
      agentCode: AGENT,
      signing,
      params,
      sleep: async () => {},
      fetch: async (url, init) => {
        const route = `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`;
        calls.push(route);
        return routes[route]!();
      },
    });
    return { platform, calls, journal };
  }
  const broken = () => new Response("{", { status: 201, headers: { "content-type": "application/json" } });

  it("регистрация ключа: битый 201, в реестре наш ключ ACTIVE — успех, ключ из реестра; одно чтение, без повтора POST", async () => {
    const r = on({ "POST /pao/v1/agent/keys": broken, "GET /pao/v1/agent": () => json(200, self([KEY])) });
    await expect(r.platform.registerKey({ alg: "ed25519", publicKey: "pk_new" }, { idempotencyKey: "agent-key-kid_new" })).resolves.toMatchObject({ kid: "kid_new", publicKey: "pk_new", status: "ACTIVE" });
    expect(r.calls).toEqual(["POST /pao/v1/agent/keys", "GET /pao/v1/agent"]);
    expect(r.journal.entries.filter((e) => e.kind === "pao.call").map((e) => [e.method, e.result])).toEqual([
      ["POST /pao/v1/agent/keys", "unknown"],
      ["GET /pao/v1/agent", "ok"],
    ]);
  });

  it.each([
    ["ключа нет в реестре", () => json(200, self([]))],
    ["ключ не ACTIVE", () => json(200, self([{ ...KEY, status: "REVOKED" }]))],
    ["чтение отказало", () => json(503, { code: "STATE_UNAVAILABLE", message: "x", retry: "same_key" })],
  ])("регистрация ключа: %s — прежний BAD_RESPONSE, без повтора POST", async (_, read) => {
    const r = on({ "POST /pao/v1/agent/keys": broken, "GET /pao/v1/agent": read });
    await expect(r.platform.registerKey({ alg: "ed25519", publicKey: "pk_new" }, { idempotencyKey: "agent-key-kid_new" })).rejects.toMatchObject({ code: "BAD_RESPONSE", httpStatus: 201 });
    expect(r.calls.filter((c) => c.startsWith("POST"))).toEqual(["POST /pao/v1/agent/keys"]);
    expect(r.calls.filter((c) => c.startsWith("GET")).length).toBeGreaterThanOrEqual(1);
  });

  it("отказ от мандата: битый 200, по GET — REVOKED — успех; ACTIVE — прежний BAD_RESPONSE", async () => {
    const ok = on({ "POST /pao/v1/mandates/m_1/relinquish": broken, "GET /pao/v1/mandates/m_1": () => json(200, mandate("REVOKED")) });
    await expect(ok.platform.relinquishMandate("m_1", { idempotencyKey: "idem_r" })).resolves.toMatchObject({ id: "m_1", status: "REVOKED" });
    expect(ok.calls).toEqual(["POST /pao/v1/mandates/m_1/relinquish", "GET /pao/v1/mandates/m_1"]);
    const no = on({ "POST /pao/v1/mandates/m_1/relinquish": broken, "GET /pao/v1/mandates/m_1": () => json(200, mandate("ACTIVE")) });
    await expect(no.platform.relinquishMandate("m_1", { idempotencyKey: "idem_r" })).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    expect(no.calls).toEqual(["POST /pao/v1/mandates/m_1/relinquish", "GET /pao/v1/mandates/m_1"]);
  });

  it("отказ Платформы (не BAD_RESPONSE на 2xx) — как есть, без чтения; подписка — без сверки (доп. 1)", async () => {
    const refused = on({ "POST /pao/v1/mandates/m_1/relinquish": () => json(404, { code: "MANDATE_NOT_FOUND", message: "x", retry: "never" }) });
    await expect(refused.platform.relinquishMandate("m_1", { idempotencyKey: "idem_r" })).rejects.toMatchObject({ code: "MANDATE_NOT_FOUND" });
    expect(refused.calls).toEqual(["POST /pao/v1/mandates/m_1/relinquish"]);
    const sub = on({ "PUT /pao/v1/subscription": () => new Response("{", { status: 200, headers: { "content-type": "application/json" } }) });
    await expect(sub.platform.subscribe("https://agent.test/push", ["operation.settled"], { idempotencyKey: "idem_s" })).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    expect(sub.calls).toEqual(["PUT /pao/v1/subscription"]);
  });
});
