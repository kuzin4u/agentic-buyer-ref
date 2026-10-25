// Адаптер витрин (Р42) на подменённом fetch: подпись до сети, схема ответа, зона, повтор только 429 и 503 на GET (один
// раз, новой подписью, Retry-After не больше предела), заказ без повтора, неизвестный код витрины, живая проверка.
// Знак готовности по ПАО (Р53) — ответы ПАО подменены здесь же (`platform`): пути нет в YAML 1.4.0, у PaoStub его нет;
// отказы — по перечню пути в адаптере. Против стенда: ACTIVE и NONE — П07, purchase-stand; 401 AGENT_KEY_REVOKED — П08;
// SUSPENDED, 403, 400, 503 стенда — К2.3.
import { describe, expect, it, vi } from "vitest";
import { ShopsAdapter, type ShopsAdapterOptions } from "../../src/agent/adapters/shops/index.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { ShopFailure } from "../../src/agent/ports/index.js";
import { orderRefIssue, sealPackage } from "../../src/agent/payment-package/index.js";
import { luhnTail } from "../support/luhn.js";
import type { RequestSigning } from "../../src/agent/ports/request-signing.js";
import { SignerStopped } from "../../src/agent/signer/index.js";
import { newEd25519Signer } from "@kuzin4u/agentic-core";
import { loadParams } from "../../src/shared/config.js";
import { PlatformFailure } from "../../src/shared/domain.js";

const params = loadParams();
const BASE = "http://shops.test";
/** Факты магазина в записи списка — как у витрин эмулятора (#45, Р54 п. 4): ИНН вымышленный, с верной контрольной цифрой. */
const FACTS = {
  inn: "7705123452",
  mcc: "5462",
  payment_methods: ["card", "sbp"],
  delivery_regions: ["RU-MOW", "RU-MOS"],
  returns: { days: 0, text: "Продовольственные товары надлежащего качества возврату не подлежат" },
};
/** Время обновления карточки — от часов теста (не литерал: ядро сравнивает его с часами). */
const UPDATED = new Date(Date.now() - 2 * 3600_000).toISOString();
const ITEM = {
  sku: "BRD-1",
  title: "Хлеб",
  description: "Хлеб на закваске.",
  price: 39000,
  currency: "RUB",
  in_stock: true,
  category: "хлеб",
  delivery_options: [{ method: "PICKUP", min_days: 0, max_days: 0, cost: 0, currency: "RUB" }],
  updated_at: UPDATED,
  gtin: null,
  brand: null,
  model: null,
  attributes: { вес: "500 г" },
};
const shop = (id: string, over: Record<string, unknown> = {}) => ({ id, merchant_id: `MER-${id}`, zone: "CONTOUR", readiness_mark: true, ...FACTS, ...over });

/** Запись без полей `keys` — витрина их не отдала. */
const without = (o: object, ...keys: string[]): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/** GTIN-13 с верной контрольной цифрой GTIN и верной суммой Луна — собирается во время прогона (литералов, похожих на
 *  номер карты, в репозитории нет; префикс 9…, такие номера карт не выпускаются). */
function gtinLuhn13(): string {
  for (let n = 0; ; n++) {
    const base = `9${String(n).padStart(11, "0")}`;
    const sum = [...base].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
    const code = base + String((10 - (sum % 10)) % 10);
    if (luhnTail(base) === code) return code;
  }
}

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

const PAO = "http://pao.test";
const { signer } = newEd25519Signer("kid_test");
const READY = (id: string, status = "ACTIVE"): Answer => ({ status: 200, body: { merchant_id: id, status, since: "2026-10-24T09:00:00Z" } });

/** ПАО-заглушка знака готовности (Р53): ответы по merchant_id очередью (последний повторяется), по умолчанию — ACTIVE;
 *  `seen` — что ушло в сеть; порт подписи запоминает остановку и смену ключа (Р53 п. 5). */
function platform(marks: Record<string, Answer[]>) {
  const seen: Seen[] = [];
  const stops: string[] = [];
  const rotations: string[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    seen.push({ method: init?.method ?? "GET", path: url.pathname, headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect, body: typeof init?.body === "string" ? init.body : undefined });
    const id = /^\/pao\/v1\/merchants\/([^/]+)\/readiness$/.exec(url.pathname)?.[1] ?? "";
    const q = marks[id] ?? [READY(id)];
    const a = q.length > 1 ? q.shift()! : q[0]!;
    if (a === "fail") throw new TypeError("fetch failed");
    if (a === "hang")
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    return new Response(a.body === undefined ? "" : JSON.stringify(a.body), { status: a.status, headers: a.headers ?? {} });
  };
  const signing: RequestSigning = {
    current: () => signer,
    keyRevoked: (kid) => (rotations.push(kid), signer),
    stop: (r) => void stops.push(r),
    suspend: () => {},
  };
  return { platform: { baseUrl: PAO, signing, fetch: f }, seen, stops, rotations };
}

