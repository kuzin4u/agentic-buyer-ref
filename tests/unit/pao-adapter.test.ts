import { describe, it, expect, afterEach } from "vitest";
import { newEd25519Signer } from "@kuzin4u/agentic-core";
import { PaoStub } from "@kuzin4u/agentic-core/pao";
import { PaoPlatform, assertPaoVersion } from "../../src/agent/adapters/pao/index.js";
import { loadParams, type StandParams } from "../../src/shared/config.js";
import { PlatformFailure, type CredentialDraft } from "../../src/shared/domain.js";
import type { RequestSigning } from "../../src/agent/ports/index.js";

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
  const platform = new PaoPlatform({ baseUrl, agentCode: AGENT, signing, params, sleep: async (ms) => void sleeps.push(ms) });
  return { platform, stub };
}

/** Платформа без заглушки: ответ задаёт тест, обращения считаются. */
function fake(reply: () => Response | Promise<Response>, p: StandParams = params) {
  const calls: RequestInit[] = [];
  const platform = new PaoPlatform({
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
  it("заявляет возможности ПАО; подписанные события — только после AG-06", async () => {
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
  ] as const)("код %s с чужим статусом %i: одно обращение, UNKNOWN", async (code, status) => {
    const { platform, stub } = await setup();
    stub.fail("GET /pao/v1/mandates/{id}/verify", { code, status, retry: "same_key", retryAfterSec: 0 }, 3);
    await expect(platform.verifyMandate(M1)).rejects.toMatchObject({ code: "UNKNOWN", retry: "never", platformCode: code });
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

  it("мандат платформы в USD — UNKNOWN (поломка «не RUB принят»)", async () => {
    const mandate = {
      id: "m_usd", agent_code: AGENT, type: "INTENT", subject: "хлеб", amount_limit: 500000, currency: "USD", valid_to: "2026-11-14T00:00:00Z",
      merchant_scope: ["shop_1"], principal_ref: "pr_1", mode: "IMMEDIATE", status: "ACTIVE",
    };
    const { platform } = fake(() => json(200, mandate));
    await expect(platform.getMandate("m_usd")).rejects.toMatchObject({ code: "UNKNOWN" });
    const rub = fake(() => json(200, { ...mandate, currency: "RUB" }));
    expect((await rub.platform.getMandate("m_usd")).amountLimit).toEqual({ amount: 500000, currency: "RUB" });
  });

  it("подтверждение в USD по мандату в RUB — отказ до обращения", async () => {
    const { platform, stub } = await setup();
    const c = { mandate: M1, merchantId: "shop_1", amount: { amount: 1, currency: "USD" }, summary: "s", channel: "UPK" as const };
    await expect(platform.requestConfirmation(c, { idempotencyKey: "idem_cf" })).rejects.toMatchObject({ code: "UNKNOWN", httpStatus: 0 });
    expect(stub.calls).toEqual([]);
  });

  it("операция чужого мандата — UNKNOWN; без признака: по одной — сумма не подтверждена, в списке — валюта мандата", async () => {
    const op = { op_ref: "op_1", amount: 1000, status: "DECLINED" };
    const other = fake(() => json(200, { ...op, aoi: { indicator: true, agent_code: AGENT, mandate_id: "m_2" } }));
    await expect(other.platform.getOperation("op_1", M1)).rejects.toMatchObject({ code: "UNKNOWN" });
    const bare = fake(() => json(200, op));
    expect(await bare.platform.getOperation("op_1", M1)).toMatchObject({ amount: null, indicator: null });
    const list = fake(() => json(200, [op]));
    expect(await list.platform.listOperations(M1)).toMatchObject([{ amount: { amount: 1000, currency: "RUB" }, indicator: null }]);
  });
});

describe("fail-closed без заглушки", () => {
  // «Открыто» № 4 (ревью AG-02): ответ 2xx — по схеме ПАО; значение вне перечня — UNKNOWN без фрагментов тела.
  it.each([
    ["outcome вне перечня", { outcome: "MAYBE_LATER", amount_left: 1, valid_to: "2026-10-20T00:00:00Z" }],
    ["нет обязательного amount_left", { outcome: "CONFIRMED", valid_to: "2026-10-20T00:00:00Z" }],
    ["valid_to не дата-время", { outcome: "CONFIRMED", amount_left: 1, valid_to: "MAYBE_LATER" }],
  ])("verify: %s — UNKNOWN", async (_, body) => {
    const { platform, calls } = fake(() => json(200, body));
    const err = (await platform.verifyMandate(M1).catch((e: unknown) => e)) as PlatformFailure;
    expect(err).toMatchObject({ code: "UNKNOWN", retry: "never", httpStatus: 200 });
    expect(err.message).not.toContain("MAYBE_LATER");
    expect(calls).toHaveLength(1);
  });

  it("неизвестные поля ответа принимаются (ПАО §7)", async () => {
    const { platform } = fake(() => json(200, { outcome: "CONFIRMED", amount_left: 7, valid_to: "2026-10-20T00:00:00Z", future_field: { x: 1 } }));
    expect((await platform.verifyMandate(M1)).amountLeft).toEqual({ amount: 7, currency: "RUB" });
  });

  it("реквизит с aoi чужого мандата или агента — UNKNOWN («Открыто» № 17)", async () => {
    const cred = (aoi: object) => ({ credential_ref: "cr_1", kind: "CARD", payload: {}, aoi, status: "ISSUED" });
    for (const aoi of [
      { indicator: true, agent_code: AGENT, mandate_id: "m_2" },
      { indicator: true, agent_code: "nspk:agent:other:v1", mandate_id: "m_1" },
    ]) {
      const { platform } = fake(() => json(201, cred(aoi)));
      await expect(platform.issueCredential(draft, { idempotencyKey: "idem_aoi" })).rejects.toMatchObject({ code: "UNKNOWN" });
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

  it("503 без тела ПАО — одно обращение, UNKNOWN", async () => {
    const { platform, calls } = fake(() => new Response("bad gateway", { status: 503, headers: { "retry-after": "1" } }));
    await expect(platform.verifyMandate(M1)).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(calls).toHaveLength(1);
  });

  it("пустое тело 2xx — UNKNOWN, а не TypeError", async () => {
    const { platform } = fake(() => new Response("", { status: 200 }));
    const err = await platform.getMandate("m_1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformFailure);
    expect(err).toMatchObject({ code: "UNKNOWN", retry: "never" });
  });

  it("битый ответ /credentials — в тексте отказа нет фрагментов тела (инвариант 1)", async () => {
    const { platform } = fake(() => new Response('{"credential_ref":"cr_1","payload":{"cryptogram": SECRETCRYP', { status: 201 }));
    const err = (await platform.issueCredential(draft, { idempotencyKey: "idem_cr_3" }).catch((e: unknown) => e)) as PlatformFailure;
    expect(err).toMatchObject({ code: "UNKNOWN", retry: "never" });
    expect(err.message).not.toMatch(/SECRETCRYP|cryptogram|payload/);
  });

  it("тайм-аут обращения — UNKNOWN, без повтора", async () => {
    const calls: unknown[] = [];
    const platform = new PaoPlatform({
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
    await expect(platform.verifyMandate(M1)).rejects.toMatchObject({ code: "UNKNOWN", httpStatus: 0 });
    expect(calls).toHaveLength(1);
  });

  // Р27: ответ 2xx на GET /pao/v1/agent не по схеме — приостановка подписи; тайм-аут и 503 — нет.
  describe("GET /pao/v1/agent: ответ не по схеме — приостановка (Р27)", () => {
    const self = { agent_code: AGENT, status: "ACTIVE", class: "BUYER", keys: [] };
    const watched = (reply: () => Response | Promise<Response>, p: StandParams = params) => {
      const suspended: string[] = [];
      const stopped: string[] = [];
      const platform = new PaoPlatform({
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
    ])("%s — UNKNOWN с HTTP 200, подпись приостановлена", async (_n, reply) => {
      const { platform, suspended, stopped } = watched(reply);
      await expect(platform.agentSelf()).rejects.toMatchObject({ code: "UNKNOWN", httpStatus: 200 });
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
      await expect(platform.agentSelf()).rejects.toMatchObject({ code: "UNKNOWN", httpStatus: 200 });
      expect(suspended).toEqual(["AGENT_SELF_UNKNOWN"]);
    });

    it("ответ по схеме — без приостановки", async () => {
      const { platform, suspended } = watched(() => json(200, self));
      await expect(platform.agentSelf()).resolves.toMatchObject({ agentClass: "BUYER" });
      expect(suspended).toEqual([]);
    });

    it("тайм-аут — UNKNOWN без ответа (HTTP 0), не приостановка", async () => {
      const suspended: string[] = [];
      const platform = new PaoPlatform({
        baseUrl: "http://pao.test",
        agentCode: AGENT,
        signing: { ...signing, suspend: (r: string) => void suspended.push(r) },
        params: { ...params, pao_request_timeout_ms: 30 },
        fetch: (_url, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
      });
      await expect(platform.agentSelf()).rejects.toMatchObject({ code: "UNKNOWN", httpStatus: 0 });
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

  it.each(["", "   "])("пустой Idempotency-Key (%j) — отказ до отправки", async (key) => {
    const { platform, calls } = fake(() => json(201, {}));
    await expect(platform.issueCredential(draft, { idempotencyKey: key })).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(calls).toHaveLength(0);
  });
});

describe("версия ПАО", () => {
  it("версия в agentic-core должна совпасть с копией (Р20)", () => {
    expect(() => assertPaoVersion()).not.toThrow();
    expect(() => assertPaoVersion("1.3.0")).toThrow(/Р20/);
  });
});

describe("экспорт адаптера ПАО (ревью AG-02 № 19)", () => {
  it("наружу — только адаптер, версия копии и проверка версии; переводчики ПАО (map) не экспортируются", async () => {
    const exported = Object.keys(await import("../../src/agent/adapters/pao/index.js")).sort();
    expect(exported).toEqual(["PAO_COPY_VERSION", "PaoPlatform", "assertPaoVersion"]);
  });
});
