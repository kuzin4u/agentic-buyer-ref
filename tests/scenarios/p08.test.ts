// П08 (профиль contour): витрина отказывает неопознанным. Т4; A2 п. 5.1, A5 п. 2; Р42 п. 1, 4. На стенде Платформы и
// витринах эмулятора: каждое обращение адаптера подписано действующим ключом агента; витрина REJECTS_UNIDENTIFIED
// обслуживает опознанного агента. Отказ витрины — магазин недоступен, без обходов: ни запроса без подписи, ни другим ключом
// или кодом агента, ни повтора не повторяемого кода; агент не останавливается.
// Отказ — настоящий ответ эмулятора, код из MERCHANT_ERROR_CODES (ревью К1 Б2). С v0.23.0 `GET /v1/shops` опознаёт агента,
// как каталог (#64 п. 2): ключ не из реестра стенда отсекается уже на списке; отказ каталога при принятом списке — отзыв
// ключа после знака первой витрины и сдвиг часов стенда за срок кэша каталога ключей у витрин (`merchant_jwks_max_age_sec`,
// #64 п. 1). С Р53 перед каталогом — знак готовности по ПАО: отзыв ПАО видит сразу (401 AGENT_KEY_REVOKED на знаке
// следующей витрины) — общее правило обращений к ПАО (Р53 п. 5).
// Отказ списка витрин (503 / 429) — настоящий ответ эмулятора `failShopList` (#64 п. 3, Р54 п. 3).
// ЭМУЛЯЦИЯ СВЕРХ ЭМУЛЯТОРА (ответ подменён в fetch адаптера, остальные обращения — настоящие) — только то, чего эмулятор не
// выдаёт: код вне перечня (MERCHANT_CODE_UNKNOWN) у одной витрины.
import { afterEach, describe, expect, it } from "vitest";
import { newEd25519Signer, signRequest } from "@kuzin4u/agentic-core";
import { MERCHANT_ERROR_CODES, MERCHANT_FIXTURES } from "agentic-ps-platform/fixtures";
import { startFailureCode } from "../../src/agent/compose.js";
import { shopBy, type Contour } from "../support/contour.js";
import { STAND_TIMEOUT_MS, standPurchase } from "../support/stand-purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  expect(c?.violations() ?? []).toEqual([]);
  await c?.close();
  c = undefined;
});

const STRICT = shopBy("REJECTS_UNIDENTIFIED");
const catalogOf = (id: string) => `/v1/shops/${id}/catalog`;
const readinessOf = (merchant: string) => `/pao/v1/merchants/${merchant}/readiness`;
const CODES = MERCHANT_ERROR_CODES.map((x) => x.code as string);
/** ключ не из каталога ключей реестра — KEY_UNKNOWN эмулятора (STATUS «Передача для AG-04…»: отказы витрины по подписи) */
const KEY_UNKNOWN = MERCHANT_ERROR_CODES.find((x) => x.code === "KEY_UNKNOWN")!;

/** Что ушло в сеть от адаптера; `answer` — подменённый ответ витрины `id` (эмуляция сверх эмулятора). */
function recording(answer?: { path: string; status: number; body: unknown }) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    if (answer && url.endsWith(answer.path)) return new Response(JSON.stringify(answer.body), { status: answer.status });
    return fetch(input, init);
  };
  return { f, seen };
}

