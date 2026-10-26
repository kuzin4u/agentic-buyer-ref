// Выдача реквизита в адаптере ПАО (Р45 п. 2.3–2.5, В2а): свой тайм-аут выше предела обработчика Платформы, повтор 503 —
// тем же ключом не раньше Retry-After и только если до конца срока registry_cache_ttl_sec остаётся ожидание и ещё одна
// попытка целиком; тайм-аут — UNKNOWN без повтора; 409 MANDATE_SCOPE и 422 CREDENTIALS_FORBIDDEN — без повтора.
import { describe, expect, it } from "vitest";
import { newEd25519Signer } from "@kuzin4u/agentic-core";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { Pace, PaoPlatform } from "../../src/agent/adapters/pao/index.js";
import { PAO_CREDENTIALS_HANDLER_MAX_MS, loadParams, parseParams, type StandParams } from "../../src/shared/config.js";
import { PlatformFailure, type CredentialDraft } from "../../src/shared/domain.js";
import type { RequestSigning } from "../../src/agent/ports/index.js";

const AGENT = "nspk:agent:buyref-01:v1";
const params = loadParams();
const draft: CredentialDraft = { mandate: { id: "m_cart", currency: "RUB" }, orderRef: "ORD-1", merchantId: "shop_1", amountMax: { amount: 250000, currency: "RUB" }, channel: "CARD" };
const { signer } = newEd25519Signer("kid_test");
const signing: RequestSigning = {
  current: () => signer,
  keyRevoked: () => {
    throw new Error("в этих тестах ключ не отзывается");
  },
  stop: () => {},
  suspend: () => {},
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const issued = (mandate_id: string, status = "ISSUED") =>
  json(201, { credential_ref: "cr_1", kind: "CARD", payload: { token_ref: "tok_ref_1", cryptogram: "cg_1" }, aoi: { indicator: true, agent_code: AGENT, mandate_id }, status });
const unavailable = (after: string) => json(503, { code: "STATE_UNAVAILABLE", message: "m", retry: "same_key" }, { "retry-after": after });

/** Платформа на подменённом транспорте: ответы по очереди; `step` — сколько мс монотонных часов проходит за обращение. */
function fake(replies: (() => Response | Promise<Response>)[], o: { p?: StandParams; step?: number } = {}) {
  const calls: { key: string | null; signal: AbortSignal | null | undefined }[] = [];
  const sleeps: number[] = [];
  let t = 0;
  const journal = new MemoryJournal();
  const platform = new PaoPlatform({
    journal,
    baseUrl: "http://pao.test",
    agentCode: AGENT,
    signing,
    params: o.p ?? params,
    sleep: async (ms) => void sleeps.push(ms),
    monotonic: () => t,
    // ограничитель частоты без интервала (Р59): в `sleeps` и сроке выдачи — только ожидание по Retry-After; сам
    // ограничитель и его ожидание в сроке выдачи — pao-pace.test.ts
    pace: new Pace({ fallbackPerMin: Infinity, journal }),
    fetch: async (_url, init) => {
      calls.push({ key: new Headers(init?.headers).get("idempotency-key"), signal: init?.signal });
      t += o.step ?? 0;
      const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
      return r();
    },
  });
  return { platform, calls, sleeps, journal };
}

describe("тайм-аут выдачи реквизита (Р45 п. 2.5)", () => {
  it("стендовое значение проходит схему: выше предела обработчика Платформы, не меньше общего тайм-аута, в пределах registry_cache_ttl_sec", () => {
    expect(params.pao_credentials_timeout_ms).toBeGreaterThan(PAO_CREDENTIALS_HANDLER_MAX_MS);
    expect(params.pao_credentials_timeout_ms).toBeGreaterThanOrEqual(params.pao_request_timeout_ms);
    expect(params.pao_credentials_timeout_ms).toBeLessThanOrEqual(params.registry_cache_ttl_sec * 1000);
  });

  it("собственный тайм-аут выдачи срабатывает: ответа нет дольше него — UNKNOWN, одно обращение (ревью reviewer К3 № 3)", async () => {
    // в обход схемы: тайм-аут выдачи 200 мс, ответ через 300 мс
    const p: StandParams = { ...params, pao_credentials_timeout_ms: 200 };
    let calls = 0;
    const platform = new PaoPlatform({
      journal: new MemoryJournal(),
      baseUrl: "http://pao.test",
      agentCode: AGENT,
      signing,
      params: p,
      sleep: async () => {},
      fetch: (_u, init) =>
        new Promise<Response>((resolve, reject) => {
          calls++;
          const t = setTimeout(() => resolve(issued("m_cart")), 300);
          init?.signal?.addEventListener("abort", () => (clearTimeout(t), reject(init.signal!.reason)), { once: true });
        }),
    });
    await expect(platform.issuePaymentPackage(draft, { idempotencyKey: "idem-own-timeout" })).rejects.toMatchObject({ code: "NO_RESPONSE", retry: "never" });
    expect(calls).toBe(1);
  });

  it.each([
    ["равно пределу обработчика", { pao_credentials_timeout_ms: PAO_CREDENTIALS_HANDLER_MAX_MS }, /предела обработчика/],
    ["меньше общего тайм-аута ПАО", { pao_credentials_timeout_ms: 31_000, pao_request_timeout_ms: 32_000, registry_cache_ttl_sec: 200 }, /меньше pao_request_timeout_ms/],
    ["больше registry_cache_ttl_sec", { pao_credentials_timeout_ms: 61_000 }, /больше registry_cache_ttl_sec/],
  ])("%s — отказ запуска", (_, over, msg) => {
    expect(() => parseParams({ ...params, ...over })).toThrow(msg);
  });

  it("выдача ждёт ответ дольше общего тайм-аута ПАО; другие методы — нет", async () => {
    // общий тайм-аут 100 мс, ответ через 300 мс: выдача (35 с) получает ответ, verify — тайм-аут (UNKNOWN)
    const p = parseParams({ ...params, pao_request_timeout_ms: 100 });
    const slow = (r: () => Response) => (init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(r()), 300);
        init?.signal?.addEventListener("abort", () => (clearTimeout(t), reject(init.signal!.reason)), { once: true });
      });
    let mode: "cred" | "verify" = "cred";
    const platform = new PaoPlatform({
      journal: new MemoryJournal(),
      baseUrl: "http://pao.test",
      agentCode: AGENT,
      signing,
      params: p,
      sleep: async () => {},
      fetch: (_u, init) => (mode === "cred" ? slow(() => issued("m_cart"))(init) : slow(() => json(200, {}))(init)),
    });
    await expect(platform.issuePaymentPackage(draft, { idempotencyKey: "idem-slow" })).resolves.toMatchObject({ credential: { status: "ISSUED" } });
    mode = "verify";
    await expect(platform.verifyMandate({ id: "m_cart", currency: "RUB" })).rejects.toMatchObject({ code: "NO_RESPONSE" });
  });
});

