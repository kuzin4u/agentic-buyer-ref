// Стадия 3 по Р44 на PaoStub: корзина из нескольких позиций одного продавца (п. 1–3) и новая цена после согласования —
// новый CART только после нового поиска, прежний CART ничем не используется (Т6, Р5, П11; п. 4). Цена «у продавца» —
// фид изменяемого магазина: поиск, живая проверка и сумма заказа читают его в момент обращения.
import { afterEach, describe, expect, it } from "vitest";
import { CartLiveRefused, CartRefused, OrderRefused, PurchaseStopped, type CartChoice, type CartChoiceLine } from "../../src/agent/pipeline/index.js";
import { isSpent } from "../../src/agent/policy/a5-issued.js";
import { humanA5Decision } from "../../src/agent/shell/index.js";
import { expectJournalClean } from "../support/journal.js";
import { AGENT, type PaoStand } from "../support/pao-stand.js";
import { SHOP, purchaseOn, signedIntent, stages, type PurchaseRun, type PurchaseSetup } from "../support/purchase.js";
import { bakery, feedPrice, liveOffers, payments, shopOrders, type FeedShop } from "../support/shop.js";

let stand: PaoStand | undefined;
afterEach(async () => {
  expect(stand?.stub.violations ?? []).toEqual([]);
  await stand?.close();
  stand = undefined;
});

const setup = (o: PurchaseSetup = {}) => purchaseOn(o, (s) => (stand = s));
const TARTINE = feedPrice(SHOP, "tartine").amount;
const ZAVARNOY = feedPrice(SHOP, "zavarnoy").amount;
const VERIFY = "GET /pao/v1/mandates/{id}/verify";
const opsFrom = (r: PurchaseRun, from: number) => r.stand.stub.calls.slice(from).map((c) => c.op);
const shownIn = (r: PurchaseRun) => ({ intentId: r.purchase.intentMandate!.id });

/** Выбор человека из позиций продавца shop_1. */
const pick = (...lines: CartChoiceLine[]): CartChoice => ({ merchantId: SHOP.merchantId, lines, keyTermsShown: true });

/** Магазин, у которого «продавец» меняет цену: фид — копия фикстуры, `price` — новая цена позиции в рублях. */
function shopWithPrices(): FeedShop & { price: (sku: string, rub: string) => void } {
  const s = { ...SHOP };
  return Object.assign(s, {
    price(sku: string, rub: string) {
      const at = s.feed.indexOf(`<offer id="${sku}"`);
      const from = s.feed.indexOf("<price>", at);
      const to = s.feed.indexOf("</price>", from);
      s.feed = `${s.feed.slice(0, from)}<price>${rub}${s.feed.slice(to)}`;
    },
  });
}

/** Покупка на изменяемом магазине: выдача, живая проверка и витрина — по его фиду. */
async function onShop(over: PurchaseSetup = {}) {
  const shop = shopWithPrices();
  const payment = payments();
  const r = await setup({ shops: [shop], live: liveOffers(shop, () => stand!.clock), shop: shopOrders(shop), payment, ...over });
  return { r, shop, payment };
}

async function sign(r: PurchaseRun, id: string) {
  r.setFeed({ kind: "event", event: r.consents.sign(id) });
  return r.purchase.awaitCart();
}

