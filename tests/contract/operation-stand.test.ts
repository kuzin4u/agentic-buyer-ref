// Стадии 5–6 на стенде Платформы v0.20.0 (Р49; AG-11 ч. 2, К5): итог стадии 5 — из события operation.authorized и
// GET /pao/v1/operations/{op_ref}, привязка по order_ref и сверка с CART; расчёт — operation.settled и GET, запись об
// исполнении. П15 — авторизация в пределах лимита с клирингом; риск 4а — авторизация по новому CART при ACTIVE прежнем.
// ПОДМЕНА ДО PS-11 (как в confirmation-stand.test.ts, вариант (а) владельца): продавец ADP не достигает, заглушка отвечает
// ему отказом, копию сообщения эквайрера тестовая поддержка передаёт в настоящий ADP стенда (contour.ts, `adpUntilPs11`).
// Ответ эмитента (ISSUER_RESPONSE) и клиринг (PRESENTMENT) шлёт тест как процессинг (ПИ-3); решение ADP, итог, события,
// GET и запись об исполнении — настоящие. Ответ продавца DECLINED — только слова (инвариант 8): итог — по событию.
import { afterEach, describe, expect, it } from "vitest";
import { DIAG } from "../../src/agent/compose.js";
import { INTENT } from "../support/consents.js";
import { shopBy, type Contour } from "../support/contour.js";
import { one } from "../support/purchase.js";
import { STAND_TIMEOUT_MS, standPurchase } from "../support/stand-purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  await c?.close();
  c = undefined;
});

const NORMAL = shopBy("NORMAL");

type Run = Awaited<ReturnType<typeof standPurchase>>;

