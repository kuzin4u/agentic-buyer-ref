// Конвейер, стадии 3–6 на PaoStub (Р38 п. 1–4): выбор человека → CART → живая проверка → заказ со сверкой суммы →
// подтверждение по порогу (Т7) → авторизация и расчёт через порт PaymentSteps (исход — из события Платформы, AG-11).
import { afterEach, describe, expect, it } from "vitest";
import { CartLiveRefused, CartRefused, OrderRefused, Purchase, PurchaseMachine, PurchaseStopped, PurchaseTransitionForbidden, type Offer } from "../../src/agent/pipeline/index.js";
import { MandateRefused } from "../../src/agent/mandates/index.js";
import { isSpent } from "../../src/agent/policy/a5-issued.js";
import { loadParams } from "../../src/shared/config.js";
import { PlatformFailure, type Fulfilment, type Operation } from "../../src/shared/domain.js";
import { PaymentFailure, ShopFailure, type ConfirmationOutcome, type PaymentContext } from "../../src/agent/ports/index.js";
import { INTENT, event } from "../support/consents.js";
import { expectJournalClean } from "../support/journal.js";
import { AGENT, type PaoStand } from "../support/pao-stand.js";
import { SHOP, one, purchaseOn, signedIntent, stages, type PurchaseRun, type PurchaseSetup } from "../support/purchase.js";
import { READY, bakery, feedOffers, feedPrice, liveOffers, payments, shopOrders } from "../support/shop.js";
import { humanA5Decision } from "../../src/agent/shell/index.js";
import { startFailureCode } from "../../src/agent/compose.js";
import { SignerStopped, SignerSuspended } from "../../src/agent/signer/index.js";

let stand: PaoStand | undefined;
afterEach(async () => {
  expect(stand?.stub.violations ?? []).toEqual([]);
  await stand?.close();
  stand = undefined;
});

const setup = (o: PurchaseSetup = {}) => purchaseOn(o, (s) => (stand = s));
/** Стенд внутри цикла теста: проверка нарушений и закрытие, afterEach его уже не видит. */
async function closeStand() {
  expect(stand?.stub.violations ?? []).toEqual([]);
  await stand?.close();
  stand = undefined;
}
const { confirm_above_kop: THRESHOLD } = loadParams();
/** mandate_id каждого verify по журналу обращений PaoStub */
const verified = (r: PurchaseRun) => r.stand.stub.calls.filter((c) => c.op === "GET /pao/v1/mandates/{id}/verify").map((c) => c.path.split("/")[4]);
/** все обращения к контуру после `from` — лишнее обращение к любому методу видно (ревью К2 В5) */
const opsFrom = (r: PurchaseRun, from: number) => r.stand.stub.calls.slice(from).map((c) => c.op);
const VERIFY = "GET /pao/v1/mandates/{id}/verify";
/** фоновый отказ от CART после остановки (Р63 п. 7): в списке обращений — после `await cartReleased()` (КТ1 сессии 46 № 4) */
const RELINQUISH = "POST /pao/v1/mandates/{id}/relinquish";
const { split_min_ops: MIN_OPS } = loadParams();
/** Занять в окне дробления `n` мест (одобрены) на сумму `sum` в целом: каждое — не меньше доли суммы, целыми копейками;
 *  `floor` — каждое не больше доли (сумма не превышает `sum`). Число операций — от `split_min_ops` из конфигурации. */
function fillWindow(r: PurchaseRun, root: string, n: number, sum: number, round: "ceil" | "floor" = "ceil") {
  const each = Math[round](sum / n);
  for (let i = 0; i < n; i++) r.split.open(root, { amount: each, currency: "RUB" }).settle("APPROVED");
}
/** цена tartine по фиду, коп. */
const TARTINE = feedPrice(SHOP, "tartine").amount;

/** Покупка, в которой человек видел показ: корневой INTENT (Р40 п. 1). */
const shownIn = (r: PurchaseRun) => ({ intentId: r.purchase.intentMandate!.id });

/** Выбор человека — ключом товара выдачи. */
const key = (o: Offer) => ({ merchantId: o.merchantId, sku: o.sku });

/** До OFFERS: INTENT подписан, выдача получена; товар — из contour по sku. */
async function offers(r: PurchaseRun, sku = "tartine"): Promise<Offer> {
  await signedIntent(r);
  const zones = await r.purchase.search();
  return zones.contour.find((o) => o.sku === sku)!;
}

/** До CART_ACTIVE: CART запрошен и подписан человеком по ленте. */
async function signedCart(r: PurchaseRun, offer: Offer, qty = 1) {
  const cart = await r.purchase.cart(one(offer, qty), { idempotencyKey: "idem-cart-1" });
  r.setFeed({ kind: "event", event: r.consents.sign(cart.id) });
  return r.purchase.awaitCart();
}

async function ordered(r: PurchaseRun, qty = 1) {
  await signedCart(r, await offers(r), qty);
  return r.purchase.placeOrder({ idempotencyKey: "idem-order-1" });
}

/** Порт оплаты: авторизация — «нужно подтверждение» (как DECLINED продавца в профиле contour: пакет уже ушёл, `sending`),
 *  стадия 4 — исход `outcome`. */
const confirming = (outcome: ConfirmationOutcome) => {
  const steps = payments({ confirm: outcome });
  return {
    ...steps,
    authorize: async (c: PaymentContext) => {
      steps.calls.push("authorize");
      c.sending();
      throw new PaymentFailure("CONFIRMATION_REQUIRED");
    },
  };
};

describe("стадии 3–6 — путь покупки (Р38 п. 1–2)", () => {
  it("сумма не выше порога: CART → заказ → авторизация → расчёт без стадии 4, purchase.stage на каждый переход", async () => {
    const r = await setup();
    expect(TARTINE).toBeLessThanOrEqual(THRESHOLD);
    const order = await ordered(r);
    const cart = r.purchase.cartMandate!;
    expect(cart).toMatchObject({ kind: "CART", parentId: r.purchase.intentMandate!.id, status: "ACTIVE" });
    expect(cart.cart).toEqual({ merchantId: "shop_1", lines: [{ sku: "tartine", qty: 1, price: { amount: TARTINE, currency: "RUB" } }], total: { amount: TARTINE, currency: "RUB" } });
    // заказ — по мандату корзины (cart_mandate_id), сумма — продавца и равна CART
    expect(r.shop.calls).toEqual([{ shopId: "massa-madre", items: [{ sku: "tartine", qty: 1 }], cartMandateId: cart.id }]);
    expect(order.total).toEqual({ amount: TARTINE, currency: "RUB" });
    expect(r.purchase.needsConfirmation).toBe(false);
    await r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
    const op = await r.purchase.settle();
    expect(op.status).toBe("SETTLED");
    expect(r.payment.calls).toEqual(["authorize", "settle"]);
    expect(stages(r)).toEqual(["INTENT_PENDING", "INTENT_ACTIVE", "OFFERS", "CART_PENDING", "CART_ACTIVE", "ORDERED", "AUTHORIZING", "SETTLING", "DONE"]);
    // после допуска: INTENT (POST, GET по подписи), verify перед поиском и перед CART (Р38 п. 3), CART (POST, GET),
    // перед заказом — verify INTENT и CART (Р44 п. 5), ворота перед стадией 5 — verify INTENT и CART (К4)
    const log = r.stand.log().map((c) => c.op);
    expect(log.slice(log.indexOf("POST /pao/v1/mandates"))).toEqual([
      "POST /pao/v1/mandates",
      "GET /pao/v1/mandates/{id}",
      "GET /pao/v1/mandates/{id}/verify",
      "GET /pao/v1/mandates/{id}/verify",
      "POST /pao/v1/mandates",
      "GET /pao/v1/mandates/{id}",
      "GET /pao/v1/mandates/{id}/verify",
      "GET /pao/v1/mandates/{id}/verify",
      "GET /pao/v1/mandates/{id}/verify",
      "GET /pao/v1/mandates/{id}/verify",
    ]);
    // живая проверка — перед CART по выбору и перед заказом по строке CART (Р43 п. 1, Р32 п. 3)
    expect(r.live.calls).toEqual([
      { sku: "tartine", quantity: 1, region: "77" },
      { sku: "tartine", quantity: 1, region: "77" },
    ]);
    expectJournalClean(r.journal.entries, AGENT, r.stand.stub.calls, ["idem-intent-1", "idem-cart-1"]);
  });

  it("сумма выше порога (Т7, Р47 п. 2а): авторизация без предварительного подтверждения — его требует ADP; не потребовала — ORDERED → AUTHORIZING → SETTLING", async () => {
    const r = await setup();
    const qty = Math.floor(THRESHOLD / TARTINE) + 1;
    await ordered(r, qty);
    expect(r.purchase.needsConfirmation).toBe(true);
    await r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
    await r.purchase.settle();
    expect(r.payment.calls).toEqual(["authorize", "settle"]);
    expect(stages(r).slice(-4)).toEqual(["ORDERED", "AUTHORIZING", "SETTLING", "DONE"]);
  });

  it("CART сразу ACTIVE (РП35): CART_PENDING и CART_ACTIVE подряд, без ожидания подписи", async () => {
    const r = await setup();
    const offer = await offers(r);
    r.consents.tamper = (m) => (m.parent_id ? Object.assign(m, { status: "ACTIVE" }) : m);
    await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-1" });
    expect(r.purchase.state).toBe("CART_ACTIVE");
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-1" });
    expect(stages(r).slice(-3)).toEqual(["CART_PENDING", "CART_ACTIVE", "ORDERED"]);
  });

  it("подписи CART нет — ждать человека: MANDATE_SIGNATURE_PENDING наружу, покупка в CART_PENDING", async () => {
    const r = await setup();
    await r.purchase.cart(one(await offers(r), 1), { idempotencyKey: "idem-cart-1" });
    r.setFeed();
    await expect(r.purchase.awaitCart()).rejects.toMatchObject({ reason: "MANDATE_SIGNATURE_PENDING" });
    expect(r.purchase.state).toBe("CART_PENDING");
  });
});

