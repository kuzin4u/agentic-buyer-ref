// П14 (профиль contour, стенд Платформы): операция без признака агентности. A1 п. 3.2, Т8; инварианты 4, 8; Р56 п. 1.
// Агент передаёт продавцу пакет с aoi{agent_code, mandate_id}, подписанный агентом; эквайрер эмулятора без поддержки aoi
// (РП22 п. 6) шлёт авторизацию без признака — ADP стенда (aoi_rollout_phase 3) отказывает AOI_MISSING. Агенту причина
// событием не приходит (#57 п. 3, SPEC §7б), поиск GET ?mandate_id операции не находит — STOPPED
// OPERATION_RESULT_UNCONFIRMED, повтора нет (инвариант 4). Без aoi пакет у агента не формируется — модульно
// (pao-adapter.test.ts, «П14: ответ выдачи без признака», ревью КТ1 Р56 № 2). ПОДМЕНА ДО PS-11 (`adpUntilPs11`): решение ADP — настоящее по копии сообщения эквайрера.
import { afterEach, describe, expect, it } from "vitest";
import { PaymentFailure } from "../../src/agent/ports/index.js";
import { INTENT } from "../support/consents.js";
import { shopBy, type Contour } from "../support/contour.js";
import { one } from "../support/purchase.js";
import { SHORT_DELAY_SEC, STAND_TIMEOUT_MS, adpDecision, routesFrom, standPurchase } from "../support/stand-purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  expect(c?.violations() ?? []).toEqual([]);
  await c?.close();
  c = undefined;
});

const NORMAL = shopBy("NORMAL");

describe("П14 — операция без признака агентности", { timeout: STAND_TIMEOUT_MS * 2 }, () => {
  it("пакет агента — с aoi и подписью; эквайрер без aoi — ADP AOI_MISSING; события нет — STOPPED OPERATION_RESULT_UNCONFIRMED, повтора нет", async () => {
    // сроки — короткие: заглушка продавца до PS-11 отвечает «нужно подтверждение», агент ждёт запроса подтверждения
    // (confirmation_wait_ms) и итога операции — ни того, ни другого не будет
    const params = { operation_outcome_max_delay_sec: SHORT_DELAY_SEC, confirmation_wait_ms: SHORT_DELAY_SEC * 1000 };
    const r = await standPurchase({ contourPayment: true, adpUntilPs11: true, aoiSupport: false, params });
    c = r.c;
    const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-p14" });
    await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
    const offer = (await r.purchase.search()).contour.find((o) => o.shopId === NORMAL.id)!;
    const cart = await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-p14" });
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    const order = await r.purchase.placeOrder({ idempotencyKey: "idem-order-p14" });

    const from = r.c.calls().length;
    const authorizing = r.purchase.authorize({ idempotencyKey: "idem-pay-p14" }).catch((e: unknown) => e);
    const d = await adpDecision(r.c);
    // признак до ADP не дошёл: эквайрер его не передаёт — отказ AOI_MISSING (A1 п. 3.2)
    expect(d).toMatchObject({ decision: "DECLINE", reason: "AOI_MISSING" });
    const emulator = r.c.merchants!.emulator;
    expect(emulator.opkc.messages.map((m) => ("aoi" in m ? m.aoi : undefined))).toEqual([undefined]);
    // пакет агента — с признаком: код агента и CART (Т8); подпись пакета проверил verifier эмулятора — иначе витрина
    // пакет не приняла бы и метаданных на сверку не было бы
    expect(emulator.reconciliation).toEqual([expect.objectContaining({ merchant_id: NORMAL.merchant_id, order_ref: order.orderId, aoi: { indicator: true, agent_code: r.c.agentCode, mandate_id: cart.id } })]);
    // сборщик итогов стенда записал отказ, но агенту событием он не приходит (#57 п. 3)
    await r.c.stand!.collectOperationOutcomes();

    const err = await authorizing;
    expect(err).toBeInstanceOf(PaymentFailure);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("OPERATION_RESULT_UNCONFIRMED");
    expect(r.c.journal.entries.some((e) => e.kind === "operation.status" || e.reason === "AOI_MISSING")).toBe(false);
    // повтора нет: полный журнал обращений агента от оплаты, без ленты (ревью КТ1 Р56 № 1) — одна выдача реквизита, одна
    // оплата продавцу, один поиск по CART
    const ids = { intent: intent.id, cart: cart.id, shop: NORMAL.id, merchant: NORMAL.merchant_id, order: order.orderId };
    expect(routesFrom(r.c, from, "agent", ids)).toEqual([
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "pao GET /pao/v1/mandates/{cart}/verify 200",
      "pao GET /pao/v1/merchants/{merchant}/readiness 200",
      "pao POST /pao/v1/credentials 201",
      "merchants POST /v1/shops/{shop}/orders/{order}/payment 200",
      "pao GET /pao/v1/operations 200",
    ]);
  });
});
