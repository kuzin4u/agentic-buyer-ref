// Отзыв всех полномочий клиента в банке (revoke-all) на стенде Платформы (Р60 п. 8, AG-14 ч. 1, К2.2; передача #41,
// PS-20 ч. 2, РП46 (а)). Т13; SPEC §7а (MANDATE_REVOKED → STOP_ALL); Р50 п. 4–5 — как П22 на PaoStub, но отказ даёт сам
// стенд: клиент отзывает всё (`stand.issuer.revokeAll`) после ворот стадии 5, до выдачи реквизита. Нового кода нет —
// проверяется поведение покупки. Перечитывание мандатов по событию — у ядра (compose), в контуре его нет (STATUS
// «Открыто»: перевод контура на createAgentCore): события и статусы тест читает сам.
import { afterEach, describe, expect, it } from "vitest";
import { startFailureCode } from "../../src/agent/compose.js";
import { UNFINISHED_TEXT } from "../../src/agent/declines/index.js";
import { PurchaseTransitionForbidden } from "../../src/agent/pipeline/index.js";
import { INTENT } from "../support/consents.js";
import { shopBy, type Contour } from "../support/contour.js";
import { one } from "../support/purchase.js";
import { STAND_TIMEOUT_MS, standPurchase } from "../support/stand-purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  expect(c?.violations() ?? []).toEqual([]);
  await c?.close();
  c = undefined;
});

const NORMAL = shopBy("NORMAL");
const CREDENTIALS = "POST /pao/v1/credentials";

describe("revoke-all на стенде (Р60 п. 8, К2.2; #41)", { timeout: STAND_TIMEOUT_MS }, () => {
  it("клиент отозвал все полномочия между воротами и реквизитом — 409 MANDATE_REVOKED: STOP_ALL, мандаты не держатся, человеку — что не завершено", async () => {
    // отзыв — после ответа знака готовности, последней проверки ворот (её шлёт адаптер витрин — `fetch` контура доходит
    // только до него), до выдачи реквизита: ворота пройдены, ответ знака и выдача уходят на стенд как есть
    const hook: { afterGates?: () => Promise<unknown> } = {};
    const f: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (new URL(String(input)).pathname === `/pao/v1/merchants/${NORMAL.merchant_id}/readiness`) await hook.afterGates?.();
      return res;
    };
    const r = await standPurchase({ contourPayment: true, fetch: f, failureCode: startFailureCode });
    c = r.c;
    const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-ra" });
    await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
    const offer = (await r.purchase.search()).contour.find((o) => o.shopId === NORMAL.id)!;
    const cart = await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-ra" });
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-ra" });
    const ids = [intent.id, cart.id];
    expect(r.mandates.held().map((m) => m.id)).toEqual(expect.arrayContaining(ids));

    let revoked: { statusCode: number; body: unknown } | undefined;
    hook.afterGates = async () => {
      hook.afterGates = undefined;
      revoked = await r.stand.issuer.revokeAll(INTENT.principalRef, "rev-all-ra");
    };
    const start = r.c.agentCalls().length;
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-ra" })).rejects.toMatchObject({ code: "MANDATE_REVOKED", httpStatus: 409 });
    expect(revoked?.statusCode).toBe(200);

    // стадия 5: ворота (verify INTENT, CART), знак готовности, одна выдача реквизита — 409 от стенда; больше ничего
    const after = r.c.agentCalls().slice(start).filter((x) => !x.route.startsWith("GET /pao/v1/events"));
    expect(after.map((x) => [x.route.replaceAll(intent.id, "{intent}").replaceAll(cart.id, "{cart}"), x.status, x.code])).toEqual([
      ["GET /pao/v1/mandates/{intent}/verify", 200, undefined],
      ["GET /pao/v1/mandates/{cart}/verify", 200, undefined],
      [`GET /pao/v1/merchants/${NORMAL.merchant_id}/readiness`, 200, undefined],
      [CREDENTIALS, 409, "MANDATE_REVOKED"],
    ]);
    // реквизита нет: ни выпуска у эмулятора токенов, ни пакета витрине
    expect(r.stand.tsp.issued.size).toBe(0);
    expect(r.c.issuedSecrets()).toEqual([]);
    expect(r.c.agentCalls().some((x) => x.target === "merchants" && x.route.endsWith("/payment"))).toBe(false);

    // начатое остановлено (STOP_ALL): покупка STOPPED, мандаты сняты с удержания, человеку — что не завершено (Т13)
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("MANDATE_REVOKED");
    expect(r.purchase.next).toBe("STOP_ALL");
    expect(r.purchase.unfinished).toBe("PAYMENT");
    expect(UNFINISHED_TEXT.PAYMENT).toContain("итог проверьте в приложении банка");
    for (const id of ids) expect(r.mandates.held().map((m) => m.id)).not.toContain(id);
    expect(r.c.journal.entries.filter((e) => e.kind === "purchase.unfinished").map((e) => [e.reason, e.detail])).toEqual([["MANDATE_REVOKED", "PAYMENT"]]);

    // со стороны стенда: mandate.revoked — по каждому мандату, в том числе CART (РП46 (а)); статус — по GET (Р34 п. 5)
    const events = (await r.c.platform.listEvents(null)).flatMap((i) => (i.kind === "event" && i.event.type === "mandate.revoked" ? [i.event.mandateId] : []));
    expect(events).toEqual(expect.arrayContaining(ids));
    for (const id of ids) expect(await r.c.platform.getMandate(id)).toMatchObject({ id, status: "REVOKED" });

    // начатое не продолжается: повтор оплаты — запрещённый переход, к Платформе не обращается
    const before = r.c.agentCalls().length;
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-ra" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    expect(r.c.agentCalls()).toHaveLength(before);
  });
});
