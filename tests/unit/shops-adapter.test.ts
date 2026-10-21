// Адаптер витрин (Р42) на подменённом fetch: подпись до сети, схема ответа, зона, повтор только 429 и 503 на GET (один
// раз, новой подписью, Retry-After не больше предела), заказ без повтора, неизвестный код витрины, живая проверка.
import { describe, expect, it } from "vitest";
import { ShopsAdapter, type ShopProfile, type ShopsAdapterOptions } from "../../src/agent/adapters/shops/index.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { ShopFailure } from "../../src/agent/ports/index.js";
import { SignerStopped } from "../../src/agent/signer/index.js";
import { loadParams } from "../../src/shared/config.js";

const params = loadParams();
const BASE = "http://shops.test";
const profile: ShopProfile = {
  shop: { inn: "7705123452", mcc: "5462", paymentMethods: ["card"], deliveryRegions: ["77"], returns: { days: 0, text: "Продовольственные товары надлежащего качества возврату не подлежат" } },
  item: () => ({ delivery: [{ method: "PICKUP", minDays: 0, maxDays: 0, cost: { amount: 0, currency: "RUB" } }], updatedAt: "2026-10-21T09:00:00+03:00" }),
};
const ITEM = { sku: "BRD-1", title: "Хлеб", description: "Хлеб на закваске.", price: 39000, currency: "RUB", in_stock: true, category: "хлеб" };
const shop = (id: string, over: Record<string, unknown> = {}) => ({ id, merchant_id: `MER-${id}`, zone: "CONTOUR", readiness_mark: true, ...over });

type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | "hang" | "fail";
interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  redirect: string | undefined;
  body: string | undefined;
}

/** Витрина-заглушка: ответы по пути очередью (последний повторяется); `seen` — что ушло в сеть. */
function vitrine(routes: Record<string, Answer[]>) {
  const seen: Seen[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    seen.push({ method: init?.method ?? "GET", path: url.pathname, headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect, body: typeof init?.body === "string" ? init.body : undefined });
    const q = routes[`${init?.method ?? "GET"} ${url.pathname}`] ?? [{ status: 404, body: { code: "SHOP_NOT_FOUND" } }];
    const a = q.length > 1 ? q.shift()! : q[0]!;
    if (a === "fail") throw new TypeError("fetch failed");
    if (a === "hang")
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    return new Response(a.body === undefined ? "" : JSON.stringify(a.body), { status: a.status, headers: a.headers ?? {} });
  };
  return { f, seen };
}

function adapter(routes: Record<string, Answer[]>, over: Partial<ShopsAdapterOptions> = {}) {
  const v = vitrine(routes);
  const journal = new MemoryJournal();
  const sleeps: number[] = [];
  const a = new ShopsAdapter({
    baseUrl: BASE,
    agentCode: "nspk:agent:test:v1",
    signing: { sign: (req) => ({ ...req, headers: { ...req.headers, signature: `sig-${req.headers["x-nonce"]}`, "signature-input": "sig=()" } }) },
    params,
    profile: () => profile,
    journal,
    fetch: v.f,
    sleep: async (ms) => void sleeps.push(ms),
    ...over,
  });
  return { a, seen: v.seen, journal, sleeps };
}

const LIST = (...shops: unknown[]): Record<string, Answer[]> => ({ "GET /v1/shops": [{ status: 200, body: { shops } }] });
const catalog = (id: string, ...a: Answer[]) => ({ [`GET /v1/shops/${id}/catalog`]: a });
const ok = (...items: unknown[]): Answer => ({ status: 200, body: { shop: {}, items } });
const calls = (j: MemoryJournal) => j.entries.filter((e) => e.kind === "shop.call").map((e) => [e.method, e.attempt, e.result, e.detail ?? e.reason]);

