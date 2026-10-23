// Д02 (профиль contour), частично: агенту цена ниже, чем человеку. Т5а, Т6; A5 п. 1.2–1.3; Р43 п. 3. На стенде Платформы и
// витрине эмулятора с поведением DUAL_PRICE: опознанному агенту витрина показывает свою цену, заказ считает по цене «для
// всех». Главный инвариант Р43: в мандат CART идёт только итог по живой цене продавца из своей выдачи; `Order.total`
// продавца ≠ итогу CART — STOPPED `ORDER_REPLY_MISMATCH` до любого обращения к реквизиту и оплате. «Предложение помечено»
// (Р48 п. 5): в следующих выдачах того же ядра позиция продавца — с сигналом A5_PRICE_MISMATCH (источник — заказ),
// зона прежняя, корзина — только по явному решению человека; пометка — в памяти процесса до перезапуска (нюанс Р48).
// Цены — из фикстур Платформы, не литералы.
import { MERCHANT_FIXTURES } from "agentic-ps-platform/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { CartRefused, PurchaseStopped } from "../../src/agent/pipeline/index.js";
import { INTENT } from "../support/consents.js";
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

describe("Д02 — агенту цена ниже, чем человеку", { timeout: STAND_TIMEOUT_MS }, () => {
  it("после ORDER_REPLY_MISMATCH позиция продавца в следующей выдаче помечена A5_PRICE_MISMATCH; корзина без решения человека не готовится (Р48 п. 5)", async () => {
    const r = await standPurchase();
    c = r.c;
    await r.signedIntent();
    const firstZones = await r.purchase.search();
    const first = firstZones.contour.find((o) => o.shopId === DUAL.id && o.sku === AGENT_ITEM.sku)!;
    // до заказа сигнала нет: пометка — от расхождения при заказе, а не от текста витрины
    expect(first.a5).toEqual([]);
    const cart = await r.purchase.cart(one(first, 1), { idempotencyKey: "idem-cart-d02-m1" });
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    await expect(r.purchase.placeOrder({ idempotencyKey: "idem-order-d02-m1" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.reason).toBe("ORDER_REPLY_MISMATCH");

    // следующая покупка того же ядра: новый INTENT, тот же поиск
    const p2 = r.next();
    const intent2 = await p2.intent({ ...INTENT, merchantScope: MERCHANT_FIXTURES.map((f) => f.merchant_id) }, { idempotencyKey: "idem-intent-d02-m2" });
    await r.signWhileWaiting(intent2.id, () => p2.awaitIntent());
    const flaggedBefore = r.c.journal.entries.filter((e) => e.kind === "offer.flagged").length;
    const zones = await p2.search();
    const again = zones.contour.find((o) => o.shopId === DUAL.id && o.sku === AGENT_ITEM.sku)!;
    // зона прежняя (контур), цена — продавца, без пересчёта; сигнал — один
    expect(again).toBeDefined();
    expect(again.a5).toEqual(["A5_PRICE_MISMATCH"]);
    expect(again.product.price.amount).toBe(AGENT_ITEM.price);
    expect(zones.market.some((o) => o.shopId === DUAL.id)).toBe(false);
    // прочие позиции и продавцы — с теми же сигналами, что в первой выдаче (у CONTRADICTORY — свой, по тексту витрины)
    const signals = (zs: typeof zones) => zs.contour.filter((o) => !(o.shopId === DUAL.id && o.sku === AGENT_ITEM.sku)).map((o) => [o.shopId, o.sku, o.a5]);
    expect(signals(zones)).toEqual(signals(firstZones));
    expect(r.c.journal.entries.filter((e) => e.kind === "offer.flagged").slice(flaggedBefore).filter((e) => e.merchant === DUAL.merchant_id)).toEqual([
      expect.objectContaining({ kind: "offer.flagged", reason: "A5_PRICE_MISMATCH", detail: "ORDER_REPLY_MISMATCH", ref: AGENT_ITEM.sku, merchant: DUAL.merchant_id }),
    ]);
    // без явного решения человека корзина не готовится, обращений нет
    const before = r.c.calls().length;
    await expect(p2.cart(one(again, 1), { idempotencyKey: "idem-cart-d02-m2" })).rejects.toBeInstanceOf(CartRefused);
    expect(r.c.calls().length).toBe(before);
  });

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
    // перед заказом — живая проверка и verify INTENT и CART (Р44 п. 5); продавец заказ создал по цене для всех; после
    // ответа — ни одного обращения: ни verify, ни реквизита, ни оплаты
    const after = r.c.calls().slice(before).filter((x) => !(x.target === "pao" && x.route.startsWith("GET /pao/v1/events")));
    expect(after.map((x) => `${x.target} ${x.route} ${x.status}`)).toEqual([
      `merchants GET /v1/shops/${DUAL.id}/catalog 200`,
      // проверка по мандату непосредственно перед заказом (Р44 п. 5)
      `pao GET /pao/v1/mandates/${intent.id}/verify 200`,
      `pao GET /pao/v1/mandates/${cart.id}/verify 200`,
      `merchants POST /v1/shops/${DUAL.id}/orders 201`,
    ]);
    expect(r.c.calls().some((x) => x.route.includes("/credentials"))).toBe(false);
    expect(r.payment.calls).toEqual([]);
    expect(r.c.journal.entries.filter((e) => e.kind === "purchase.stage").at(-1)).toMatchObject({ detail: "STOPPED", reason: "ORDER_REPLY_MISMATCH", mandate: intent.id });
    // полный журнал обращений стадии 3 (без чтений ленты): verify, живая проверка, CART, подпись, живая проверка, verify, заказ
    const shape = (x: { target: string; route: string; status: number | null }) => `${x.target} ${x.route.replaceAll(intent.id, "{intent}").replaceAll(cart.id, "{cart}")} ${x.status}`;
    expect(r.c.calls().slice(start).filter((x) => !x.route.startsWith("GET /pao/v1/events")).map(shape)).toEqual([
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      `merchants GET /v1/shops/${DUAL.id}/catalog 200`,
      "pao POST /pao/v1/mandates 201",
      "pao GET /pao/v1/mandates/{cart} 200",
      "pao POST /participants/v1/mandates/{cart}/sign 200",
      "pao GET /pao/v1/mandates/{cart} 200",
      `merchants GET /v1/shops/${DUAL.id}/catalog 200`,
      // проверка по мандату непосредственно перед заказом (Р44 п. 5)
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "pao GET /pao/v1/mandates/{cart}/verify 200",
      `merchants POST /v1/shops/${DUAL.id}/orders 201`,
    ]);
    // журнал агента: поля и коды из набора, ни nonce, ни ключей обращений; журнал контура без compose — кода агента нет
    const secrets = r.c.calls().flatMap((x) => [x.nonce, x.idempotencyKey]).filter((v): v is string => typeof v === "string");
    expectJournalClean(r.c.journal.entries, null, [], secrets);
  });
});
