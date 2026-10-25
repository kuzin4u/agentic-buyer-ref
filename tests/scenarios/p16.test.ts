// П16 (профиль contour, стенд Платформы): превышение разовой суммы — лимит клиента в банке (ПИ-8, PS-20). A3 п. 5.2, Т10;
// инварианты 7, 8, 9; Р56 п. 1. per_operation 4 000 ₽, CART 4 500 ₽ в пределах INTENT: ADP — LIMIT_EXCEEDED (источник
// CLIENT), итог — operation.declined по проходу сборщика итогов стенда → STOPPED DECLINED_LIMIT_EXCEEDED; клиент
// уведомлён банком (client.limit_declined); повтора нет — одна выдача реквизита, без дробления.
// ПОДМЕНА ДО PS-11 (`adpUntilPs11`, как в operation-stand.test.ts): решение ADP — настоящее по копии сообщения эквайрера.
import { afterEach, describe, expect, it } from "vitest";
import { PurchaseStopped } from "../../src/agent/pipeline/index.js";
import { PurchaseTransitionForbidden } from "../../src/agent/pipeline/machine.js";
import { INTENT, RUB } from "../support/consents.js";
import { shopBy, type Contour } from "../support/contour.js";
import { one } from "../support/purchase.js";
import { STAND_TIMEOUT_MS, adpDecision, bankNotices, clientLimits, standPurchase } from "../support/stand-purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  await c?.close();
  c = undefined;
});

// витрина с багетом по 150 ₽: 30 штук — 4 500 ₽
const SHOP = shopBy("REJECTS_UNIDENTIFIED");
const CREDENTIALS = "POST /pao/v1/credentials";

describe("П16 — превышение разовой суммы", { timeout: STAND_TIMEOUT_MS * 2 }, () => {
  it("лимит клиента per_operation 4 000 ₽, CART 4 500 ₽: ADP LIMIT_EXCEEDED → operation.declined → STOPPED DECLINED_LIMIT_EXCEEDED; client.limit_declined с reason CLIENT; одна выдача, повтора нет", async () => {
    const notices: string[] = [];
    const r = await standPurchase({ contourPayment: true, adpUntilPs11: true, notify: (code) => void notices.push(code) });
    c = r.c;
    await clientLimits(r.c, INTENT.principalRef, { per_operation: 400000, currency: "RUB" });
    const intent = await r.purchase.intent({ ...INTENT, merchantScope: [SHOP.merchant_id] }, { idempotencyKey: "idem-intent-p16" });
    await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
    const offer = (await r.purchase.search()).contour.find((o) => o.shopId === SHOP.id)!;
    const cart = await r.purchase.cart(one(offer, 30), { idempotencyKey: "idem-cart-p16" });
    expect(cart.cart!.total).toEqual(RUB(450000));
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-p16" });

    const authorizing = r.purchase.authorize({ idempotencyKey: "idem-pay-p16" }).catch((e: unknown) => e);
    const d = await adpDecision(r.c);
    expect(d).toMatchObject({ decision: "DECLINE", reason: "LIMIT_EXCEEDED" });
    // итог отказа ADP вне пути авторизации — событие operation.declined по проходу сборщика стенда
    await r.c.stand!.collectOperationOutcomes();
    const err = await authorizing;
    expect(err).toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("DECLINED_LIMIT_EXCEEDED");
    expect(r.purchase.next).toBe("NOTIFY_HUMAN");

    // клиент уведомлён банком: отказ по превышению, предел — клиента
    const bank = await bankNotices(r.c);
    expect(bank.filter((n) => n.type === "client.limit_declined")).toEqual([
      { type: "client.limit_declined", data: { principal_ref: INTENT.principalRef, mandate_id: cart.id, agent_code: r.c.agentCode, op_ref: d.op_ref, reason: "CLIENT" } },
    ]);
    expect(bank.some((n) => n.type === "client.mandate_first_use")).toBe(false);

    // повтора нет: одна выдача реквизита, одна оплата продавцу, бюджет CART не тронут (инварианты 7, 9)
    expect(r.c.calls().filter((x) => x.target === "pao" && x.route === CREDENTIALS)).toHaveLength(1);
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.call" && e.method?.endsWith("/payment"))).toHaveLength(1);
    expect((await r.c.platform.verifyMandate({ id: cart.id, currency: "RUB" })).amountLeft).toEqual(RUB(450000));
    // повторный вызов из конечного состояния — только отказ перехода, причина остановки прежняя
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-p16" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    expect(r.purchase.reason).toBe("DECLINED_LIMIT_EXCEEDED");
    expect(r.c.calls().filter((x) => x.target === "pao" && x.route === CREDENTIALS)).toHaveLength(1);
    expect(notices).toEqual([]);
  });
});