describe("стадия 2 — зона по способу оплаты агента (дополнение 1 к Р66 п. 3, Р-534)", () => {
  const LINK = "http://shops.test/v1/shops/massa-madre/catalog";

  it.each([
    ["только sbp", ["sbp"]],
    ["наличные", ["cash"]],
    ["пустой список", []],
    ["регистр и пробелы", ["Card", " card"]],
  ])("знак ACTIVE без способа агента (%s) — зона рынка со ссылкой и ZONE_MARKET_NO_METHOD, shop.zone_market без строк витрины; выбор — OFFER_NOT_IN_CONTOUR", async (_name, methods) => {
    const r = await setup({ shops: [{ ...SHOP, profile: bakery({ paymentMethods: methods }), link: LINK }] });
    await signedIntent(r);
    const zones = await r.purchase.search();
    expect(zones.contour).toEqual([]);
    expect(zones.market.length).toBeGreaterThan(0);
    for (const o of zones.market) {
      expect(o).toMatchObject({ merchantId: "shop_1", link: LINK, marketReason: "ZONE_MARKET_NO_METHOD" });
      expect(o.channel).toBeUndefined();
    }
    const records = r.journal.entries.filter((e) => e.kind === "shop.zone_market");
    expect(records.map((e) => [e.merchant, e.reason])).toEqual([["shop_1", "NO_AGENT_PAYMENT_METHOD"]]);
    // строки payment_methods витрины в журнал не попадают (инвариант 5)
    for (const m of methods.filter((x) => x.trim() !== "")) expect(JSON.stringify(r.journal.entries).includes(`"${m}"`)).toBe(false);
    // оплаты нет: выбор такого товара — отказ без обращений (инвариант 10)
    const before = r.stand.log().length;
    await expect(r.purchase.cart(one(key(zones.market[0]!), 1), { idempotencyKey: "idem-cart-1" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.reason).toBe("OFFER_NOT_IN_CONTOUR");
    expect(r.stand.log().length).toBe(before);
  });

  it("способ агента есть — зона контура с каналом CARD, без ссылки и причины; канал уходит в шаг оплаты", async () => {
    const channels: string[] = [];
    const steps = payments();
    const r = await setup({
      shops: [{ ...SHOP, profile: bakery({ paymentMethods: ["sbp", "card"] }), link: LINK }],
      payment: { ...steps, authorize: (c, m) => (channels.push(c.channel), steps.authorize(c, m)) },
    });
    const offer = await offers(r);
    expect(offer).toMatchObject({ channel: "CARD" });
    expect(offer.link).toBeUndefined();
    expect(offer.marketReason).toBeUndefined();
    expect(r.journal.entries.filter((e) => e.kind === "shop.zone_market")).toEqual([]);
    await signedCart(r, offer);
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-1" });
    await r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
    expect(channels).toEqual(["CARD"]);
  });

  // случай «все товары отсеяны по региону» на фиде пекарни не собрать: самовывоз проходит при любом регионе
  it("способа нет, но витрина исключена целиком (пустая строка в payment_methods) — товаров в зоне рынка нет, записи shop.zone_market нет, только исключения (ревью КТ1 № 4)", async () => {
    const r = await setup({ shops: [{ ...SHOP, profile: bakery({ paymentMethods: ["", "cash"] }), link: LINK }] });
    await signedIntent(r);
    const zones = await r.purchase.search();
    expect(zones.contour).toEqual([]);
    expect(zones.market).toEqual([]);
    expect(r.journal.entries.filter((e) => e.kind === "offer.excluded").length).toBeGreaterThan(0);
    expect(r.journal.entries.filter((e) => e.kind === "shop.zone_market")).toEqual([]);
  });

  it("знак не ACTIVE и способа нет — зона рынка без ZONE_MARKET_NO_METHOD и без shop.zone_market (причина — знак)", async () => {
    const r = await setup({ shops: [{ ...SHOP, profile: bakery({ paymentMethods: ["cash"] }), inContour: false, link: LINK }] });
    await signedIntent(r);
    const zones = await r.purchase.search();
    expect(zones.contour).toEqual([]);
    for (const o of zones.market) {
      expect(o.link).toBe(LINK);
      expect(o.marketReason).toBeUndefined();
    }
    expect(r.journal.entries.filter((e) => e.kind === "shop.zone_market")).toEqual([]);
  });
});

describe("стадия 3 — проект корзины (Р32 п. 2): отказ политики без перехода (Р38 п. 4, поправка К3), выбор вне контура — STOPPED", () => {
  it("выбор не из contour этой выдачи (зона вне контура, товара нет) — STOPPED OFFER_NOT_IN_CONTOUR, agent.refused, обращений нет (А2)", async () => {
    for (const pick of ["market", "missing"] as const) {
      const r = await setup({ shops: [SHOP, { ...SHOP, merchantId: "shop_2", inContour: false }] });
      await signedIntent(r);
      const zones = await r.purchase.search();
      const before = r.stand.log().length;
      const choice = pick === "market" ? key(zones.market[0]!) : { merchantId: "shop_1", sku: "нет такого" };
      await expect(r.purchase.cart(one(choice, 1), { idempotencyKey: "idem-cart-1" })).rejects.toBeInstanceOf(PurchaseStopped);
      expect(r.purchase.reason).toBe("OFFER_NOT_IN_CONTOUR");
      expect(r.atStop().slice(-2).map((e) => [e.kind, e.reason, e.ref])).toEqual([
        ["agent.refused", "OFFER_NOT_IN_CONTOUR", pick === "market" ? "tartine" : undefined],
        ["purchase.stage", "OFFER_NOT_IN_CONTOUR", undefined],
      ]);
      expect(r.stand.log().length).toBe(before);
      expectJournalClean(r.journal.entries, AGENT, r.stand.stub.calls, ["idem-intent-1"]);
      await closeStand();
    }
  });

  it("выдача, отданная наружу, — копия: подмена A5 и цены у вызывающего на решения не влияет (ревью К3 № 1)", async () => {
    const r = await setup({ shops: [{ ...SHOP, profile: bakery({ returns: { days: 0, text: "Возврат в течение 14 дней" } }) }] });
    await signedIntent(r);
    const zones = await r.purchase.search();
    zones.contour[0]!.a5 = [];
    zones.contour[0]!.product.price.amount = 1;
    r.purchase.offers!.contour[0]!.a5 = [];
    await expect(r.purchase.cart(one(zones.contour[0]!, 1), { idempotencyKey: "idem-cart-1" })).rejects.toMatchObject({ code: "A5_NEEDS_HUMAN" });
    expect(r.purchase.state).toBe("OFFERS");
    const decision = humanA5Decision(shownIn(r), r.purchase.offers!.contour[0]!, ["A5_RETURNS_MISMATCH"]);
    const cart = await r.purchase.cart(one(zones.contour[0]!, 1, decision), { idempotencyKey: "idem-cart-1" });
    expect(cart.cart!.total.amount).toBe(TARTINE);
  });

  it("выдача, отданная наружу, — копия: товар рынка, дописанный в contour у вызывающего, — всё равно вне контура", async () => {
    const r = await setup({ shops: [SHOP, { ...SHOP, merchantId: "shop_2", inContour: false }] });
    await signedIntent(r);
    const zones = await r.purchase.search();
    zones.contour.push(zones.market[0]!);
    r.purchase.offers!.contour.push(zones.market[0]!);
    await expect(r.purchase.cart(one(zones.market[0]!, 1), { idempotencyKey: "idem-cart-1" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.reason).toBe("OFFER_NOT_IN_CONTOUR");
  });

  it("сигнал A5 без решения человека — A5_NEEDS_HUMAN; с решением по показанным кодам — CART", async () => {
    const r = await setup({ shops: [{ ...SHOP, profile: bakery({ returns: { days: 0, text: "Возврат в течение 14 дней" } }) }] });
    const offer = await offers(r);
    expect(offer.a5).toEqual(["A5_RETURNS_MISMATCH"]);
    const refused = await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-1" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CartRefused);
    expect(refused).toMatchObject({ code: "A5_NEEDS_HUMAN" });
    expect(r.purchase.state).toBe("OFFERS");
    // решение политики — в журнал конвейером (Р38 п. 5): код сигнала, решение, sku; без текста фида
    expect(r.tail().filter((e) => e.kind === "cart.refused")).toEqual([
      expect.objectContaining({ reason: "A5_RETURNS_MISMATCH", detail: "A5_NEEDS_HUMAN", ref: "tartine", merchant: "shop_1", mandate: r.purchase.intentMandate!.id }),
    ]);
    expectJournalClean(r.journal.entries, AGENT, r.stand.stub.calls, ["idem-intent-1"]);
    const decision = humanA5Decision(shownIn(r), offer, ["A5_RETURNS_MISMATCH"]);
    await r.purchase.cart(one(offer, 1, decision), { idempotencyKey: "idem-cart-1" });
    expect(r.purchase.state).toBe("CART_PENDING");
  });

  it("решение по тому же sku другого магазина — устарело: A5_DECISION_STALE, в cart.refused — все сигналы (Р39 п. 5, Р40 п. 3)", async () => {
    const profile = bakery({ returns: { days: 0, text: "Возврат в течение 14 дней" } });
    const r = await setup({ shops: [{ ...SHOP, profile }, { ...SHOP, profile, merchantId: "shop_2" }] });
    await signedIntent(r, { ...INTENT, merchantScope: ["shop_1", "shop_2"] });
    const zones = await r.purchase.search();
    const [a, b] = ["shop_1", "shop_2"].map((m) => zones.contour.find((o) => o.merchantId === m && o.sku === "tartine")!);
    const decision = humanA5Decision(shownIn(r), a!, a!.a5);
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.cart(one(b!, 1, decision), { idempotencyKey: "idem-cart-1" })).rejects.toMatchObject({ code: "A5_DECISION_STALE" });
    expect(r.tail().filter((e) => e.kind === "cart.refused").map((e) => [e.reason, e.detail, e.merchant])).toEqual([["A5_RETURNS_MISMATCH", "A5_DECISION_STALE", "shop_2"]]);
    expect(r.stand.stub.calls.slice(from)).toEqual([]);
    expect(r.purchase.state).toBe("OFFERS");
  });

  it("решение по подменённой у вызывающего выдаче — устарело: A5_DECISION_STALE, все сигналы в журнал, обращений нет (Р39 п. 5, Р40 п. 3 д, ревью К3 М4)", async () => {
    const r = await setup({ shops: [{ ...SHOP, profile: bakery({ returns: { days: 0, text: "Возврат в течение 14 дней" } }) }] });
    const offer = await offers(r);
    // выдача, отданная наружу, — копия: цена подменена у вызывающего, решение — по подмене
    const tampered = { ...offer, product: { ...offer.product, price: { ...offer.product.price, amount: 1 } } };
    const decision = humanA5Decision(shownIn(r), tampered, tampered.a5);
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.cart(one(offer, 1, decision), { idempotencyKey: "idem-cart-1" })).rejects.toMatchObject({ code: "A5_DECISION_STALE" });
    expect(r.tail().filter((e) => e.kind === "cart.refused").map((e) => [e.reason, e.detail])).toEqual([["A5_RETURNS_MISMATCH", "A5_DECISION_STALE"]]);
    expect(r.stand.stub.calls.slice(from)).toEqual([]);
    expect(r.purchase.state).toBe("OFFERS");
  });

  for (const [name, a5, mode] of [
    ["товар с сигналом A5", true, "IMMEDIATE"],
    ["товар без сигналов", false, "IMMEDIATE"],
    ["автономный режим", true, "AUTONOMOUS"],
  ] as const) {
    it(`копия и подделка решения (${name}) — agent.refused A5_DECISION_FORGED и STOPPED, cart.refused нет, обращений нет (Р40 п. 3 б, п. 4)`, async () => {
      for (const forge of ["copy", "cast"] as const) {
        const r = await setup(a5 ? { shops: [{ ...SHOP, profile: bakery({ returns: { days: 0, text: "Возврат в течение 14 дней" } }) }] } : {});
        await signedIntent(r, { ...INTENT, confirmationMode: mode });
        const offer = (await r.purchase.search()).contour.find((o) => o.sku === "tartine")!;
        const real = humanA5Decision(shownIn(r), offer, offer.a5);
        // структурная копия выданного решения и литерал с приведением типа — оба не выданы оболочкой
        const decision =
          forge === "copy"
            ? { ...real }
            : ({ intentId: real.intentId, merchantId: real.merchantId, sku: real.sku, price: real.price, shown: real.shown, accepted: real.accepted } as unknown as typeof real);
        const from = r.stand.stub.calls.length;
        const start = r.tail().length;
        await expect(r.purchase.cart(one(offer, 1, decision), { idempotencyKey: "idem-cart-1" })).rejects.toBeInstanceOf(PurchaseStopped);
        expect(r.purchase.reason).toBe("A5_DECISION_FORGED");
        const root = r.purchase.intentMandate!.id;
        expect(r.tail().slice(start).map((e) => [e.kind, e.reason, e.ref, e.merchant, e.mandate])).toEqual([
          ["agent.refused", "A5_DECISION_FORGED", "tartine", "shop_1", root],
          ["purchase.stage", "A5_DECISION_FORGED", undefined, undefined, root],
        ]);
        expect(r.stand.stub.calls.slice(from)).toEqual([]);
        expectJournalClean(r.journal.entries, AGENT, r.stand.stub.calls, ["idem-intent-1"]);
        await closeStand();
      }
    });
  }

  it("решение из другой покупки (другой корневой INTENT) — A5_DECISION_STALE, все сигналы в журнал, обращений нет (Р40 п. 1)", async () => {
    const r = await setup({ shops: [{ ...SHOP, profile: bakery({ returns: { days: 0, text: "Возврат в течение 14 дней" } }) }] });
    const offer = await offers(r);
    const decision = humanA5Decision({ intentId: "mnd_other_purchase" }, offer, offer.a5);
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.cart(one(offer, 1, decision), { idempotencyKey: "idem-cart-1" })).rejects.toMatchObject({ code: "A5_DECISION_STALE" });
    expect(r.tail().filter((e) => e.kind === "cart.refused").map((e) => [e.reason, e.detail])).toEqual([["A5_RETURNS_MISMATCH", "A5_DECISION_STALE"]]);
    expect(r.stand.stub.calls.slice(from)).toEqual([]);
    expect(r.purchase.state).toBe("OFFERS");
  });

  it("решение одноразовое: после CART и возврата в OFFERS то же решение — A5_DECISION_STALE, новое решение по тому же показу — CART (Р40 п. 2)", async () => {
    const profile = bakery({ returns: { days: 0, text: "Возврат в течение 14 дней" } });
    // живая проверка: перед первым CART — ok, перед заказом — нет в наличии; перед вторым CART — ok (Р43 п. 1)
    const r = await setup({ shops: [{ ...SHOP, profile }], live: liveOffers(SHOP, () => stand!.clock, (_, n) => (n === 2 ? { availability: { inStock: false } } : {})) });
    const offer = await offers(r);
    const decision = humanA5Decision(shownIn(r), offer, offer.a5);
    const cart = await r.purchase.cart(one(offer, 1, decision), { idempotencyKey: "idem-cart-1" });
    r.setFeed({ kind: "event", event: r.consents.sign(cart.id) });
    await r.purchase.awaitCart();
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toBeInstanceOf(OrderRefused);
    expect(r.purchase.state).toBe("OFFERS");
    // показ тот же (выдача не менялась), покупка та же — решение потрачено на первый CART
    const from = r.stand.stub.calls.length;
    const start = r.tail().length;
    await expect(r.purchase.cart(one(offer, 1, decision), { idempotencyKey: "idem-cart-2" })).rejects.toMatchObject({ code: "A5_DECISION_STALE" });
    expect(r.tail().slice(start).filter((e) => e.kind === "cart.refused").map((e) => [e.reason, e.detail])).toEqual([["A5_RETURNS_MISMATCH", "A5_DECISION_STALE"]]);
    expect(r.stand.stub.calls.slice(from)).toEqual([]);
    expect(r.purchase.state).toBe("OFFERS");
    await r.purchase.cart(one(offer, 1, humanA5Decision(shownIn(r), offer, offer.a5)), { idempotencyKey: "idem-cart-2" });
    expect(r.purchase.state).toBe("CART_PENDING");
  });

  for (const [name, code, attempts] of [
    ["отказ Платформы", "REQUEST_INVALID", 1],
    ["сбой Платформы на всех попытках", "STATE_UNAVAILABLE", loadParams().pao_max_attempts],
  ] as const) {
    it(`решение тратится и при исходе запроса CART «${name}» — ${code} (fail-closed, Р40 п. 2)`, async () => {
      const r = await setup({ shops: [{ ...SHOP, profile: bakery({ returns: { days: 0, text: "Возврат в течение 14 дней" } }) }] });
      const offer = await offers(r);
      const decision = humanA5Decision(shownIn(r), offer, offer.a5);
      const before = r.stand.log().filter((c) => c.op === "POST /pao/v1/mandates").length;
      r.stand.stub.fail("POST /pao/v1/mandates", { code }, attempts);
      await expect(r.purchase.cart(one(offer, 1, decision), { idempotencyKey: "idem-cart-1" })).rejects.toBeInstanceOf(PlatformFailure);
      expect(r.purchase.reason).toBe(code);
      // запрос CART ушёл — решение потрачено при любом исходе
      expect(r.stand.log().filter((c) => c.op === "POST /pao/v1/mandates").length).toBe(before + attempts);
      expect(isSpent(decision)).toBe(true);
    });
  }

  it("товар без сигналов A5 — решение не нужно и не тратится (нюанс К2 Р40)", async () => {
    const r = await setup();
    const offer = await offers(r);
    expect(offer.a5).toEqual([]);
    const decision = humanA5Decision(shownIn(r), offer, []);
    await r.purchase.cart(one(offer, 1, decision), { idempotencyKey: "idem-cart-1" });
    expect(r.purchase.state).toBe("CART_PENDING");
    expect(isSpent(decision)).toBe(false);
  });

  it("частичное согласие человека — в cart.refused только непринятые сигналы (ревью К5 № 2)", async () => {
    const feed = SHOP.feed.replace("Цена 450 ₽", "Цена 500 ₽");
    const r = await setup({ shops: [{ ...SHOP, feed, profile: bakery({ returns: { days: 0, text: "Возврат в течение 14 дней" } }) }] });
    const offer = await offers(r);
    expect([...offer.a5].sort()).toEqual(["A5_PRICE_MISMATCH", "A5_RETURNS_MISMATCH"]);
    const decision = humanA5Decision(shownIn(r), offer, ["A5_RETURNS_MISMATCH"]);
    await expect(r.purchase.cart(one(offer, 1, decision), { idempotencyKey: "idem-cart-1" })).rejects.toMatchObject({ code: "A5_NEEDS_HUMAN" });
    expect(r.tail().filter((e) => e.kind === "cart.refused").map((e) => e.reason)).toEqual(["A5_PRICE_MISMATCH"]);
    // отказ политики до запроса CART — решение не потрачено (Р40 п. 2)
    expect(isSpent(decision)).toBe(false);
  });

  it("сигнал A5 при автономном режиме — A5_AUTONOMOUS, решение человека не помогает", async () => {
    const r = await setup({ shops: [{ ...SHOP, profile: bakery({ returns: { days: 0, text: "Возврат в течение 14 дней" } }) }] });
    await signedIntent(r, { ...INTENT, confirmationMode: "AUTONOMOUS" });
    const offer = (await r.purchase.search()).contour[0]!;
    const decision = humanA5Decision(shownIn(r), offer, offer.a5);
    const refused = await r.purchase.cart(one(offer, 1, decision), { idempotencyKey: "idem-cart-1" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CartRefused);
    expect(refused).toMatchObject({ code: "A5_AUTONOMOUS" });
    expect(r.purchase.state).toBe("OFFERS");
    expect(r.tail().filter((e) => e.kind === "cart.refused").map((e) => [e.reason, e.detail, e.ref])).toEqual([["A5_RETURNS_MISMATCH", "A5_AUTONOMOUS", offer.sku]]);
  });
});

describe("стадия 3 — отказ витрины на заказе (Р42 п. 4): остановка этой сделки, не агента", () => {
  for (const code of ["SHOP_ORDER_REFUSED", "SHOP_ORDER_STATE_UNKNOWN"] as const) {
    it(`${code} — STOPPED сделки, заказ не повторяется; агент работает: новый мандат запрашивается`, async () => {
      let orders = 0;
      const r = await setup({ shop: { ...READY, order: async () => (orders++, Promise.reject(new ShopFailure(code))) } });
      await signedCart(r, await offers(r));
      await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toBeInstanceOf(ShopFailure);
      expect(r.purchase.state).toBe("STOPPED");
      expect(r.purchase.reason).toBe(code);
      expect(orders).toBe(1);
      expect(r.tail().some((e) => e.kind === "agent.stopped")).toBe(false);
      // другие сделки идут: подпись агента не остановлена
      expect((await r.core.mandates.request(INTENT, { idempotencyKey: "idem-intent-2" })).kind).toBe("INTENT");
    });
  }
});

describe("стадия 3 — корзина по живой цене перед CART, количество до обращений (Р43)", () => {
  it("CART под действующим INTENT: позиция и итог — по живой цене продавца перед запросом, 2 шт. (П10, Р43 п. 1–2)", async () => {
    const live = { amount: TARTINE, currency: "RUB" };
    const r = await setup();
    const offer = await offers(r);
    const from = r.stand.stub.calls.length;
    const cart = await r.purchase.cart(one(offer, 2), { idempotencyKey: "idem-cart-1" });
    // живая проверка — после verify INTENT и до запроса CART: одна, по выбору человека
    expect(r.live.calls).toEqual([{ sku: "tartine", quantity: 2, region: "77" }]);
    expect(opsFrom(r, from)).toEqual([VERIFY, "POST /pao/v1/mandates"]);
    expect(cart).toMatchObject({ kind: "CART", parentId: r.purchase.intentMandate!.id });
    expect(cart.cart).toEqual({ merchantId: "shop_1", lines: [{ sku: "tartine", qty: 2, price: live }], total: { amount: 2 * TARTINE, currency: "RUB" } });
  });

  const cases = [
    ["цена выросла", { price: { amount: TARTINE + 100, currency: "RUB" } }, "NEW_CART_MANDATE", ["LIVE_PRICE_UP"]],
    ["цена снизилась", { price: { amount: TARTINE - 100, currency: "RUB" } }, "NEW_CART_MANDATE", ["LIVE_PRICE_DOWN"]],
    ["нет в наличии", { availability: { inStock: false } }, "TELL_STOCK", ["LIVE_OUT_OF_STOCK"]],
    ["не хватает количества на 2 шт.", { availability: { inStock: true, quantity: 1 } }, "TELL_STOCK", ["LIVE_QUANTITY"]],
    ["цена в другой валюте", { price: { amount: TARTINE, currency: "USD" } }, "TELL_UNCONFIRMED", ["LIVE_CURRENCY"]],
  ] as const;
  for (const [name, over, next, codes] of cases) {
    it(`${name} перед CART — CartLiveRefused ${next}, CART не запрошен, покупка в OFFERS (Р43 п. 1, Р32 п. 4)`, async () => {
      const r = await setup({ live: liveOffers(SHOP, () => stand!.clock, () => over) });
      const offer = await offers(r);
      const from = r.stand.stub.calls.length;
      const err = await r.purchase.cart(one(offer, 2), { idempotencyKey: "idem-cart-1" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CartLiveRefused);
      expect(err).toMatchObject({ next, codes });
      expect(r.purchase.state).toBe("OFFERS");
      expect(r.purchase.cartMandate).toBeNull();
      // verify INTENT — до живой проверки (П05), CART не запрошен
      expect(opsFrom(r, from)).toEqual([VERIFY]);
      expect(r.tail().filter((e) => e.kind === "cart.live_refused").map((e) => [e.reason, e.detail, e.ref, e.merchant, e.mandate])).toEqual(
        codes.map((c) => [c, next, "tartine", "shop_1", r.purchase.intentMandate!.id]),
      );
      expectJournalClean(r.journal.entries, AGENT, r.stand.stub.calls, ["idem-intent-1"]);
    });
  }

  it("INTENT отозван у Платформы, события ещё нет — verify до живой проверки: STOPPED, к витрине ни одного обращения (П05)", async () => {
    const r = await setup();
    const offer = await offers(r);
    r.consents.mandates.get(r.purchase.intentMandate!.id)!.status = "REVOKED";
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-1" })).rejects.toBeInstanceOf(MandateRefused);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.live.calls).toEqual([]);
    expect(opsFrom(r, from)).toEqual([VERIFY]);
  });

  it("отзыв INTENT пришёл по ленте во время живой проверки — STOPPED MANDATE_REVOKED, CART не запрошен, решение A5 не потрачено (Р38 п. 3)", async () => {
    const ok = liveOffers(SHOP, () => stand!.clock);
    const at: { run?: PurchaseRun } = {};
    const r = await setup({
      shops: [{ ...SHOP, profile: bakery({ returns: { days: 0, text: "Возврат в течение 14 дней" } }) }],
      live: {
        fetch: async (req, signal) => {
          const id = at.run!.purchase.intentMandate!.id;
          at.run!.consents.mandates.get(id)!.status = "REVOKED";
          await at.run!.core.mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", id) });
          return ok.fetch(req, signal);
        },
      },
    });
    at.run = r;
    const offer = await offers(r);
    const decision = humanA5Decision(shownIn(r), offer, offer.a5);
    const before = r.stand.log().filter((c) => c.op === "POST /pao/v1/mandates").length;
    await expect(r.purchase.cart(one(offer, 1, decision), { idempotencyKey: "idem-cart-1" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.reason).toBe("MANDATE_REVOKED");
    expect(r.stand.log().filter((c) => c.op === "POST /pao/v1/mandates").length).toBe(before);
    expect(isSpent(decision)).toBe(false);
  });

  it("журнал не принял cart.live_refused — STOPPED UNKNOWN, CART не запрошен (инвариант 4)", async () => {
    const boom = new Error("журнал недоступен");
    const r = await setup({
      live: liveOffers(SHOP, () => stand!.clock, () => ({ availability: { inStock: false } })),
      tap: (e) => {
        if (e.kind === "cart.live_refused") throw boom;
      },
    });
    const offer = await offers(r);
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-1" })).rejects.toBe(boom);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("UNKNOWN");
    expect(opsFrom(r, from)).toEqual([VERIFY]);
  });

  it("продавец не ответил перед CART — LIVE_UNAVAILABLE, CART не запрошен; решение A5 не потрачено", async () => {
    const r = await setup({ shops: [{ ...SHOP, profile: bakery({ returns: { days: 0, text: "Возврат в течение 14 дней" } }) }], live: { fetch: () => Promise.reject(new Error("сбой")) } });
    const offer = await offers(r);
    const decision = humanA5Decision(shownIn(r), offer, offer.a5);
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.cart(one(offer, 1, decision), { idempotencyKey: "idem-cart-1" })).rejects.toMatchObject({ next: "TELL_UNCONFIRMED", codes: ["LIVE_UNAVAILABLE"] });
    expect(opsFrom(r, from)).toEqual([VERIFY]);
    expect(isSpent(decision)).toBe(false);
    expect(r.purchase.state).toBe("OFFERS");
  });

  it("количество — снимком выбора: геттер отдаёт 1, затем 5 — в живой проверке и CART одно количество 1 (ревью К1, блокер 1)", async () => {
    const r = await setup();
    const offer = await offers(r);
    let reads = 0;
    const choice = { merchantId: offer.merchantId, keyTermsShown: true, lines: [{ sku: offer.sku, get qty() { return ++reads === 1 ? 1 : 5; } }] };
    const cart = await r.purchase.cart(choice, { idempotencyKey: "idem-cart-1" });
    expect(reads).toBe(1);
    expect(r.live.calls).toEqual([{ sku: "tartine", quantity: 1, region: "77" }]);
    expect(cart.cart).toMatchObject({ lines: [{ qty: 1 }], total: { amount: TARTINE } });
  });

  it("бросающий геттер выбора — отказ промиса, покупка в OFFERS, обращений нет", async () => {
    const r = await setup();
    const offer = await offers(r);
    const before = r.stand.log().length;
    const boom = new Error("геттер");
    const choice = { merchantId: offer.merchantId, keyTermsShown: true, lines: [{ sku: offer.sku, get qty(): number { throw boom; } }] };
    await expect(r.purchase.cart(choice, { idempotencyKey: "idem-cart-1" })).rejects.toBe(boom);
    expect(r.purchase.state).toBe("OFFERS");
    expect(r.live.calls).toEqual([]);
    expect(r.stand.log().length).toBe(before);
  });

  it("количество не целое ≥ 1 или итог не безопасное целое — STOPPED CART_QTY_INVALID, agent.refused, ни проверки, ни обращений (Р43 п. 3)", async () => {
    for (const qty of [0, -1, 1.5, Number.NaN, Math.floor(Number.MAX_SAFE_INTEGER / TARTINE) + 1]) {
      const r = await setup();
      const offer = await offers(r);
      const before = r.stand.log().length;
      await expect(r.purchase.cart(one(offer, qty), { idempotencyKey: "idem-cart-1" })).rejects.toBeInstanceOf(PurchaseStopped);
      expect(r.purchase.reason).toBe("CART_QTY_INVALID");
      expect(r.atStop().slice(-2).map((e) => [e.kind, e.reason, e.ref])).toEqual([
        ["agent.refused", "CART_QTY_INVALID", "tartine"],
        ["purchase.stage", "CART_QTY_INVALID", undefined],
      ]);
      expect(r.live.calls).toEqual([]);
      expect(r.stand.log().length).toBe(before);
      expectJournalClean(r.journal.entries, AGENT, r.stand.stub.calls, ["idem-intent-1"]);
      await closeStand();
    }
  });
});

describe("стадия 3 — живая проверка перед заказом (Р32 п. 3–4): не ok — CART_ACTIVE → OFFERS, заказа нет", () => {
  const cases = [
    ["цена выросла", { price: { amount: TARTINE + 100, currency: "RUB" } }, "NEW_CART_MANDATE", ["LIVE_PRICE_UP"]],
    ["нет в наличии", { availability: { inStock: false } }, "TELL_STOCK", ["LIVE_OUT_OF_STOCK"]],
  ] as const;
  for (const [name, over, next, codes] of cases) {
    it(`${name} — OrderRefused ${next}`, async () => {
      // перед CART — ok, перед заказом — ответ случая (Р43 п. 1)
      const r = await setup({ live: liveOffers(SHOP, () => stand!.clock, (_, n) => (n > 1 ? over : {})) });
      await signedCart(r, await offers(r));
      const err = await r.purchase.placeOrder({ idempotencyKey: "idem-order-1" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OrderRefused);
      expect(err).toMatchObject({ next, codes });
      expect(r.purchase.state).toBe("OFFERS");
      expect(r.shop.calls).toEqual([]);
      // заказа нет — запись конвейера на каждый код проверки (Р38 п. 5)
      expect(r.tail().filter((e) => e.kind === "order.live_refused").map((e) => [e.reason, e.detail, e.ref, e.merchant, e.mandate])).toEqual(
        codes.map((c) => [c, next, "tartine", "shop_1", r.purchase.intentMandate!.id]),
      );
      expectJournalClean(r.journal.entries, AGENT, r.stand.stub.calls, ["idem-intent-1", "idem-cart-1"]);
    });
  }

  it("продавец не ответил — LIVE_UNAVAILABLE, «не подтверждено»; новый выбор после отказа — снова CART", async () => {
    // перед CART — ok, перед заказом — сбой, перед новым CART — снова ok (Р43 п. 1)
    const ok = liveOffers(SHOP, () => stand!.clock);
    const r = await setup({ live: { fetch: (req, signal) => (ok.calls.length === 1 ? (ok.calls.push(req), Promise.reject(new Error("сбой"))) : ok.fetch(req, signal)) } });
    const offer = await offers(r);
    await signedCart(r, offer);
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toMatchObject({ next: "TELL_UNCONFIRMED", codes: ["LIVE_UNAVAILABLE"] });
    expect(r.tail().filter((e) => e.kind === "order.live_refused").map((e) => [e.reason, e.detail])).toEqual([["LIVE_UNAVAILABLE", "TELL_UNCONFIRMED"]]);
    await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-2" });
    expect(stages(r).slice(-3)).toEqual(["CART_ACTIVE", "OFFERS", "CART_PENDING"]);
  });
});

describe("стадия 3 — сверка суммы заказа (Т6)", () => {
  it("сумма заказа ≠ CART — STOPPED ORDER_REPLY_MISMATCH, оплаты нет", async () => {
    const r = await setup({ shop: shopOrders(SHOP, () => ({ amount: TARTINE - 1, currency: "RUB" })) });
    await signedCart(r, await offers(r));
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toMatchObject({ code: "ORDER_REPLY_MISMATCH" });
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.order).toBeNull();
    expect(r.payment.calls).toEqual([]);
  });

  it("валюта заказа ≠ CART — STOPPED ORDER_REPLY_MISMATCH", async () => {
    const r = await setup({ shop: shopOrders(SHOP, () => ({ amount: TARTINE, currency: "USD" })) });
    await signedCart(r, await offers(r));
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toMatchObject({ code: "ORDER_REPLY_MISMATCH" });
  });

  it("CART отозван до заказа — STOPPED MANDATE_REVOKED (STOP_ALL: ORDER), ни проверки, ни заказа", async () => {
    const r = await setup();
    const cart = await signedCart(r, await offers(r));
    r.consents.mandates.get(cart.id)!.status = "REVOKED";
    await r.core.mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", cart.id) });
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.reason).toBe("MANDATE_REVOKED");
    expect(r.purchase.unfinished).toBe("ORDER");
    // только проверка перед CART (Р43 п. 1); перед заказом — нет
    expect(r.live.calls).toHaveLength(1);
    expect(r.shop.calls).toEqual([]);
  });
});

describe("стадии 4–6 — исходы из порта PaymentSteps (инварианты 7, 8)", () => {
  it("стадия 4 после стадии 5 (Р47 п. 2, 6): AUTHORIZING → CONFIRMING → STOPPED с кодом исхода; CONFIRMING → AUTHORIZING не проходит ни один исход", async () => {
    for (const [outcome, code] of [
      ["APPROVED", "CONFIRMATION_NOT_DELIVERED"],
      ["REJECTED", "CONFIRMATION_REJECTED"],
      ["EXPIRED", "CONFIRMATION_EXPIRED"],
      ["UNBOUND", "CONFIRMATION_UNBOUND"],
      ["NONE", "OPERATION_RESULT_UNCONFIRMED"],
      // пакет ушёл: неитоговый код — OPERATION_RESULT_UNCONFIRMED (Р49 п. 2, блокер Р-298)
      ["UNKNOWN", "OPERATION_RESULT_UNCONFIRMED"],
    ] as const) {
      const steps = confirming(outcome);
      const notified: string[] = [];
      const r = await setup({ payment: steps, notify: (c) => void notified.push(c) });
      await ordered(r, Math.floor(THRESHOLD / TARTINE) + 1);
      await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" }), outcome).rejects.toMatchObject({ code });
      expect(steps.calls).toEqual(["authorize", "confirm"]);
      expect(stages(r).slice(-3), outcome).toEqual(["AUTHORIZING", "CONFIRMING", `STOPPED:${code}`]);
      // уведомление — только по привязанному PENDING (В3): без запроса (NONE) и без привязки (UNBOUND) — нет
      expect(notified).toEqual(outcome === "NONE" || outcome === "UNBOUND" ? [] : ["CONFIRMATION_PENDING"]);
      // в ч. 1 из CONFIRMING — только в STOPPED: повтора авторизации нет (Р47 п. 6, ч. 2)
      expect(r.tail().some((e) => e.kind === "agent.refused" && e.detail === "CONFIRMING->AUTHORIZING")).toBe(false);
      expect(stages(r).filter((x) => x === "AUTHORIZING")).toHaveLength(1);
      await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
      expect(steps.calls).toEqual(["authorize", "confirm"]);
      await closeStand();
    }
  });

  it("стадия 4 и ниже порога: требование подтверждения от Платформы (порог банка ниже, Р-142) — тот же путь", async () => {
    const steps = confirming("REJECTED");
    const r = await setup({ payment: steps });
    await ordered(r);
    expect(r.purchase.needsConfirmation).toBe(false);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "CONFIRMATION_REJECTED" });
    expect(stages(r).slice(-2)).toEqual(["CONFIRMING", "STOPPED:CONFIRMATION_REJECTED"]);
  });

  it("уведомление оболочки (В3): исключение и отказ обещания — notify.failed, исход прежний; висящее — не ждётся", async () => {
    const cases: [string, () => void | Promise<void>, string[]][] = [
      [
        "исключение",
        () => {
          throw new Error("оболочка упала");
        },
        ["CONFIRMATION_PENDING"],
      ],
      ["отказ обещания", () => Promise.reject(new Error("оболочка отказала")), ["CONFIRMATION_PENDING"]],
      ["висящее обещание", () => new Promise<void>(() => undefined), []],
    ];
    for (const [name, notify, failed] of cases) {
      const r = await setup({ payment: confirming("REJECTED"), notify });
      await ordered(r);
      await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" }), name).rejects.toMatchObject({ code: "CONFIRMATION_REJECTED" });
      await new Promise((res) => setImmediate(res));
      expect(r.tail().filter((e) => e.kind === "notify.failed").map((e) => e.reason), name).toEqual(failed);
      await closeStand();
    }
  });

  it("нет перехода ORDERED → CONFIRMING и публичного confirm() (Р47 п. 2, В3 п. 4)", () => {
    expect("confirm" in Purchase.prototype).toBe(false);
  });

  it("граница порога (Т7): итог ровно confirm_above_kop — сведения «не выше порога», на копейку выше — «выше» (воротами не служат, Р47 п. 2)", async () => {
    for (const [limit, needs] of [[2 * TARTINE, false], [2 * TARTINE - 1, true]] as const) {
      const r = await setup({ params: { confirm_above_kop: limit } });
      await ordered(r, 2);
      expect(r.purchase.needsConfirmation).toBe(needs);
      await closeStand();
    }
  });

  it("мандат корзины, отданный наружу, — копия: подмена итога не меняет сведения о пороге (ревью К3 № 3)", async () => {
    const r = await setup();
    await ordered(r, Math.floor(THRESHOLD / TARTINE) + 1);
    const cart = r.purchase.cartMandate!;
    cart.cart!.total.amount = 1;
    expect(r.purchase.needsConfirmation).toBe(true);
  });

  it("снимок CART свой (после подписи и сразу ACTIVE): изменение объекта в держимых клиента мандатов не меняет сведения о пороге", async () => {
    for (const immediate of [false, true]) {
      const r = await setup();
      const qty = Math.floor(THRESHOLD / TARTINE) + 1;
      if (immediate) {
        const offer = await offers(r);
        r.consents.tamper = (m) => (m.parent_id ? Object.assign(m, { status: "ACTIVE" }) : m);
        await r.purchase.cart(one(offer, qty), { idempotencyKey: "idem-cart-1" });
      } else await signedCart(r, await offers(r), qty);
      const held = r.core.mandates.held().find((m) => m.kind === "CART")!;
      (held.cart!.total as { amount: number }).amount = 1;
      expect(r.purchase.needsConfirmation).toBe(true);
      await closeStand();
    }
  });

  it("код «ждать подписи» из порта оплаты — не ожидание: STOPPED, авторизации нет (ревью К3 повторное Н1)", async () => {
    for (const step of ["confirm", "authorize"] as const) {
      const steps = payments();
      const refuse = () => Promise.reject(new MandateRefused("MANDATE_SIGNATURE_PENDING", "ждём человека"));
      const needConfirm = () => (steps.calls.push("authorize"), Promise.reject(new PaymentFailure("CONFIRMATION_REQUIRED")));
      const r = await setup({ payment: { ...steps, ...(step === "confirm" ? { authorize: needConfirm, confirm: refuse } : { authorize: refuse }) } });
      await ordered(r, 1);
      await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(MandateRefused);
      expect(stages(r).at(-1)).toBe("STOPPED:MANDATE_SIGNATURE_PENDING");
      expect(steps.calls).toEqual(step === "confirm" ? ["authorize"] : []);
      if (step === "confirm") expect(stages(r)).toContain("CONFIRMING");
      await closeStand();
    }
  });

  it("машина покупки вызывающему не дана: переходы — только стадиями (ревью К3 повторное Н2)", async () => {
    const r = await setup();
    expect("machine" in r.purchase).toBe(false);
    expect(Object.values(r.purchase).some((v) => v instanceof PurchaseMachine)).toBe(false);
  });

  it("авторизация, пока стадия 4 ждёт человека, — запрещённый переход; ожидание прервано остановкой (ревью К3 № 4)", async () => {
    // порт подтверждения начал ждать человека — уже в CONFIRMING; ждёт, пока покупку не остановят
    let started: () => void = () => {};
    const entered = new Promise<void>((res) => (started = res));
    const steps = payments();
    const confirm = (_c: unknown, _n: unknown, signal: AbortSignal) =>
      new Promise<ConfirmationOutcome>((_res, rej) => (started(), signal.addEventListener("abort", () => rej(signal.reason), { once: true })));
    let authorized = 0;
    const r = await setup({ payment: { ...steps, authorize: () => (authorized++, Promise.reject(new PaymentFailure("CONFIRMATION_REQUIRED"))), confirm } });
    await ordered(r, Math.floor(THRESHOLD / TARTINE) + 1);
    const waiting = r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
    await entered;
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-2" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    // параллельный вызов не дошёл ни до порта, ни до контура
    expect(authorized).toBe(1);
    expect(r.stand.stub.calls.slice(from)).toEqual([]);
    expect(r.tail().filter((e) => e.reason === "PIPELINE_TRANSITION_FORBIDDEN" && e.kind === "agent.refused").map((e) => e.detail)).toEqual(["CONFIRMING->AUTHORIZING"]);
    await expect(waiting).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("PIPELINE_TRANSITION_FORBIDDEN");
  });

  it("повторный вход в идущую стадию — запрещённый переход (два cart() подряд)", async () => {
    const r = await setup();
    const offer = await offers(r);
    const first = r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-1" });
    await expect(r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-2" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    await expect(first).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.stand.log().filter((c) => c.op === "POST /pao/v1/mandates")).toHaveLength(1);
  });

  it("ответ порта со статусом CONFIRMATION_REQUIRED — стадия 4 (Р47 п. 2); одобрение до канала к продавцу — CONFIRMATION_NOT_DELIVERED, без повтора", async () => {
    const r = await setup({ payment: payments({ authorize: { status: "CONFIRMATION_REQUIRED" } }) });
    await ordered(r);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "CONFIRMATION_NOT_DELIVERED" });
    expect(r.payment.calls).toEqual(["authorize", "confirm"]);
    expect(stages(r).slice(-3)).toEqual(["AUTHORIZING", "CONFIRMING", "STOPPED:CONFIRMATION_NOT_DELIVERED"]);
    await expect(r.purchase.settle()).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
  });

  it("операция отклонена — STOPPED с кодом причины (SPEC §7б); неизвестная причина — DECLINE_REASON_UNKNOWN", async () => {
    for (const [reason, code] of [["INSUFFICIENT_FUNDS", "INSUFFICIENT_FUNDS"], ["LIMIT_EXCEEDED", "DECLINED_LIMIT_EXCEEDED"], ["ISSUER_DECLINED", "ISSUER_DECLINED"], ["что-то новое", "DECLINE_REASON_UNKNOWN"]] as const) {
      const r = await setup({ payment: payments({ authorize: { status: "DECLINED", declineReason: reason } }) });
      await ordered(r);
      await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code });
      expect(stages(r).at(-1)).toBe(`STOPPED:${code}`);
      expect(r.payment.calls).toEqual(["authorize"]);
      await closeStand();
    }
  });

  it("Р50 дополнение 1 п. 3: подпись приостановлена после отправки пакета — итоговый OPERATION_RESULT_UNCONFIRMED (Р-298), исходный код — в payment.unconfirmed", async () => {
    const r = await setup({
      failureCode: startFailureCode,
      payment: { ...payments(), authorize: async (c: PaymentContext) => (c.sending(), Promise.reject(new SignerSuspended("EVENTS_UNAVAILABLE"))) },
    });
    await ordered(r);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(stages(r).at(-1)).toBe("STOPPED:OPERATION_RESULT_UNCONFIRMED");
    expect(r.tail().filter((e) => e.kind === "payment.unconfirmed").map((e) => e.reason)).toEqual(["EVENTS_UNAVAILABLE"]);
  });

  it("Р50 п. 4: 409 MANDATE_REVOKED на стадии 5 до пакета — STOP_ALL: мандаты сняты с удержания, purchase.unfinished PAYMENT", async () => {
    // отказ задан подменным портом оплаты; от контура (PaoStub, POST /pao/v1/credentials) — сценарий П22
    const revoked = new PlatformFailure("MANDATE_REVOKED", "never", "MANDATE_REVOKED", 409, null);
    const r = await setup({ payment: { ...payments(), authorize: () => Promise.reject(revoked) } });
    await ordered(r);
    const ids = [r.purchase.intentMandate!.id, r.purchase.cartMandate!.id];
    expect(r.core.mandates.held().map((m) => m.id)).toEqual(expect.arrayContaining(ids));
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBe(revoked);
    expect(stages(r).at(-1)).toBe("STOPPED:MANDATE_REVOKED");
    expect(r.purchase.next).toBe("STOP_ALL");
    expect(r.purchase.unfinished).toBe("PAYMENT");
    expect(r.core.mandates.held().map((m) => m.id)).not.toEqual(expect.arrayContaining([ids[0]]));
    expect(r.core.mandates.held().map((m) => m.id)).not.toEqual(expect.arrayContaining([ids[1]]));
    expect(r.tail().filter((e) => e.kind === "purchase.unfinished").map((e) => [e.reason, e.detail])).toEqual([["MANDATE_REVOKED", "PAYMENT"]]);
  });

  it("Р50 п. 4: ворота видят CART отозванным (GET REVOKED) — STOP_ALL с MANDATE_REVOKED, реквизит не запрашивается", async () => {
    const r = await setup();
    await ordered(r);
    const cart = r.purchase.cartMandate!.id;
    r.consents.mandates.get(cart)!.status = "REVOKED";
    await r.core.mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", cart) });
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "MANDATE_REVOKED", next: "STOP_ALL", unfinished: "PAYMENT" });
    expect(r.payment.calls).toEqual([]);
    expect(r.core.mandates.held().map((m) => m.id)).toEqual([]);
  });

  it("Р50 п. 4 (ревью КТ1 № 1): причина §7б MANDATE_REVOKED после пакета — STOP_ALL; итог известен — PAYMENT, а не PAYMENT_OUTCOME", async () => {
    const r = await setup({ payment: payments({ authorize: { status: "DECLINED", declineReason: "MANDATE_REVOKED" } }) });
    await ordered(r);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "DECLINED_MANDATE_REVOKED", next: "STOP_ALL", unfinished: "PAYMENT" });
    expect(r.tail().filter((e) => e.kind === "purchase.unfinished").map((e) => e.detail)).toEqual(["PAYMENT"]);
  });

  it("Р50 п. 4 (ревью КТ1 № 3): журнал не принял purchase.unfinished — мандаты не сняты (решение без записи не исполняется), наружу — сбой журнала", async () => {
    const down = new Error("журнал недоступен");
    const revoked = new PlatformFailure("MANDATE_REVOKED", "never", "MANDATE_REVOKED", 409, null);
    const r = await setup({
      payment: { ...payments(), authorize: () => Promise.reject(revoked) },
      tap: (e) => {
        if (e.kind === "purchase.unfinished") throw down;
      },
    });
    await ordered(r);
    const ids = [r.purchase.intentMandate!.id, r.purchase.cartMandate!.id];
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBe(down);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.core.mandates.held().map((m) => m.id)).toEqual(expect.arrayContaining(ids));
  });

  it("Р50 п. 4 (ревью КТ1 № 4): CART отозван, пока ждали его подписи (GET в awaitSigned — REVOKED), — STOP_ALL MANDATE_REVOKED, ORDER", async () => {
    const r = await setup();
    await signedIntent(r);
    const offer = (await r.purchase.search()).contour[0]!;
    const cart = await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-1" });
    r.consents.mandates.get(cart.id)!.status = "REVOKED";
    r.setFeed({ kind: "event", event: event("mandate.revoked", cart.id) });
    await expect(r.purchase.awaitCart()).rejects.toBeInstanceOf(MandateRefused);
    expect(r.purchase.reason).toBe("MANDATE_REVOKED");
    expect(r.purchase.next).toBe("STOP_ALL");
    expect(r.purchase.unfinished).toBe("ORDER");
    expect(r.core.mandates.held()).toEqual([]);
  });

  it("Р50 п. 4 (ревью КТ1 № 5): INTENT вышел не отзывом, CART отозван — в воротах код отзыва, порядок мандатов не влияет", async () => {
    const r = await setup();
    await ordered(r);
    const intent = r.purchase.intentMandate!.id;
    const cart = r.purchase.cartMandate!.id;
    r.consents.mandates.get(intent)!.status = "EXHAUSTED";
    await r.core.mandates.refreshHeld({ kind: "event", event: event("mandate.exhausted", intent) });
    r.consents.mandates.get(cart)!.status = "REVOKED";
    await r.core.mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", cart) });
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "MANDATE_REVOKED", next: "STOP_ALL" });
    expect(r.tail().filter((e) => e.kind === "agent.refused").map((e) => e.mandate)).toEqual([cart]);
  });

  it("Р50 п. 4: NEW_MANDATE и ASK_HUMAN — next из таблицы, без STOP_ALL (мандаты не снимаются, отчёта нет)", async () => {
    for (const [code, next] of [["MANDATE_EXPIRED", "NEW_MANDATE"], ["LIMIT_EXCEEDED", "ASK_HUMAN"]] as const) {
      const r = await setup({ payment: { ...payments(), authorize: () => Promise.reject(new PlatformFailure(code, "after_human", code, 409, null)) } });
      await ordered(r);
      const intent = r.purchase.intentMandate!.id;
      await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code });
      expect(r.purchase.next).toBe(next);
      expect(r.purchase.unfinished).toBeNull();
      expect(r.core.mandates.held().map((m) => m.id)).toContain(intent);
      expect(r.tail().filter((e) => e.kind === "purchase.unfinished")).toEqual([]);
      await closeStand();
    }
  });

  it("Р50 дополнение 1: подпись приостановлена до отправки пакета — код приостановки, не UNKNOWN", async () => {
    const r = await setup({ failureCode: startFailureCode, payment: { ...payments(), authorize: () => Promise.reject(new SignerSuspended("EVENTS_UNAVAILABLE")) } });
    await ordered(r);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(SignerSuspended);
    expect(stages(r).at(-1)).toBe("STOPPED:EVENTS_UNAVAILABLE");
  });

  it("расчёт не SETTLED, не REFUNDED и не REVERSED — STOPPED, после одобрения итоговым кодом OPERATION_RESULT_UNCONFIRMED (инвариант 4, Р49 п. 2; REVERSED — Р51 п. 3)", async () => {
    const r = await setup({ payment: payments({ settle: "DECLINED" }) });
    await ordered(r);
    await r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
    await expect(r.purchase.settle()).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.tail().filter((e) => e.kind === "payment.unconfirmed").map((e) => e.reason)).toEqual(["UNKNOWN"]);
  });

  it("сбой порта оплаты — STOPPED UNKNOWN, исходная ошибка наружу", async () => {
    const boom = new Error("шлюз недоступен");
    const r = await setup({ payment: { ...payments(), authorize: () => Promise.reject(boom) } });
    await ordered(r);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBe(boom);
    expect(r.purchase.reason).toBe("UNKNOWN");
  });

  it("Р49 п. 4: операция не сходится с заказом и CART — STOPPED OPERATION_REPLY_MISMATCH (итоговый код и после отправки пакета)", async () => {
    const steps = { ...payments(), authorize: (c: PaymentContext) => (c.sending(), Promise.reject(new PaymentFailure("OPERATION_REPLY_MISMATCH"))) };
    const r = await setup({ payment: steps });
    await ordered(r);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "OPERATION_REPLY_MISMATCH" });
    expect(r.purchase.reason).toBe("OPERATION_REPLY_MISMATCH");
    expect(r.tail().some((e) => e.kind === "payment.unconfirmed")).toBe(false);
  });

  it("Р49 п. 6: расчёта ещё нет, ожидание прервано — SETTLEMENT_PENDING, покупка в SETTLING без остановки; settle() снова — DONE", async () => {
    let pending = true;
    const base = payments();
    const steps = {
      ...base,
      settle: (x: Operation) => (pending ? Promise.reject(new PaymentFailure("SETTLEMENT_PENDING")) : base.settle(x)),
    };
    const r = await setup({ payment: steps });
    await ordered(r);
    await r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
    await expect(r.purchase.settle()).rejects.toMatchObject({ code: "SETTLEMENT_PENDING" });
    expect(r.purchase.state).toBe("SETTLING");
    expect(r.purchase.reason).toBeNull();
    pending = false;
    await expect(r.purchase.settle()).resolves.toMatchObject({ status: "SETTLED" });
    expect(stages(r).slice(-2)).toEqual(["SETTLING", "DONE"]);
  });

  it("Р49 п. 7: scope_check не WITHIN_LIMITS — уведомление оболочки, покупка DONE; WITHIN_LIMITS — без уведомления", async () => {
    const cases: [Fulfilment["scopeCheck"] | null, string[]][] = [
      ["WITHIN_LIMITS", []],
      ["EXCEEDS_AUTHORIZATION", ["SCOPE_EXCEEDS_AUTHORIZATION"]],
      ["NOT_RESERVED", ["SCOPE_NOT_RESERVED"]],
      [{ other: "PARTIAL" }, ["SCOPE_CHECK_UNRECOGNIZED"]],
      [null, ["SCOPE_CHECK_UNRECOGNIZED"]],
    ];
    for (const [scopeCheck, expected] of cases) {
      const settle = async (x: Operation): Promise<Operation> => ({
        ...x,
        status: "SETTLED",
        fulfilment: scopeCheck === null ? null : { ref: "ful_1", finalAmount: x.amount!, scopeCheck, spentPosition: x.amount!, at: "2026-10-23T12:05:00.000Z" },
      });
      const notified: string[] = [];
      const amounts: unknown[] = [];
      const r = await setup({ payment: payments({ settle }), notify: (c, a) => void (notified.push(c), amounts.push(a)) });
      await ordered(r);
      await r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
      const op = await r.purchase.settle();
      expect(r.purchase.state).toBe("DONE");
      expect(notified, JSON.stringify(scopeCheck)).toEqual(expected);
      // сумма списания с валютой — вторым аргументом (Р51 п. 3; ревью чата): из записи об исполнении, без неё — сумма операции
      expect(amounts).toEqual(expected.map(() => op.fulfilment?.finalAmount ?? op.amount));
      if (expected.length > 0) expect(amounts[0]).toEqual({ amount: expect.any(Number), currency: "RUB" });
      // значение вне перечня — человеку как есть из операции покупки (#59 п. 6)
      if (typeof scopeCheck === "object" && scopeCheck !== null) expect(op.fulfilment?.scopeCheck).toEqual({ other: "PARTIAL" });
      await closeStand();
    }
  });

  it("Р51 п. 2 (б): граница ожидания — от получения AUTHORIZED на стадии 5: порт расчёта получает этот момент при каждом settle()", async () => {
    const seen: (Date | undefined)[] = [];
    let pending = true;
    const settle = async (x: Operation, at?: Date): Promise<Operation> => {
      seen.push(at);
      if (pending) throw new PaymentFailure("SETTLEMENT_PENDING");
      return { ...x, status: "SETTLED", fulfilment: { ref: "ful_1", finalAmount: x.amount!, scopeCheck: "WITHIN_LIMITS", spentPosition: x.amount!, at: "2026-10-23T12:05:00.000Z" } };
    };
    const r = await setup({ payment: payments({ settle }) });
    await ordered(r);
    await r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
    await expect(r.purchase.settle()).rejects.toMatchObject({ code: "SETTLEMENT_PENDING" });
    pending = false;
    await r.purchase.settle();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeInstanceOf(Date);
    // повторный settle() — тот же момент, граница не сдвигается
    expect(seen[1]!.getTime()).toBe(seen[0]!.getTime());
  });

  it("Р51 п. 2 (б): граница прошла без итога (порт — OPERATION_RESULT_UNCONFIRMED) — STOPPED, next NOTIFY_HUMAN; unfinished — только при STOP_ALL (Р50 п. 4)", async () => {
    const r = await setup({ payment: payments({ settle: () => Promise.reject(new PaymentFailure("OPERATION_RESULT_UNCONFIRMED")) }) });
    await ordered(r);
    await r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
    await expect(r.purchase.settle()).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(r.purchase.reason).toBe("OPERATION_RESULT_UNCONFIRMED");
    expect(r.purchase.next).toBe("NOTIFY_HUMAN");
    expect(r.purchase.unfinished).toBeNull();
  });

  it("Р51 п. 3: REVERSED на стадии 6 — STOPPED OPERATION_REVERSED (итоговый код), next NOTIFY_HUMAN; уведомлений нет", async () => {
    const notified: string[] = [];
    const r = await setup({ payment: payments({ settle: "REVERSED" }), notify: (c) => void notified.push(c) });
    await ordered(r);
    await r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
    const err = await r.purchase.settle().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PurchaseStopped);
    expect(err).toMatchObject({ code: "OPERATION_REVERSED" });
    expect(r.purchase.reason).toBe("OPERATION_REVERSED");
    expect(r.purchase.next).toBe("NOTIFY_HUMAN");
    expect(r.purchase.unfinished).toBeNull();
    // итоговый код — без замены на OPERATION_RESULT_UNCONFIRMED (Р49 п. 2)
    expect(r.tail().some((e) => e.kind === "payment.unconfirmed")).toBe(false);
    expect(notified).toEqual([]);
    // снимок операции — REVERSED, не прежний AUTHORIZED: op_ref и причина для оболочки (ревью КТ1 Р51 № 2)
    expect(r.purchase.operation).toMatchObject({ opRef: "op_1", status: "REVERSED" });
  });

  it("Р51 п. 3: REVERSED на стадии 5 (реверсал до ответа эмитента, итог по GET) — STOPPED OPERATION_REVERSED; снимок операции — REVERSED с причиной (окно — в «окне дробления» ниже)", async () => {
    const r = await setup({ payment: payments({ authorize: { status: "REVERSED", declineReason: "REVERSAL" } }) });
    await ordered(r);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "OPERATION_REVERSED" });
    expect(r.purchase.reason).toBe("OPERATION_REVERSED");
    expect(r.purchase.next).toBe("NOTIFY_HUMAN");
    expect(r.tail().some((e) => e.kind === "payment.unconfirmed")).toBe(false);
    expect(r.purchase.operation).toMatchObject({ opRef: "op_1", status: "REVERSED", declineReason: "REVERSAL" });
  });

  it("Р51 п. 3: REFUNDED на GET стадии 6 (расчёт и возврат уже были) — DONE, уведомление OPERATION_REFUNDED с суммой списания и валютой", async () => {
    const settle = async (x: Operation): Promise<Operation> => ({
      ...x,
      status: "REFUNDED",
      fulfilment: { ref: "ful_1", finalAmount: x.amount!, scopeCheck: "WITHIN_LIMITS", spentPosition: x.amount!, at: "2026-10-23T12:05:00.000Z" },
    });
    const notified: [string, unknown][] = [];
    const r = await setup({ payment: payments({ settle }), notify: (c, a) => void notified.push([c, a]) });
    await ordered(r);
    const authorized = await r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
    await expect(r.purchase.settle()).resolves.toMatchObject({ status: "REFUNDED" });
    expect(r.purchase.state).toBe("DONE");
    expect(notified).toEqual([["OPERATION_REFUNDED", authorized.amount]]);
  });
});

