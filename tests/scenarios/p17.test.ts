// П17 (профиль contour, стенд Платформы): продавец вне категорий мандата. A7, Т10, Т16; инварианты 8, 9; Р56 п. 1,
// путь (а) — засчитывается. «Мандат на хлеб»: категории держит банк клиента — лимит клиента merchant_categories (ПИ-8,
// PS-20) из MCC пекарен по фактам витрин эмулятора (Р54 п. 4); в мандате агента категорий нет, только продавцы.
// Витрина электроники эмулятора (поведение OUT_OF_CATEGORY, свой MCC) — в области INTENT: ADP — MANDATE_SCOPE по MCC → operation.declined по проходу
// сборщика итогов стенда → STOPPED DECLINED_MANDATE_SCOPE, повтора нет. Путь (б) — самоостановка по области INTENT до
// CART — модульно (pipeline-cart-lines.test.ts), по нему П17 не засчитывается.
// ПОДМЕНА ДО PS-11 (`adpUntilPs11`): решение ADP — настоящее по копии сообщения эквайрера.
import { MERCHANT_FIXTURES } from "agentic-ps-platform/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { PurchaseStopped } from "../../src/agent/pipeline/index.js";
import { INTENT, RUB } from "../support/consents.js";
import { shopBy, type Contour } from "../support/contour.js";
import { one } from "../support/purchase.js";
import { STAND_TIMEOUT_MS, adpDecision, clientLimits, standPurchase } from "../support/stand-purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  await c?.close();
  c = undefined;
});

const ELECTRONICS = shopBy("OUT_OF_CATEGORY");
// MCC пекарен — по фактам витрин эмулятора, не литералом: витрины с той же категорией, что у обычной пекарни
const BAKERY_MCC = [...new Set(MERCHANT_FIXTURES.filter((f) => f.category === shopBy("NORMAL").category).map((f) => f.mcc))];
const CREDENTIALS = "POST /pao/v1/credentials";

describe("П17 — продавец вне категорий мандата", { timeout: STAND_TIMEOUT_MS * 2 }, () => {
  it("лимит клиента — MCC пекарен, витрина электроники (OUT_OF_CATEGORY) в области INTENT: ADP MANDATE_SCOPE → operation.declined → STOPPED DECLINED_MANDATE_SCOPE, повтора нет", async () => {
    expect(BAKERY_MCC.length).toBeGreaterThan(0);
    expect(BAKERY_MCC).not.toContain(ELECTRONICS.mcc);
    const r = await standPurchase({ contourPayment: true, adpUntilPs11: true });
    c = r.c;
    await clientLimits(r.c, INTENT.principalRef, { merchant_categories: BAKERY_MCC });
    const intent = await r.purchase.intent({ ...INTENT, merchantScope: [ELECTRONICS.merchant_id] }, { idempotencyKey: "idem-intent-p17" });
    await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
    const offer = (await r.purchase.search()).contour.find((o) => o.shopId === ELECTRONICS.id)!;
    expect(offer).toBeDefined();
    const cart = await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-p17" });
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-p17" });

    const authorizing = r.purchase.authorize({ idempotencyKey: "idem-pay-p17" }).catch((e: unknown) => e);
    const d = await adpDecision(r.c);
    expect(d).toMatchObject({ decision: "DECLINE", reason: "MANDATE_SCOPE" });
    // MCC сообщения эквайрера — настоящий MCC продавца, а не из профиля теста
    expect(r.c.merchants!.emulator.opkc.messages.map((m) => m.merchant?.mcc)).toEqual([ELECTRONICS.mcc]);
    await r.c.stand!.collectOperationOutcomes();
    expect(await authorizing).toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("DECLINED_MANDATE_SCOPE");

    // повтора нет: одна выдача реквизита и одна оплата продавцу; бюджет CART не тронут
    expect(r.c.agentCalls().filter((x) => x.route === CREDENTIALS)).toHaveLength(1);
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.call" && e.method?.endsWith("/payment"))).toHaveLength(1);
    expect((await r.c.platform.verifyMandate({ id: cart.id, currency: "RUB" })).amountLeft).toEqual(RUB(cart.cart!.total.amount));
  });
});
