// Стадия 3 по Р44 на PaoStub: корзина из нескольких позиций одного продавца (п. 1–3) и новая цена после согласования —
// новый CART только после нового поиска, прежний CART ничем не используется (Т6, Р5, П11; п. 4). Цена «у продавца» —
// фид изменяемого магазина: поиск, живая проверка и сумма заказа читают его в момент обращения.
import { afterEach, describe, expect, it } from "vitest";
import { CartLiveRefused, CartRefused, OrderRefused, PurchaseStopped, type CartChoice, type CartChoiceLine } from "../../src/agent/pipeline/index.js";
import { isSpent } from "../../src/agent/policy/a5-issued.js";
import { humanA5Decision } from "../../src/agent/shell/index.js";
import type { JournalEntry } from "../../src/agent/journal/index.js";
import { expectJournalClean } from "../support/journal.js";
import { loadParams } from "../../src/shared/config.js";
import { AGENT, type PaoStand } from "../support/pao-stand.js";
import { SHOP, purchaseOn, signedIntent, stages, type PurchaseRun, type PurchaseSetup } from "../support/purchase.js";
import { READY, bakery, feedPrice, liveOffers, payments, shopOrders, type FeedShop } from "../support/shop.js";

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
const RELINQUISH = "POST /pao/v1/mandates/{id}/relinquish";
/** обращения после `from`; после остановки — с фоновым отказом от CART: сначала дождаться `cartReleased()` (Р63 п. 7) */
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