/** Решение ADP стенда по копии сообщения эквайрера: ждать, пока продавец его запросит; op_ref — из сообщения. */
async function decided(r: Run, n = 1): Promise<{ op_ref: string; decision: string }> {
  for (let i = 0; i < 200; i++) {
    const all = (await r.c.adpDecisions!()) as { op_ref?: string; decision?: string }[];
    if (all.length >= n) {
      const d = all[n - 1]!;
      expect(d.op_ref).toEqual(expect.any(String));
      return d as { op_ref: string; decision: string };
    }
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("продавец не дошёл до ADP стенда");
}

/** Сообщение процессинга ПИ-3 на стенд (ответ эмитента, клиринг): 202 — принято. */
async function processing(r: Run, payload: Record<string, unknown>): Promise<void> {
  const res = await r.c.stand!.app.inject({ method: "POST", url: "/adp/v1/events", payload });
  expect(res.statusCode, JSON.stringify(payload)).toBe(202);
}

const entries = (r: Run, kind: string) => r.c.journal.entries.filter((e) => e.kind === kind).map((e) => [e.ref, e.detail]);

describe("стадии 5–6 на стенде v0.20.0: итог из события и GET операции, расчёт (Р49)", { timeout: STAND_TIMEOUT_MS * 2 }, () => {
  it("П15: авторизация в пределах лимита — эмитент одобрил → operation.authorized → GET → SETTLING; остаток CART уменьшен; клиринг → operation.settled → DONE, запись об исполнении WITHIN_LIMITS", async () => {
    const notices: string[] = [];
    const r = await standPurchase({ contourPayment: true, adpUntilPs11: true, notify: (code) => void notices.push(code) });
    c = r.c;
    const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-p15" });
    await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
    const offer = (await r.purchase.search()).contour.find((o) => o.shopId === NORMAL.id)!;
    const cart = await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-p15" });
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    const order = await r.purchase.placeOrder({ idempotencyKey: "idem-order-p15" });
    const total = cart.cart!.total;
    expect(total.amount).toBeLessThanOrEqual(r.c.stand!.params.confirm_above_kop);

    const authorizing = r.purchase.authorize({ idempotencyKey: "idem-pay-p15" });
    const d = await decided(r);
    // ADP одобрила по пределам мандата и ждёт эмитента: итога ещё нет, события нет
    expect(d.decision).toBe("APPROVE");
    await processing(r, { op_ref: d.op_ref, msg_type: "ISSUER_RESPONSE", issuer_approved: true });
    const op = await authorizing;
    expect(op).toMatchObject({ opRef: d.op_ref, orderRef: order.orderId, status: "AUTHORIZED", amount: total, merchantId: cart.cart!.merchantId, indicator: { mandateId: cart.id }, channel: "CARD" });
    expect(r.purchase.state).toBe("SETTLING");
    // продавец ответил отказом (подмена до PS-11) — слова продавца только в журнале, итог — по событию Платформы
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.call" && e.method?.endsWith("/payment")).map((e) => e.detail)).toEqual(["DECLINED"]);
    expect(entries(r, "operation.status")).toEqual([[d.op_ref, "AUTHORIZED"]]);
    // П15: остаток бюджета CART уменьшен — по verify Платформы, агент его не вычисляет (инвариант 6)
    const left = await r.c.platform.verifyMandate({ id: cart.id, currency: total.currency });
    expect(left.amountLeft.amount).toBe(0);

    // клиринг — PRESENTMENT суммой одобрения; расчёт ждёт operation.settled и читает GET
    const ac = new AbortController();
    const settling = r.purchase.settle(ac.signal);
    await processing(r, { op_ref: d.op_ref, msg_type: "PRESENTMENT", amount: total.amount, currency: total.currency });
    const settled = await settling;
    expect(settled).toMatchObject({ status: "SETTLED", fulfilment: { finalAmount: total, spentPosition: total, scopeCheck: "WITHIN_LIMITS" } });
    expect(settled.fulfilment!.ref).toMatch(/^ful_/);
    expect(r.purchase.state).toBe("DONE");
    expect(entries(r, "operation.settled")).toEqual([[d.op_ref, "WITHIN_LIMITS"]]);
    expect(notices).toEqual([]);
    // реквизит нигде не встречается (инвариант 1)
    const out = JSON.stringify([r.c.journal.entries, r.purchase.operation]);
    for (const s of r.c.issuedSecrets!()) expect(out.includes(s)).toBe(false);
  });

  it("риск 4а (авторизация): новый CART при ACTIVE прежнем — операция привязана к новому CART, прежний остаётся ACTIVE и не используется", async () => {
    const r = await standPurchase({ contourPayment: true, adpUntilPs11: true });
    c = r.c;
    const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-4a2" });
    await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
    const first = (await r.purchase.search()).contour.find((o) => o.shopId === NORMAL.id)!;
    const old = await r.purchase.cart(one(first, 1), { idempotencyKey: "idem-cart-4a2-old" });
    await r.signWhileWaiting(old.id, () => r.purchase.awaitCart());
    const offer = (await r.purchase.search()).contour.find((o) => o.shopId === NORMAL.id)!;
    const cart = await r.purchase.cart(one(offer, 2), { idempotencyKey: "idem-cart-4a2-new" });
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-4a2" });
    expect((await r.c.platform.getMandate(old.id)).status).toBe("ACTIVE");

    const authorizing = r.purchase.authorize({ idempotencyKey: "idem-pay-4a2" });
    const d = await decided(r);
    expect(d.decision).toBe("APPROVE");
    await processing(r, { op_ref: d.op_ref, msg_type: "ISSUER_RESPONSE", issuer_approved: true });
    const op = await authorizing;
    expect(op).toMatchObject({ status: "AUTHORIZED", amount: cart.cart!.total, indicator: { mandateId: cart.id } });
    expect(r.c.journal.entries.some((e) => e.kind === "operation.mismatch")).toBe(false);
    // прежний CART — ACTIVE и с полным остатком: операция по нему не шла
    expect((await r.c.platform.getMandate(old.id)).status).toBe("ACTIVE");
    expect((await r.c.platform.verifyMandate({ id: old.id, currency: "RUB" })).amountLeft).toEqual(old.cart!.total);
  });

  it("Р51 п. 5: реверсал до ответа эмитента — событий нет вовсе; итог находит поиск GET ?mandate_id по CART — STOPPED OPERATION_REVERSED, текст Р51 п. 3; бюджет CART освобождён", async () => {
    // сроки стадии 5 — короткие: событий не будет, ждать полный срок незачем (сравнение — с одним поиском после срока)
    const r = await standPurchase({ contourPayment: true, adpUntilPs11: true, params: { operation_outcome_max_delay_sec: 1, confirmation_wait_ms: 1000 } });
    c = r.c;
    const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-rev" });
    await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
    const offer = (await r.purchase.search()).contour.find((o) => o.shopId === NORMAL.id)!;
    const cart = await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-rev" });
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-rev" });
    const total = cart.cart!.total;

    const authorizing = r.purchase.authorize({ idempotencyKey: "idem-pay-rev" }).catch((e: unknown) => e);
    const d = await decided(r);
    expect(d.decision).toBe("APPROVE");
    // процессинг отменил авторизацию до ответа эмитента: ни operation.authorized, ни operation.declined (передача #63 п. 3)
    await processing(r, { op_ref: d.op_ref, msg_type: "REVERSAL", amount: total.amount, currency: total.currency });
    const err = await authorizing;
    expect(err).toMatchObject({ name: "PurchaseStopped", code: "OPERATION_REVERSED" });
    expect(r.purchase.reason).toBe("OPERATION_REVERSED");
    expect(r.purchase.next).toBe("NOTIFY_HUMAN");
    expect(DIAG.OPERATION_REVERSED!.human.ru).toBe("Оплата отменена; списания быть не должно — если оно всё же придёт, сообщим отдельно. Покупка остановлена; итог проверьте в приложении банка.");
    // поиск — одно обращение по CART; запись — CART и BOUND, без тела ответа
    expect(r.c.calls().filter((x) => x.target === "pao" && x.route === "GET /pao/v1/operations")).toHaveLength(1);
    expect(entries(r, "operation.lookup")).toEqual([[cart.id, "BOUND"]]);
    expect(entries(r, "operation.reversed")).toEqual([[d.op_ref, "REVERSAL"]]);
    // бюджет освободила Платформа — по verify (инвариант 6)
    expect((await r.c.platform.verifyMandate({ id: cart.id, currency: total.currency })).amountLeft).toEqual(total);
  });
});