describe("Р44 п. 1–3 — корзина из нескольких позиций одного продавца", () => {
  it("две позиции: живая проверка каждой перед CART и перед заказом, итог — Σ, заказ — все позиции, Order.total = итогу CART", async () => {
    const { r, payment } = await onShop();
    await signedIntent(r);
    await r.purchase.search();
    const cart = await r.purchase.cart(pick({ sku: "tartine", qty: 2 }, { sku: "zavarnoy", qty: 1 }), { idempotencyKey: "idem-cart-1" });
    const total = { amount: 2 * TARTINE + ZAVARNOY, currency: "RUB" };
    expect(cart.cart).toEqual({
      merchantId: "shop_1",
      lines: [
        { sku: "tartine", qty: 2, price: { amount: TARTINE, currency: "RUB" } },
        { sku: "zavarnoy", qty: 1, price: { amount: ZAVARNOY, currency: "RUB" } },
      ],
      total,
    });
    expect(cart.amountLimit).toEqual(total);
    await sign(r, cart.id);
    const order = await r.purchase.placeOrder({ idempotencyKey: "idem-order-1" });
    expect(order.total).toEqual(total);
    // по каждой позиции — две живые проверки, в порядке корзины (Р43 п. 1, Р32 п. 3)
    expect(r.live.calls).toEqual([
      { sku: "tartine", quantity: 2, region: "77" },
      { sku: "zavarnoy", quantity: 1, region: "77" },
      { sku: "tartine", quantity: 2, region: "77" },
      { sku: "zavarnoy", quantity: 1, region: "77" },
    ]);
    expect(r.shop.calls).toEqual([{ shopId: "massa-madre", items: [{ sku: "tartine", qty: 2 }, { sku: "zavarnoy", qty: 1 }], cartMandateId: cart.id }]);
    await r.purchase.authorize({ idempotencyKey: "idem-auth-1" });
    expect(payment.carts).toEqual([{ cart: cart.id, total, order: total }]);
  });

  it("живая проверка перед CART — до первой позиции не ok: вторая не ok — CartLiveRefused, коды только её, CART не запрошен", async () => {
    const shop = shopWithPrices();
    const r = await setup({ shops: [shop], live: liveOffers(shop, () => stand!.clock, (req) => (req.sku === "zavarnoy" ? { availability: { inStock: false } } : {})) });
    await signedIntent(r);
    await r.purchase.search();
    const from = r.stand.stub.calls.length;
    const err = await r.purchase.cart(pick({ sku: "tartine", qty: 1 }, { sku: "zavarnoy", qty: 1 }, { sku: "borodinsky", qty: 1 }), { idempotencyKey: "idem-cart-1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CartLiveRefused);
    expect(err).toMatchObject({ next: "TELL_STOCK", codes: ["LIVE_OUT_OF_STOCK"] });
    expect((r.live.calls as { sku: string }[]).map((c) => c.sku)).toEqual(["tartine", "zavarnoy"]);
    expect(opsFrom(r, from)).toEqual([VERIFY]);
    expect(r.tail().filter((e) => e.kind === "cart.live_refused").map((e) => [e.reason, e.ref])).toEqual([["LIVE_OUT_OF_STOCK", "zavarnoy"]]);
    expect(r.purchase.state).toBe("OFFERS");
  });

  it("пустой выбор, повтор sku, неверное количество любой позиции — STOPPED CART_QTY_INVALID до обращений", async () => {
    const cases: [CartChoiceLine[], string | undefined][] = [
      [[], undefined],
      [[{ sku: "tartine", qty: 1 }, { sku: "tartine", qty: 2 }], undefined],
      [[{ sku: "tartine", qty: 1 }, { sku: "zavarnoy", qty: 0 }], "zavarnoy"],
    ];
    for (const [lines, ref] of cases) {
      const { r } = await onShop();
      await signedIntent(r);
      await r.purchase.search();
      const from = r.stand.stub.calls.length;
      await expect(r.purchase.cart(pick(...lines), { idempotencyKey: "idem-cart-1" })).rejects.toBeInstanceOf(PurchaseStopped);
      expect(r.purchase.reason).toBe("CART_QTY_INVALID");
      expect(r.tail().filter((e) => e.kind === "agent.refused").map((e) => [e.reason, e.ref])).toEqual([["CART_QTY_INVALID", ref]]);
      expect(r.live.calls).toEqual([]);
      expect(opsFrom(r, from)).toEqual([]);
      expect(stand?.stub.violations ?? []).toEqual([]);
      await stand?.close();
      stand = undefined;
    }
  });

  it("позиция не из контура этого продавца (нет в выдаче у shop_1, хотя есть у shop_2) — STOPPED OFFER_NOT_IN_CONTOUR до обращений", async () => {
    const r = await setup({ shops: [SHOP, { ...SHOP, merchantId: "shop_2" }] });
    await signedIntent(r);
    const zones = await r.purchase.search();
    expect(zones.contour.some((o) => o.merchantId === "shop_2" && o.sku === "zavarnoy")).toBe(true);
    const from = r.stand.stub.calls.length;
    // продавец выбора — shop_1 по построению: позиция ищется только у него
    await expect(r.purchase.cart(pick({ sku: "tartine", qty: 1 }, { sku: "нет такого", qty: 1 }), { idempotencyKey: "idem-cart-1" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.reason).toBe("OFFER_NOT_IN_CONTOUR");
    expect(r.live.calls).toEqual([]);
    expect(opsFrom(r, from)).toEqual([]);
  });

  it("позиции одного продавца у двух витрин — STOPPED OFFER_NOT_IN_CONTOUR по позиции чужой витрины, до обращений (Р44 п. 1)", async () => {
    const other = { ...SHOP, feed: SHOP.feed.replace('<offer id="borodinsky"', '<offer id="rye"'), profile: bakery({ id: "massa-madre-2" }) };
    const r = await setup({ shops: [SHOP, other] });
    await signedIntent(r);
    const zones = await r.purchase.search();
    expect(zones.contour.find((o) => o.sku === "rye")).toMatchObject({ merchantId: "shop_1", shopId: "massa-madre-2" });
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.cart(pick({ sku: "tartine", qty: 1 }, { sku: "rye", qty: 1 }), { idempotencyKey: "idem-cart-1" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.reason).toBe("OFFER_NOT_IN_CONTOUR");
    expect(r.tail().filter((e) => e.kind === "agent.refused").map((e) => [e.reason, e.ref])).toEqual([["OFFER_NOT_IN_CONTOUR", "rye"]]);
    expect(r.live.calls).toEqual([]);
    expect(opsFrom(r, from)).toEqual([]);
  });

  it("сигнал A5 у второй позиции без решения — CartRefused, обращений нет; решение по каждой позиции — CART, решение потрачено", async () => {
    const shop = { ...SHOP, profile: bakery({ returns: { days: 0, text: "Возврат в течение 14 дней" } }) };
    // перед заказом первая позиция — нет в наличии: возврат в OFFERS без сброса выдачи
    const out = { on: false };
    const r = await setup({ shops: [shop], live: liveOffers(shop, () => stand!.clock, () => (out.on ? { availability: { inStock: false } } : {})) });
    await signedIntent(r);
    const zones = await r.purchase.search();
    const [a, b] = ["tartine", "zavarnoy"].map((sku) => zones.contour.find((o) => o.sku === sku)!);
    expect(a!.a5.length).toBeGreaterThan(0);
    const da = humanA5Decision(shownIn(r), a!, a!.a5);
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.cart(pick({ sku: "tartine", qty: 1, decision: da }, { sku: "zavarnoy", qty: 1 }), { idempotencyKey: "idem-cart-1" })).rejects.toBeInstanceOf(CartRefused);
    expect(opsFrom(r, from)).toEqual([]);
    const db = humanA5Decision(shownIn(r), b!, b!.a5);
    const cart = await r.purchase.cart(pick({ sku: "tartine", qty: 1, decision: da }, { sku: "zavarnoy", qty: 1, decision: db }), { idempotencyKey: "idem-cart-1" });
    expect(cart.cart?.lines.map((l) => l.sku)).toEqual(["tartine", "zavarnoy"]);
    // оба решения потрачены на этот CART (Р40 п. 2): после возврата в OFFERS те же — A5_DECISION_STALE, CART не запрошен
    expect([isSpent(da), isSpent(db)]).toEqual([true, true]);
    await sign(r, cart.id);
    out.on = true;
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toMatchObject({ next: "TELL_STOCK" });
    const again = r.stand.stub.calls.length;
    await expect(r.purchase.cart(pick({ sku: "tartine", qty: 1, decision: da }, { sku: "zavarnoy", qty: 1, decision: db }), { idempotencyKey: "idem-cart-2" })).rejects.toMatchObject({ code: "A5_DECISION_STALE" });
    expect(opsFrom(r, again)).toEqual([]);
  });

  it("позиции — снимком выбора: правка массива после вызова не меняет ни проверку, ни CART (Р-205)", async () => {
    const { r } = await onShop();
    await signedIntent(r);
    await r.purchase.search();
    const choice = pick({ sku: "tartine", qty: 1 });
    const pending = r.purchase.cart(choice, { idempotencyKey: "idem-cart-1" });
    choice.lines.push({ sku: "zavarnoy", qty: 5 });
    choice.lines[0]!.qty = 9;
    const cart = await pending;
    expect(cart.cart?.lines).toEqual([{ sku: "tartine", qty: 1, price: { amount: TARTINE, currency: "RUB" } }]);
    expect(r.live.calls).toEqual([{ sku: "tartine", quantity: 1, region: "77" }]);
  });
});

describe("Р44 п. 4 — новая цена после согласования: новый CART только после нового поиска (Т6, П11)", () => {
  it("цена выросла между CART и заказом: заказа нет, прежний CART не используется; новый поиск → новый CART → заказ и оплата только по нему", async () => {
    const { r, shop, payment } = await onShop();
    await signedIntent(r);
    await r.purchase.search();
    const old = await r.purchase.cart(pick({ sku: "tartine", qty: 2 }, { sku: "zavarnoy", qty: 1 }), { idempotencyKey: "idem-cart-1" });
    await sign(r, old.id);
    // продавец поднял цену второй позиции после подписи CART
    shop.price("zavarnoy", "410");
    const err = await r.purchase.placeOrder({ idempotencyKey: "idem-order-1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderRefused);
    expect(err).toMatchObject({ next: "NEW_CART_MANDATE", codes: ["LIVE_PRICE_UP"] });
    expect(r.shop.calls).toEqual([]);
    expect(r.purchase.state).toBe("OFFERS");
    // прежний CART и выдача сброшены (выбор 4а: у Платформы он остаётся ACTIVE, агент его не использует)
    expect(r.purchase.cartMandate).toBeNull();
    expect(r.purchase.offers).toBeNull();
    expect(r.consents.mandates.get(old.id)!.status).toBe("ACTIVE");

    // новый показ — новая цена; CART по ней, заказ и оплата — только по новому CART
    const zones = await r.purchase.search();
    expect(zones.contour.find((o) => o.sku === "zavarnoy")!.product.price).toEqual({ amount: 41000, currency: "RUB" });
    const fresh = await r.purchase.cart(pick({ sku: "tartine", qty: 2 }, { sku: "zavarnoy", qty: 1 }), { idempotencyKey: "idem-cart-2" });
    const total = { amount: 2 * TARTINE + 41000, currency: "RUB" };
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.cart?.total).toEqual(total);
    await sign(r, fresh.id);
    const order = await r.purchase.placeOrder({ idempotencyKey: "idem-order-2" });
    expect(order.total).toEqual(total);
    await r.purchase.authorize({ idempotencyKey: "idem-auth-1" });
    await r.purchase.settle();
    expect(r.purchase.state).toBe("DONE");
    expect((r.shop.calls as { cartMandateId: string }[]).map((c) => c.cartMandateId)).toEqual([fresh.id]);
    expect(payment.carts).toEqual([{ cart: fresh.id, total, order: total }]);
    expect(stages(r).filter((s) => s === "CART_PENDING" || s === "OFFERS")).toEqual(["OFFERS", "CART_PENDING", "OFFERS", "OFFERS", "CART_PENDING"]);
    expectJournalClean(r.journal.entries, AGENT, r.stand.stub.calls, ["idem-intent-1", "idem-cart-1", "idem-cart-2", "idem-order-1", "idem-order-2", "idem-auth-1"]);
  });

  it("после ценового отказа перед заказом cart() без нового поиска — STOPPED PIPELINE_TRANSITION_FORBIDDEN, CART по старой цене не запрошен", async () => {
    const { r, shop } = await onShop();
    await signedIntent(r);
    await r.purchase.search();
    await sign(r, (await r.purchase.cart(pick({ sku: "tartine", qty: 1 }), { idempotencyKey: "idem-cart-1" })).id);
    shop.price("tartine", "470");
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toBeInstanceOf(OrderRefused);
    const from = r.stand.stub.calls.length;
    const calls = r.live.calls!.length;
    await expect(r.purchase.cart(pick({ sku: "tartine", qty: 1 }), { idempotencyKey: "idem-cart-2" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.reason).toBe("PIPELINE_TRANSITION_FORBIDDEN");
    expect(opsFrom(r, from)).toEqual([]);
    expect(r.live.calls!.length).toBe(calls);
  });

  it("ценовой отказ перед CART сбрасывает выдачу: cart() без поиска — STOPPED; отказ по наличию — нет, выбор из того же показа идёт", async () => {
    {
      const { r, shop } = await onShop();
      await signedIntent(r);
      await r.purchase.search();
      shop.price("tartine", "470");
      await expect(r.purchase.cart(pick({ sku: "tartine", qty: 1 }), { idempotencyKey: "idem-cart-1" })).rejects.toMatchObject({ next: "NEW_CART_MANDATE" });
      expect(r.purchase.offers).toBeNull();
      await expect(r.purchase.cart(pick({ sku: "tartine", qty: 1 }), { idempotencyKey: "idem-cart-1" })).rejects.toBeInstanceOf(PurchaseStopped);
      expect(r.purchase.reason).toBe("PIPELINE_TRANSITION_FORBIDDEN");
      await stand?.close();
      stand = undefined;
    }
    const shop = shopWithPrices();
    const r = await setup({ shops: [shop], live: liveOffers(shop, () => stand!.clock, (req, n) => (n === 1 ? { availability: { inStock: false } } : {})) });
    await signedIntent(r);
    await r.purchase.search();
    await expect(r.purchase.cart(pick({ sku: "tartine", qty: 1 }), { idempotencyKey: "idem-cart-1" })).rejects.toMatchObject({ next: "TELL_STOCK" });
    expect(r.purchase.offers).not.toBeNull();
    const cart = await r.purchase.cart(pick({ sku: "zavarnoy", qty: 1 }), { idempotencyKey: "idem-cart-2" });
    expect(cart.cart?.total).toEqual({ amount: ZAVARNOY, currency: "RUB" });
  });

  it("отказ по наличию перед заказом — выдача и CART не сброшены ценой: новый выбор из того же показа без поиска", async () => {
    const shop = shopWithPrices();
    const r = await setup({ shops: [shop], live: liveOffers(shop, () => stand!.clock, (_, n) => (n === 2 ? { availability: { inStock: false } } : {})), shop: shopOrders(shop) });
    await signedIntent(r);
    await r.purchase.search();
    await sign(r, (await r.purchase.cart(pick({ sku: "tartine", qty: 1 }), { idempotencyKey: "idem-cart-1" })).id);
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toMatchObject({ next: "TELL_STOCK" });
    expect(r.purchase.offers).not.toBeNull();
    await r.purchase.cart(pick({ sku: "zavarnoy", qty: 1 }), { idempotencyKey: "idem-cart-2" });
    expect(r.purchase.state).toBe("CART_PENDING");
  });

  it("перед заказом — до первой позиции не ok: первая не в наличии — вторая не проверяется, коды только первой (Р44 п. 2)", async () => {
    const shop = shopWithPrices();
    const out = { on: false };
    const r = await setup({ shops: [shop], live: liveOffers(shop, () => stand!.clock, (req) => (out.on && req.sku === "tartine" ? { availability: { inStock: false } } : {})), shop: shopOrders(shop) });
    await signedIntent(r);
    await r.purchase.search();
    await sign(r, (await r.purchase.cart(pick({ sku: "tartine", qty: 1 }, { sku: "zavarnoy", qty: 1 }), { idempotencyKey: "idem-cart-1" })).id);
    out.on = true;
    const checked = r.live.calls!.length;
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toMatchObject({ next: "TELL_STOCK", codes: ["LIVE_OUT_OF_STOCK"] });
    expect((r.live.calls as { sku: string }[]).slice(checked).map((c) => c.sku)).toEqual(["tartine"]);
    expect(r.tail().filter((e) => e.kind === "order.live_refused").map((e) => [e.reason, e.ref])).toEqual([["LIVE_OUT_OF_STOCK", "tartine"]]);
    expect(r.shop.calls).toEqual([]);
  });

  it("перед CART первая позиция ok, у второй выросла цена — выдача сброшена, CART не запрошен; cart() без поиска — STOPPED", async () => {
    const { r, shop } = await onShop();
    await signedIntent(r);
    await r.purchase.search();
    shop.price("zavarnoy", "410");
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.cart(pick({ sku: "tartine", qty: 1 }, { sku: "zavarnoy", qty: 1 }), { idempotencyKey: "idem-cart-1" })).rejects.toMatchObject({ next: "NEW_CART_MANDATE", codes: ["LIVE_PRICE_UP"] });
    expect((r.live.calls as { sku: string }[]).map((c) => c.sku)).toEqual(["tartine", "zavarnoy"]);
    expect(opsFrom(r, from)).toEqual([VERIFY]);
    expect(r.purchase.offers).toBeNull();
    expect(r.purchase.cartMandate).toBeNull();
    await expect(r.purchase.cart(pick({ sku: "tartine", qty: 1 }), { idempotencyKey: "idem-cart-1" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.reason).toBe("PIPELINE_TRANSITION_FORBIDDEN");
  });

  it("решение A5 по старой цене не покрывает новый показ: ценовой отказ → новый поиск → cart() со старым решением — A5_DECISION_STALE, CART не запрошен", async () => {
    const shop = Object.assign(shopWithPrices(), { profile: bakery({ returns: { days: 0, text: "Возврат в течение 14 дней" } }) });
    const r = await setup({ shops: [shop], live: liveOffers(shop, () => stand!.clock), shop: shopOrders(shop) });
    await signedIntent(r);
    const first = (await r.purchase.search()).contour.find((o) => o.sku === "tartine")!;
    const old = humanA5Decision(shownIn(r), first, first.a5);
    shop.price("tartine", "470");
    await expect(r.purchase.cart(pick({ sku: "tartine", qty: 1, decision: old }), { idempotencyKey: "idem-cart-1" })).rejects.toMatchObject({ next: "NEW_CART_MANDATE" });
    // решение не потрачено: CART не запрашивался (Р40 п. 2 — тратится только перед запросом CART)
    expect(isSpent(old)).toBe(false);
    const shown = (await r.purchase.search()).contour.find((o) => o.sku === "tartine")!;
    expect(shown.product.price).toEqual({ amount: 47000, currency: "RUB" });
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.cart(pick({ sku: "tartine", qty: 1, decision: old }), { idempotencyKey: "idem-cart-1" })).rejects.toMatchObject({ code: "A5_DECISION_STALE" });
    expect(opsFrom(r, from)).toEqual([]);
    const cart = await r.purchase.cart(pick({ sku: "tartine", qty: 1, decision: humanA5Decision(shownIn(r), shown, shown.a5) }), { idempotencyKey: "idem-cart-1" });
    expect(cart.cart?.total).toEqual({ amount: 47000, currency: "RUB" });
  });
});
