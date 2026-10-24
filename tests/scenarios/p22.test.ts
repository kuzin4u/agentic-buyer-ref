// П22 (профиль contour, PaoStub): действие после отзыва мандата. Т13; A7 п. 6; SPEC §7а (MANDATE_REVOKED → STOP_ALL);
// Р50 п. 4–5. Ворота стадии 5 пройдены (verify подтвердил оба мандата), отзыв — между воротами и выдачей реквизита:
// POST /pao/v1/credentials → 409 MANDATE_REVOKED. Начатое остановлено: покупка STOPPED, мандаты сняты с удержания,
// пакет продавцу не уходит, второго обращения нет; человеку — что не завершено (PAYMENT, текст по Р-298).
import { afterEach, describe, expect, it } from "vitest";
import { UNFINISHED_TEXT } from "../../src/agent/declines/index.js";
import { PurchaseTransitionForbidden } from "../../src/agent/pipeline/index.js";
import type { PaoStand } from "../support/pao-stand.js";
import { SHOP, one, purchaseOn, signedIntent, stages } from "../support/purchase.js";
import { shopOrders } from "../support/shop.js";

let stand: PaoStand | undefined;
afterEach(async () => {
  expect(stand?.stub.violations ?? []).toEqual([]);
  await stand?.close();
  stand = undefined;
});

const CREDENTIALS = "POST /pao/v1/credentials" as const;

describe("П22 — действие после отзыва мандата", () => {
  it("409 MANDATE_REVOKED на выдаче реквизита — STOP_ALL: начатое остановлено, мандаты не держатся, человеку — что не завершено", async () => {
    const paid: string[] = [];
    // знак готовности в воротах — тестовый порт (пути нет ни в PaoStub, ни в YAML 1.4.0; на стенде — readiness-stand):
    // считается, что он спрошен один раз, у продавца CART, до реквизита (Р53 п. 6; ревью КТ1 № 3)
    const marks: string[] = [];
    const shop = { ...shopOrders(SHOP), readiness: async (m: string) => (marks.push(m), { status: "ACTIVE" as const }) };
    const r = await purchaseOn({ shop, payment: (core) => core.payment({ pay: async (req) => (paid.push(req.orderId), { status: "PAID" }) }) }, (s) => (stand = s));
    await signedIntent(r);
    const offer = (await r.purchase.search()).contour[0]!;
    const cart = await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-p22" });
    r.setFeed({ kind: "event", event: r.consents.sign(cart.id) });
    await r.purchase.awaitCart();
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-p22" });
    const ids = [r.purchase.intentMandate!.id, cart.id];
    expect(r.core.mandates.held().map((m) => m.id)).toEqual(expect.arrayContaining(ids));

    r.stand.stub.fail(CREDENTIALS, { code: "MANDATE_REVOKED" });
    const from = r.stand.stub.calls.length;
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-p22" })).rejects.toMatchObject({ code: "MANDATE_REVOKED" });

    expect(marks).toEqual([cart.cart!.merchantId]);
    // полный журнал обращений стадии 5 к контуру: ворота (verify INTENT, затем CART; знак — тестовым портом выше) и одна
    // выдача реквизита — 409, больше ничего
    expect(r.stand.stub.calls.slice(from).map((c) => [c.op, c.status, c.code])).toEqual([
      ["GET /pao/v1/mandates/{id}/verify", 200, undefined],
      ["GET /pao/v1/mandates/{id}/verify", 200, undefined],
      [CREDENTIALS, 409, "MANDATE_REVOKED"],
    ]);
    expect(paid).toEqual([]);
    expect(stages(r).at(-1)).toBe("STOPPED:MANDATE_REVOKED");
    expect(r.purchase.next).toBe("STOP_ALL");
    expect(r.purchase.unfinished).toBe("PAYMENT");
    expect(UNFINISHED_TEXT.PAYMENT).toContain("итог проверьте в приложении банка");
    for (const id of ids) expect(r.core.mandates.held().map((m) => m.id)).not.toContain(id);
    expect(r.tail().filter((e) => e.kind === "purchase.unfinished").map((e) => [e.reason, e.detail])).toEqual([["MANDATE_REVOKED", "PAYMENT"]]);

    // начатое не продолжается: повтор авторизации — запрещённый переход, к Платформе не обращается
    const before = r.stand.stub.calls.length;
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-p22" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    expect(r.stand.stub.calls.length).toBe(before);
  });
});
