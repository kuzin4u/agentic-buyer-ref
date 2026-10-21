// Д02 (профиль contour), частично: агенту цена ниже, чем человеку. Т5а, Т6; A5 п. 1.2–1.3; Р43 п. 3. На стенде Платформы и
// витрине эмулятора с поведением DUAL_PRICE: опознанному агенту витрина показывает свою цену, заказ считает по цене «для
// всех». Главный инвариант Р43: в мандат CART идёт только итог по живой цене продавца из своей выдачи; `Order.total`
// продавца ≠ итогу CART — STOPPED `ORDER_REPLY_MISMATCH` до любого обращения к реквизиту и оплате. «Предложение помечено»
// (пометка витрины в следующих выдачах) — не в AG-10 ч. 1: Д02 в счёт не идёт (Р43 п. 4, STATUS «Открыто»).
// Цены — из фикстур Платформы, не литералы.
import { afterEach, describe, expect, it } from "vitest";
import { PurchaseStopped } from "../../src/agent/pipeline/index.js";
import { shopBy, type Contour } from "../support/contour.js";
import { expectJournalClean } from "../support/journal.js";
import { STAND_TIMEOUT_MS, standPurchase } from "../support/stand-purchase.js";
import { one } from "../support/purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  expect(c?.violations() ?? []).toEqual([]);
  await c?.close();
  c = undefined;
});

const DUAL = shopBy("DUAL_PRICE");
const AGENT_ITEM = DUAL.agent_items[0]!;
const HUMAN_ITEM = DUAL.items.find((i) => i.sku === AGENT_ITEM.sku)!;

describe("Д02 — агенту цена ниже, чем человеку (частично)", { timeout: STAND_TIMEOUT_MS }, () => {
  it("DUAL_PRICE: CART по цене агента, Order.total по цене для всех — STOPPED ORDER_REPLY_MISMATCH, оплаты нет", async () => {
    expect(DUAL.zone).toBe("CONTOUR");
    expect(AGENT_ITEM.price!).toBeLessThan(HUMAN_ITEM.price!);
    const r = await standPurchase();
    c = r.c;
    const intent = await r.signedIntent();
    const zones = await r.purchase.search();
    const offer = zones.contour.find((o) => o.shopId === DUAL.id && o.sku === AGENT_ITEM.sku)!;
    expect(offer.product.price.amount).toBe(AGENT_ITEM.price);

    const start = r.c.calls().length;
    const cart = await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-d02" });
    // в CART — итог по живой цене продавца из своей выдачи (Р43 п. 1–2), не подставленный
    expect(cart.cart!.total).toEqual({ amount: AGENT_ITEM.price, currency: AGENT_ITEM.currency });
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());

    const before = r.c.calls().length;
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-d02" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("ORDER_REPLY_MISMATCH");
    expect(r.purchase.order).toBeNull();
    // продавец заказ создал по цене для всех; после ответа — ни одного обращения: ни verify, ни реквизита, ни оплаты
    const after = r.c.calls().slice(before).filter((x) => !(x.target === "pao" && x.route.startsWith("GET /pao/v1/events")));
    expect(after.map((x) => `${x.target} ${x.route} ${x.status}`)).toEqual([
      `merchants GET /v1/shops/${DUAL.id}/catalog 200`,
      `merchants POST /v1/shops/${DUAL.id}/orders 201`,
    ]);
    expect(r.c.calls().some((x) => x.route.includes("/credentials"))).toBe(false);
    expect(r.payment.calls).toEqual([]);
    expect(r.c.journal.entries.filter((e) => e.kind === "purchase.stage").at(-1)).toMatchObject({ detail: "STOPPED", reason: "ORDER_REPLY_MISMATCH", mandate: intent.id });
    // полный журнал обращений стадии 3 (без чтений ленты): verify, живая проверка, CART, подпись, живая проверка, заказ
    const shape = (x: { target: string; route: string; status: number | null }) => `${x.target} ${x.route.replaceAll(intent.id, "{intent}").replaceAll(cart.id, "{cart}")} ${x.status}`;
    expect(r.c.calls().slice(start).filter((x) => !x.route.startsWith("GET /pao/v1/events")).map(shape)).toEqual([
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      `merchants GET /v1/shops/${DUAL.id}/catalog 200`,
      "pao POST /pao/v1/mandates 201",
      "pao GET /pao/v1/mandates/{cart} 200",
      "pao POST /participants/v1/mandates/{cart}/sign 200",
      "pao GET /pao/v1/mandates/{cart} 200",
      `merchants GET /v1/shops/${DUAL.id}/catalog 200`,
      `merchants POST /v1/shops/${DUAL.id}/orders 201`,
    ]);
    // журнал агента: поля и коды из набора, ни nonce, ни ключей обращений; журнал контура без compose — кода агента нет
    const secrets = r.c.calls().flatMap((x) => [x.nonce, x.idempotencyKey]).filter((v): v is string => typeof v === "string");
    expectJournalClean(r.c.journal.entries, null, [], secrets);
  });
});
