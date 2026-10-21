// П10 (профиль contour): корзина и мандат корзины. Т6; A7 п. 1.2; Р43. На стенде Платформы и витринах эмулятора через
// адаптер витрин: человек выбирает 2 шт. хлеба из зоны контура → живая проверка у витрины непосредственно перед CART →
// мандат CART с родителем INTENT, позиция и итог — по живой цене продавца → подпись эмулятором банка → живая проверка
// перед заказом → заказ по cart_mandate_id; `Order.total` продавца совпадает с итогом CART — тем, что показан человеку.
// Цена и sku — из витрины по-настоящему (фикстуры Платформы, не литералы); факты ТЕСТОВОГО ПРОФИЛЯ (stand-shop.ts) здесь не
// проверяются.
import { afterEach, describe, expect, it } from "vitest";
import { shopBy, type Contour } from "../support/contour.js";
import { expectJournalClean } from "../support/journal.js";
import { STAND_TIMEOUT_MS, standPurchase } from "../support/stand-purchase.js";
import { one } from "../support/purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  expect(c?.violations() ?? []).toEqual([]);
  await c?.close();
  c = undefined;
});

const NORMAL = shopBy("NORMAL");
/** хлеб витрины NORMAL — цена для всех и для агента одна (не DUAL_PRICE) */
const BREAD = NORMAL.agent_items.find((i) => i.category === "хлеб")!;
const QTY = 2;
/** цена и валюта карточки — у витрины NORMAL есть всегда (без них — INCOMPLETE) */
const PRICE = { amount: BREAD.price!, currency: BREAD.currency! };