describe("ответ порта не той формы или сбой — STOPPED, а не промежуточное состояние (ревью К3 № 6, инвариант 4)", () => {
  it("заказ: исключение порта, ответ без суммы — STOPPED UNKNOWN", async () => {
    for (const order of [() => Promise.reject(new Error("витрина недоступна")), async () => ({ orderId: "ord_1" }) as never]) {
      const r = await setup({ shop: { ...READY, order } });
      await signedCart(r, await offers(r));
      await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toThrow();
      expect(stages(r).at(-1)).toBe("STOPPED:UNKNOWN");
      await closeStand();
    }
  });

  it("авторизация и расчёт: ответ null — STOPPED UNKNOWN до отправки пакета; после одобрения — OPERATION_RESULT_UNCONFIRMED наружу (Р49 п. 2)", async () => {
    const auth = await setup({ payment: { ...payments(), authorize: async () => null as never } });
    await ordered(auth);
    await expect(auth.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toThrow();
    expect(stages(auth).at(-1)).toBe("STOPPED:UNKNOWN");
    await closeStand();
    const settle = await setup({ payment: { ...payments(), settle: async () => null as never } });
    await ordered(settle);
    await settle.purchase.authorize({ idempotencyKey: "idem-pay-1" });
    await expect(settle.purchase.settle()).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(stages(settle).at(-1)).toBe("STOPPED:OPERATION_RESULT_UNCONFIRMED");
  });

  it("ревью КТ1 № 1: после отправки пакета сбой шага с кодом и без — наружу PurchaseStopped OPERATION_RESULT_UNCONFIRMED, исходная ошибка — в cause", async () => {
    const failure = new PlatformFailure("STATE_UNAVAILABLE", "same_key", "STATE_UNAVAILABLE", 503, null);
    for (const boom of [failure, new Error("журнал витрины недоступен")]) {
      const r = await setup({ payment: { ...payments(), authorize: (c: PaymentContext) => (c.sending(), Promise.reject(boom)) } });
      await ordered(r);
      const err = await r.purchase.authorize({ idempotencyKey: "idem-pay-1" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PurchaseStopped);
      expect(err).toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED", cause: boom });
      expect(r.purchase.reason).toBe("OPERATION_RESULT_UNCONFIRMED");
      await closeStand();
    }
  });

  it("ревью КТ1 № 6: итог стадии 5 уже SETTLED (событие одобрения прочитано поздно) — как одобрение: SETTLING, расчёт заберёт settle", async () => {
    const r = await setup({ payment: payments({ authorize: { status: "SETTLED" } }) });
    await ordered(r);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).resolves.toMatchObject({ status: "SETTLED" });
    expect(r.purchase.state).toBe("SETTLING");
    await expect(r.purchase.settle()).resolves.toMatchObject({ status: "SETTLED" });
    expect(r.purchase.state).toBe("DONE");
  });

  it("ревью КТ1 № 7: второй settle(), пока первый ждёт, — SETTLEMENT_PENDING без остановки; остановка покупки прерывает ожидание расчёта", async () => {
    let seen: AbortSignal | undefined;
    let finish: (op: Operation) => void = () => {};
    const steps = {
      ...payments(),
      settle: (x: Operation, signal?: AbortSignal) => {
        seen = signal;
        return new Promise<Operation>((res) => (finish = (op) => res(op)));
      },
    };
    const r = await setup({ payment: steps });
    await ordered(r);
    const authorized = await r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
    const first = r.purchase.settle();
    await expect(r.purchase.settle()).rejects.toMatchObject({ code: "SETTLEMENT_PENDING" });
    expect(r.purchase.state).toBe("SETTLING");
    // порту передан сигнал: остановка покупки его прерывает
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(false);
    finish({ ...authorized, status: "SETTLED", fulfilment: { ref: "ful_1", finalAmount: authorized.amount!, scopeCheck: "WITHIN_LIMITS", spentPosition: authorized.amount!, at: "2026-10-23T12:05:00.000Z" } });
    await expect(first).resolves.toMatchObject({ status: "SETTLED" });
    expect(r.purchase.state).toBe("DONE");
  });
});

describe("сбой журнала — STOPPED UNKNOWN, решение без записи не исполняется (ревью К5 № 1, инвариант 4)", () => {
  it("журнал не принял order.live_refused — STOPPED, заказа нет, повторный заказ — запрещённый переход", async () => {
    const boom = new Error("журнал недоступен");
    const r = await setup({
      live: liveOffers(SHOP, () => stand!.clock, (_, n) => (n > 1 ? { availability: { inStock: false } } : {})),
      tap: (e) => {
        if (e.kind === "order.live_refused") throw boom;
      },
    });
    await signedCart(r, await offers(r));
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toBe(boom);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("UNKNOWN");
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    expect(r.shop.calls).toEqual([]);
  });

  it("журнал не принял cart.abandoned при новом поиске из CART_ACTIVE — STOPPED UNKNOWN, выдача не сменилась (Р46 п. 3, инвариант 4)", async () => {
    const boom = new Error("журнал недоступен");
    // вторая выдача отличается от первой (магазинов нет): по выдаче покупки видно, сменилась ли она (ревью reviewer К3 № 1)
    const inner = feedOffers(SHOP);
    let n = 0;
    const r = await setup({
      offers: { search: async (m) => (++n > 1 ? [] : inner.search(m)) },
      tap: (e) => {
        if (e.kind === "cart.abandoned") throw boom;
      },
    });
    const cart = await signedCart(r, await offers(r));
    expect(r.purchase.state).toBe("CART_ACTIVE");
    await expect(r.purchase.search()).rejects.toBe(boom);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("UNKNOWN");
    expect(r.tail().filter((e) => e.kind === "cart.abandoned")).toEqual([]);
    expect(r.purchase.cartMandate?.id).toBe(cart.id);
    expect(r.purchase.offers?.contour.length).toBeGreaterThan(0);
  });

  it("журнал не принял cart.abandoned при отказе перед заказом — STOPPED UNKNOWN, снимок CART прежний, заказа нет (Р46 п. 3; ревью reviewer К3 № 3)", async () => {
    const boom = new Error("журнал недоступен");
    const r = await setup({
      live: liveOffers(SHOP, () => stand!.clock, (_, n) => (n > 1 ? { availability: { inStock: false } } : {})),
      tap: (e) => {
        if (e.kind === "cart.abandoned") throw boom;
      },
    });
    const cart = await signedCart(r, await offers(r));
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toBe(boom);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("UNKNOWN");
    expect(r.purchase.cartMandate?.id).toBe(cart.id);
    expect(r.tail().filter((e) => e.kind === "order.live_refused")).toHaveLength(1);
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    expect(r.shop.calls).toEqual([]);
  });

  it("журнал не принял cart.refused — STOPPED UNKNOWN, CART не запрошен", async () => {
    const boom = new Error("журнал недоступен");
    const r = await setup({
      shops: [{ ...SHOP, profile: bakery({ returns: { days: 0, text: "Возврат в течение 14 дней" } }) }],
      tap: (e) => {
        if (e.kind === "cart.refused") throw boom;
      },
    });
    const offer = await offers(r);
    await expect(r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-1" })).rejects.toBe(boom);
    expect(r.purchase.reason).toBe("UNKNOWN");
    expect(r.stand.log().filter((c) => c.op === "POST /pao/v1/mandates")).toHaveLength(1);
  });
});

describe("держимые после ожиданий (Р38 п. 3, ревью К3 № 10)", () => {
  it("INTENT отозван, пока ждали подписи CART, — STOPPED MANDATE_REVOKED, CART_ACTIVE не записан", async () => {
    const r = await setup();
    const intent = await signedIntent(r);
    const offer = (await r.purchase.search()).contour[0]!;
    const cart = await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-1" });
    r.setStream(async function* () {
      r.consents.mandates.get(intent.id)!.status = "REVOKED";
      await r.core.mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", intent.id) });
      yield { kind: "event", event: r.consents.sign(cart.id) };
    });
    await expect(r.purchase.awaitCart()).rejects.toBeInstanceOf(PurchaseStopped);
    expect(stages(r).slice(-2)).toEqual(["CART_PENDING", "STOPPED:MANDATE_REVOKED"]);
  });

  it("CART отозван, пока человек подтверждал, — пакет ушёл: STOPPED OPERATION_RESULT_UNCONFIRMED, исходный MANDATE_REVOKED — в журнале, повтора нет (Р49 п. 2)", async () => {
    const calls: string[] = [];
    const steps = {
      ...payments(),
      authorize: (c: PaymentContext) => (calls.push("authorize"), c.sending(), Promise.reject(new PaymentFailure("CONFIRMATION_REQUIRED"))),
    };
    const run: { r?: PurchaseRun } = {};
    const confirm = async () => {
      const r = run.r!;
      const id = r.purchase.cartMandate!.id;
      r.consents.mandates.get(id)!.status = "REVOKED";
      await r.core.mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", id) });
      calls.push("confirm");
      return "APPROVED" as const;
    };
    const r = (run.r = await setup({ payment: { ...steps, confirm } }));
    await ordered(r, Math.floor(THRESHOLD / TARTINE) + 1);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(r.purchase.reason).toBe("OPERATION_RESULT_UNCONFIRMED");
    expect(stages(r).slice(-3)).toEqual(["AUTHORIZING", "CONFIRMING", "STOPPED:OPERATION_RESULT_UNCONFIRMED"]);
    expect(r.tail().filter((e) => e.kind === "agent.refused" || e.kind === "payment.unconfirmed").map((e) => [e.kind, e.reason])).toEqual([
      ["agent.refused", "MANDATE_NOT_ACTIVE"],
      ["payment.unconfirmed", "MANDATE_REVOKED"],
    ]);
    // итоговый код после пакета — NOTIFY_HUMAN, не STOP_ALL (Р50 п. 4: next — по итоговому коду)
    expect(r.purchase.next).toBe("NOTIFY_HUMAN");
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    expect(calls).toEqual(["authorize", "confirm"]);
  });

  it("CART отозван, пока продавец отвечал на заказ, — STOPPED MANDATE_REVOKED, ORDERED не записан", async () => {
    const run: { r?: PurchaseRun } = {};
    const inner = shopOrders(SHOP);
    const order = async (req: Parameters<typeof inner.order>[0], m: Parameters<typeof inner.order>[1]) => {
      const r = run.r!;
      r.consents.mandates.get(req.cartMandateId)!.status = "REVOKED";
      await r.core.mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", req.cartMandateId) });
      return inner.order(req, m);
    };
    const r = (run.r = await setup({ shop: { ...READY, order } }));
    await signedCart(r, await offers(r));
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toMatchObject({ code: "MANDATE_REVOKED" });
    expect(r.purchase.order).toBeNull();
    expect(stages(r).at(-1)).toBe("STOPPED:MANDATE_REVOKED");
  });

  it("мандат вышел к авторизации не отзывом (EXHAUSTED) — STOPPED MANDATE_NOT_ACTIVE до порта, без STOP_ALL", async () => {
    const r = await setup();
    await ordered(r);
    const id = r.purchase.cartMandate!.id;
    r.consents.mandates.get(id)!.status = "EXHAUSTED";
    await r.core.mandates.refreshHeld({ kind: "event", event: event("mandate.exhausted", id) });
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "MANDATE_NOT_ACTIVE", next: null, unfinished: null });
    expect(r.payment.calls).toEqual([]);
  });
});