describe("повторы выдачи в пределах срока (Р45 п. 2.4, В2а)", () => {
  // параметры срока — явно, не из стендового файла (ревью reviewer К3 № 4): срок 60 с, попытка до 35 с, попыток до 3
  const P = parseParams({ ...params, registry_cache_ttl_sec: 60, pao_credentials_timeout_ms: 35_000, pao_max_attempts: 3 });
  const TTL = P.registry_cache_ttl_sec * 1000;
  const TIMEOUT = P.pao_credentials_timeout_ms;

  it("503 с коротким Retry-After — повтор тем же ключом после ожидания, реквизит выдан", async () => {
    const f = fake([() => unavailable("1"), () => issued("m_cart")], { p: P, step: 50 });
    const r = await f.platform.issuePaymentPackage(draft, { idempotencyKey: "idem-503" });
    expect(r.credential.status).toBe("ISSUED");
    expect(f.calls.map((c) => c.key)).toEqual(["idem-503", "idem-503"]);
    expect(f.sleeps).toEqual([1000]);
    expect(f.journal.entries.filter((e) => e.kind === "pao.call").map((e) => [e.attempt, e.result, e.reason])).toEqual([
      [1, "refused", "STATE_UNAVAILABLE"],
      [2, "ok", undefined],
    ]);
  });

  it("медленный 503: до конца срока не помещаются ожидание и ещё одна попытка — без повтора, STATE_UNAVAILABLE", async () => {
    // 30 с на попытку + 1 с ожидания + 35 с следующей попытки > 60 с
    const f = fake([() => unavailable("1"), () => issued("m_cart")], { p: P, step: 30_000 });
    await expect(f.platform.issuePaymentPackage(draft, { idempotencyKey: "idem-slow503" })).rejects.toMatchObject({ code: "STATE_UNAVAILABLE", retry: "same_key" });
    expect(f.calls).toHaveLength(1);
    expect(f.sleeps).toEqual([]);
  });

  it("второй повтор не помещается в срок — остановка на нём, а не после pao_max_attempts", async () => {
    // попытки по ≈ 11,5 с, ожидание 1 с: первая проверка — 47,5 с ≤ 60 — повтор; вторая — 60,002 с > 60 — нет. Без учёта
    // ожидания вторая дала бы 59,002 с и третью попытку; без срока — pao_max_attempts = 3 (ревью reviewer К3 № 2)
    const step = (TTL - TIMEOUT - 2 * 1000) / 2 + 1;
    const f = fake([() => unavailable("1")], { p: P, step });
    await expect(f.platform.issuePaymentPackage(draft, { idempotencyKey: "idem-budget" })).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    expect(f.calls).toHaveLength(2);
  });

  it("граница срока включительно: «потрачено + ожидание + попытка» ровно равно сроку — повтор есть, на 1 мс больше — нет", async () => {
    const exact = fake([() => unavailable("0"), () => issued("m_cart")], { p: P, step: TTL - TIMEOUT });
    await expect(exact.platform.issuePaymentPackage(draft, { idempotencyKey: "idem-edge" })).resolves.toBeDefined();
    expect(exact.calls).toHaveLength(2);
    const over = fake([() => unavailable("0"), () => issued("m_cart")], { p: P, step: TTL - TIMEOUT + 1 });
    await expect(over.platform.issuePaymentPackage(draft, { idempotencyKey: "idem-edge" })).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    expect(over.calls).toHaveLength(1);
  });

  it("повтор другим ключом (AGENT_KEY_REVOKED) — тоже в пределах срока (ревью reviewer К3 № 1)", async () => {
    const rotating: RequestSigning = { ...signing, keyRevoked: () => signer };
    const revoked = () => json(401, { code: "AGENT_KEY_REVOKED", message: "m", retry: "new_key" });
    const run = (step: number) => {
      const calls: number[] = [];
      let t = 0;
      const platform = new PaoPlatform({
        journal: new MemoryJournal(),
        baseUrl: "http://pao.test",
        agentCode: AGENT,
        signing: rotating,
        params: P,
        sleep: async () => {},
        monotonic: () => t,
        fetch: async () => {
          calls.push(1);
          t += step;
          return calls.length === 1 ? revoked() : issued("m_cart");
        },
      });
      return { platform, calls };
    };
    const quick = run(1_000);
    await expect(quick.platform.issuePaymentPackage(draft, { idempotencyKey: "idem-rot" })).resolves.toBeDefined();
    expect(quick.calls).toHaveLength(2);
    // попытка заняла больше «срок − тайм-аут»: новая попытка целиком в срок не помещается — отказ без повтора
    const slow = run(TTL - TIMEOUT + 1);
    await expect(slow.platform.issuePaymentPackage(draft, { idempotencyKey: "idem-rot" })).rejects.toMatchObject({ code: "AGENT_KEY_REVOKED" });
    expect(slow.calls).toHaveLength(1);
  });

  it("тайм-аут выдачи — NO_RESPONSE без повтора (исход выдачи неизвестен, fail-closed; Р45 п. 3, Р48 п. 4)", async () => {
    const f = fake([
      () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
      () => issued("m_cart"),
    ], { p: P });
    await expect(f.platform.issuePaymentPackage(draft, { idempotencyKey: "idem-timeout" })).rejects.toMatchObject({ code: "NO_RESPONSE", retry: "never" });
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    ["409 MANDATE_SCOPE (продавца нет в справочнике)", json(409, { code: "MANDATE_SCOPE", message: "m", retry: "after_human" }), "MANDATE_SCOPE", "after_human"],
    ["422 CREDENTIALS_FORBIDDEN", json(422, { code: "CREDENTIALS_FORBIDDEN", message: "m", retry: "never" }), "CREDENTIALS_FORBIDDEN", "never"],
  ])("%s — без повтора", async (_, res, code, retry) => {
    const f = fake([() => res.clone(), () => issued("m_cart")], { p: P });
    const err = await f.platform.issuePaymentPackage(draft, { idempotencyKey: "idem-no-retry" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformFailure);
    expect(err).toMatchObject({ code, retry });
    expect(f.calls).toHaveLength(1);
  });
});