/** Записи об оставленном CART (Р46 п. 3): только причина и id CART — сумм, позиций и продавца нет. */
const abandoned = (r: { tail: () => JournalEntry[] }) =>
  r.tail().filter((e) => e.kind === "cart.abandoned").map((e) => ({ ...e, at: undefined, agent: undefined }));

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

  it("П17 (б), Р56 п. 2: продавец выбора вне merchantScope INTENT (позиция в контуре выдачи) — STOPPED MANDATE_OUT_OF_SCOPE по INTENT, до обращений к витрине и ПАО", async () => {
    const r = await setup({ shops: [SHOP, { ...SHOP, merchantId: "shop_2" }] });
    await signedIntent(r);
    const intent = r.purchase.intentMandate!;
    expect(intent.merchantScope).toEqual(["shop_1"]);
    const zones = await r.purchase.search();
    // поиск не меняется (Р56 п. 2, STATUS «Открыто» — к AG-16): товар продавца вне области INTENT в выдаче
    expect(zones.contour.some((o) => o.merchantId === "shop_2" && o.sku === "tartine")).toBe(true);
    const from = r.stand.stub.calls.length;
    const choice: CartChoice = { merchantId: "shop_2", lines: [{ sku: "tartine", qty: 1 }], keyTermsShown: true };
    await expect(r.purchase.cart(choice, { idempotencyKey: "idem-cart-1" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.reason).toBe("MANDATE_OUT_OF_SCOPE");
    expect(r.tail().filter((e) => e.kind === "agent.refused").map((e) => [e.reason, e.mandate])).toEqual([["MANDATE_OUT_OF_SCOPE", intent.id]]);
    expect(r.live.calls).toEqual([]);
    expect(r.shop.calls).toEqual([]);
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
    // прежний CART и выдача сброшены; от прежнего CART агент отказывается в фоне (Р63, дополнение 1; прежде — выбор 4а,
    // CART оставался ACTIVE), cartRelease — итог до нового CART
    expect(r.purchase.cartMandate).toBeNull();
    expect(r.purchase.offers).toBeNull();
    expect(await r.purchase.cartReleased()).toBe("RELINQUISHED");
    expect(r.consents.mandates.get(old.id)!.status).toBe("REVOKED");
    // оставленный CART — в журнале (Р46 п. 3)
    const left = [{ kind: "cart.abandoned", detail: "REFUSED_BEFORE_ORDER", mandate: old.id, at: undefined, agent: undefined }];
    expect(abandoned(r)).toEqual(left);

    // новый показ — новая цена; CART по ней, заказ и оплата — только по новому CART
    const zones = await r.purchase.search();
    // поиск из OFFERS — CART не было, новой записи нет
    expect(abandoned(r)).toEqual(left);
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

  it("отказ по наличию перед заказом — снимок CART стёрт (наружу не отдаётся), выдача — нет: новый выбор из того же показа без поиска (ревью КТ1 п. 1)", async () => {
    const shop = shopWithPrices();
    const r = await setup({ shops: [shop], live: liveOffers(shop, () => stand!.clock, (_, n) => (n === 2 ? { availability: { inStock: false } } : {})), shop: shopOrders(shop) });
    await signedIntent(r);
    await r.purchase.search();
    await sign(r, (await r.purchase.cart(pick({ sku: "tartine", qty: 1 }), { idempotencyKey: "idem-cart-1" })).id);
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toMatchObject({ next: "TELL_STOCK" });
    expect(r.purchase.cartMandate).toBeNull();
    expect(r.purchase.offers).not.toBeNull();
    await r.purchase.cart(pick({ sku: "zavarnoy", qty: 1 }), { idempotencyKey: "idem-cart-2" });
    expect(r.purchase.state).toBe("CART_PENDING");
  });

  for (const [name, over] of [
    ["нет в наличии", { availability: { inStock: false } }],
    ["продавец не ответил", { checkedAt: "2000-01-01T00:00:00Z" }],
  ] as const) {
    it(`${name} перед заказом — снимок CART стёрт: заказ без нового CART невозможен (STOPPED), к витрине не обращаемся (ревью КТ1 п. 1)`, async () => {
      const shop = shopWithPrices();
      const r = await setup({ shops: [shop], live: liveOffers(shop, () => stand!.clock, (_, n) => (n === 2 ? over : {})), shop: shopOrders(shop) });
      await signedIntent(r);
      await r.purchase.search();
      await sign(r, (await r.purchase.cart(pick({ sku: "tartine", qty: 1 }), { idempotencyKey: "idem-cart-1" })).id);
      await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toBeInstanceOf(OrderRefused);
      expect(r.purchase.cartMandate).toBeNull();
      const from = r.stand.stub.calls.length;
      await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-2" })).rejects.toThrow();
      expect(r.purchase.state).toBe("STOPPED");
      expect(r.purchase.reason).toBe("PIPELINE_TRANSITION_FORBIDDEN");
      expect(r.shop.calls).toEqual([]);
      expect(opsFrom(r, from)).toEqual([]);
    });
  }
});

describe("К2а — новая выдача при подписанном CART стирает снимок CART (решение владельца 21.10)", () => {
  it("новый поиск из CART_ACTIVE: снимок CART стёрт (cartMandate пуст, needsConfirmation — fail-closed); новый выбор — новый CART, заказ — по нему", async () => {
    const { r } = await onShop();
    await signedIntent(r);
    await r.purchase.search();
    const old = await r.purchase.cart(pick({ sku: "tartine", qty: 1 }), { idempotencyKey: "idem-cart-1" });
    await sign(r, old.id);
    expect(r.purchase.state).toBe("CART_ACTIVE");
    expect(r.purchase.needsConfirmation).toBe(false);
    const from = r.stand.stub.calls.length;
    expect(abandoned(r)).toEqual([]);
    await r.purchase.search();
    // новый поиск — только verify INTENT; по прежнему CART обращений нет
    expect(opsFrom(r, from)).toEqual([VERIFY]);
    // оставленный CART — в журнале до того, как снимок стёрт (Р46 п. 3)
    expect(abandoned(r)).toEqual([{ kind: "cart.abandoned", detail: "NEW_SEARCH", mandate: old.id, at: undefined, agent: undefined }]);
    expect(r.purchase.state).toBe("OFFERS");
    expect(r.purchase.cartMandate).toBeNull();
    expect(r.purchase.needsConfirmation).toBe(true);
    const fresh = await r.purchase.cart(pick({ sku: "zavarnoy", qty: 1 }), { idempotencyKey: "idem-cart-2" });
    expect(fresh.id).not.toBe(old.id);
    expect(r.purchase.cartMandate!.id).toBe(fresh.id);
    await sign(r, fresh.id);
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-1" });
    expect((r.shop.calls as { cartMandateId: string }[]).map((c) => c.cartMandateId)).toEqual([fresh.id]);
    expectJournalClean(r.journal.entries, AGENT, r.stand.stub.calls, ["idem-intent-1", "idem-cart-1", "idem-cart-2", "idem-order-1"]);
  });

  it("вторая защита: из OFFERS заказ запрещён машиной — STOPPED PIPELINE_TRANSITION_FORBIDDEN, обращений нет (стирание проверяет тест выше)", async () => {
    const { r } = await onShop();
    await signedIntent(r);
    await r.purchase.search();
    await sign(r, (await r.purchase.cart(pick({ sku: "tartine", qty: 1 }), { idempotencyKey: "idem-cart-1" })).id);
    await r.purchase.search();
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toThrow();
    expect(r.purchase.reason).toBe("PIPELINE_TRANSITION_FORBIDDEN");
    expect(opsFrom(r, from)).toEqual([]);
    expect(r.shop.calls).toEqual([]);
  });
});

describe("Р44 п. 5 — проверка по мандату непосредственно перед заказом (Р-149)", () => {
  /** До CART_ACTIVE: CART на две позиции подписан; остаток задаёт «Платформа» (consents.left). */
  async function signedTwo() {
    const { r, payment } = await onShop();
    await signedIntent(r);
    await r.purchase.search();
    const cart = await r.purchase.cart(pick({ sku: "tartine", qty: 2 }, { sku: "zavarnoy", qty: 1 }), { idempotencyKey: "idem-cart-1" });
    await sign(r, cart.id);
    return { r, payment, cart };
  }
  const TOTAL = 2 * TARTINE + ZAVARNOY;

  it("остаток INTENT иссяк между CART и заказом (другая покупка) — STOPPED до заказа: agent.refused, к витрине POST нет, реквизита нет", async () => {
    for (const [left, code] of [
      [TOTAL - 1, "MANDATE_AMOUNT_LEFT_INSUFFICIENT"],
      [0, "MANDATE_OUT_OF_SCOPE"],
    ] as const) {
      const { r, payment } = await signedTwo();
      const intentId = r.purchase.intentMandate!.id;
      r.consents.left.set(intentId, left);
      const from = r.stand.stub.calls.length;
      await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toMatchObject({ code });
      expect(r.purchase.state).toBe("STOPPED");
      // живые проверки обеих позиций прошли, затем verify INTENT — и стоп: по INTENT вне пределов CART уже не проверяется
      expect(r.live.calls!.length).toBe(4);
      // CART не использован — фоновый отказ от него (Р63 п. 7; КТ1 сессии 46 № 4)
      expect(await r.purchase.cartReleased()).toBe("RELINQUISHED");
      expect(opsFrom(r, from)).toEqual([VERIFY, RELINQUISH]);
      expect(r.shop.calls).toEqual([]);
      expect(payment.calls).toEqual([]);
      expect(r.atStop().slice(-2).map((e) => [e.kind, e.reason, e.mandate])).toEqual([
        ["agent.refused", code, intentId],
        ["purchase.stage", code, intentId],
      ]);
      expect(stand?.stub.violations ?? []).toEqual([]);
      await stand?.close();
      stand = undefined;
    }
  });

  it("остаток CART меньше итога — STOPPED MANDATE_AMOUNT_LEFT_INSUFFICIENT после verify обоих, заказа нет", async () => {
    const { r, cart } = await signedTwo();
    r.consents.left.set(cart.id, TOTAL - 1);
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toMatchObject({ code: "MANDATE_AMOUNT_LEFT_INSUFFICIENT" });
    expect(r.purchase.state).toBe("STOPPED");
    expect(await r.purchase.cartReleased()).toBe("RELINQUISHED");
    expect(opsFrom(r, from)).toEqual([VERIFY, VERIFY, RELINQUISH]);
    expect(r.shop.calls).toEqual([]);
    expect(r.atStop().slice(-2).map((e) => [e.kind, e.reason, e.mandate])).toEqual([
      ["agent.refused", "MANDATE_AMOUNT_LEFT_INSUFFICIENT", cart.id],
      ["purchase.stage", "MANDATE_AMOUNT_LEFT_INSUFFICIENT", r.purchase.intentMandate!.id],
    ]);
  });

  it("CART отозван у Платформы, события ещё нет — verify перед заказом: STOPPED, заказа нет", async () => {
    const { r, cart } = await signedTwo();
    r.consents.mandates.get(cart.id)!.status = "REVOKED";
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toThrow();
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("MANDATE_OUT_OF_SCOPE");
    expect(opsFrom(r, from)).toEqual([VERIFY, VERIFY]);
    expect(r.shop.calls).toEqual([]);
    expect(r.tail().filter((e) => e.kind === "agent.refused").map((e) => [e.reason, e.mandate])).toEqual([["MANDATE_OUT_OF_SCOPE", cart.id]]);
  });

  it("остаток в порядке — verify INTENT и CART после живых проверок и непосредственно перед POST заказа, затем заказ", async () => {
    // витрина записывает, какие обращения к контуру были непосредственно перед заказом
    // живая проверка записывает, сколько обращений к контуру было к её моменту
    const at: { r?: PurchaseRun; before?: (string | undefined)[]; live: number[] } = { live: [] };
    const shop = shopWithPrices();
    const real = shopOrders(shop);
    const checks = liveOffers(shop, () => stand!.clock);
    const live = { fetch: (req: Parameters<typeof checks.fetch>[0], signal: AbortSignal) => (at.live.push(at.r?.stand.stub.calls.length ?? -1), checks.fetch(req, signal)) };
    const r = await setup({ shops: [shop], live, shop: { ...READY, order: (req, m) => ((at.before = at.r!.stand.stub.calls.slice(-2).map((c) => c.op)), real.order(req, m)) } });
    at.r = r;
    await signedIntent(r);
    await r.purchase.search();
    await sign(r, (await r.purchase.cart(pick({ sku: "tartine", qty: 2 }, { sku: "zavarnoy", qty: 1 }), { idempotencyKey: "idem-cart-1" })).id);
    const from = r.stand.stub.calls.length;
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-1" });
    expect(opsFrom(r, from)).toEqual([VERIFY, VERIFY]);
    expect(at.before).toEqual([VERIFY, VERIFY]);
    // обе живые проверки перед заказом — до verify: между ними и началом placeOrder обращений к контуру нет
    expect(at.live.slice(-2)).toEqual([from, from]);
    expect(r.purchase.state).toBe("ORDERED");
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

// Р46 п. 4 (выбор 4а): два verify перед заказом (до registry_cache_ttl_sec каждый) могут состарить живые проверки.
// Часы стенда двигает живая проверка: setImmediate — после сравнения ядром (микрозадачи) и во время verify (обращения к
// стенду), синхронно — до ответа продавца.
describe("Р46 п. 4 — возраст живой проверки перед заказом", () => {
  // порог — из стендовых параметров, не литералом (ревью reviewer К4 № 1)
  const MAX_AGE_MS = loadParams().live_check_max_age_sec * 1000;

  /** Живая проверка по фиду магазина; `step(i)` — перед i-м обращением с момента `arm()`. */
  function timed(shop: FeedShop) {
    const inner = liveOffers(shop, () => stand!.clock);
    let i = -1;
    let step: (i: number) => void = () => {};
    const src = {
      calls: inner.calls,
      fetch: (...args: Parameters<typeof inner.fetch>) => {
        if (i >= 0) step(++i);
        return inner.fetch(...args);
      },
      arm(s: (i: number) => void) {
        i = 0;
        step = s;
      },
      get armed() {
        return i;
      },
    };
    return src;
  }
  const later = (ms: number) => setImmediate(() => (stand!.clock = new Date(stand!.clock.getTime() + ms)));
  const now = (ms: number) => (stand!.clock = new Date(stand!.clock.getTime() + ms));

  async function onTimed(...lines: CartChoiceLine[]) {
    const shop = shopWithPrices();
    const live = timed(shop);
    const r = await setup({ shops: [shop], live, shop: shopOrders(shop), payment: payments() });
    await signedIntent(r);
    await r.purchase.search();
    const cart = await r.purchase.cart(pick(...lines), { idempotencyKey: "idem-cart-1" });
    await sign(r, cart.id);
    return { r, shop, live, cart };
  }

  it("проверки не устарели — повтора нет: одна живая проверка на позицию, заказ", async () => {
    const { r, live } = await onTimed({ sku: "tartine", qty: 1 });
    live.arm(() => {});
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-1" });
    expect(live.armed).toBe(1);
    expect(r.purchase.state).toBe("ORDERED");
  });

  it("после verify проверка старше live_check_max_age_sec — повтор ровно один раз без нового verify, затем заказ", async () => {
    const { r, live } = await onTimed({ sku: "tartine", qty: 1 });
    live.arm((i) => {
      if (i === 1) later(MAX_AGE_MS + 1000);
    });
    const from = r.stand.stub.calls.length;
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-1" });
    expect(live.armed).toBe(2);
    // verify INTENT и CART — только до повтора
    expect(opsFrom(r, from)).toEqual([VERIFY, VERIFY]);
    expect(r.purchase.state).toBe("ORDERED");
    expect(r.shop.calls).toHaveLength(1);
    expect(r.tail().filter((e) => e.kind === "order.live_refused")).toEqual([]);
  });

  it("(б) повторная показала новую цену — путь Р44: заказа нет, выдача сброшена, CART оставлен", async () => {
    const { r, shop, live, cart } = await onTimed({ sku: "tartine", qty: 1 });
    live.arm((i) => {
      if (i === 1) later(MAX_AGE_MS + 1000);
      if (i === 2) shop.price("tartine", "999");
    });
    const from = r.stand.stub.calls.length;
    const err = await r.purchase.placeOrder({ idempotencyKey: "idem-order-1" }).catch((e: unknown) => e);
    // verify — только до повтора (ревью reviewer К4 № 3)
    expect(opsFrom(r, from)).toEqual([VERIFY, VERIFY]);
    expect(err).toBeInstanceOf(OrderRefused);
    expect(err).toMatchObject({ next: "NEW_CART_MANDATE", codes: ["LIVE_PRICE_UP"] });
    expect(live.armed).toBe(2);
    expect(r.shop.calls).toEqual([]);
    expect(r.purchase.state).toBe("OFFERS");
    expect(r.purchase.offers).toBeNull();
    expect(r.tail().filter((e) => e.kind === "cart.abandoned").map((e) => [e.detail, e.mandate])).toEqual([["REFUSED_BEFORE_ORDER", cart.id]]);
  });

  it("(а1) повторная к заказу тоже устарела (медленный продавец) — отказ LIVE_STALE путём Р44, второго круга нет", async () => {
    const { r, live, cart } = await onTimed({ sku: "tartine", qty: 1 }, { sku: "zavarnoy", qty: 1 });
    live.arm((i) => {
      if (i === 2) later(MAX_AGE_MS + 1000);
      // вторая позиция повторной проверки отвечает через минуту: первая к заказу старше live_check_max_age_sec
      if (i === 4) now(MAX_AGE_MS + 1000);
    });
    const from = r.stand.stub.calls.length;
    const err = await r.purchase.placeOrder({ idempotencyKey: "idem-order-1" }).catch((e: unknown) => e);
    expect(opsFrom(r, from)).toEqual([VERIFY, VERIFY]);
    expect(err).toBeInstanceOf(OrderRefused);
    expect(err).toMatchObject({ next: "TELL_UNCONFIRMED", codes: ["LIVE_STALE"] });
    // две позиции × ровно два круга
    expect(live.armed).toBe(4);
    expect(r.shop.calls).toEqual([]);
    expect(r.purchase.state).toBe("OFFERS");
    expect(r.purchase.cartMandate).toBeNull();
    // не ценовой отказ — выдача остаётся (новый выбор из того же показа, Р44 п. 4)
    expect(r.purchase.offers).not.toBeNull();
    expect(r.tail().filter((e) => e.kind === "order.live_refused").map((e) => [e.reason, e.detail, e.ref])).toEqual([["LIVE_STALE", "TELL_UNCONFIRMED", "tartine"]]);
    expect(r.tail().filter((e) => e.kind === "cart.abandoned").map((e) => [e.detail, e.mandate])).toEqual([["REFUSED_BEFORE_ORDER", cart.id]]);
  });
});
