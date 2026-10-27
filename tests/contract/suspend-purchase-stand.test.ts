// Покупка при приостановлении агента на стенде Платформы и витринах эмулятора (Р60 п. 3, AG-14 ч. 1, К1.3б; передача
// #61 п. 7). Проверяется поведение покупки, не расписание: сверку вызывает тест (`c.recheck()` — та же сверка связки
// ключей, что у ядра); расписание и push — К1.3а на createAgentCore. Приостанавливает и снимает оператор стенда
// (`suspendAgent` / `reinstateAgent`, РП54). Ожидание — из ответов стенда и эмулятора токенов, не из слов витрины.
import { afterEach, describe, expect, it } from "vitest";
import { startFailureCode } from "../../src/agent/compose.js";
import { PurchaseTransitionForbidden, type Purchase } from "../../src/agent/pipeline/index.js";
import { INTENT } from "../support/consents.js";
import { shopBy, type Contour } from "../support/contour.js";
import { one } from "../support/purchase.js";
import { STAND_TIMEOUT_MS, adpDecision, processing, reinstated, standPurchase } from "../support/stand-purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  expect(c?.violations() ?? []).toEqual([]);
  await c?.close();
  c = undefined;
});

const NORMAL = shopBy("NORMAL");
const CREDENTIALS = "POST /pao/v1/credentials";
type Run = Awaited<ReturnType<typeof standPurchase>>;

/** До ORDERED: INTENT и CART подписаны эмулятором банка во время ожидания, заказ у витрины. */
async function ordered(r: Run, p: Purchase, tag: string) {
  const intent = await p.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: `idem-intent-${tag}` });
  await r.signWhileWaiting(intent.id, () => p.awaitIntent());
  const offer = (await p.search()).contour.find((o) => o.shopId === NORMAL.id)!;
  const cart = await p.cart(one(offer, 1), { idempotencyKey: `idem-cart-${tag}` });
  await r.signWhileWaiting(cart.id, () => p.awaitCart());
  const order = await p.placeOrder({ idempotencyKey: `idem-order-${tag}` });
  return { intent, cart, order };
}

describe("покупка при приостановлении агента на стенде (Р60 п. 3, К1.3б)", { timeout: STAND_TIMEOUT_MS }, () => {
  it("suspendAgent перед оплатой — STOPPED AGENT_SUSPENDED без реквизита; reinstateAgent и сверка — новая покупка: новый заказ и новый реквизит, прежний не используется", async () => {
    // авторизация продавца доходит до ADP стенда копией сообщения (подмена до PS-11, `adpUntilPs11`): решение ADP по новому
    // реквизиту видно тесту, итог стадии 5 — из события Платформы после ответа эмитента (как П15)
    const r = await standPurchase({ contourPayment: true, adpUntilPs11: true, failureCode: startFailureCode });
    c = r.c;
    const first = await ordered(r, r.purchase, "s1");

    // оператор приостановил агента между заказом и оплатой: первое подписанное обращение ворот — 403, подпись приостановлена
    await r.stand.suspendAgent(r.c.agentCode, "OUT_OF_MANDATE");
    const start = r.c.agentCalls().length;
    // отказ ворот — исходный PlatformFailure наружу, покупка STOPPED тем же кодом (как знак готовности, readiness-stand)
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-s1" })).rejects.toMatchObject({ name: "PlatformFailure", code: "AGENT_SUSPENDED", httpStatus: 403 });
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("AGENT_SUSPENDED");
    expect(r.c.admission()).toBe("AGENT_SUSPENDED");
    const paused = r.c.agentCalls().slice(start).filter((x) => !x.route.startsWith("GET /pao/v1/events"));
    expect(paused.map((x) => [x.route.replaceAll(first.intent.id, "{intent}"), x.status, x.code])).toEqual([["GET /pao/v1/mandates/{intent}/verify", 403, "AGENT_SUSPENDED"]]);
    // реквизита нет: ни обращения агента, ни выпуска у эмулятора токенов стенда
    expect(r.c.agentCalls().filter((x) => x.route === CREDENTIALS)).toEqual([]);
    expect(r.stand.tsp.issued.size).toBe(0);
    expect(r.c.issuedSecrets()).toEqual([]);

    // снял оператор; сверка с реестром прочитала ACTIVE — подпись возобновлена (Р60 п. 2)
    await reinstated(r.stand, r.c.agentCode);
    await expect(r.c.recheck()).resolves.toMatchObject({ status: "ACTIVE" });
    expect(r.c.admission()).toBeNull();
    expect(r.c.journal.entries.filter((e) => e.kind === "signing.resumed")).toHaveLength(1);

    // прежняя покупка остаётся STOPPED: перехода нет, реквизита по прежнему заказу нет (Р60 п. 3)
    const before = r.c.agentCalls().length;
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-s1" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    expect(r.c.agentCalls()).toHaveLength(before);

    // оплата — только новой покупкой: новый заказ продавца (новый order_ref) и новый реквизит по новому CART
    const p2 = r.next();
    const second = await ordered(r, p2, "s2");
    expect(second.order.orderId).not.toBe(first.order.orderId);
    expect(second.cart.id).not.toBe(first.cart.id);
    const from = r.c.agentCalls().length;
    const authorizing = p2.authorize({ idempotencyKey: "idem-pay-s2" });
    // новый реквизит выдан после приостановления: ADP стенда его принимает (граница до миллисекунды, Р61 п. 3)
    const d = await adpDecision(r.c);
    expect(d.decision).toBe("APPROVE");
    await processing(r.c, { op_ref: d.op_ref, msg_type: "ISSUER_RESPONSE", issuer_approved: true });
    await expect(authorizing).resolves.toMatchObject({ opRef: d.op_ref, orderRef: second.order.orderId, status: "AUTHORIZED" });
    const paid = r.c.agentCalls().slice(from);
    expect(paid.filter((x) => x.route === CREDENTIALS).map((x) => [x.status, x.idempotencyKey])).toEqual([[201, "idem-pay-s2"]]);
    // пакет — витрине по новому заказу; по прежнему заказу обращений нет
    expect(paid.filter((x) => x.target === "merchants").map((x) => x.route)).toEqual([`POST /v1/shops/${NORMAL.id}/orders/${second.order.orderId}/payment`]);
    expect(r.c.agentCalls().some((x) => x.route.includes(first.order.orderId) && x.route.endsWith("/payment"))).toBe(false);
    // выпущен один реквизит — новый; первый заказ реквизита не получал никогда
    expect(r.stand.tsp.issued.size).toBe(1);
  });
});
