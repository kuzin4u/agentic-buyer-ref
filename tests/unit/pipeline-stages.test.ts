// Конвейер, стадии 3–6 на PaoStub (Р38 п. 1–4): выбор человека → CART → живая проверка → заказ со сверкой суммы →
// подтверждение по порогу (Т7) → авторизация и расчёт через порт PaymentSteps (исход — из события Платформы, AG-11).
import { afterEach, describe, expect, it } from "vitest";
import { CartLiveRefused, CartRefused, OrderRefused, PurchaseMachine, PurchaseStopped, PurchaseTransitionForbidden, type Offer } from "../../src/agent/pipeline/index.js";
import { MandateRefused } from "../../src/agent/mandates/index.js";
import { isSpent } from "../../src/agent/policy/a5-issued.js";
import { loadParams } from "../../src/shared/config.js";
import { PlatformFailure } from "../../src/shared/domain.js";
import { ShopFailure } from "../../src/agent/ports/index.js";
import { INTENT, event } from "../support/consents.js";
import { expectJournalClean } from "../support/journal.js";
import { AGENT, type PaoStand } from "../support/pao-stand.js";
import { SHOP, one, purchaseOn, signedIntent, stages, type PurchaseRun, type PurchaseSetup } from "../support/purchase.js";
import { bakery, feedPrice, liveOffers, payments, shopOrders } from "../support/shop.js";
import { humanA5Decision } from "../../src/agent/shell/index.js";

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

  it("сумма выше порога (Т7): ORDERED → CONFIRMING → AUTHORIZING, решение — из порта", async () => {
    const r = await setup();
    const qty = Math.floor(THRESHOLD / TARTINE) + 1;
    await ordered(r, qty);
    expect(r.purchase.needsConfirmation).toBe(true);
    await r.purchase.confirm();
    await r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
    await r.purchase.settle();
    expect(r.payment.calls).toEqual(["confirm", "authorize", "settle"]);
    expect(stages(r).slice(-5)).toEqual(["ORDERED", "CONFIRMING", "AUTHORIZING", "SETTLING", "DONE"]);
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
      expect(r.tail().slice(-2).map((e) => [e.kind, e.reason, e.ref])).toEqual([
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
      const r = await setup({ shop: { order: async () => (orders++, Promise.reject(new ShopFailure(code))) } });
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

  it("отзыв INTENT пришёл по ленте во время живой проверки — STOPPED MANDATE_NOT_ACTIVE, CART не запрошен, решение A5 не потрачено (Р38 п. 3)", async () => {
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
    expect(r.purchase.reason).toBe("MANDATE_NOT_ACTIVE");
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
      expect(r.tail().slice(-2).map((e) => [e.kind, e.reason, e.ref])).toEqual([
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

  it("CART отозван до заказа — STOPPED MANDATE_NOT_ACTIVE, ни проверки, ни заказа", async () => {
    const r = await setup();
    const cart = await signedCart(r, await offers(r));
    r.consents.mandates.get(cart.id)!.status = "REVOKED";
    await r.core.mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", cart.id) });
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.reason).toBe("MANDATE_NOT_ACTIVE");
    // только проверка перед CART (Р43 п. 1); перед заказом — нет
    expect(r.live.calls).toHaveLength(1);
    expect(r.shop.calls).toEqual([]);
  });
});

describe("стадии 4–6 — исходы из порта PaymentSteps (инварианты 7, 8)", () => {
  it("человек не подтвердил — STOPPED CONFIRMATION_REQUIRED, авторизации нет", async () => {
    const r = await setup({ payment: payments({ confirm: "REJECTED" }) });
    await ordered(r, Math.floor(THRESHOLD / TARTINE) + 1);
    await expect(r.purchase.confirm()).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(r.payment.calls).toEqual(["confirm"]);
    expect(stages(r).at(-1)).toBe("STOPPED:CONFIRMATION_REQUIRED");
  });

  it("выше порога авторизация без подтверждения — запрещённый переход (agent.refused «откуда->куда»), порт не вызван", async () => {
    const r = await setup();
    await ordered(r, Math.floor(THRESHOLD / TARTINE) + 1);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    expect(r.purchase.reason).toBe("PIPELINE_TRANSITION_FORBIDDEN");
    expect(r.tail().filter((e) => e.kind === "agent.refused").map((e) => e.detail)).toEqual(["ORDERED->AUTHORIZING"]);
    expect(r.payment.calls).toEqual([]);
  });

  it("не выше порога подтверждение не запрашивается — confirm() запрещён", async () => {
    const r = await setup();
    await ordered(r);
    await expect(r.purchase.confirm()).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    expect(r.tail().filter((e) => e.kind === "agent.refused").map((e) => e.detail)).toEqual(["ORDERED->CONFIRMING"]);
    expect(r.payment.calls).toEqual([]);
  });

  it("граница порога (Т7): итог ровно confirm_above_kop — без стадии 4, на копейку выше — со стадией 4", async () => {
    for (const [limit, needs] of [[2 * TARTINE, false], [2 * TARTINE - 1, true]] as const) {
      const r = await setup({ params: { confirm_above_kop: limit } });
      await ordered(r, 2);
      expect(r.purchase.needsConfirmation).toBe(needs);
      await closeStand();
    }
  });

  it("мандат корзины, отданный наружу, — копия: подмена итога не снимает стадию 4 (ревью К3 № 3)", async () => {
    const r = await setup();
    await ordered(r, Math.floor(THRESHOLD / TARTINE) + 1);
    const cart = r.purchase.cartMandate!;
    cart.cart!.total.amount = 1;
    expect(r.purchase.needsConfirmation).toBe(true);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
  });

  it("снимок CART свой (после подписи и сразу ACTIVE): изменение объекта в держимых клиента мандатов не снимает стадию 4", async () => {
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
      const r = await setup({ payment: { ...steps, [step]: refuse } });
      await ordered(r, step === "confirm" ? Math.floor(THRESHOLD / TARTINE) + 1 : 1);
      await expect(step === "confirm" ? r.purchase.confirm() : r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(MandateRefused);
      expect(stages(r).at(-1)).toBe("STOPPED:MANDATE_SIGNATURE_PENDING");
      expect(steps.calls).toEqual([]);
      await closeStand();
    }
  });

  it("машина покупки вызывающему не дана: переходы — только стадиями (ревью К3 повторное Н2)", async () => {
    const r = await setup();
    expect("machine" in r.purchase).toBe(false);
    expect(Object.values(r.purchase).some((v) => v instanceof PurchaseMachine)).toBe(false);
  });

  it("авторизация, пока стадия 4 ждёт человека, — запрещённый переход, порт авторизации не вызван (ревью К3 № 4)", async () => {
    let release: (s: "APPROVED") => void = () => {};
    const pending = new Promise<"APPROVED">((res) => (release = res));
    // порт подтверждения начал ждать человека — после проверки по мандату (Р40 п. 5), уже в CONFIRMING
    let started: () => void = () => {};
    const entered = new Promise<void>((res) => (started = res));
    const steps = payments();
    const r = await setup({ payment: { ...steps, confirm: () => (started(), pending) } });
    await ordered(r, Math.floor(THRESHOLD / TARTINE) + 1);
    const waiting = r.purchase.confirm();
    await entered;
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    expect(r.tail().filter((e) => e.reason === "PIPELINE_TRANSITION_FORBIDDEN" && e.kind === "agent.refused").map((e) => e.detail)).toEqual(["CONFIRMING->AUTHORIZING"]);
    release("APPROVED");
    await expect(waiting).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.state).toBe("STOPPED");
    expect(steps.calls).toEqual([]);
  });

  it("авторизация, пока до стадии 4 идёт verify, — запрещённый переход ORDERED->AUTHORIZING, порты не вызваны (Р40 п. 5)", async () => {
    const steps = payments();
    const r = await setup({ payment: steps });
    await ordered(r, Math.floor(THRESHOLD / TARTINE) + 1);
    const from = r.stand.stub.calls.length;
    const checking = r.purchase.confirm();
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    await expect(checking).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.tail().filter((e) => e.reason === "PIPELINE_TRANSITION_FORBIDDEN" && e.kind === "agent.refused").map((e) => e.detail)).toEqual(["ORDERED->AUTHORIZING"]);
    // verify INTENT уже ушёл; CART после остановки не проверяется
    expect(opsFrom(r, from)).toEqual([VERIFY]);
    expect(steps.calls).toEqual([]);
  });

  it("повторный вход в идущую стадию — запрещённый переход (два cart() подряд)", async () => {
    const r = await setup();
    const offer = await offers(r);
    const first = r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-1" });
    await expect(r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-2" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    await expect(first).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.stand.log().filter((c) => c.op === "POST /pao/v1/mandates")).toHaveLength(1);
  });

  it("Платформа требует подтверждения на стадии 5 — STOPPED CONFIRMATION_REQUIRED, без повтора", async () => {
    const r = await setup({ payment: payments({ authorize: { status: "CONFIRMATION_REQUIRED" } }) });
    await ordered(r);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(r.payment.calls).toEqual(["authorize"]);
    expect(stages(r).slice(-2)).toEqual(["AUTHORIZING", "STOPPED:CONFIRMATION_REQUIRED"]);
    await expect(r.purchase.settle()).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
  });

  it("операция отклонена — STOPPED с кодом причины (SPEC §7б); неизвестная причина — DECLINE_REASON_UNKNOWN", async () => {
    for (const [reason, code] of [["INSUFFICIENT_FUNDS", "INSUFFICIENT_FUNDS"], ["что-то новое", "DECLINE_REASON_UNKNOWN"]] as const) {
      const r = await setup({ payment: payments({ authorize: { status: "DECLINED", declineReason: reason } }) });
      await ordered(r);
      await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code });
      expect(stages(r).at(-1)).toBe(`STOPPED:${code}`);
      expect(r.payment.calls).toEqual(["authorize"]);
      await closeStand();
    }
  });

  it("расчёт не SETTLED — STOPPED UNKNOWN (инвариант 4)", async () => {
    const r = await setup({ payment: payments({ settle: "REVERSED" }) });
    await ordered(r);
    await r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
    await expect(r.purchase.settle()).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(r.purchase.state).toBe("STOPPED");
  });

  it("сбой порта оплаты — STOPPED UNKNOWN, исходная ошибка наружу", async () => {
    const boom = new Error("шлюз недоступен");
    const r = await setup({ payment: { ...payments(), authorize: () => Promise.reject(boom) } });
    await ordered(r);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBe(boom);
    expect(r.purchase.reason).toBe("UNKNOWN");
  });
});

describe("ответ порта не той формы или сбой — STOPPED, а не промежуточное состояние (ревью К3 № 6, инвариант 4)", () => {
  it("заказ: исключение порта, ответ без суммы — STOPPED UNKNOWN", async () => {
    for (const order of [() => Promise.reject(new Error("витрина недоступна")), async () => ({ orderId: "ord_1" }) as never]) {
      const r = await setup({ shop: { order } });
      await signedCart(r, await offers(r));
      await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toThrow();
      expect(stages(r).at(-1)).toBe("STOPPED:UNKNOWN");
      await closeStand();
    }
  });

  it("авторизация и расчёт: ответ null — STOPPED UNKNOWN", async () => {
    const auth = await setup({ payment: { ...payments(), authorize: async () => null as never } });
    await ordered(auth);
    await expect(auth.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toThrow();
    expect(stages(auth).at(-1)).toBe("STOPPED:UNKNOWN");
    await closeStand();
    const settle = await setup({ payment: { ...payments(), settle: async () => null as never } });
    await ordered(settle);
    await settle.purchase.authorize({ idempotencyKey: "idem-pay-1" });
    await expect(settle.purchase.settle()).rejects.toThrow();
    expect(stages(settle).at(-1)).toBe("STOPPED:UNKNOWN");
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
  it("INTENT отозван, пока ждали подписи CART, — STOPPED MANDATE_NOT_ACTIVE, CART_ACTIVE не записан", async () => {
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
    expect(stages(r).slice(-2)).toEqual(["CART_PENDING", "STOPPED:MANDATE_NOT_ACTIVE"]);
  });

  it("CART отозван, пока человек подтверждал, — STOPPED MANDATE_NOT_ACTIVE, авторизации нет", async () => {
    const steps = payments();
    const run: { r?: PurchaseRun } = {};
    const confirm = async () => {
      const r = run.r!;
      const id = r.purchase.cartMandate!.id;
      r.consents.mandates.get(id)!.status = "REVOKED";
      await r.core.mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", id) });
      return "APPROVED" as const;
    };
    const r = (run.r = await setup({ payment: { ...steps, confirm } }));
    await ordered(r, Math.floor(THRESHOLD / TARTINE) + 1);
    await expect(r.purchase.confirm()).rejects.toMatchObject({ code: "MANDATE_NOT_ACTIVE" });
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    expect(steps.calls).toEqual([]);
  });

  it("CART отозван, пока продавец отвечал на заказ, — STOPPED MANDATE_NOT_ACTIVE, ORDERED не записан", async () => {
    const run: { r?: PurchaseRun } = {};
    const inner = shopOrders(SHOP);
    const order = async (req: Parameters<typeof inner.order>[0], m: Parameters<typeof inner.order>[1]) => {
      const r = run.r!;
      r.consents.mandates.get(req.cartMandateId)!.status = "REVOKED";
      await r.core.mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", req.cartMandateId) });
      return inner.order(req, m);
    };
    const r = (run.r = await setup({ shop: { order } }));
    await signedCart(r, await offers(r));
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toMatchObject({ code: "MANDATE_NOT_ACTIVE" });
    expect(r.purchase.order).toBeNull();
    expect(stages(r).at(-1)).toBe("STOPPED:MANDATE_NOT_ACTIVE");
  });

  it("мандат вышел к авторизации — STOPPED MANDATE_NOT_ACTIVE до порта", async () => {
    const r = await setup();
    await ordered(r);
    const id = r.purchase.cartMandate!.id;
    r.consents.mandates.get(id)!.status = "REVOKED";
    await r.core.mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", id) });
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "MANDATE_NOT_ACTIVE" });
    expect(r.payment.calls).toEqual([]);
  });
});

describe("ворота перед стадией 5 (Р38 п. 3, К4): оба мандата держатся и подтверждены verify — иначе STOPPED до реквизита", () => {
  /** verify обращения к контуру по порядку: id мандата из пути */

  it("ворота — verify INTENT, затем CART, непосредственно перед портом авторизации; и после стадии 4 тоже", async () => {
    for (const qty of [1, Math.floor(THRESHOLD / TARTINE) + 1]) {
      const r = await setup();
      await ordered(r, qty);
      if (r.purchase.needsConfirmation) await r.purchase.confirm();
      const before = verified(r).length;
      const log = r.stand.log().length;
      await r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
      expect(verified(r).slice(before)).toEqual([r.purchase.intentMandate!.id, r.purchase.cartMandate!.id]);
      // в воротах — только два verify, без иных обращений к контуру (ревью К4 № 4)
      expect(r.stand.log().slice(log).map((c) => c.op)).toEqual(["GET /pao/v1/mandates/{id}/verify", "GET /pao/v1/mandates/{id}/verify"]);
      await closeStand();
    }
  });

  it("INTENT отозван после заказа — agent.refused MANDATE_NOT_ACTIVE, STOPPED, ни verify, ни реквизита", async () => {
    const r = await setup();
    await ordered(r);
    const id = r.purchase.intentMandate!.id;
    r.consents.mandates.get(id)!.status = "REVOKED";
    await r.core.mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", id) });
    const before = verified(r).length;
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.tail().slice(-2).map((e) => [e.kind, e.reason])).toEqual([
      ["agent.refused", "MANDATE_NOT_ACTIVE"],
      ["purchase.stage", "MANDATE_NOT_ACTIVE"],
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

  it("CART отозван, пока шёл verify в воротах, — STOPPED MANDATE_NOT_ACTIVE, реквизита нет", async () => {
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
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "MANDATE_NOT_ACTIVE" });
    expect(r.tail().filter((e) => e.kind === "agent.refused").map((e) => [e.reason, e.mandate])).toEqual([["MANDATE_NOT_ACTIVE", cartId]]);
    expect(stages(r).at(-1)).toBe("STOPPED:MANDATE_NOT_ACTIVE");
    expect(r.payment.calls).toEqual([]);
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
      const call = r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
      if (!stop) {
        await call;
        expect(verified(r).slice(before)).toEqual([intentId, cartId]);
        expect(r.tail().filter((e) => e.kind === "agent.refused")).toEqual([]);
        expect(r.payment.calls).toEqual(["authorize"]);
        return;
      }
      await expect(call).rejects.toMatchObject({ code: "MANDATE_AMOUNT_LEFT_INSUFFICIENT" });
      expect(r.tail().slice(-2).map((e) => [e.kind, e.reason, e.mandate])).toEqual([
        ["agent.refused", "MANDATE_AMOUNT_LEFT_INSUFFICIENT", id],
        ["purchase.stage", "MANDATE_AMOUNT_LEFT_INSUFFICIENT", intentId],
      ]);
      // по INTENT не хватает — CART уже не проверяется
      expect(verified(r).slice(before)).toEqual(which === "INTENT" ? [intentId] : [intentId, cartId]);
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
});

describe("проверка по мандату до стадии 4 (Р40 п. 5, К4а № 3): человека не просят подтвердить покупку, которую ворота отклонят", () => {
  const ABOVE = Math.floor(THRESHOLD / TARTINE) + 1;

  it("до запроса подтверждения — verify INTENT, затем CART, без иных обращений; в воротах стадии 5 — снова", async () => {
    const r = await setup();
    await ordered(r, ABOVE);
    expect(r.purchase.needsConfirmation).toBe(true);
    const intentId = r.purchase.intentMandate!.id;
    const cartId = r.purchase.cartMandate!.id;
    const from = r.stand.stub.calls.length;
    const before = verified(r).length;
    await r.purchase.confirm();
    expect(opsFrom(r, from)).toEqual([VERIFY, VERIFY]);
    expect(verified(r).slice(before)).toEqual([intentId, cartId]);
    expect(r.payment.calls).toEqual(["confirm"]);
    await r.purchase.authorize({ idempotencyKey: "idem-pay-1" });
    expect(verified(r).slice(before)).toEqual([intentId, cartId, intentId, cartId]);
  });

  for (const which of ["INTENT", "CART"] as const) {
    it(`остаток ${which} меньше итога — STOPPED MANDATE_AMOUNT_LEFT_INSUFFICIENT до запроса подтверждения`, async () => {
      const r = await setup();
      await ordered(r, ABOVE);
      const intentId = r.purchase.intentMandate!.id;
      const id = which === "INTENT" ? intentId : r.purchase.cartMandate!.id;
      r.consents.left.set(id, TARTINE * ABOVE - 1);
      const from = r.stand.stub.calls.length;
      await expect(r.purchase.confirm()).rejects.toMatchObject({ code: "MANDATE_AMOUNT_LEFT_INSUFFICIENT" });
      // по INTENT не хватает — CART уже не проверяется
      expect(opsFrom(r, from)).toEqual(which === "INTENT" ? [VERIFY] : [VERIFY, VERIFY]);
      expect(r.purchase.state).toBe("STOPPED");
      expect(r.tail().slice(-2).map((e) => [e.kind, e.reason, e.mandate])).toEqual([
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
      await expect(r.purchase.confirm()).rejects.toBeInstanceOf(MandateRefused);
      expect(r.purchase.reason).toBe("MANDATE_OUT_OF_SCOPE");
      expect(opsFrom(r, from)).toEqual(which === "INTENT" ? [VERIFY] : [VERIFY, VERIFY]);
      expect(r.tail().filter((e) => e.kind === "agent.refused").map((e) => [e.reason, e.mandate])).toEqual([["MANDATE_OUT_OF_SCOPE", id]]);
      expect(stages(r)).not.toContain("CONFIRMING");
      expect(r.payment.calls).toEqual([]);
    });
  }

  it("INTENT отозван после заказа — MANDATE_NOT_ACTIVE до запроса подтверждения, ни verify, ни порта", async () => {
    const r = await setup();
    await ordered(r, ABOVE);
    const id = r.purchase.intentMandate!.id;
    r.consents.mandates.get(id)!.status = "REVOKED";
    await r.core.mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", id) });
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.confirm()).rejects.toMatchObject({ code: "MANDATE_NOT_ACTIVE" });
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
      expect(opsFrom(r, from)).toEqual(which === "INTENT" ? [VERIFY] : [VERIFY, VERIFY]);
      expect(r.tail().slice(-2).map((e) => [e.kind, e.reason, e.mandate])).toEqual([
        ["agent.refused", "MANDATE_OUT_OF_SCOPE", id],
        ["purchase.stage", "MANDATE_OUT_OF_SCOPE", intentId],
      ]);
      expect(r.payment.calls).toEqual([]);
    });
  }

  it("продавец CART вне merchantScope INTENT — STOPPED MANDATE_OUT_OF_SCOPE после verify обоих уже перед заказом: заказа и реквизита нет (Р39 п. 1.3, Р44 п. 5)", async () => {
    const r = await setup();
    await signedIntent(r, { ...INTENT, merchantScope: ["shop_2"] });
    const zones = await r.purchase.search();
    await signedCart(r, zones.contour.find((o) => o.sku === "tartine")!);
    const intentId = r.purchase.intentMandate!.id;
    const cartId = r.purchase.cartMandate!.id;
    const before = verified(r).length;
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toMatchObject({ code: "MANDATE_OUT_OF_SCOPE" });
    expect(r.shop.calls).toEqual([]);
    expect(verified(r).slice(before)).toEqual([intentId, cartId]);
    expect(opsFrom(r, from)).toEqual([VERIFY, VERIFY]);
    expect(r.tail().slice(-2).map((e) => [e.kind, e.reason, e.mandate])).toEqual([
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
    expect(r.tail().slice(-2).map((e) => [e.kind, e.reason, e.mandate])).toEqual([
      ["agent.refused", "SPLIT_WINDOW", intentId],
      ["purchase.stage", "SPLIT_WINDOW", intentId],
    ]);
    expect(opsFrom(r, from)).toEqual([]);
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
    expect(opsFrom(r, from)).toEqual([VERIFY, VERIFY]);
    expect(verified(r).slice(-2)).toEqual([intentId, cartId]);
    expect(r.tail().slice(-2).map((e) => [e.kind, e.reason])).toEqual([
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
    [{ status: "CONFIRMATION_REQUIRED" }, false],
    // ответ не той формы для стадии 5 — неизвестный исход (STOPPED UNKNOWN), окно занято
    [{ status: "SETTLED" }, true],
  ] as const) {
    it(`ответ стадии 5 ${reply.status} — операция ${counts ? "занимает" : "не занимает"} окно дробления (Р39 п. 4)`, async () => {
      const r = await setup({ payment: payments({ authorize: reply }) });
      await ordered(r);
      const intentId = r.purchase.intentMandate!.id;
      await r.purchase.authorize({ idempotencyKey: "idem-pay-1" }).catch(() => undefined);
      expect(r.payment.calls).toEqual(["authorize"]);
      expect(isShareAfter(r, intentId)).toBe(counts);
    });
  }

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