describe("ворота перед стадией 5 (Р38 п. 3, К4): оба мандата держатся и подтверждены verify — иначе STOPPED до реквизита", () => {
  /** verify обращения к контуру по порядку: id мандата из пути */

  it("ворота — verify INTENT, затем CART, непосредственно перед портом авторизации; и выше порога тоже (Р47 п. 2)", async () => {
    for (const qty of [1, Math.floor(THRESHOLD / TARTINE) + 1]) {
      const r = await setup();
      await ordered(r, qty);
      const before = verified(r).length;
      const log = r.stand.log().length;
      await r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
      expect(verified(r).slice(before)).toEqual([r.purchase.intentMandate!.id, r.purchase.cartMandate!.id]);
      // в воротах к контуру — только два verify (ревью К4 № 4); знак готовности — тестовым портом READY, мимо PaoStub (Р53 п. 6)
      expect(r.stand.log().slice(log).map((c) => c.op)).toEqual(["GET /pao/v1/mandates/{id}/verify", "GET /pao/v1/mandates/{id}/verify"]);
      await closeStand();
    }
  });

  it("INTENT отозван после заказа — agent.refused MANDATE_NOT_ACTIVE, STOPPED MANDATE_REVOKED, ни verify, ни реквизита", async () => {
    const r = await setup();
    await ordered(r);
    const id = r.purchase.intentMandate!.id;
    r.consents.mandates.get(id)!.status = "REVOKED";
    await r.core.mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", id) });
    const before = verified(r).length;
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.atStop().slice(-3).map((e) => [e.kind, e.reason])).toEqual([
      ["agent.refused", "MANDATE_NOT_ACTIVE"],
      ["purchase.stage", "MANDATE_REVOKED"],
      ["purchase.unfinished", "MANDATE_REVOKED"],
    ]);
    expect(verified(r).length).toBe(before);
    expect(r.payment.calls).toEqual([]);
  });

  for (const which of ["INTENT", "CART"] as const) {
    it(`verify ${which} в воротах не CONFIRMED — STOPPED MANDATE_OUT_OF_SCOPE (запись клиента мандатов, одна), реквизита нет`, async () => {
      const r = await setup();
      await ordered(r);
      const id = which === "INTENT" ? r.purchase.intentMandate!.id : r.purchase.cartMandate!.id;
      r.consents.outcomeOf.set(id, "OUT_OF_SCOPE");
      const start = r.tail().length;
      await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(MandateRefused);
      expect(r.purchase.reason).toBe("MANDATE_OUT_OF_SCOPE");
      expect(r.tail().slice(start).filter((e) => e.kind === "agent.refused").map((e) => [e.reason, e.mandate])).toEqual([["MANDATE_OUT_OF_SCOPE", id]]);
      expect(stages(r).at(-1)).toBe("STOPPED:MANDATE_OUT_OF_SCOPE");
      expect(r.payment.calls).toEqual([]);
    });
  }

  it("знак готовности продавца корзины перечитывается в воротах после обоих verify; ACTIVE — авторизация идёт (Р53 п. 6)", async () => {
    const asked: [string, number][] = [];
    const r = await setup({ shop: { ...shopOrders(SHOP), readiness: async (m) => (asked.push([m, verified(r).length]), { status: "ACTIVE" }) } });
    await ordered(r);
    const before = verified(r).length;
    asked.length = 0;
    await r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
    // продавец — из подписанного CART; знак — после verify INTENT и CART, до порта авторизации
    expect(asked).toEqual([[r.purchase.cartMandate!.cart!.merchantId, before + 2]]);
    expect(r.payment.calls).toEqual(["authorize"]);
  });

  for (const [answer, code] of [
    [{ status: "SUSPENDED" }, "MERCHANT_NOT_READY"],
    [{ status: "NONE" }, "MERCHANT_NOT_READY"],
    [{ unverified: "STATE_UNAVAILABLE" }, "READINESS_UNAVAILABLE"],
    [{ unverified: "NO_RESPONSE" }, "READINESS_UNAVAILABLE"],
  ] as const) {
    it(`знак в воротах ${answer.status ?? `не проверен (${answer.unverified})`} — STOPPED ${code} до реквизита (Р53 п. 6)`, async () => {
      const r = await setup({ shop: { ...shopOrders(SHOP), readiness: async () => answer } });
      await ordered(r);
      await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(PurchaseStopped);
      expect(r.purchase.reason).toBe(code);
      expect(stages(r).at(-1)).toBe(`STOPPED:${code}`);
      expect(r.payment.calls).toEqual([]);
    });
  }

  it("отказ по агенту на знаке в воротах (403 AGENT_SUSPENDED) — STOPPED тем же кодом, реквизита нет (Р53 п. 5)", async () => {
    const refused = new PlatformFailure("AGENT_SUSPENDED", "never", "AGENT_SUSPENDED", 403, null);
    const r = await setup({ shop: { ...shopOrders(SHOP), readiness: () => Promise.reject(refused) } });
    await ordered(r);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBe(refused);
    expect(r.purchase.reason).toBe("AGENT_SUSPENDED");
    expect(r.payment.calls).toEqual([]);
  });

  for (const which of ["INTENT", "CART"] as const) {
    it(`мандат ${which} отозван у Платформы, события по ленте не было — verify OUT_OF_SCOPE, STOPPED до реквизита`, async () => {
      const r = await setup();
      await ordered(r);
      const id = which === "INTENT" ? r.purchase.intentMandate!.id : r.purchase.cartMandate!.id;
      // держимое множество не знает об отзыве: решение — по verify (инвариант 6)
      r.consents.mandates.get(id)!.status = "REVOKED";
      await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(MandateRefused);
      expect(r.purchase.reason).toBe("MANDATE_OUT_OF_SCOPE");
      expect(r.tail().filter((e) => e.kind === "agent.refused").map((e) => [e.reason, e.mandate])).toEqual([["MANDATE_OUT_OF_SCOPE", id]]);
      expect(r.payment.calls).toEqual([]);
    });
  }

  it("ответ verify устарел (as_of старше registry_cache_ttl_sec) — STATE_UNKNOWN, STOPPED MANDATE_OUT_OF_SCOPE (инвариант 4)", async () => {
    const r = await setup();
    await ordered(r);
    r.consents.asOf = new Date(stand!.clock.getTime() - (loadParams().registry_cache_ttl_sec + 1) * 1000).toISOString();
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(MandateRefused);
    expect(r.purchase.reason).toBe("MANDATE_OUT_OF_SCOPE");
    expect(r.tail().filter((e) => e.kind === "agent.refused").map((e) => e.reason)).toEqual(["MANDATE_OUT_OF_SCOPE"]);
    expect(r.payment.calls).toEqual([]);
  });

  it("CART отозван, пока шёл verify в воротах, — STOPPED MANDATE_REVOKED, реквизита нет", async () => {
    const r = await setup();
    await ordered(r);
    const cartId = r.purchase.cartMandate!.id;
    const mandates = r.core.mandates;
    const requireActive = mandates.requireActive.bind(mandates);
    mandates.requireActive = async (m) => {
      const c = await requireActive(m);
      if (m?.id === cartId) {
        r.consents.mandates.get(cartId)!.status = "REVOKED";
        await mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", cartId) });
      }
      return c;
    };
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "MANDATE_REVOKED" });
    expect(r.tail().filter((e) => e.kind === "agent.refused").map((e) => [e.reason, e.mandate])).toEqual([["MANDATE_NOT_ACTIVE", cartId]]);
    expect(stages(r).at(-1)).toBe("STOPPED:MANDATE_REVOKED");
    expect(r.payment.calls).toEqual([]);
  });

  it("CART отозван по ленте, пока шёл знак в воротах, — STOPPED MANDATE_REVOKED, реквизита нет (ревью КТ1 № 1)", async () => {
    const holder: { r?: PurchaseRun } = {};
    const r = (holder.r = await setup({
      shop: {
        ...shopOrders(SHOP),
        readiness: async () => {
          const run = holder.r!;
          const cartId = run.purchase.cartMandate!.id;
          run.consents.mandates.get(cartId)!.status = "REVOKED";
          await run.core.mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", cartId) });
          return { status: "ACTIVE" };
        },
      },
    }));
    await ordered(r);
    const cartId = r.purchase.cartMandate!.id;
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "MANDATE_REVOKED" });
    expect(r.tail().filter((e) => e.kind === "agent.refused").map((e) => [e.reason, e.mandate])).toEqual([["MANDATE_NOT_ACTIVE", cartId]]);
    expect(stages(r).at(-1)).toBe("STOPPED:MANDATE_REVOKED");
    expect(r.payment.calls).toEqual([]);
  });

  it("покупку остановили, пока шёл знак в воротах (параллельный вызов), — наружу PurchaseStopped, реквизита нет (ревью КТ1 № 2)", async () => {
    const holder: { r?: PurchaseRun; release?: () => void } = {};
    const r = (holder.r = await setup({
      shop: {
        ...shopOrders(SHOP),
        readiness: (_m, signal) =>
          new Promise((_, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            holder.release?.();
          }),
      },
    }));
    await ordered(r);
    const asking = new Promise<void>((resolve) => (holder.release = resolve));
    const pay = r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
    await asking;
    // параллельный вызов чужой стадии — запрещённый переход останавливает покупку
    await expect(r.purchase.settle()).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    await expect(pay).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.payment.calls).toEqual([]);
  });

  it("отказ по агенту на знаке в воротах: 401 AGENT_KEY_REVOKED и SignerStopped NO_ACTIVE_KEY — STOPPED без повтора, реквизита нет (ревью КТ1 № 4)", async () => {
    for (const [refusal, code] of [
      [new PlatformFailure("AGENT_KEY_REVOKED", "new_key", "AGENT_KEY_REVOKED", 401, null), "AGENT_KEY_REVOKED"],
      [new SignerStopped("NO_ACTIVE_KEY"), "NO_ACTIVE_KEY"],
    ] as const) {
      let asked = 0;
      const r = await setup({ shop: { ...shopOrders(SHOP), readiness: () => (asked++, Promise.reject(refusal)) }, failureCode: startFailureCode });
      await ordered(r);
      await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBe(refusal);
      expect([r.purchase.reason, asked, r.payment.calls]).toEqual([code, 1, []]);
      await closeStand();
    }
  });

  for (const [which, left, stop] of [
    ["CART", TARTINE - 1, true],
    ["INTENT", TARTINE - 1, true],
    ["CART", TARTINE, false],
    ["INTENT", TARTINE, false],
  ] as const) {
    it(`остаток ${which} по verify ${left} при итоге CART ${TARTINE} — ${stop ? "STOPPED MANDATE_AMOUNT_LEFT_INSUFFICIENT, реквизита нет" : "ворота пройдены"} (К4а)`, async () => {
      const r = await setup();
      await ordered(r);
      const intentId = r.purchase.intentMandate!.id;
      const cartId = r.purchase.cartMandate!.id;
      const id = which === "INTENT" ? intentId : cartId;
      r.consents.left.set(id, left);
      const before = verified(r).length;
      const from = r.stand.stub.calls.length;
      const call = r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
      if (!stop) {
        await call;
        expect(verified(r).slice(before)).toEqual([intentId, cartId]);
        expect(r.tail().filter((e) => e.kind === "agent.refused")).toEqual([]);
        expect(r.payment.calls).toEqual(["authorize"]);
        return;
      }
      await expect(call).rejects.toMatchObject({ code: "MANDATE_AMOUNT_LEFT_INSUFFICIENT" });
      expect(r.atStop().slice(-2).map((e) => [e.kind, e.reason, e.mandate])).toEqual([
        ["agent.refused", "MANDATE_AMOUNT_LEFT_INSUFFICIENT", id],
        ["purchase.stage", "MANDATE_AMOUNT_LEFT_INSUFFICIENT", intentId],
      ]);
      // по INTENT не хватает — CART уже не проверяется
      expect(verified(r).slice(before)).toEqual(which === "INTENT" ? [intentId] : [intentId, cartId]);
      expect(await r.purchase.cartReleased()).toBe("RELINQUISHED");
      expect(opsFrom(r, from)).toEqual(which === "INTENT" ? [VERIFY, RELINQUISH] : [VERIFY, VERIFY, RELINQUISH]);
      expect(r.payment.calls).toEqual([]);
    });
  }

  it("сбой verify в воротах — STOPPED с кодом Платформы, agent.refused не пишется (Р38 п. 4)", async () => {
    const r = await setup();
    await ordered(r);
    const start = r.tail().length;
    const before = verified(r).length;
    const attempts = loadParams().pao_max_attempts;
    r.stand.stub.fail("GET /pao/v1/mandates/{id}/verify", { code: "STATE_UNAVAILABLE" }, attempts);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(PlatformFailure);
    expect(r.purchase.reason).toBe("STATE_UNAVAILABLE");
    // все попытки — по INTENT, до CART ворота не дошли
    expect(verified(r).slice(before)).toEqual(Array(attempts).fill(r.purchase.intentMandate!.id));
    expect(r.tail().slice(start).filter((e) => e.kind === "agent.refused")).toEqual([]);
    expect(r.payment.calls).toEqual([]);
  });

  it("Р50 п. 6 (б): ядро не повторяет сверх бюджета адаптера — отказ RETRY_SAME_KEY, дошедший до конвейера, — остановка; следующее обращение прошло бы, но его нет", async () => {
    const r = await setup();
    await ordered(r);
    const attempts = loadParams().pao_max_attempts;
    // отказов ровно столько, сколько попыток у адаптера: повтор ядра получил бы ответ 200 и пошёл дальше
    r.stand.stub.fail(VERIFY, { code: "STATE_UNAVAILABLE", retryAfterSec: 0 }, attempts);
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    expect(opsFrom(r, from)).toEqual(Array(attempts).fill(VERIFY));
    expect(r.purchase.state).toBe("STOPPED");
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    expect(opsFrom(r, from)).toHaveLength(attempts);
  });
});