describe("адаптер витрин (Р42)", () => {
  it("каждое обращение подписано до сети; подпись остановлена — исключение, обращений нет", async () => {
    const { a, seen } = adapter({ ...LIST(shop("S1")), ...catalog("S1", ok(ITEM)) });
    await a.search();
    expect(seen.map((s) => [s.method, s.path, typeof s.headers.signature, s.headers["x-agent-code"], s.redirect])).toEqual([
      ["GET", "/v1/shops", "string", "nspk:agent:test:v1", "manual"],
      ["GET", "/v1/shops/S1/catalog", "string", "nspk:agent:test:v1", "manual"],
    ]);
    const stopped = adapter(LIST(shop("S1")), { signing: { sign: () => { throw new SignerStopped("NO_ACTIVE_KEY"); } } });
    await expect(stopped.a.search()).rejects.toBeInstanceOf(SignerStopped);
    expect(stopped.seen).toEqual([]);
    await expect(stopped.a.order({ shopId: "S1", items: [{ sku: "BRD-1", qty: 1 }], cartMandateId: "mnd_1" })).rejects.toBeInstanceOf(SignerStopped);
    expect(stopped.seen).toEqual([]);
  });

  it("зона контура — только CONTOUR и знак готовности; иначе рынок со ссылкой витрины", async () => {
    const { a } = adapter({
      ...LIST(shop("S1"), shop("S2", { readiness_mark: false }), shop("S3", { zone: "OUTSIDE" }), shop("S4", { zone: "contour" })),
      ...catalog("S1", ok(ITEM)),
      ...catalog("S2", ok({ ...ITEM, sku: "B2" })),
      ...catalog("S3", ok({ ...ITEM, sku: "B3" })),
      ...catalog("S4", ok({ ...ITEM, sku: "B4" })),
    });
    const out = await a.search();
    expect(out.map((s) => ("unavailable" in s ? null : [s.merchantId, s.inContour, s.link]))).toEqual([
      ["MER-S1", true, undefined],
      ["MER-S2", false, `${BASE}/v1/shops/S2/catalog`],
      ["MER-S3", false, `${BASE}/v1/shops/S3/catalog`],
      ["MER-S4", false, `${BASE}/v1/shops/S4/catalog`],
    ]);
  });

  it("карточка не по схеме не переведена: нет поля — REQUIRED, чужая валюта — BAD_CURRENCY, иначе BAD_TYPE; профиля нет — магазин исключён", async () => {
    const { a } = adapter({
      ...LIST(shop("S1"), shop("S2")),
      ...catalog("S1", ok(ITEM, { sku: "B2", title: "Хлеб дня" }, { ...ITEM, sku: "B3", currency: "USD" }, { ...ITEM, sku: "B4", price: "390" })),
      ...catalog("S2", ok(ITEM)),
    });
    const [s1] = await a.search();
    expect("unavailable" in s1! ? null : [s1!.facts.products.map((p) => p.product.sku), s1!.facts.dropped]).toEqual([["BRD-1"], ["REQUIRED", "BAD_CURRENCY", "BAD_TYPE"]]);
    const none = adapter({ ...LIST(shop("S1")), ...catalog("S1", ok(ITEM)) }, { profile: () => null });
    const [n] = await none.a.search();
    expect("unavailable" in n! ? null : n!.facts).toEqual({ shop: null, shopIssues: ["REQUIRED"], products: [], dropped: [] });
  });

  it("503 без Retry-After — один повтор через shop_retry_default_ms, новой подписью; второй отказ — магазин недоступен", async () => {
    const busy: Answer = { status: 503, body: { code: "UPSTREAM_UNAVAILABLE" } };
    const { a, seen, journal, sleeps } = adapter({ ...LIST(shop("S1")), ...catalog("S1", busy, ok(ITEM)) });
    const [s] = await a.search();
    expect("unavailable" in s!).toBe(false);
    expect(sleeps).toEqual([params.shop_retry_default_ms]);
    const tries = seen.filter((x) => x.path === "/v1/shops/S1/catalog");
    expect(tries).toHaveLength(2);
    expect(tries[0]!.headers["x-nonce"]).not.toBe(tries[1]!.headers["x-nonce"]);
    expect(calls(journal).slice(1)).toEqual([
      ["GET /v1/shops/{id}/catalog", 1, "refused", "UPSTREAM_UNAVAILABLE"],
      ["GET /v1/shops/{id}/catalog", 2, "ok", undefined],
    ]);
    const twice = adapter({ ...LIST(shop("S1")), ...catalog("S1", busy, busy, ok(ITEM)) });
    const [t] = await twice.a.search();
    expect(t).toEqual({ shopId: "S1", merchantId: "MER-S1", unavailable: { detail: "UPSTREAM_UNAVAILABLE" } });
    expect(twice.seen.filter((x) => x.path === "/v1/shops/S1/catalog")).toHaveLength(2);
  });

  it("429: Retry-After не больше предела — ждать его; больше предела или не секунды — без повтора", async () => {
    const limited = (after: string): Answer => ({ status: 429, body: { code: "RATE_LIMITED" }, headers: { "retry-after": after } });
    const max = params.shop_retry_after_max_sec;
    const within = adapter({ ...LIST(shop("S1")), ...catalog("S1", limited(String(max)), ok(ITEM)) });
    await within.a.search();
    expect(within.sleeps).toEqual([max * 1000]);
    for (const after of [String(max + 1), "Wed, 21 Oct 2026 07:28:00 GMT", "-1"]) {
      const over = adapter({ ...LIST(shop("S1")), ...catalog("S1", limited(after), ok(ITEM)) });
      const [s] = await over.a.search();
      expect(s).toEqual({ shopId: "S1", merchantId: "MER-S1", unavailable: { detail: "RATE_LIMITED" } });
      expect(over.sleeps).toEqual([]);
    }
  });

  it("не повторяемые отказы — без повтора; код вне перечня — MERCHANT_CODE_UNKNOWN, сам код не в журнале", async () => {
    for (const [answer, cause] of [
      [{ status: 401, body: { code: "KEY_UNKNOWN" } }, { detail: "KEY_UNKNOWN" }],
      [{ status: 403, body: { code: "AGENT_UNIDENTIFIED" } }, { detail: "AGENT_UNIDENTIFIED" }],
      [{ status: 503, body: { code: "TRY_UNSIGNED" } }, { reason: "MERCHANT_CODE_UNKNOWN" }],
      [{ status: 503, body: { code: "KEY_UNKNOWN" } }, { detail: "KEY_UNKNOWN" }],
      [{ status: 302, headers: { location: "http://elsewhere.test/" } }, { detail: "BAD_RESPONSE" }],
      [{ status: 200, body: { items: "нет" } }, { detail: "BAD_RESPONSE" }],
      ["fail", { detail: "NO_RESPONSE" }],
    ] as [Answer, unknown][]) {
      const { a, seen, journal, sleeps } = adapter({ ...LIST(shop("S1")), ...catalog("S1", answer, ok(ITEM)) });
      const [s] = await a.search();
      expect(s).toEqual({ shopId: "S1", merchantId: "MER-S1", unavailable: cause });
      expect(seen.filter((x) => x.path === "/v1/shops/S1/catalog")).toHaveLength(1);
      expect(sleeps).toEqual([]);
      expect(JSON.stringify(journal.entries)).not.toContain("TRY_UNSIGNED");
    }
  });

  it("нет ответа в shop_request_timeout_ms — NO_RESPONSE, без повтора", async () => {
    const { a } = adapter({ ...LIST(shop("S1")), ...catalog("S1", "hang") }, { params: { ...params, shop_request_timeout_ms: 20 } });
    const [s] = await a.search();
    expect(s).toEqual({ shopId: "S1", merchantId: "MER-S1", unavailable: { detail: "NO_RESPONSE" } });
  });

  it("списка витрин нет целиком — исключение (отказ стадии); запись списка не по схеме — только эта витрина (ревью КТ1 п. 1)", async () => {
    await expect(adapter({ "GET /v1/shops": [{ status: 503, body: { code: "UPSTREAM_UNAVAILABLE" } }] }).a.search()).rejects.toThrow();
    await expect(adapter({ "GET /v1/shops": [{ status: 200, body: { shops: "нет" } }] }).a.search()).rejects.toThrow();
    const { a, seen } = adapter({ ...LIST({ id: "../x", merchant_id: "MER-X" }, shop("S1")), ...catalog("S1", ok(ITEM)) });
    const out = await a.search();
    expect(out[0]).toEqual({ unavailable: { detail: "BAD_RESPONSE" } });
    expect(out[1]).toMatchObject({ merchantId: "MER-S1", inContour: true });
    expect(seen.map((s) => s.path)).toEqual(["/v1/shops", "/v1/shops/S1/catalog"]);
  });

  it("у одной витрины нет readiness_mark или он не true — она в зоне рынка, вторая в выдаче как была (ревью КТ1 п. 1)", async () => {
    const { a } = adapter({
      ...LIST({ id: "S1", merchant_id: "MER-S1", zone: "CONTOUR" }, shop("S2"), shop("S3", { readiness_mark: "true" })),
      ...catalog("S1", ok({ ...ITEM, sku: "B1" })),
      ...catalog("S2", ok({ ...ITEM, sku: "B2" })),
      ...catalog("S3", ok({ ...ITEM, sku: "B3" })),
    });
    const out = await a.search();
    expect(out.map((s) => ("unavailable" in s ? null : [s.merchantId, s.inContour]))).toEqual([
      ["MER-S1", false],
      ["MER-S2", true],
      ["MER-S3", false],
    ]);
  });

  it("заказ не повторяется: отказ — SHOP_ORDER_REFUSED; нет ответа или не по схеме — SHOP_ORDER_STATE_UNKNOWN", async () => {
    const req = { shopId: "S1", items: [{ sku: "BRD-1", qty: 1 }], cartMandateId: "mnd_1" };
    for (const [answer, code] of [
      [{ status: 503, body: { code: "UPSTREAM_UNAVAILABLE" } }, "SHOP_ORDER_REFUSED"],
      [{ status: 429, body: { code: "RATE_LIMITED" }, headers: { "retry-after": "1" } }, "SHOP_ORDER_REFUSED"],
      [{ status: 422, body: { code: "ITEM_INCOMPLETE" } }, "SHOP_ORDER_REFUSED"],
      [{ status: 201, body: { id: "ord_1" } }, "SHOP_ORDER_STATE_UNKNOWN"],
      [{ status: 200, body: { id: "ord_1", total: 39000, currency: "RUB" } }, "SHOP_ORDER_STATE_UNKNOWN"],
      ["fail", "SHOP_ORDER_STATE_UNKNOWN"],
    ] as [Answer, string][]) {
      const { a, seen, sleeps } = adapter({ "POST /v1/shops/S1/orders": [answer, { status: 201, body: { id: "ord_2", total: 39000, currency: "RUB" } }] });
      const err = await a.order(req).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ShopFailure);
      expect((err as ShopFailure).code).toBe(code);
      expect(seen).toHaveLength(1);
      expect(sleeps).toEqual([]);
    }
    const { a, seen, journal } = adapter({ "POST /v1/shops/S1/orders": [{ status: 201, body: { id: "ord_1", total: 39000, currency: "RUB" } }] });
    expect(await a.order(req)).toEqual({ orderId: "ord_1", total: { amount: 39000, currency: "RUB" } });
    expect(seen).toHaveLength(1);
    // тело заказа — позиции и мандат корзины (`cart_mandate_id`, не `mandate_id`); суммы в теле нет (ревью К1 № 8)
    expect(JSON.parse(seen[0]!.body!)).toEqual({ items: [{ sku: "BRD-1", qty: 1 }], cart_mandate_id: "mnd_1" });
    expect(seen[0]!.headers["content-type"]).toBe("application/json");
    // запись обращения — с витриной и мандатом корзины (ревью К1 № 4)
    expect(journal.entries.filter((e) => e.kind === "shop.call").map((e) => [e.method, e.ref, e.mandate, e.result])).toEqual([["POST /v1/shops/{id}/orders", "S1", "mnd_1", "ok"]]);
  });

  it("живая проверка: sku у двух витрин — отказ без обращения; иначе цена и наличие из каталога витрины", async () => {
    const { a, seen } = adapter({ ...LIST(shop("S1"), shop("S2")), ...catalog("S1", ok(ITEM, { ...ITEM, sku: "B2" })), ...catalog("S2", ok(ITEM)) });
    await a.search();
    const before = seen.length;
    await expect(a.fetch({ sku: "BRD-1", quantity: 1 }, new AbortController().signal)).rejects.toThrow();
    expect(seen.length).toBe(before);
    const offer = await a.fetch({ sku: "B2", quantity: 1 }, new AbortController().signal);
    expect(offer).toMatchObject({ sku: "B2", price: { amount: 39000, currency: "RUB" }, availability: { inStock: true } });
    expect(seen.slice(before).map((s) => s.path)).toEqual(["/v1/shops/S1/catalog"]);
  });

  it("два поиска (две покупки на одном адаптере): sku переехал к другой витрине — живая проверка отказывает, не в чужой магазин (ревью К1 Б1)", async () => {
    const { a, seen } = adapter({
      "GET /v1/shops": [{ status: 200, body: { shops: [shop("S1")] } }, { status: 200, body: { shops: [shop("S2")] } }],
      ...catalog("S1", ok(ITEM)),
      ...catalog("S2", ok(ITEM)),
    });
    await a.search();
    await a.search();
    const before = seen.length;
    await expect(a.fetch({ sku: "BRD-1", quantity: 1 }, new AbortController().signal)).rejects.toThrow();
    expect(seen.length).toBe(before);
  });
});
