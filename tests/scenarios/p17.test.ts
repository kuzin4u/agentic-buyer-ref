// П17 (профиль contour, стенд Платформы): продавец вне категорий мандата. A7, Т10, Т16; инварианты 8, 9; Р56 п. 1,
// путь (а) — засчитывается. «Мандат на хлеб»: категории держит банк клиента — лимит клиента merchant_categories (ПИ-8,
// PS-20) из MCC пекарен по фактам витрин эмулятора (Р54 п. 4); в мандате агента категорий нет, только продавцы.
// Витрина электроники эмулятора (поведение OUT_OF_CATEGORY, свой MCC) — в области INTENT: ADP — MANDATE_SCOPE по MCC →
// operation.declined по проходу сборщика итогов стенда → STOPPED DECLINED_MANDATE_SCOPE, повтора нет. Контрольный
// прогон без лимита клиента — ADP одобряет: отказ дал именно лимит клиента (ревью КТ1 Р56 № 3). Путь (б) —
// самоостановка по области INTENT до CART — модульно (pipeline-cart-lines.test.ts), по нему П17 не засчитывается.
// ПОДМЕНА ДО PS-11 (`adpUntilPs11`): решение ADP — настоящее по копии сообщения эквайрера.
import { MERCHANT_FIXTURES } from "agentic-ps-platform/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { PurchaseStopped } from "../../src/agent/pipeline/index.js";
import { INTENT, RUB } from "../support/consents.js";
import { shopBy, type Contour } from "../support/contour.js";
import { one } from "../support/purchase.js";
import { STAND_TIMEOUT_MS, adpDecision, clientLimits, routesFrom, standPurchase } from "../support/stand-purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  expect(c?.violations() ?? []).toEqual([]);
  await c?.close();
  c = undefined;
});

const ELECTRONICS = shopBy("OUT_OF_CATEGORY");
// MCC пекарен — по фактам витрин эмулятора, не литералом: витрины с той же категорией, что у обычной пекарни
const BAKERY_MCC = [...new Set(MERCHANT_FIXTURES.filter((f) => f.category === shopBy("NORMAL").category).map((f) => f.mcc))];

/** Покупка у витрины электроники до решения ADP; `limits` — лимит клиента в банке до поручения. */
async function toDecision(key: string, limits?: Record<string, unknown>) {
  const r = await standPurchase({ contourPayment: true, adpUntilPs11: true });
  c = r.c;
  if (limits !== undefined) await clientLimits(r.c, INTENT.principalRef, limits);
  const intent = await r.purchase.intent({ ...INTENT, merchantScope: [ELECTRONICS.merchant_id] }, { idempotencyKey: `idem-intent-${key}` });
  await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
  const offer = (await r.purchase.search()).contour.find((o) => o.shopId === ELECTRONICS.id)!;
  expect(offer).toBeDefined();
  const cart = await r.purchase.cart(one(offer, 1), { idempotencyKey: `idem-cart-${key}` });
  await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
  const order = await r.purchase.placeOrder({ idempotencyKey: `idem-order-${key}` });
  const from = r.c.calls().length;
  const authorizing = r.purchase.authorize({ idempotencyKey: `idem-pay-${key}` }).catch((e: unknown) => e);
  const d = await adpDecision(r.c);
  // MCC сообщения эквайрера — настоящий MCC продавца, а не из профиля теста
  expect(r.c.merchants!.emulator.opkc.messages.map((m) => m.merchant?.mcc)).toEqual([ELECTRONICS.mcc]);
  return { r, intent, cart, order, from, authorizing, d };
}

describe("П17 — продавец вне категорий мандата", { timeout: STAND_TIMEOUT_MS * 2 }, () => {
  it("лимит клиента — MCC пекарен, витрина электроники (OUT_OF_CATEGORY) в области INTENT: ADP MANDATE_SCOPE → operation.declined → STOPPED DECLINED_MANDATE_SCOPE, повтора нет", async () => {
    expect(BAKERY_MCC.length).toBeGreaterThan(0);
    expect(BAKERY_MCC).not.toContain(ELECTRONICS.mcc);
    const { r, intent, cart, order, from, authorizing, d } = await toDecision("p17", { merchant_categories: BAKERY_MCC });
    expect(d).toMatchObject({ decision: "DECLINE", reason: "MANDATE_SCOPE" });
    await r.c.stand!.collectOperationOutcomes();
    expect(await authorizing).toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("DECLINED_MANDATE_SCOPE");

    // повтора нет: одна выдача реквизита и одна оплата продавцу; бюджет CART не тронут
    expect((await r.c.platform.verifyMandate({ id: cart.id, currency: "RUB" })).amountLeft).toEqual(RUB(cart.cart!.total.amount));
    // полный журнал обращений агента от оплаты, без ленты (ревью КТ1 Р56 № 1); последний verify — проверка теста
    const ids = { intent: intent.id, cart: cart.id, shop: ELECTRONICS.id, merchant: ELECTRONICS.merchant_id, order: order.orderId, op: d.op_ref };
    expect(routesFrom(r.c, from, "agent", ids)).toEqual([
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "pao GET /pao/v1/mandates/{cart}/verify 200",
      "pao GET /pao/v1/merchants/{merchant}/readiness 200",
      "pao POST /pao/v1/credentials 201",
      "merchants POST /v1/shops/{shop}/orders/{order}/payment 200",
      "pao GET /pao/v1/operations/{op} 200",
      "pao GET /pao/v1/mandates/{cart}/verify 200",
    ]);
  });

  it("контроль: та же покупка без лимита клиента — ADP проходит все проверки MANDATE_SCOPE и доходит до порога подтверждения (отказ П17 дал лимит клиента merchant_categories, а не область мандата или домен токена)", async () => {
    const { r, cart, d } = await toDecision("p17-control");
    // товар дороже порога подтверждения: ADP проверяет порог после области мандата, MCC домена токена и лимитов клиента
    // (decide стенда, п. 6–10) — CONFIRMATION_REQUIRED, а не отказ MANDATE_SCOPE
    expect(cart.cart!.total.amount).toBeGreaterThan(r.c.stand!.params.confirm_above_kop);
    expect(d.decision).toBe("CONFIRMATION_REQUIRED");
    expect(d.reason).not.toBe("MANDATE_SCOPE");
  });
});