describe("проверка по мандату до стадии 4 (Р40 п. 5, К4а № 3; после Р47 п. 2 — ворота стадии 5): человека не просят подтвердить покупку, которую ворота отклонят", () => {
  const ABOVE = Math.floor(THRESHOLD / TARTINE) + 1;

  it("выше порога — verify INTENT, затем CART, один раз в воротах стадии 5, без иных обращений до порта", async () => {
    const r = await setup();
    await ordered(r, ABOVE);
    expect(r.purchase.needsConfirmation).toBe(true);
    const intentId = r.purchase.intentMandate!.id;
    const cartId = r.purchase.cartMandate!.id;
    const from = r.stand.stub.calls.length;
    const before = verified(r).length;
    await r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
    expect(opsFrom(r, from)).toEqual([VERIFY, VERIFY]);
    expect(verified(r).slice(before)).toEqual([intentId, cartId]);
    expect(r.payment.calls).toEqual(["authorize"]);
  });

  for (const which of ["INTENT", "CART"] as const) {
    it(`остаток ${which} меньше итога — STOPPED MANDATE_AMOUNT_LEFT_INSUFFICIENT до запроса подтверждения`, async () => {
      const r = await setup();
      await ordered(r, ABOVE);
      const intentId = r.purchase.intentMandate!.id;
      const id = which === "INTENT" ? intentId : r.purchase.cartMandate!.id;
      r.consents.left.set(id, TARTINE * ABOVE - 1);
      const from = r.stand.stub.calls.length;
      await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "MANDATE_AMOUNT_LEFT_INSUFFICIENT" });
      // по INTENT не хватает — CART уже не проверяется
      expect(await r.purchase.cartReleased()).toBe("RELINQUISHED");
      expect(opsFrom(r, from)).toEqual(which === "INTENT" ? [VERIFY, RELINQUISH] : [VERIFY, VERIFY, RELINQUISH]);
      expect(r.purchase.state).toBe("STOPPED");
      expect(r.atStop().slice(-2).map((e) => [e.kind, e.reason, e.mandate])).toEqual([
        ["agent.refused", "MANDATE_AMOUNT_LEFT_INSUFFICIENT", id],
        ["purchase.stage", "MANDATE_AMOUNT_LEFT_INSUFFICIENT", intentId],
      ]);
      // в CONFIRMING не входили, порт подтверждения не вызван
      expect(stages(r)).not.toContain("CONFIRMING");
      expect(r.payment.calls).toEqual([]);
    });
  }

  for (const which of ["INTENT", "CART"] as const) {
    it(`verify ${which} не CONFIRMED — agent.refused MANDATE_OUT_OF_SCOPE и STOPPED до запроса подтверждения`, async () => {
      const r = await setup();
      await ordered(r, ABOVE);
      const id = which === "INTENT" ? r.purchase.intentMandate!.id : r.purchase.cartMandate!.id;
      r.consents.outcomeOf.set(id, "OUT_OF_SCOPE");
      const from = r.stand.stub.calls.length;
      await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(MandateRefused);
      expect(r.purchase.reason).toBe("MANDATE_OUT_OF_SCOPE");
      expect(await r.purchase.cartReleased()).toBe("RELINQUISHED");
      expect(opsFrom(r, from)).toEqual(which === "INTENT" ? [VERIFY, RELINQUISH] : [VERIFY, VERIFY, RELINQUISH]);
      expect(r.tail().filter((e) => e.kind === "agent.refused").map((e) => [e.reason, e.mandate])).toEqual([["MANDATE_OUT_OF_SCOPE", id]]);
      expect(stages(r)).not.toContain("CONFIRMING");
      expect(r.payment.calls).toEqual([]);
    });
  }

  it("INTENT отозван после заказа — MANDATE_REVOKED до запроса подтверждения, ни verify, ни порта", async () => {
    const r = await setup();
    await ordered(r, ABOVE);
    const id = r.purchase.intentMandate!.id;
    r.consents.mandates.get(id)!.status = "REVOKED";
    await r.core.mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", id) });
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "MANDATE_REVOKED" });
    // CART отозван вместе с INTENT — отказ не нужен
    expect(await r.purchase.cartReleased()).toBe("NOT_NEEDED");
    expect(opsFrom(r, from)).toEqual([]);
    expect(r.payment.calls).toEqual([]);
  });
});