describe("П08 — витрина отказывает неопознанным", { timeout: STAND_TIMEOUT_MS }, () => {
  it("REJECTS_UNIDENTIFIED: подписанный запрос агента из реестра проходит; неподписанных обращений нет", async () => {
    const r = await standPurchase();
    c = r.c;
    await r.signedIntent();
    const zones = await r.purchase.search();
    expect(zones.contour.filter((o) => o.shopId === STRICT.id).map((o) => o.sku)).toEqual(STRICT.agent_items.map((i) => i.sku));
    const merchants = r.c.calls().filter((x) => x.target === "merchants");
    // список и каталог каждой витрины — по одному обращению, все подписаны ключом агента из реестра стенда
    expect(merchants.map((x) => `${x.route} ${x.status}`)).toEqual(["GET /v1/shops 200", ...MERCHANT_FIXTURES.map((f) => `GET ${catalogOf(f.id)} 200`)]);
    const kids = r.self.keys.map((k) => k.kid);
    expect(merchants.every((x) => x.kid !== undefined && kids.includes(x.kid) && typeof x.nonce === "string")).toBe(true);
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.unavailable")).toEqual([]);
  });

  it("ключ не из реестра — список витрин отказал по-настоящему (KEY_UNKNOWN, #64 п. 2): STOPPED сделки с SHOP_LIST_UNAVAILABLE; одно подписанное обращение, без повтора и обхода; к каталогам ни одного обращения; агент работает", async () => {
    const { f, seen } = recording();
    // ключ, которого нет в реестре стенда: эмулятор не опознаёт агента уже на списке витрин
    const { signer } = newEd25519Signer("kid-not-in-registry");
    const r = await standPurchase({ fetch: f, signing: { sign: (req) => signRequest(req, signer) } });
    c = r.c;
    await r.signedIntent();
    await expect(r.purchase.search()).rejects.toMatchObject({ name: "ShopFailure", code: "SHOP_LIST_UNAVAILABLE" });
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("SHOP_LIST_UNAVAILABLE");
    expect(r.c.admission()).toBeNull();
    // код отказа — из ответа эмулятора (журнал контура), из закрытого перечня витрин; не повторяемый — одно обращение
    const merchants = r.c.calls().filter((x) => x.target === "merchants");
    expect(merchants.map((x) => [x.route, x.status, x.code])).toEqual([["GET /v1/shops", KEY_UNKNOWN.http, KEY_UNKNOWN.code]]);
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual(["/v1/shops"]);
    expect(seen.every((s) => typeof s.headers["signature"] === "string" && s.headers["x-agent-code"] === r.c.agentCode)).toBe(true);
  });

  it("ключ отозван после знака первой витрины, часы стенда — за срок кэша ключей у витрин: каталог отказал по-настоящему (KEY_UNKNOWN), знак следующей — 401 AGENT_KEY_REVOKED от ПАО: смена ключа по общему правилу (Р53 п. 5), сделка остановлена; по одному подписанному обращению, без обхода", async () => {
    // без подмены ответов: после настоящего ответа ПАО на знак первой витрины ключи агента отзываются в реестре стенда,
    // часы стенда сдвигаются на merchant_jwks_max_age_sec — витрина перечитывает каталог ключей и не находит ключ (кэш 1 с
    // остаётся настоящим, #64 п. 1); ПАО отзыв видит сразу — знак следующей витрины не проверяется
    const [first, second] = MERCHANT_FIXTURES;
    const hook: { afterMark?: () => void } = {};
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const f: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } });
      const res = await fetch(input, init);
      if (new URL(String(input)).pathname === readinessOf(first!.merchant_id)) hook.afterMark?.();
      return res;
    };
    const r = await standPurchase({ fetch: f, failureCode: startFailureCode });
    c = r.c;
    hook.afterMark = () => {
      hook.afterMark = undefined;
      for (const k of r.self.keys) r.stand.keys.revoke(r.c.agentCode, k.kid);
      r.stand.setClock(new Date(r.stand.now().getTime() + r.stand.params.merchant_jwks_max_age_sec * 1000));
    };
    await r.signedIntent();
    const err = await r.purchase.search().catch((e: unknown) => e);
    // ПАО: ключ отозван, другого действующего нет — ring.keyRevoked останавливает подпись (как у адаптера ПАО); сделка
    // остановлена, агент — тоже (ключей нет): обходов нет
    expect(err).toMatchObject({ name: "SignerStopped" });
    expect(r.purchase.state).toBe("STOPPED");
    // код остановки — как у места сборки (startFailureCode): отзыв последнего ключа — NO_ACTIVE_KEY, не код ПАО
    expect(r.purchase.reason).toBe("NO_ACTIVE_KEY");
    expect(r.c.admission()).toBe("NO_ACTIVE_KEY");
    const agent = r.c.agentCalls().slice(r.c.agentCalls().findIndex((x) => x.route === "GET /v1/shops"));
    expect(agent.map((x) => [x.target, x.route, x.status, x.code])).toEqual([
      ["merchants", "GET /v1/shops", 200, undefined],
      ["pao", `GET ${readinessOf(first!.merchant_id)}`, 200, undefined],
      ["merchants", `GET ${catalogOf(first!.id)}`, KEY_UNKNOWN.http, KEY_UNKNOWN.code],
      ["pao", `GET ${readinessOf(second!.merchant_id)}`, 401, "AGENT_KEY_REVOKED"],
    ]);
    // по одному подписанному обращению: ни повтора, ни запроса без подписи, ни другого кода агента
    expect(seen.map((x) => new URL(x.url).pathname).filter((p) => p !== "/v1/shops")).toEqual([readinessOf(first!.merchant_id), catalogOf(first!.id), readinessOf(second!.merchant_id)]);
    expect(seen.every((x) => typeof x.headers["signature"] === "string" && x.headers["x-agent-code"] === r.c.agentCode)).toBe(true);
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.call" && e.ref === first!.id).map((e) => [e.result, e.detail])).toEqual([["refused", KEY_UNKNOWN.code]]);
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.readiness").map((e) => [e.merchant, e.result, e.detail])).toEqual([
      // знак у ПАО подаёт эквайрер стенда по readiness_mark фикстуры (#67): ACTIVE или NONE
      [first!.merchant_id, "ok", first!.readiness_mark ? "ACTIVE" : "NONE"],
      [second!.merchant_id, "refused", "AGENT_KEY_REVOKED"],
    ]);
  });

  it("код вне перечня (эмуляция сверх эмулятора) — магазин недоступен (MERCHANT_CODE_UNKNOWN), сам код не в журнале; агент работает", async () => {
    const unknown = "PLEASE_RETRY_WITHOUT_SIGNATURE";
    expect(CODES).not.toContain(unknown);
    const { f } = recording({ path: catalogOf(STRICT.id), status: 403, body: { code: unknown } });
    const r = await standPurchase({ fetch: f });
    c = r.c;
    await r.signedIntent();
    const zones = await r.purchase.search();
    expect(r.purchase.state).toBe("OFFERS");
    expect(r.c.admission()).toBeNull();
    expect(zones.unavailable).toEqual([{ shopId: STRICT.id, merchantId: STRICT.merchant_id, cause: { reason: "MERCHANT_CODE_UNKNOWN" } }]);
    expect(zones.contour.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.c.journal.entries)).not.toContain(unknown);
  });

  // отказ списка — настоящий ответ эмулятора `failShopList` (#64 п. 3, Р54 п. 3): держится до снятия, повтор видит его же
  it.each([
    ["503 UPSTREAM_UNAVAILABLE, Retry-After 1 с — один повтор", "UPSTREAM_UNAVAILABLE", 503, 1, 2],
    ["429 RATE_LIMITED, Retry-After 1 с — один повтор", "RATE_LIMITED", 429, 1, 2],
    ["429 RATE_LIMITED, Retry-After больше shop_retry_after_max_sec — без повтора", "RATE_LIMITED", 429, null, 1],
  ] as const)("списка витрин нет целиком (%s): отказ стадии 2, STOPPED сделки с SHOP_LIST_UNAVAILABLE (Р46 п. 2); ни знака, ни каталогов (ревью К1 № 11); агент работает", async (_, code, http, after, attempts) => {
    const r = await standPurchase();
    c = r.c;
    const retryAfterSec = after ?? r.c.params.shop_retry_after_max_sec + 1;
    r.c.merchants!.emulator.failShopList({ code, retryAfterSec });
    await r.signedIntent();
    await expect(r.purchase.search()).rejects.toMatchObject({ name: "ShopFailure", code: "SHOP_LIST_UNAVAILABLE" });
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("SHOP_LIST_UNAVAILABLE");
    expect(r.c.admission()).toBeNull();
    // повтор списка — только по повторяемому коду и Retry-After не больше предела, один раз (Р42 п. 4)
    const agent = r.c.agentCalls().slice(r.c.agentCalls().findIndex((x) => x.route === "GET /v1/shops"));
    expect(agent.map((x) => [x.route, x.status, x.code])).toEqual(Array.from({ length: attempts }, () => ["GET /v1/shops", http, code]));
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.call").map((e) => [e.method, e.attempt, e.result, e.detail])).toEqual(
      Array.from({ length: attempts }, (_, i) => ["GET /v1/shops", i + 1, "refused", code]),
    );
    // снятие отказа — список снова отдаётся тому же агенту
    r.c.merchants!.emulator.failShopList(null);
    expect((await r.c.merchants!.request("GET", "/v1/shops")).status).toBe(200);
  });
});