describe("П10 — корзина и мандат корзины", { timeout: STAND_TIMEOUT_MS }, () => {
  it("2 шт. хлеба: CART с parent_id INTENT, итог — по живой цене продавца; заказ создан, Order.total = итогу CART", async () => {
    const r = await standPurchase();
    c = r.c;
    expect(NORMAL.items.find((i) => i.sku === BREAD.sku)!.price).toBe(PRICE.amount);
    const intent = await r.signedIntent();
    const zones = await r.purchase.search();
    const offer = zones.contour.find((o) => o.shopId === NORMAL.id && o.sku === BREAD.sku)!;
    expect(offer.product.price).toEqual(PRICE);

    const before = r.c.calls().length;
    const cart = await r.purchase.cart(one(offer, QTY), { idempotencyKey: "idem-cart-p10" });
    // verify INTENT, затем живая проверка у витрины — непосредственно перед запросом CART (П05, Р43 п. 1)
    expect(r.c.calls().slice(before).map((x) => `${x.target} ${x.route.replaceAll(intent.id, "{intent}")} ${x.status}`).filter((s) => !s.startsWith("pao GET /pao/v1/events"))).toEqual([
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      `merchants GET /v1/shops/${NORMAL.id}/catalog 200`,
      "pao POST /pao/v1/mandates 201",
    ]);
    const shown = { amount: QTY * PRICE.amount, currency: PRICE.currency };
    expect(cart).toMatchObject({ kind: "CART", parentId: intent.id, status: "PENDING_SIGNATURE" });
    expect(cart.cart).toEqual({ merchantId: NORMAL.merchant_id, lines: [{ sku: BREAD.sku, qty: QTY, price: PRICE }], total: shown });

    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    // подписанный мандат у Платформы — та же корзина (эхо сверено клиентом мандатов, Р43 п. 3)
    expect(r.purchase.cartMandate).toMatchObject({ id: cart.id, status: "ACTIVE", cart: cart.cart });

    const order = await r.purchase.placeOrder({ idempotencyKey: "idem-order-p10" });
    expect(order.total).toEqual(shown);
    expect(r.purchase.state).toBe("ORDERED");
    // две живые проверки: перед CART и перед заказом (Р43 п. 1, Р32 п. 3); заказ — один
    const merchants = r.c.calls().slice(before).filter((x) => x.target === "merchants").map((x) => `${x.route} ${x.status}`);
    expect(merchants).toEqual([
      `GET /v1/shops/${NORMAL.id}/catalog 200`,
      `GET /v1/shops/${NORMAL.id}/catalog 200`,
      `POST /v1/shops/${NORMAL.id}/orders 201`,
    ]);
    expect(r.payment.calls).toEqual([]);
    // журнал агента: отказов нет, поля и коды — из набора, ни nonce, ни ключей обращений (ревью К1 № 6)
    const entries = r.c.journal.entries;
    expect(entries.filter((e) => e.kind === "agent.refused" || e.kind === "cart.live_refused" || e.kind === "order.live_refused")).toEqual([]);
    expect(entries.filter((e) => e.kind === "purchase.stage").map((e) => e.detail).slice(-3)).toEqual(["CART_PENDING", "CART_ACTIVE", "ORDERED"]);
    const secrets = r.c.calls().flatMap((x) => [x.nonce, x.idempotencyKey]).filter((v): v is string => typeof v === "string");
    // журнал контура собран без compose — кода агента в записях нет (Р37 п. 3)
    expectJournalClean(entries, null, [], secrets);
  });

  it("две позиции одной витрины: живая проверка каждой перед CART и перед заказом, итог — Σ; заказ — обе позиции, Order.total = итогу CART (Р44 п. 1–3)", async () => {
    const r = await standPurchase();
    c = r.c;
    const intent = await r.signedIntent();
    await r.purchase.search();
    const items = NORMAL.agent_items.slice(0, 2);
    expect(items).toHaveLength(2);
    const lines = items.map((i, n) => ({ sku: i.sku, qty: n + 1 }));
    const total = { amount: items.reduce((sum, i, n) => sum + i.price! * (n + 1), 0), currency: "RUB" };
    const before = r.c.calls().length;
    const cart = await r.purchase.cart({ merchantId: NORMAL.merchant_id, lines, keyTermsShown: true }, { idempotencyKey: "idem-cart-p10-2" });
    expect(cart.cart).toEqual({ merchantId: NORMAL.merchant_id, lines: items.map((i, n) => ({ sku: i.sku, qty: n + 1, price: { amount: i.price!, currency: i.currency! } })), total });
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    const order = await r.purchase.placeOrder({ idempotencyKey: "idem-order-p10-2" });
    expect(order.total).toEqual(total);
    // полный журнал обращений (без ленты): verify INTENT, живые проверки обеих позиций, CART, подпись, снова обе, заказ
    const shop = `merchants GET /v1/shops/${NORMAL.id}/catalog 200`;
    const ids = (x: string) => x.replaceAll(intent.id, "{intent}").replaceAll(cart.id, "{cart}");
    expect(r.c.calls().slice(before).filter((x) => !x.route.startsWith("GET /pao/v1/events")).map((x) => ids(`${x.target} ${x.route} ${x.status}`))).toEqual([
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      shop,
      shop,
      "pao POST /pao/v1/mandates 201",
      "pao GET /pao/v1/mandates/{cart} 200",
      "pao POST /participants/v1/mandates/{cart}/sign 200",
      "pao GET /pao/v1/mandates/{cart} 200",
      shop,
      shop,
      // проверка по мандату непосредственно перед заказом (Р44 п. 5)
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "pao GET /pao/v1/mandates/{cart}/verify 200",
      `merchants POST /v1/shops/${NORMAL.id}/orders 201`,
    ]);
    expect(r.payment.calls).toEqual([]);
    const entries = r.c.journal.entries;
    expect(entries.filter((e) => e.kind === "agent.refused" || e.kind === "cart.live_refused" || e.kind === "order.live_refused")).toEqual([]);
    const secrets = r.c.calls().flatMap((x) => [x.nonce, x.idempotencyKey]).filter((v): v is string => typeof v === "string");
    expectJournalClean(entries, null, [], secrets);
  });
});