describe("политика до стадий 4–5 (Р39): отказ — agent.refused и STOPPED до подтверждения и реквизита", () => {

  for (const which of ["INTENT", "CART"] as const) {
    it(`amount_left ${which} = 0 при CONFIRMED — вне пределов: STOPPED MANDATE_OUT_OF_SCOPE (Р39 п. 1.1, Р35)`, async () => {
      const r = await setup();
      await ordered(r);
      const intentId = r.purchase.intentMandate!.id;
      const id = which === "INTENT" ? intentId : r.purchase.cartMandate!.id;
      r.consents.left.set(id, 0);
      const from = r.stand.stub.calls.length;
      await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "MANDATE_OUT_OF_SCOPE" });
      // по INTENT вне пределов — verify CART не делается
      expect(await r.purchase.cartReleased()).toBe("RELINQUISHED");
      expect(opsFrom(r, from)).toEqual(which === "INTENT" ? [VERIFY, RELINQUISH] : [VERIFY, VERIFY, RELINQUISH]);
      expect(r.atStop().slice(-2).map((e) => [e.kind, e.reason, e.mandate])).toEqual([
        ["agent.refused", "MANDATE_OUT_OF_SCOPE", id],
        ["purchase.stage", "MANDATE_OUT_OF_SCOPE", intentId],
      ]);
      expect(r.payment.calls).toEqual([]);
    });
  }

  // Р56 п. 2: прежде (Р39 п. 1.3, Р44 п. 5) такой CART останавливали ворота перед заказом после verify обоих; теперь — cart()
  // до проекта CART. Второй рубеж ворот (mayAuthorize) остаётся и проверяется модульно — payment-policy.test.ts.
  it("продавец CART вне merchantScope INTENT — STOPPED MANDATE_OUT_OF_SCOPE в cart() до проекта CART: ни verify, ни CART, ни заказа (Р56 п. 2)", async () => {
    const r = await setup();
    await signedIntent(r, { ...INTENT, merchantScope: ["shop_2"] });
    const zones = await r.purchase.search();
    const intentId = r.purchase.intentMandate!.id;
    const before = verified(r).length;
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.cart(one(zones.contour.find((o) => o.sku === "tartine")!, 1), { idempotencyKey: "idem-cart-1" })).rejects.toMatchObject({ code: "MANDATE_OUT_OF_SCOPE" });
    expect(r.purchase.cartMandate).toBeNull();
    expect(r.shop.calls).toEqual([]);
    expect(verified(r).slice(before)).toEqual([]);
    expect(opsFrom(r, from)).toEqual([]);
    expect(r.atStop().slice(-2).map((e) => [e.kind, e.reason, e.mandate])).toEqual([
      ["agent.refused", "MANDATE_OUT_OF_SCOPE", intentId],
      ["purchase.stage", "MANDATE_OUT_OF_SCOPE", intentId],
    ]);
    expect(r.payment.calls).toEqual([]);
  });

  it("окно из одной операции — не дробление: тесты окна ниже требуют split_min_ops > 1", () => {
    expect(MIN_OPS).toBeGreaterThan(1);
  });

  it("доля в окне по корневому INTENT — STOPPED SPLIT_WINDOW до verify, подтверждения и реквизита (Р39 п. 4)", async () => {
    const r = await setup();
    await ordered(r);
    const intentId = r.purchase.intentMandate!.id;
    expect(r.purchase.needsConfirmation).toBe(false);
    // под тем же INTENT в окне split_min_ops − 1 операций: вместе с этой — split_min_ops, сумма выше порога
    fillWindow(r, intentId, MIN_OPS - 1, THRESHOLD - TARTINE + 1);
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "SPLIT_WINDOW" });
    expect(r.atStop().slice(-2).map((e) => [e.kind, e.reason, e.mandate])).toEqual([
      ["agent.refused", "SPLIT_WINDOW", intentId],
      ["purchase.stage", "SPLIT_WINDOW", intentId],
    ]);
    expect(await r.purchase.cartReleased()).toBe("RELINQUISHED");
    expect(opsFrom(r, from)).toEqual([RELINQUISH]);
    expect(r.payment.calls).toEqual([]);
  });

  it("доля появилась, пока шёл verify CART (параллельная покупка под тем же INTENT), — STOPPED SPLIT_WINDOW после ворот, реквизита нет (ревью К2 В4)", async () => {
    const r = await setup();
    await ordered(r);
    const intentId = r.purchase.intentMandate!.id;
    const cartId = r.purchase.cartMandate!.id;
    const mandates = r.core.mandates;
    const requireActive = mandates.requireActive.bind(mandates);
    mandates.requireActive = async (m) => {
      const c = await requireActive(m);
      if (m?.id === cartId) fillWindow(r, intentId, MIN_OPS - 1, THRESHOLD - TARTINE + 1);
      return c;
    };
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "SPLIT_WINDOW" });
    expect(await r.purchase.cartReleased()).toBe("RELINQUISHED");
    expect(opsFrom(r, from)).toEqual([VERIFY, VERIFY, RELINQUISH]);
    expect(verified(r).slice(-2)).toEqual([intentId, cartId]);
    expect(r.atStop().slice(-2).map((e) => [e.kind, e.reason])).toEqual([
      ["agent.refused", "SPLIT_WINDOW"],
      ["purchase.stage", "SPLIT_WINDOW"],
    ]);
    expect(r.payment.calls).toEqual([]);
  });

  it("сумма в окне ровно порог, другой INTENT или окно истекло — не доля, оплата идёт (Р39 п. 4)", async () => {
    const { split_window_sec } = loadParams();
    for (const kind of ["ровно порог", "другой INTENT", "окно истекло"] as const) {
      const r = await setup();
      await ordered(r);
      const root = kind === "другой INTENT" ? "mnd_other" : r.purchase.intentMandate!.id;
      // «ровно порог» — сумма в окне не больше порога вместе с этой (floor); иначе — на копейку выше
      if (kind === "ровно порог") fillWindow(r, root, MIN_OPS - 1, THRESHOLD - TARTINE, "floor");
      else fillWindow(r, root, MIN_OPS - 1, THRESHOLD - TARTINE + 1);
      if (kind === "окно истекло") r.stand.clock = new Date(r.stand.clock.getTime() + (split_window_sec + 1) * 1000);
      await r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
      expect(r.payment.calls).toEqual(["authorize"]);
      await closeStand();
    }
  });

  /** После стадии 5 этой покупки (итог TARTINE): ещё split_min_ops − 2 мест по копейке и проба — split_min_ops операций
   *  на порог + 1, если операция этой покупки в окне; без неё операций на одну меньше — не доля. */
  const isShareAfter = (r: PurchaseRun, root: string) => {
    for (let i = 0; i < MIN_OPS - 2; i++) r.split.open(root, { amount: 1, currency: "RUB" }).settle("APPROVED");
    return r.split.isShare(root, { amount: THRESHOLD - TARTINE - (MIN_OPS - 2) + 1, currency: "RUB" }, THRESHOLD);
  };

  for (const [reply, counts] of [
    [{ status: "AUTHORIZED" }, true],
    [{ status: "DECLINED", declineReason: "LIMIT_EXCEEDED" }, false],
    // дальше стадия 4 — место занято, как после исключения порта (Р47 п. 6, решение владельца по ревью К3 № 4)
    [{ status: "CONFIRMATION_REQUIRED" }, true],
    // ответ не той формы для стадии 5 — неизвестный исход (STOPPED UNKNOWN), окно занято
    [{ status: "SETTLED" }, true],
    // оплата отменена — окно занято: клиринг после реверсала возможен (Р51 п. 3, fail-closed; ревью КТ1 Р51 № 6)
    [{ status: "REVERSED", declineReason: "REVERSAL" }, true],
    // расчёт и возврат уже были — как одобрение (Р51 п. 3)
    [{ status: "REFUNDED" }, true],
  ] as const) {
    it(`ответ стадии 5 ${reply.status} — операция ${counts ? "занимает" : "не занимает"} окно дробления (Р39 п. 4)`, async () => {
      const r = await setup({ payment: payments({ authorize: reply }) });
      await ordered(r);
      const intentId = r.purchase.intentMandate!.id;
      await r.purchase.authorize({ idempotencyKey: "idem-pay-1" }).catch(() => undefined);
      // ответ CONFIRMATION_REQUIRED ведёт в стадию 4 (Р47 п. 2)
      expect(r.payment.calls).toEqual(reply.status === "CONFIRMATION_REQUIRED" ? ["authorize", "confirm"] : ["authorize"]);
      expect(isShareAfter(r, intentId)).toBe(counts);
    });
  }

  it("порт бросил CONFIRMATION_REQUIRED (профиль contour: пакет передан, продавец DECLINED) — место в окне занято при любом исходе стадии 4 (Р47 п. 6)", async () => {
    for (const outcome of ["APPROVED", "REJECTED", "NONE"] as const) {
      const r = await setup({ payment: confirming(outcome) });
      await ordered(r);
      const intentId = r.purchase.intentMandate!.id;
      await r.purchase.authorize({ idempotencyKey: "idem-pay-1" }).catch(() => undefined);
      expect(isShareAfter(r, intentId), outcome).toBe(true);
      await closeStand();
    }
  });

  it("сбой порта на стадии 5 — операция остаётся в окне (fail-closed, Р39 п. 4)", async () => {
    const payment = payments();
    payment.authorize = async () => {
      throw new Error("сеть");
    };
    const r = await setup({ payment });
    await ordered(r);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toThrow("сеть");
    expect(isShareAfter(r, r.purchase.intentMandate!.id)).toBe(true);
  });
});

