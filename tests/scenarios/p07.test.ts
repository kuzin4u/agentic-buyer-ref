// П07 (профиль contour): поиск по обеим зонам каталога. Т5; A5, A6 п. 3.1; Р3, Р42 п. 3. На стенде Платформы и витринах
// эмулятора через адаптер витрин: зона контура — только при знаке готовности ACTIVE по ПАО (Р53 п. 3); у зоны рынка —
// ссылка человеку, платежа нет (инвариант 10); пояснение различия в защите — код зоны и текст оболочки.
// Решения каталога по фактам ТЕСТОВОГО ПРОФИЛЯ (stand-shop.ts) доказательством не считаются; знак — из ПАО, sku и цена —
// из витрины. Ожидаемая зона — по ответу знака стенда эквайреру; приостановление знака и расхождение со словами витрины —
// readiness-stand.test.ts, модульно — shops-adapter.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { MERCHANT_FIXTURES } from "agentic-ps-platform/fixtures";
import { PurchaseStopped } from "../../src/agent/pipeline/index.js";
import { ZONE_TEXT } from "../../src/agent/shell/index.js";
import { shopBy, type Contour } from "../support/contour.js";
import { STAND_TIMEOUT_MS, standPurchase } from "../support/stand-purchase.js";
import { one } from "../support/purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  expect(c?.violations() ?? []).toEqual([]);
  await c?.close();
  c = undefined;
});

const NORMAL = shopBy("NORMAL");
const OUTSIDE = shopBy("READ_ONLY");

describe("П07 — поиск по обеим зонам каталога", { timeout: STAND_TIMEOUT_MS }, () => {
  it("NORMAL в контуре, READ_ONLY вне: две зоны, пояснение у каждой, ссылка у зоны рынка", async () => {
    const r = await standPurchase();
    c = r.c;
    await r.signedIntent();
    const zones = await r.purchase.search();

    expect(NORMAL.zone).toBe("CONTOUR");
    expect(OUTSIDE.zone).toBe("OUTSIDE");
    expect(zones.contour.filter((o) => o.shopId === NORMAL.id).map((o) => o.sku).sort()).toEqual(NORMAL.agent_items.map((i) => i.sku).sort());
    expect(zones.market.map((o) => [o.shopId, o.sku])).toEqual(OUTSIDE.agent_items.map((i) => [OUTSIDE.id, i.sku]));
    // ни одного товара вне контура в зоне контура и наоборот
    expect(zones.contour.some((o) => o.shopId === OUTSIDE.id)).toBe(false);
    expect(zones.market.some((o) => o.shopId === NORMAL.id)).toBe(false);
    // ссылка — только у зоны рынка; адрес — витрина эмулятора, не текст карточки
    expect(zones.market.every((o) => o.link === `${r.c.merchants!.baseUrl}/v1/shops/${OUTSIDE.id}/catalog`)).toBe(true);
    expect(zones.contour.every((o) => o.link === undefined)).toBe(true);
    // пояснение различия в защите (A6 п. 3.1): код у каждой зоны, тексты оболочки различаются
    expect(zones.disclosure).toEqual({ contour: "ZONE_CONTOUR", market: "ZONE_MARKET" });
    expect(ZONE_TEXT[zones.disclosure.contour].ru).toMatch(/гаранти/);
    expect(ZONE_TEXT[zones.disclosure.market].ru).toMatch(/вне контура гарантий/);
    expect(ZONE_TEXT[zones.disclosure.market].ru).toMatch(/не оплачивает/);
    expect(zones.unavailable).toEqual([]);
  });

  it("главный инвариант зон (инвариант 10, Р3): товар вне контура не уходит ни в корзину, ни в заказ; в контуре — ровно витрины контура фикстур", async () => {
    const r = await standPurchase();
    c = r.c;
    const intent = await r.signedIntent();
    const zones = await r.purchase.search();
    // зона контура — витрины, у которых знак готовности у стенда ACTIVE (ответ стенда эквайреру, ПИ-8; Р53 п. 3, ревью
    // reviewer К2.1 № 13), кроме витрины с неполными карточками (INCOMPLETE: все карточки не проходят модель, П09) — не из
    // слов витрины и не из журнала агента (ревью К3 № 5); зона рынка — все прочие
    const marks = await Promise.all(MERCHANT_FIXTURES.map((f) => r.stand.acquirerParticipant.getReadiness(f.merchant_id)));
    expect(marks.every((m, i) => m.statusCode === 200 && (m.body as { merchant_id?: unknown }).merchant_id === MERCHANT_FIXTURES[i]!.merchant_id)).toBe(true);
    const contourShops = new Set(MERCHANT_FIXTURES.filter((_, i) => (marks[i]!.body as { status: string }).status === "ACTIVE").map((f) => f.id));
    const excluded = new Set(MERCHANT_FIXTURES.filter((f) => f.behaviour === "INCOMPLETE").map((f) => f.id));
    expect(new Set(zones.contour.map((o) => o.shopId))).toEqual(new Set([...contourShops].filter((id) => !excluded.has(id))));
    expect(zones.unavailable).toEqual([]);
    expect(zones.market.length).toBeGreaterThan(0);
    expect(zones.market.every((o) => !contourShops.has(o.shopId) && o.link !== undefined)).toBe(true);
    // выбор человека из зоны рынка — сделка остановлена до любого обращения: ни CART у Платформы, ни заказа у витрины
    const market = zones.market[0]!;
    const before = r.c.calls().length;
    await expect(r.purchase.cart(one(market, 1), { idempotencyKey: "idem-cart-market" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("OFFER_NOT_IN_CONTOUR");
    expect(r.c.calls().slice(before)).toEqual([]);
    expect(r.c.calls().filter((x) => x.target === "merchants" && x.route.endsWith("/orders"))).toEqual([]);
    expect(r.c.journal.entries.filter((e) => e.kind === "agent.refused").map((e) => [e.reason, e.ref, e.mandate])).toEqual([["OFFER_NOT_IN_CONTOUR", market.sku, intent.id]]);
    expect(r.payment.calls).toEqual([]);
  });
});
