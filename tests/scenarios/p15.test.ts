// П15 (профиль contour, стенд Платформы): авторизация в пределах лимита. A3 п. 5, Т10; инварианты 1, 6, 8; Р56 п. 1.
// Сумма 1 890 ₽ (набор хлеба витрины NORMAL), бюджет INTENT 5 000 ₽: эмитент одобрил → operation.authorized → GET →
// SETTLING; остаток CART и INTENT — по verify Платформы; уведомление о первом использовании — client.mandate_first_use
// через вебхук банка стенда (засчитывается только с ним, Р51 п. 7); клиринг → operation.settled → DONE, запись об
// исполнении WITHIN_LIMITS. ПОДМЕНА ДО PS-11 (`adpUntilPs11`, как в operation-stand.test.ts): решение ADP — настоящее по
// копии сообщения эквайрера, ответ эмитента и клиринг шлёт тест как процессинг (ПИ-3).
import { afterEach, describe, expect, it } from "vitest";
import { INTENT, RUB } from "../support/consents.js";
import { shopBy, type Contour } from "../support/contour.js";
import { one } from "../support/purchase.js";
import { STAND_TIMEOUT_MS, adpDecision, bankNotices, processing, routesFrom, standPurchase } from "../support/stand-purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  expect(c?.violations() ?? []).toEqual([]);
  await c?.close();
  c = undefined;
});

const NORMAL = shopBy("NORMAL");

describe("П15 — авторизация в пределах лимита", { timeout: STAND_TIMEOUT_MS * 2 }, () => {
  it("1 890 ₽ при бюджете 5 000 ₽: AUTHORIZED по событию, остаток по verify меньше на сумму, client.mandate_first_use банку, расчёт DONE с записью WITHIN_LIMITS", async () => {
    const r = await standPurchase({ contourPayment: true, adpUntilPs11: true });
    c = r.c;
    const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-p15" });
    expect(intent.amountLimit).toEqual(RUB(500000));
    await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
    const offer = (await r.purchase.search()).contour.find((o) => o.shopId === NORMAL.id && o.product.price.amount === 189000)!;
    expect(offer).toBeDefined();
    const cart = await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-p15" });
    const total = cart.cart!.total;
    expect(total).toEqual(RUB(189000));
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    const order = await r.purchase.placeOrder({ idempotencyKey: "idem-order-p15" });
    // до оплаты уведомлений банку нет: мандат ещё не использован; остаток CART — полный итог (ревью КТ1 Р56 № 8)
    expect(await bankNotices(r.c)).toEqual([]);
    expect((await r.c.platform.verifyMandate({ id: cart.id, currency: "RUB" })).amountLeft).toEqual(total);

    const from = r.c.calls().length;
    const authorizing = r.purchase.authorize({ idempotencyKey: "idem-pay-p15" });
    const d = await adpDecision(r.c);
    expect(d.decision).toBe("APPROVE");
    await processing(r.c, { op_ref: d.op_ref, msg_type: "ISSUER_RESPONSE", issuer_approved: true });
    // 200 AUTHORIZED — из события Платформы и GET операции, не со слов продавца (инвариант 8)
    expect(await authorizing).toMatchObject({ opRef: d.op_ref, orderRef: order.orderId, status: "AUTHORIZED", amount: total, indicator: { mandateId: cart.id } });
    expect(r.purchase.state).toBe("SETTLING");

    // остаток бюджета уменьшен — по verify Платформы, агент его не вычисляет (инвариант 6)
    expect((await r.c.platform.verifyMandate({ id: cart.id, currency: "RUB" })).amountLeft).toEqual(RUB(0));
    expect((await r.c.platform.verifyMandate({ id: intent.id, currency: "RUB" })).amountLeft).toEqual(RUB(500000 - 189000));

    // уведомление о первом использовании — клиенту через банк, одно, по мандату операции (CART) и коду агента
    expect(await bankNotices(r.c)).toEqual([{ type: "client.mandate_first_use", data: { principal_ref: INTENT.principalRef, mandate_id: cart.id, agent_code: r.c.agentCode } }]);

    // запись об исполнении — по operation.settled и GET (К5 пула)
    const ac = new AbortController();
    const settling = r.purchase.settle(ac.signal);
    await processing(r.c, { op_ref: d.op_ref, msg_type: "PRESENTMENT", amount: total.amount, currency: total.currency });
    expect(await settling).toMatchObject({ status: "SETTLED", fulfilment: { finalAmount: total, scopeCheck: "WITHIN_LIMITS" } });
    expect(r.purchase.state).toBe("DONE");
    // полный журнал обращений агента от оплаты, без ленты: итог — GET операции по событию, расчёт — GET по
    // operation.settled (ревью КТ1 Р56 № 1); два verify после GET — проверка остатка самим тестом через клиент агента
    const ids = { intent: intent.id, cart: cart.id, shop: NORMAL.id, merchant: NORMAL.merchant_id, order: order.orderId, op: d.op_ref };
    expect(routesFrom(r.c, from, "agent", ids)).toEqual([
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "pao GET /pao/v1/mandates/{cart}/verify 200",
      "pao GET /pao/v1/merchants/{merchant}/readiness 200",
      "pao POST /pao/v1/credentials 201",
      "merchants POST /v1/shops/{shop}/orders/{order}/payment 200",
      "pao GET /pao/v1/operations/{op} 200",
      "pao GET /pao/v1/mandates/{cart}/verify 200",
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "pao GET /pao/v1/operations/{op} 200",
    ]);
    // лента банка — целиком: о первом использовании — по-прежнему одно (ключ — мандат); после расчёта CART исчерпан —
    // client.mandate_exhausted по нему же
    expect((await bankNotices(r.c)).map((n) => [n.type, n.data.mandate_id])).toEqual([
      ["client.mandate_first_use", cart.id],
      ["client.mandate_exhausted", cart.id],
    ]);

    // реквизит нигде не встречается (инвариант 1)
    const out = JSON.stringify([r.c.journal.entries, r.purchase.operation]);
    for (const s of r.c.issuedSecrets!()) expect(out.includes(s)).toBe(false);
    // перечень значений реквизита не пуст — иначе проверка выше пустая
    expect(r.c.issuedSecrets!()).not.toEqual([]);
  });
});