describe("стадии 3–6 — запрещённые переходы до работы стадии (Р38 п. 1)", () => {
  it("заказ без CART, авторизация без заказа — отказ машины, обращений нет", async () => {
    for (const step of ["order", "authorize", "settle"] as const) {
      const r = await setup();
      await signedIntent(r);
      await r.purchase.search();
      const before = r.stand.log().length;
      const call = step === "order" ? r.purchase.placeOrder({ idempotencyKey: "k" }) : step === "authorize" ? r.purchase.authorize({ idempotencyKey: "k" }) : r.purchase.settle();
      await expect(call).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
      expect(r.purchase.state).toBe("STOPPED");
      expect(r.stand.log().length).toBe(before);
      await closeStand();
    }
  });

  it("verify INTENT перед CART не CONFIRMED — STOPPED MANDATE_OUT_OF_SCOPE, CART не запрошен, решение A5 не потрачено (Р40 п. 2)", async () => {
    const r = await setup({ shops: [{ ...SHOP, profile: bakery({ returns: { days: 0, text: "Возврат в течение 14 дней" } }) }] });
    const offer = await offers(r);
    const decision = humanA5Decision(shownIn(r), offer, offer.a5);
    r.consents.outcome = "OUT_OF_SCOPE";
    await expect(r.purchase.cart(one(offer, 1, decision), { idempotencyKey: "idem-cart-1" })).rejects.toBeInstanceOf(MandateRefused);
    expect(r.purchase.reason).toBe("MANDATE_OUT_OF_SCOPE");
    expect(r.stand.log().filter((c) => c.op === "POST /pao/v1/mandates")).toHaveLength(1);
    expect(isSpent(decision)).toBe(false);
  });
});