function adapter(routes: Record<string, Answer[]>, over: Partial<ShopsAdapterOptions> = {}, marks: Record<string, Answer[]> = {}) {
  const v = vitrine(routes);
  const p = platform(marks);
  const journal = new MemoryJournal();
  const sleeps: number[] = [];
  const a = new ShopsAdapter({
    baseUrl: BASE,
    agentCode: "nspk:agent:test:v1",
    signing: { sign: (req) => ({ ...req, headers: { ...req.headers, signature: `sig-${req.headers["x-nonce"]}`, "signature-input": "sig=()" } }) },
    platform: p.platform,
    params,
    journal,
    fetch: v.f,
    sleep: async (ms) => void sleeps.push(ms),
    ...over,
  });
  return { a, seen: v.seen, journal, sleeps, pao: p };
}

const LIST = (...shops: unknown[]): Record<string, Answer[]> => ({ "GET /v1/shops": [{ status: 200, body: { shops } }] });
const catalog = (id: string, ...a: Answer[]) => ({ [`GET /v1/shops/${id}/catalog`]: a });
/** Ответ каталога; `responded_at` — от часов теста в момент сборки ответа (Р54 п. 6). */
const ok = (...items: unknown[]): Answer => ({ status: 200, body: { shop: {}, items, responded_at: new Date().toISOString() } });
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

  it("зона контура — только при ACTIVE по ПАО; SUSPENDED и NONE — рынок со ссылкой витрины, зона и знак витрины — сведения (Р53 п. 3)", async () => {
    const { a, journal } = adapter(
      {
        ...LIST(shop("S1"), shop("S2"), shop("S3"), shop("S4", { readiness_mark: false }), shop("S5", { zone: "OUTSIDE" })),
        ...catalog("S1", ok(ITEM)),
        ...catalog("S2", ok({ ...ITEM, sku: "B2" })),
        ...catalog("S3", ok({ ...ITEM, sku: "B3" })),
        ...catalog("S4", ok({ ...ITEM, sku: "B4" })),
        ...catalog("S5", ok({ ...ITEM, sku: "B5" })),
      },
      {},
      { "MER-S2": [READY("MER-S2", "SUSPENDED")], "MER-S3": [READY("MER-S3", "NONE")] },
    );
    const out = await a.search();
    expect(out.map((s) => ("unavailable" in s ? null : [s.merchantId, s.inContour, s.link]))).toEqual([
      ["MER-S1", true, undefined],
      ["MER-S2", false, `${BASE}/v1/shops/S2/catalog`],
      ["MER-S3", false, `${BASE}/v1/shops/S3/catalog`],
      ["MER-S4", true, undefined],
      ["MER-S5", true, undefined],
    ]);
    expect(journal.entries.filter((e) => e.kind === "shop.readiness_mismatch").map((e) => [e.merchant, e.detail])).toEqual([
      ["MER-S2", "SUSPENDED:CONTOUR"],
      ["MER-S3", "NONE:CONTOUR"],
      ["MER-S4", "ACTIVE:MARKET"],
      ["MER-S5", "ACTIVE:MARKET"],
    ]);
  });

  it("карточка не по схеме не переведена: нет поля — REQUIRED, чужая валюта — BAD_CURRENCY, иначе BAD_TYPE (Р42 п. 6; доставка и время обновления — Р54 п. 4)", async () => {
    const noDelivery = without(ITEM, "delivery_options");
    const noUpdated = without(ITEM, "updated_at");
    const { a } = adapter({
      ...LIST(shop("S1"), shop("S2")),
      ...catalog(
        "S1",
        ok(
          ITEM,
          { sku: "B2", title: "Хлеб дня" },
          { ...ITEM, sku: "B3", currency: "USD" },
          { ...ITEM, sku: "B4", price: "390" },
          { ...noDelivery, sku: "B5" },
          { ...noUpdated, sku: "B6" },
          { ...ITEM, sku: "B8", attributes: { вес: 500 } },
          // вложенные поля — код по полному пути (ревью КТ1 reviewer № 1)
          { ...ITEM, sku: "B9", delivery_options: [without(ITEM.delivery_options[0]!, "min_days")] },
          { ...ITEM, sku: "B10", delivery_options: [{ ...ITEM.delivery_options[0]!, currency: "USD" }] },
          { ...ITEM, sku: "B11", delivery_options: [without(ITEM.delivery_options[0]!, "currency")] },
          { ...ITEM, sku: "B12", delivery_options: [{ ...ITEM.delivery_options[0]!, max_days: "2" }] },
          { ...ITEM, sku: "B13", price: null },
        ),
      ),
      ...catalog("S2", ok(ITEM)),
    });
    const [s1] = await a.search();
    expect("unavailable" in s1! ? null : [s1!.facts.products.map((p) => p.product.sku), s1!.facts.dropped]).toEqual([
      ["BRD-1"],
      ["REQUIRED", "BAD_CURRENCY", "BAD_TYPE", "REQUIRED", "REQUIRED", "BAD_TYPE", "REQUIRED", "BAD_CURRENCY", "REQUIRED", "BAD_TYPE", "REQUIRED"],
    ]);
  });

  it("способ доставки вне перечня — перечень у ядра: карточка переведена, ядро даёт BAD_METHOD, как у фида (ревью КТ1 reviewer № 1)", async () => {
    const { a } = adapter({ ...LIST(shop("S1")), ...catalog("S1", ok({ ...ITEM, delivery_options: [{ ...ITEM.delivery_options[0]!, method: "COURIER" }] })) });
    const [s] = await a.search();
    if (s === undefined || "unavailable" in s) throw new Error("витрина недоступна");
    expect(s.facts.dropped).toEqual([]);
    expect(s.facts.products.map((p) => [p.product.sku, p.issues])).toEqual([["BRD-1", ["BAD_METHOD"]]]);
  });

  it("факты витрины → модель К8 (Р54 п. 4): магазин — из записи списка, товар — доставка, время обновления, GTIN, бренд, модель, атрибуты; модель ядра без замечаний", async () => {
    const full = { ...ITEM, sku: "BRD-2", delivery_options: [...ITEM.delivery_options, { method: "DELIVERY", region: "RU-MOW", min_days: 1, max_days: 2, cost: 25000, currency: "RUB" }], brand: "Пекарня", model: "Бородинский" };
    const bare = without(ITEM, "gtin", "brand", "model", "attributes");
    const { a } = adapter({ ...LIST(shop("S1")), ...catalog("S1", ok(full, { ...bare, sku: "BRD-3" })) });
    const [s] = await a.search();
    if (s === undefined || "unavailable" in s) throw new Error("витрина недоступна");
    expect(s.facts.shop).toEqual({ id: "S1", inn: FACTS.inn, mcc: FACTS.mcc, paymentMethods: ["card", "sbp"], deliveryRegions: ["RU-MOW", "RU-MOS"], returns: FACTS.returns });
    expect(s.facts.shopIssues).toEqual([]);
    expect(s.facts.products.map((p) => [p.product.sku, p.issues])).toEqual([
      ["BRD-2", []],
      ["BRD-3", []],
    ]);
    expect(s.facts.products[0]!.product).toMatchObject({
      gtin: null,
      brand: "Пекарня",
      model: "Бородинский",
      attributes: { вес: "500 г" },
      updatedAt: UPDATED,
      delivery: [
        { method: "PICKUP", minDays: 0, maxDays: 0, cost: { amount: 0, currency: "RUB" } },
        { method: "DELIVERY", region: "RU-MOW", minDays: 1, maxDays: 2, cost: { amount: 25000, currency: "RUB" } },
      ],
    });
    // нет полей сопоставления — null и {}
    expect(s.facts.products[1]!.product).toMatchObject({ gtin: null, brand: null, model: null, attributes: {} });
    // зона и знак витрины в модель не идут (Р53 п. 3)
    expect(s.facts.shop).not.toHaveProperty("readiness");
  });

  it("факты магазина не по схеме — магазин исключён целиком одним кодом, по карточкам записей нет (витрина INCOMPLETE, Р54 п. 5): нет returns — REQUIRED, не тот тип — BAD_TYPE", async () => {
    const noReturns = without(FACTS, "returns");
    const { a, seen } = adapter({
      ...LIST(
        { id: "S1", merchant_id: "MER-S1", zone: "CONTOUR", readiness_mark: true, ...noReturns },
        shop("S2", { payment_methods: "card" }),
        // вложенные поля и null — код по полному пути (ревью КТ1 reviewer № 1)
        shop("S3", { returns: { text: FACTS.returns.text } }),
        shop("S4", { returns: null }),
        shop("S5", { returns: { ...FACTS.returns, days: "0" } }),
      ),
      ...catalog("S1", ok(ITEM, { sku: "B2", title: "Хлеб дня" })),
      ...catalog("S2", ok(ITEM)),
      ...catalog("S3", ok(ITEM)),
      ...catalog("S4", ok(ITEM)),
      ...catalog("S5", ok(ITEM)),
    });
    const out = await a.search();
    expect(out.map((s) => ("unavailable" in s ? null : s.facts))).toEqual(
      ["REQUIRED", "BAD_TYPE", "REQUIRED", "REQUIRED", "BAD_TYPE"].map((code) => ({ shop: null, shopIssues: [code], products: [], dropped: [] })),
    );
    // каталог по-прежнему запрашивается
    expect(seen.map((s) => s.path)).toEqual(["/v1/shops", ...["S1", "S2", "S3", "S4", "S5"].map((id) => `/v1/shops/${id}/catalog`)]);
  });

  it("магазин, исключённый по фактам, sku не регистрирует: тот же sku у исправной витрины проходит живую проверку (ревью КТ1 reviewer № 3)", async () => {
    const { a, seen } = adapter({
      ...LIST(shop("S1", { returns: null }), shop("S2")),
      ...catalog("S1", ok(ITEM)),
      ...catalog("S2", ok(ITEM)),
    });
    await a.search();
    const before = seen.length;
    const offer = await a.fetch({ sku: ITEM.sku, quantity: 1 }, new AbortController().signal);
    expect(offer).toMatchObject({ sku: ITEM.sku, price: { amount: ITEM.price, currency: "RUB" } });
    expect(seen.slice(before).map((s) => s.path)).toEqual(["/v1/shops/S2/catalog"]);
  });

  it("живая проверка: checkedAt — responded_at ответа витрины, не часы агента (Р54 п. 6)", async () => {
    // часы агента отстают на сутки — checkedAt от них не зависит
    const respondedAt = new Date(Date.now() - 10_000).toISOString();
    const { a } = adapter({ ...LIST(shop("S1")), ...catalog("S1", ok(ITEM), { status: 200, body: { items: [ITEM], responded_at: respondedAt } }) }, { now: () => new Date(Date.now() - 86_400_000) });
    await a.search();
    const offer = await a.fetch({ sku: ITEM.sku, quantity: 1 }, new AbortController().signal);
    expect(offer.checkedAt).toBe(respondedAt);
  });

  it("живая проверка: responded_at нет, не дата-время или без пояса — отказ источника, не «свежо» (Р54 п. 6; Date.parse = NaN ядро пропустило бы)", async () => {
    const at = new Date().toISOString();
    for (const responded of [undefined, "вчера", at.slice(0, 19), at.slice(0, 10), 1761400000000]) {
      const { a, journal } = adapter({ ...LIST(shop("S1")), ...catalog("S1", ok(ITEM), { status: 200, body: { items: [ITEM], ...(responded !== undefined && { responded_at: responded }) } }) });
      await a.search();
      await expect(a.fetch({ sku: ITEM.sku, quantity: 1 }, new AbortController().signal)).rejects.toThrow();
      expect(calls(journal).at(-1)).toEqual(["GET /v1/shops/{id}/catalog", 1, "refused", "BAD_RESPONSE"]);
    }
    // в поиске responded_at не проверяется — снимок (Р54 п. 6)
    const { a } = adapter({ ...LIST(shop("S1")), ...catalog("S1", { status: 200, body: { items: [ITEM] } }) });
    const [s] = await a.search();
    expect(s !== undefined && !("unavailable" in s)).toBe(true);
  });

  it("живая проверка разбирает только цену и наличие: карточка без delivery_options и updated_at — цена и наличие, не отказ (Р32 п. 3, нюанс К3.1 Р54; ревью КТ1 reviewer № 2)", async () => {
    const bare = without(ITEM, "delivery_options", "updated_at");
    const { a } = adapter({ ...LIST(shop("S1")), ...catalog("S1", ok(ITEM), ok(bare)) });
    const [s] = await a.search();
    if (s === undefined || "unavailable" in s) throw new Error("витрина недоступна");
    expect(s.facts.products.map((p) => p.product.sku)).toEqual([ITEM.sku]);
    const offer = await a.fetch({ sku: ITEM.sku, quantity: 1 }, new AbortController().signal);
    expect(offer).toMatchObject({ sku: ITEM.sku, price: { amount: ITEM.price, currency: "RUB" }, availability: { inStock: true } });
  });

  it("GTIN-13 с верной суммой Луна — данные модели, не номер карты: карточка проходит модель, GTIN в журнал не пишется (Р54 п. 4, нюанс #70)", async () => {
    const gtin = gtinLuhn13();
    // сканер номеров карт ссылки заказа (ПАО §4) счёл бы его номером карты — поэтому каталоги через него не идут
    expect(orderRefIssue(gtin)).toBe("PAN_LIKE");
    const { a, journal } = adapter({ ...LIST(shop("S1")), ...catalog("S1", ok({ ...ITEM, gtin })) });
    const [s] = await a.search();
    if (s === undefined || "unavailable" in s) throw new Error("витрина недоступна");
    expect(s.facts.products.map((p) => [p.product.gtin, p.issues])).toEqual([[gtin, []]]);
    expect(JSON.stringify(journal.entries)).not.toContain(gtin);
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
    // срок поиска больше ожидания — иначе повтора нет (Р44 п. 6, тест ниже)
    const within = adapter({ ...LIST(shop("S1")), ...catalog("S1", limited(String(max)), ok(ITEM)) }, { params: { ...params, shop_search_deadline_ms: (max + 10) * 1000 } });
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

  it("общий срок поиска истёк во время обращения — оно прервано, следующей витрине не обращаются: обе SHOP_SEARCH_DEADLINE (Р44 п. 6)", async () => {
    const { a, seen, journal } = adapter({ ...LIST(shop("S1"), shop("S2")), ...catalog("S1", "hang"), ...catalog("S2", ok(ITEM)) }, { params: { ...params, shop_search_deadline_ms: 300 } });
    const out = await a.search();
    expect(out).toEqual([
      { shopId: "S1", merchantId: "MER-S1", unavailable: { reason: "SHOP_SEARCH_DEADLINE" } },
      { shopId: "S2", merchantId: "MER-S2", unavailable: { reason: "SHOP_SEARCH_DEADLINE" } },
    ]);
    expect(seen.map((s) => s.path)).toEqual(["/v1/shops", "/v1/shops/S1/catalog"]);
    expect(calls(journal)).toEqual([
      ["GET /v1/shops", 1, "ok", undefined],
      ["GET /v1/shops/{id}/catalog", 1, "unknown", "SHOP_SEARCH_DEADLINE"],
    ]);
  });

  it("таймер срока сработал, а часы срок ещё не отсчитали — остаток ноль: к следующей витрине не обращаются (Р46, К2а; ревью reviewer К2 № 1)", async () => {
    // часы стоят: по ним срок не истёк никогда; прерывает только таймер срока — как при его раннем срабатывании в Node
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    try {
      const { a, seen } = adapter({ ...LIST(shop("S1"), shop("S2")), ...catalog("S1", "hang"), ...catalog("S2", ok(ITEM)) }, { params: { ...params, shop_search_deadline_ms: 300 } });
      const out = await a.search();
      expect(out.map((x) => ("unavailable" in x ? x.unavailable : null))).toEqual([{ reason: "SHOP_SEARCH_DEADLINE" }, { reason: "SHOP_SEARCH_DEADLINE" }]);
      expect(seen.map((s) => s.path)).toEqual(["/v1/shops", "/v1/shops/S1/catalog"]);
    } finally {
      now.mockRestore();
    }
  });

  it("ожидание Retry-After не меньше остатка срока поиска — без ожидания и повтора, SHOP_SEARCH_DEADLINE (Р44 п. 6)", async () => {
    const after = Math.ceil(params.shop_search_deadline_ms / 1000);
    expect(after).toBeLessThanOrEqual(params.shop_retry_after_max_sec);
    const limited: Answer = { status: 429, body: { code: "RATE_LIMITED" }, headers: { "retry-after": String(after) } };
    const { a, sleeps, seen, journal } = adapter({ ...LIST(shop("S1")), ...catalog("S1", limited, ok(ITEM)) });
    const [s] = await a.search();
    expect(s).toEqual({ shopId: "S1", merchantId: "MER-S1", unavailable: { reason: "SHOP_SEARCH_DEADLINE" } });
    expect(sleeps).toEqual([]);
    // попытка — с кодом витрины, недоступность — по сроку (описание shop.unavailable)
    expect(calls(journal)).toEqual([
      ["GET /v1/shops", 1, "ok", undefined],
      ["GET /v1/shops/{id}/catalog", 1, "refused", "RATE_LIMITED"],
    ]);
    expect(seen.filter((x) => x.path === "/v1/shops/S1/catalog")).toHaveLength(1);
  });

  it("срок поиска истёк, а подпись остановлена — исключение подписи наружу, не SHOP_SEARCH_DEADLINE (инвариант 4)", async () => {
    const stopped = new Error("подпись остановлена");
    let n = 0;
    const { a } = adapter({ ...LIST(shop("S1")), ...catalog("S1", { status: 429, body: { code: "RATE_LIMITED" } }, ok(ITEM)) }, {
      // повтор без Retry-After через 1 мс — меньше остатка; пауза повтора съедает срок: к повтору срок истёк, подпись остановлена
      params: { ...params, shop_search_deadline_ms: 300, shop_retry_default_ms: 1 },
      signing: { sign: (req) => { if (++n > 2) throw stopped; return { ...req, headers: { ...req.headers, signature: "sig", "signature-input": "sig=()" } }; } },
      sleep: async () => new Promise((r) => setTimeout(r, 400)),
    });
    await expect(a.search()).rejects.toBe(stopped);
  });

  it("срок поиска истёк до ответа списка витрин — SHOP_LIST_UNAVAILABLE (Р46 п. 2), к каталогам не обращаются (Р44 п. 6)", async () => {
    const { a, seen } = adapter({ "GET /v1/shops": ["hang"] }, { params: { ...params, shop_search_deadline_ms: 300 } });
    await expect(a.search()).rejects.toMatchObject({ name: "ShopFailure", code: "SHOP_LIST_UNAVAILABLE" });
    expect(seen.map((s) => s.path)).toEqual(["/v1/shops"]);
  });

  it("списка витрин нет целиком — ShopFailure SHOP_LIST_UNAVAILABLE (Р46 п. 2); запись списка не по схеме — только эта витрина (ревью КТ1 п. 1)", async () => {
    await expect(adapter({ "GET /v1/shops": [{ status: 503, body: { code: "UPSTREAM_UNAVAILABLE" } }] }).a.search()).rejects.toMatchObject({ name: "ShopFailure", code: "SHOP_LIST_UNAVAILABLE" });
    await expect(adapter({ "GET /v1/shops": [{ status: 200, body: { shops: "нет" } }] }).a.search()).rejects.toMatchObject({ name: "ShopFailure", code: "SHOP_LIST_UNAVAILABLE" });
    const { a, seen } = adapter({ ...LIST({ id: "../x", merchant_id: "MER-X" }, shop("S1")), ...catalog("S1", ok(ITEM)) });
    const out = await a.search();
    expect(out[0]).toEqual({ unavailable: { detail: "BAD_RESPONSE" } });
    expect(out[1]).toMatchObject({ merchantId: "MER-S1", inContour: true });
    expect(seen.map((s) => s.path)).toEqual(["/v1/shops", "/v1/shops/S1/catalog"]);
  });

  it("слова витрины без знака (нет readiness_mark, «true» строкой) при ACTIVE по ПАО — контур; расхождение — в журнал (Р53 п. 3; ревью КТ1 п. 1)", async () => {
    const { a, journal } = adapter({
      ...LIST({ id: "S1", merchant_id: "MER-S1", zone: "CONTOUR" }, shop("S2"), shop("S3", { readiness_mark: "true" })),
      ...catalog("S1", ok({ ...ITEM, sku: "B1" })),
      ...catalog("S2", ok({ ...ITEM, sku: "B2" })),
      ...catalog("S3", ok({ ...ITEM, sku: "B3" })),
    });
    const out = await a.search();
    expect(out.map((s) => ("unavailable" in s ? null : [s.merchantId, s.inContour]))).toEqual([
      ["MER-S1", true],
      ["MER-S2", true],
      ["MER-S3", true],
    ]);
    expect(journal.entries.filter((e) => e.kind === "shop.readiness_mismatch").map((e) => [e.merchant, e.detail])).toEqual([
      ["MER-S1", "ACTIVE:MARKET"],
      ["MER-S3", "ACTIVE:MARKET"],
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

  it("номер заказа — по маске ссылки агента, 128 знаков, как у Платформы (Р46 п. 1, выбор 1а): 65 и 128 — заказ, 129 — SHOP_ORDER_STATE_UNKNOWN", async () => {
    const req = { shopId: "S1", items: [{ sku: "BRD-1", qty: 1 }], cartMandateId: "mnd_1" };
    for (const len of [65, 128]) {
      const id = "o".repeat(len);
      const { a } = adapter({ "POST /v1/shops/S1/orders": [{ status: 201, body: { id, total: 39000, currency: "RUB" } }] });
      expect((await a.order(req)).orderId).toBe(id);
    }
    const { a } = adapter({ "POST /v1/shops/S1/orders": [{ status: 201, body: { id: "o".repeat(129), total: 39000, currency: "RUB" } }] });
    const err = await a.order(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopFailure);
    expect((err as ShopFailure).code).toBe("SHOP_ORDER_STATE_UNKNOWN");
  });

  it("оплата: номер заказа 65 и 128 знаков — в путь и ответ по той же маске; 129 — исключение до обращения (Р46 п. 1, выбор 1а; ревью reviewer К1 № 2)", async () => {
    const pkg = (orderRef: string) =>
      sealPackage({ credential_ref: "CRD-1", kind: "CARD", payload: { token_ref: "tok_test", cryptogram: "c", valid_to: "2026-10-22T10:00:00Z" }, aoi: { indicator: true, agent_code: "nspk:agent:test:v1", mandate_id: "mnd_1" }, cart_mandate_id: "mnd_1", order_ref: orderRef });
    for (const len of [65, 128]) {
      const id = "o".repeat(len);
      const { a, seen } = adapter({ [`POST /v1/shops/S1/orders/${id}/payment`]: [{ status: 200, body: { id, status: "PAID" } }] });
      expect(await a.pay({ shopId: "S1", orderId: id, cartMandateId: "mnd_1", package: pkg(id) })).toEqual({ status: "PAID" });
      expect(seen.map((x) => x.path)).toEqual([`/v1/shops/S1/orders/${id}/payment`]);
    }
    const id = "o".repeat(129);
    const { a, seen } = adapter({});
    await expect(a.pay({ shopId: "S1", orderId: id, cartMandateId: "mnd_1", package: pkg(id) })).rejects.toThrow();
    expect(seen).toEqual([]);
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

describe("знак готовности продавца по ПАО (Р53)", () => {
  const readiness = (j: MemoryJournal) => j.entries.filter((e) => e.kind === "shop.readiness").map((e) => [e.method, e.merchant, e.result, e.detail]);

  it("подписанный GET /pao/v1/merchants/{merchant_id}/readiness к Платформе до каталога, без тела и перенаправлений; в журнале — статус", async () => {
    const { a, seen, journal, pao } = adapter({ ...LIST(shop("S1")), ...catalog("S1", ok(ITEM)) });
    await a.search();
    expect(pao.seen.map((s) => [s.method, s.path, typeof s.headers.signature, s.headers["x-agent-code"], s.redirect, s.body])).toEqual([
      ["GET", "/pao/v1/merchants/MER-S1/readiness", "string", "nspk:agent:test:v1", "manual", undefined],
    ]);
    // подписан тем же портом, что витрины (действующий ключ, профиль ПАО §2), с одноразовым x-nonce
    expect(pao.seen[0]!.headers.signature).toBe(`sig-${pao.seen[0]!.headers["x-nonce"]}`);
    expect(seen.map((s) => s.path)).toEqual(["/v1/shops", "/v1/shops/S1/catalog"]);
    expect(readiness(journal)).toEqual([["GET /pao/v1/merchants/{merchant_id}/readiness", "MER-S1", "ok", "ACTIVE"]]);
  });

  it("знак не проверен (503, 400, 414, нет ответа, не по схеме, чужой merchant_id) — витрина недоступна READINESS_UNAVAILABLE, не рынок; каталог не запрашивается, подпись не тронута (Р53 п. 4)", async () => {
    const cases: [Answer, string][] = [
      [{ status: 503, body: { code: "STATE_UNAVAILABLE", retry: "same_key" } }, "STATE_UNAVAILABLE"],
      [{ status: 400, body: { code: "REQUEST_INVALID", retry: "after_fix" } }, "REQUEST_INVALID"],
      [{ status: 414 }, "HTTP_414"],
      [{ status: 403, body: { code: "REQUEST_INVALID" } }, "HTTP_403"],
      [{ status: 503, body: { code: "UPSTREAM_UNAVAILABLE", retry: "same_key" } }, "UPSTREAM_UNAVAILABLE"],
      [{ status: 429, body: { code: "RATE_LIMITED", retry: "same_key" }, headers: { "retry-after": "1" } }, "RATE_LIMITED"],
      ["fail", "NO_RESPONSE"],
      [{ status: 200, body: { merchant_id: "MER-S1", status: "READY", since: null } }, "BAD_RESPONSE"],
      [READY("MER-S2"), "BAD_RESPONSE"],
    ];
    for (const [answer, detail] of cases) {
      const { a, seen, journal, pao } = adapter({ ...LIST(shop("S1")), ...catalog("S1", ok(ITEM)) }, {}, { "MER-S1": [answer] });
      expect(await a.search()).toEqual([{ shopId: "S1", merchantId: "MER-S1", unavailable: { reason: "READINESS_UNAVAILABLE" } }]);
      expect(seen.map((s) => s.path)).toEqual(["/v1/shops"]);
      expect(readiness(journal).map((r) => r[3])).toEqual([detail]);
      expect([pao.stops, pao.rotations]).toEqual([[], []]);
    }
  });

  it("merchant_id не по маске — без обращения к Платформе, знак не проверен (Р53 п. 2)", async () => {
    const { a, journal, pao } = adapter({});
    expect(await a.readiness("MER/../x")).toEqual({ unverified: "PATTERN" });
    // маска MERCHANT_ID — до 128 знаков, как у ПАО (Р54 п. 1): 129 — уже без обращения
    expect(await a.readiness("M".repeat(129))).toEqual({ unverified: "PATTERN" });
    expect(pao.seen).toEqual([]);
    expect(readiness(journal)).toEqual([
      ["GET /pao/v1/merchants/{merchant_id}/readiness", undefined, "refused", "PATTERN"],
      ["GET /pao/v1/merchants/{merchant_id}/readiness", undefined, "refused", "PATTERN"],
    ]);
  });

  it("merchant_id из 128 знаков — знак запрашивается, в журнале — код продавца (Р54 п. 1, № 46)", async () => {
    const id = "M".repeat(128);
    const { a, journal, pao } = adapter({}, {}, { [id]: [READY(id)] });
    expect(await a.readiness(id)).toEqual({ status: "ACTIVE" });
    expect(pao.seen.map((s) => s.path)).toEqual([`/pao/v1/merchants/${id}/readiness`]);
    expect(readiness(journal)).toEqual([["GET /pao/v1/merchants/{merchant_id}/readiness", id, "ok", "ACTIVE"]]);
  });

  it("через поиск: merchant_id 128 знаков — зона контура по знаку; 129 — запись списка не по маске, витрина недоступна без знака и каталога (Р54 п. 1)", async () => {
    const long = "M".repeat(128);
    const { a, seen, pao } = adapter(
      { ...LIST(shop("S1", { merchant_id: long }), shop("S2", { merchant_id: "M".repeat(129) })), ...catalog("S1", ok(ITEM)), ...catalog("S2", ok(ITEM)) },
      {},
      { [long]: [READY(long)] },
    );
    const out = await a.search();
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ merchantId: long, inContour: true });
    expect(out[1]).toEqual({ unavailable: { detail: "BAD_RESPONSE" } });
    expect(pao.seen.map((s) => s.path)).toEqual([`/pao/v1/merchants/${long}/readiness`]);
    expect(seen.map((s) => s.path)).toEqual(["/v1/shops", "/v1/shops/S1/catalog"]);
  });

  it("403 AGENT_SUSPENDED — остановка подписи и PlatformFailure тем же кодом; к следующим витринам не обращаются (Р53 п. 5)", async () => {
    const { a, seen, pao, journal } = adapter(
      { ...LIST(shop("S1"), shop("S2")), ...catalog("S1", ok(ITEM)), ...catalog("S2", ok(ITEM)) },
      {},
      { "MER-S1": [{ status: 403, body: { code: "AGENT_SUSPENDED", retry: "never" } }] },
    );
    const err = await a.search().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformFailure);
    expect((err as PlatformFailure).code).toBe("AGENT_SUSPENDED");
    expect(pao.stops).toEqual(["AGENT_SUSPENDED"]);
    expect(readiness(journal)).toEqual([["GET /pao/v1/merchants/{merchant_id}/readiness", "MER-S1", "refused", "AGENT_SUSPENDED"]]);
    expect(pao.seen.map((s) => s.path)).toEqual(["/pao/v1/merchants/MER-S1/readiness"]);
    expect(seen.map((s) => s.path)).toEqual(["/v1/shops"]);
  });

  it("401 — как после допуска (Р53 п. 5): AGENT_KEY_REVOKED — смена ключа, SIGNATURE_INVALID — без остановки; без кода по перечню — BAD_RESPONSE; повтора нет", async () => {
    for (const [answer, code, stops, rotations] of [
      [{ status: 401, body: { code: "AGENT_KEY_REVOKED", retry: "new_key" } }, "AGENT_KEY_REVOKED", [], ["kid_test"]],
      [{ status: 401, body: { code: "SIGNATURE_INVALID", retry: "after_fix" } }, "SIGNATURE_INVALID", [], []],
      [{ status: 401, body: { code: "AGENT_UNKNOWN", retry: "never" } }, "AGENT_UNKNOWN", ["AGENT_UNKNOWN"], []],
      [{ status: 401 }, "BAD_RESPONSE", [], []],
    ] as [Answer, string, string[], string[]][]) {
      const { a, pao } = adapter({}, {}, { "MER-S1": [answer] });
      await expect(a.readiness("MER-S1")).rejects.toMatchObject({ name: "PlatformFailure", code, httpStatus: 401 });
      expect([pao.stops, pao.rotations, pao.seen.length]).toEqual([stops, rotations, 1]);
    }
    // через поиск — так же: отказ наружу, каталогов нет
    const s = adapter({ ...LIST(shop("S1")), ...catalog("S1", ok(ITEM)) }, {}, { "MER-S1": [{ status: 401, body: { code: "SIGNATURE_INVALID", retry: "after_fix" } }] });
    await expect(s.a.search()).rejects.toMatchObject({ name: "PlatformFailure", code: "SIGNATURE_INVALID" });
    expect(s.seen.map((x) => x.path)).toEqual(["/v1/shops"]);
  });

  it("нет ответа в pao_request_timeout_ms (не shop_request_timeout_ms) — знак не проверен NO_RESPONSE", async () => {
    const quick = { ...params, pao_request_timeout_ms: 30, shop_request_timeout_ms: 60_000 };
    const { a, journal } = adapter({}, { params: quick }, { "MER-S1": ["hang"] });
    expect(await a.readiness("MER-S1")).toEqual({ unverified: "NO_RESPONSE" });
    expect(readiness(journal).map((r) => [r[2], r[3]])).toEqual([["unknown", "NO_RESPONSE"]]);
  });

  it("общий срок поиска истёк во время запроса знака — SHOP_SEARCH_DEADLINE у этой и следующих витрин, каталогов нет; обращение — в журнале (Р44 п. 6, Т15)", async () => {
    const short = { ...params, shop_search_deadline_ms: 40, pao_request_timeout_ms: 60_000, shop_request_timeout_ms: 30 };
    const { a, seen, journal, pao } = adapter({ ...LIST(shop("S1"), shop("S2")), ...catalog("S1", ok(ITEM)) }, { params: short }, { "MER-S1": ["hang"] });
    const out = await a.search();
    expect(out).toEqual([
      { shopId: "S1", merchantId: "MER-S1", unavailable: { reason: "SHOP_SEARCH_DEADLINE" } },
      { shopId: "S2", merchantId: "MER-S2", unavailable: { reason: "SHOP_SEARCH_DEADLINE" } },
    ]);
    expect(seen.map((x) => x.path)).toEqual(["/v1/shops"]);
    expect(pao.seen.map((x) => x.path)).toEqual(["/pao/v1/merchants/MER-S1/readiness"]);
    expect(journal.entries.filter((e) => e.kind === "shop.readiness").map((e) => [e.merchant, e.result, e.reason])).toEqual([["MER-S1", "unknown", "SHOP_SEARCH_DEADLINE"]]);
  });

  it("подпись остановлена — исключение наружу, к Платформе не обращаются", async () => {
    const { pao } = adapter({});
    const stopped = adapter({}, { platform: { ...pao.platform, signing: { ...pao.platform.signing, current: () => { throw new SignerStopped("NO_ACTIVE_KEY"); } } } });
    await expect(stopped.a.readiness("MER-S1")).rejects.toBeInstanceOf(SignerStopped);
    expect(stopped.pao.seen).toEqual([]);
    expect(pao.seen).toEqual([]);
  });
});
