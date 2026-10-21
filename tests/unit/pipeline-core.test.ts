// Полный путь покупки 0–6 на PaoStub через место сборки — core.purchase() (Р38 п. 8, К6): клиент мандатов, журнал и
// допуск ядра, порты стадий — от вызывающего. Ленты у PaoStub нет (Р34 п. 10): мандаты приходят сразу ACTIVE (РП35),
// ожидание подписи по ленте — в pipeline-purchase/pipeline-stages и на стенде (tests/contract/purchase-stand.test.ts).
import { afterEach, describe, expect, it } from "vitest";
import { Consents, INTENT } from "../support/consents.js";
import { coreOn } from "../support/core.js";
import { expectJournalClean } from "../support/journal.js";
import { AGENT, PaoStand } from "../support/pao-stand.js";
import { SHOP, one } from "../support/purchase.js";
import { feedOffers, liveOffers, payments, shopOrders } from "../support/shop.js";

let stand: PaoStand | undefined;
afterEach(async () => {
  expect(stand?.stub.violations ?? []).toEqual([]);
  await stand?.close();
  stand = undefined;
});

describe("core.purchase() — путь 0–6 на PaoStub (Р38 п. 8, К6)", () => {
  it("допуск → INTENT → выдача → CART → заказ → ворота → авторизация → расчёт: DONE, purchase.stage на каждый переход", async () => {
    const consents: Consents = new Consents(() => s.clock);
    const s = new PaoStand({ handlers: consents.handlers() });
    stand = s;
    consents.tamper = (m) => Object.assign(m, { status: "ACTIVE" });
    const { core, journal } = await coreOn(s);
    await core.start();
    const shop = shopOrders(SHOP);
    const payment = payments();
    const p = core.purchase({ offers: feedOffers(SHOP), live: liveOffers(SHOP, () => s.clock), shop, payment, region: "77" });
    const intent = await p.intent(INTENT, { idempotencyKey: "idem-intent-1" });
    const offer = (await p.search()).contour[0]!;
    const cart = await p.cart(one(offer, 1), { idempotencyKey: "idem-cart-1" });
    await p.placeOrder({ idempotencyKey: "idem-order-1" });
    expect(p.needsConfirmation).toBe(false);
    await p.authorize({ idempotencyKey: "idem-pay-1" });
    await p.settle();
    expect(p.state).toBe("DONE");
    // полный журнал обращений к PaoStub: допуск, INTENT (сразу ACTIVE — GET), verify перед поиском и перед CART, CART,
    // перед заказом и в воротах — verify INTENT и CART (Р44 п. 5); лишнее обращение видно (ревью К6 № 4)
    expect(s.stub.calls.map((c) => c.op)).toEqual([
      "GET /.well-known/pao-configuration",
      "GET /pao/v1/agent",
      "POST /pao/v1/mandates",
      "GET /pao/v1/mandates/{id}",
      "GET /pao/v1/mandates/{id}/verify",
      "GET /pao/v1/mandates/{id}/verify",
      "POST /pao/v1/mandates",
      "GET /pao/v1/mandates/{id}",
      "GET /pao/v1/mandates/{id}/verify",
      "GET /pao/v1/mandates/{id}/verify",
      "GET /pao/v1/mandates/{id}/verify",
      "GET /pao/v1/mandates/{id}/verify",
    ]);
    expect(shop.calls).toEqual([{ shopId: SHOP.profile.id, items: [{ sku: offer.sku, qty: 1 }], cartMandateId: cart.id }]);
    expect(payment.calls).toEqual(["authorize", "settle"]);
    expect(journal.entries.filter((e) => e.kind === "purchase.stage").map((e) => [e.detail, e.mandate])).toEqual(
      ["INTENT_ACTIVE", "OFFERS", "CART_PENDING", "CART_ACTIVE", "ORDERED", "AUTHORIZING", "SETTLING", "DONE"].map((d) => [d, intent.id]),
    );
    // журнал ядра: код агента и время ядра в каждой записи, закрытый набор полей, без ключей идемпотентности
    expectJournalClean(journal.entries, AGENT, s.stub.calls, ["idem-intent-1", "idem-cart-1"]);
  });

  it("окно дробления — одно на ядро: покупки core.purchase() видят одно окно (Р39 п. 4, ревью К2 М6)", async () => {
    const consents: Consents = new Consents(() => s.clock);
    const s = new PaoStand({ handlers: consents.handlers() });
    stand = s;
    const { core } = await coreOn(s);
    const ports = () => ({ offers: feedOffers(SHOP), live: liveOffers(SHOP, () => s.clock), shop: shopOrders(SHOP), payment: payments(), region: "77" });
    // окно — закрытое поле конвейера: снаружи его не подменить и не прочитать, кроме как в тесте
    const windowOf = (p: unknown) => (p as { o: { split: unknown } }).o.split;
    const a = core.purchase(ports());
    const b = core.purchase(ports());
    expect(windowOf(a)).toBeDefined();
    expect(windowOf(a)).toBe(windowOf(b));
  });
});
