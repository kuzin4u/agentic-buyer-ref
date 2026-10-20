// Конвейер, стадии 3–6 на PaoStub (Р38 п. 1–4): выбор человека → CART → живая проверка → заказ со сверкой суммы →
// подтверждение по порогу (Т7) → авторизация и расчёт через порт PaymentSteps (исход — из события Платформы, AG-11).
import { afterEach, describe, expect, it } from "vitest";
import { CartRefused, OrderRefused, PurchaseMachine, PurchaseStopped, PurchaseTransitionForbidden, type Offer } from "../../src/agent/pipeline/index.js";
import { MandateRefused } from "../../src/agent/mandates/index.js";
import { loadParams } from "../../src/shared/config.js";
import { PlatformFailure } from "../../src/shared/domain.js";
import { INTENT, event } from "../support/consents.js";
import { expectJournalClean } from "../support/journal.js";
import { AGENT, type PaoStand } from "../support/pao-stand.js";
import { SHOP, purchaseOn, signedIntent, stages, type PurchaseRun, type PurchaseSetup } from "../support/purchase.js";
import { bakery, feedPrice, liveOffers, payments, shopOrders } from "../support/shop.js";

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
/** цена tartine по фиду, коп. */
const TARTINE = feedPrice(SHOP, "tartine").amount;

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
  const cart = await r.purchase.cart({ ...key(offer), qty, keyTermsShown: true }, { idempotencyKey: "idem-cart-1" });
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
    // ворота перед стадией 5 — verify INTENT и CART (К4)
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
    ]);
    // живая проверка — по строке CART
    expect(r.live.calls).toEqual([{ sku: "tartine", quantity: 1, region: "77" }]);
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
    await r.purchase.cart({ ...key(offer), qty: 1, keyTermsShown: true }, { idempotencyKey: "idem-cart-1" });
    expect(r.purchase.state).toBe("CART_ACTIVE");
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-1" });
    expect(stages(r).slice(-3)).toEqual(["CART_PENDING", "CART_ACTIVE", "ORDERED"]);
  });

  it("подписи CART нет — ждать человека: MANDATE_SIGNATURE_PENDING наружу, покупка в CART_PENDING", async () => {
    const r = await setup();
    await r.purchase.cart({ ...key(await offers(r)), qty: 1, keyTermsShown: true }, { idempotencyKey: "idem-cart-1" });
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
      await expect(r.purchase.cart({ ...choice, qty: 1, keyTermsShown: true }, { idempotencyKey: "idem-cart-1" })).rejects.toBeInstanceOf(PurchaseStopped);
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
    await expect(r.purchase.cart({ ...key(zones.contour[0]!), qty: 1, keyTermsShown: true }, { idempotencyKey: "idem-cart-1" })).rejects.toMatchObject({ code: "A5_NEEDS_HUMAN" });
    expect(r.purchase.state).toBe("OFFERS");
    const decision = { sku: "tartine", accepted: ["A5_RETURNS_MISMATCH" as const] };
    const cart = await r.purchase.cart({ ...key(zones.contour[0]!), qty: 1, decision, keyTermsShown: true }, { idempotencyKey: "idem-cart-1" });
    expect(cart.cart!.total.amount).toBe(TARTINE);
  });

  it("выдача, отданная наружу, — копия: товар рынка, дописанный в contour у вызывающего, — всё равно вне контура", async () => {
    const r = await setup({ shops: [SHOP, { ...SHOP, merchantId: "shop_2", inContour: false }] });
    await signedIntent(r);
    const zones = await r.purchase.search();
    zones.contour.push(zones.market[0]!);
    r.purchase.offers!.contour.push(zones.market[0]!);
    await expect(r.purchase.cart({ ...key(zones.market[0]!), qty: 1, keyTermsShown: true }, { idempotencyKey: "idem-cart-1" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.reason).toBe("OFFER_NOT_IN_CONTOUR");
  });

  it("сигнал A5 без решения человека — A5_NEEDS_HUMAN; с решением по показанным кодам — CART", async () => {
    const r = await setup({ shops: [{ ...SHOP, profile: bakery({ returns: { days: 0, text: "Возврат в течение 14 дней" } }) }] });
    const offer = await offers(r);
    expect(offer.a5).toEqual(["A5_RETURNS_MISMATCH"]);
    const refused = await r.purchase.cart({ ...key(offer), qty: 1, keyTermsShown: true }, { idempotencyKey: "idem-cart-1" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CartRefused);
    expect(refused).toMatchObject({ code: "A5_NEEDS_HUMAN" });
    expect(r.purchase.state).toBe("OFFERS");
    const decision = { sku: "tartine", accepted: ["A5_RETURNS_MISMATCH" as const] };
    await r.purchase.cart({ ...key(offer), qty: 1, decision, keyTermsShown: true }, { idempotencyKey: "idem-cart-1" });
    expect(r.purchase.state).toBe("CART_PENDING");
  });

  it("сигнал A5 при автономном режиме — A5_AUTONOMOUS, решение человека не помогает", async () => {
    const r = await setup({ shops: [{ ...SHOP, profile: bakery({ returns: { days: 0, text: "Возврат в течение 14 дней" } }) }] });
    await signedIntent(r, { ...INTENT, confirmationMode: "AUTONOMOUS" });
    const offer = (await r.purchase.search()).contour[0]!;
    const decision = { sku: offer.sku, accepted: offer.a5 };
    const refused = await r.purchase.cart({ ...key(offer), qty: 1, decision, keyTermsShown: true }, { idempotencyKey: "idem-cart-1" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CartRefused);
    expect(refused).toMatchObject({ code: "A5_AUTONOMOUS" });
    expect(r.purchase.state).toBe("OFFERS");
  });
});

describe("стадия 3 — живая проверка перед заказом (Р32 п. 3–4): не ok — CART_ACTIVE → OFFERS, заказа нет", () => {
  const cases = [
    ["цена выросла", { price: { amount: TARTINE + 100, currency: "RUB" } }, "NEW_CART_MANDATE", ["LIVE_PRICE_UP"]],
    ["нет в наличии", { availability: { inStock: false } }, "TELL_STOCK", ["LIVE_OUT_OF_STOCK"]],
  ] as const;
  for (const [name, over, next, codes] of cases) {
    it(`${name} — OrderRefused ${next}`, async () => {
      const r = await setup({ live: liveOffers(SHOP, () => stand!.clock, () => over) });
      await signedCart(r, await offers(r));
      const err = await r.purchase.placeOrder({ idempotencyKey: "idem-order-1" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OrderRefused);
      expect(err).toMatchObject({ next, codes });
      expect(r.purchase.state).toBe("OFFERS");
      expect(r.shop.calls).toEqual([]);
    });
  }

  it("продавец не ответил — LIVE_UNAVAILABLE, «не подтверждено»; новый выбор после отказа — снова CART", async () => {
    const r = await setup({ live: { fetch: () => Promise.reject(new Error("сбой")) } });
    const offer = await offers(r);
    await signedCart(r, offer);
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-1" })).rejects.toMatchObject({ next: "TELL_UNCONFIRMED", codes: ["LIVE_UNAVAILABLE"] });
    await r.purchase.cart({ ...key(offer), qty: 1, keyTermsShown: true }, { idempotencyKey: "idem-cart-2" });
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
    expect(r.live.calls).toEqual([]);
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
        await r.purchase.cart({ ...key(offer), qty, keyTermsShown: true }, { idempotencyKey: "idem-cart-1" });
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
    const steps = payments();
    const r = await setup({ payment: { ...steps, confirm: () => pending } });
    await ordered(r, Math.floor(THRESHOLD / TARTINE) + 1);
    const waiting = r.purchase.confirm();
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    release("APPROVED");
    await expect(waiting).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.state).toBe("STOPPED");
    expect(steps.calls).toEqual([]);
  });

  it("повторный вход в идущую стадию — запрещённый переход (два cart() подряд)", async () => {
    const r = await setup();
    const offer = await offers(r);
    const first = r.purchase.cart({ ...key(offer), qty: 1, keyTermsShown: true }, { idempotencyKey: "idem-cart-1" });
    await expect(r.purchase.cart({ ...key(offer), qty: 1, keyTermsShown: true }, { idempotencyKey: "idem-cart-2" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
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

describe("держимые после ожиданий (Р38 п. 3, ревью К3 № 10)", () => {
  it("INTENT отозван, пока ждали подписи CART, — STOPPED MANDATE_NOT_ACTIVE, CART_ACTIVE не записан", async () => {
    const r = await setup();
    const intent = await signedIntent(r);
    const offer = (await r.purchase.search()).contour[0]!;
    const cart = await r.purchase.cart({ ...key(offer), qty: 1, keyTermsShown: true }, { idempotencyKey: "idem-cart-1" });
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
  const verified = (r: PurchaseRun) => r.stand.stub.calls.filter((c) => c.op === "GET /pao/v1/mandates/{id}/verify").map((c) => c.path.split("/")[4]);

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

  it("verify INTENT перед CART не CONFIRMED — STOPPED MANDATE_OUT_OF_SCOPE, CART не запрошен", async () => {
    const r = await setup();
    const offer = await offers(r);
    r.consents.outcome = "OUT_OF_SCOPE";
    await expect(r.purchase.cart({ ...key(offer), qty: 1, keyTermsShown: true }, { idempotencyKey: "idem-cart-1" })).rejects.toBeInstanceOf(MandateRefused);
    expect(r.purchase.reason).toBe("MANDATE_OUT_OF_SCOPE");
    expect(r.stand.log().filter((c) => c.op === "POST /pao/v1/mandates")).toHaveLength(1);
  });
});
