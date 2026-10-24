// П11 (профиль contour): цена изменилась после согласования. Т6; A7 п. 5.2; Р5, Р44 п. 4. На стенде Платформы и витринах
// эмулятора: корзина из двух позиций витрины NORMAL; эмулятор цену не меняет, поэтому «прежняя» цена — подмена ответа
// каталога витрины поверх настоящего обращения (как П08): до подписи CART позиция дешевле, после — настоящая цена витрины.
// Живая проверка перед заказом видит рост цены — заказа нет; прежний CART не используется (выбор 4а: у Платформы он
// остаётся ACTIVE); новый поиск → новый CART по новой цене → заказ, Order.total = итогу нового CART → оплата только по нему.
// Риск 4а (ACTIVE CART резервирует остаток INTENT → LIMIT_EXCEEDED на новом CART) проверяется суммой: оба CART вместе
// больше предела INTENT, каждый — в пределе.
import { afterEach, describe, expect, it } from "vitest";
import { OrderRefused } from "../../src/agent/pipeline/index.js";
import { loadParams } from "../../src/shared/config.js";
import { INTENT } from "../support/consents.js";
import { MERCHANT_FIXTURES } from "agentic-ps-platform/fixtures";
import { shopBy, type Contour } from "../support/contour.js";
import { expectJournalClean } from "../support/journal.js";
import { STAND_TIMEOUT_MS, standPurchase } from "../support/stand-purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  expect(c?.violations() ?? []).toEqual([]);
  await c?.close();
  c = undefined;
});

const NORMAL = shopBy("NORMAL");
const [A, B] = NORMAL.agent_items;
const RUB = (amount: number) => ({ amount, currency: "RUB" });
/** «прежняя» цена второй позиции — ниже настоящей на 5 % */
const OLD_B = Math.round(B!.price! * 0.95);
const QTY_B = 2;
const catalog = `/v1/shops/${NORMAL.id}/catalog`;
const { confirm_above_kop: THRESHOLD } = loadParams();

/** Каталог витрины NORMAL — с прежней ценой позиции B, пока `cheap`; иначе — настоящий ответ эмулятора. */
function priceSwitch() {
  const s = { cheap: true };
  const f: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (!s.cheap || !String(input).endsWith(catalog) || res.status !== 200) return res;
    const body = (await res.json()) as { items: { sku: string; price?: number }[] };
    for (const i of body.items) if (i.sku === B!.sku) i.price = OLD_B;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { s, f };
}

describe("П11 — цена изменилась после согласования", { timeout: STAND_TIMEOUT_MS }, () => {
  it("цена выросла между CART и заказом: заказ не создаётся, новый CART по новой цене после нового поиска; оплата — только по нему", async () => {
    const { s, f } = priceSwitch();
    const r = await standPurchase({ fetch: f });
    c = r.c;
    const intent = await r.signedIntent();
    const oldTotal = A!.price! + QTY_B * OLD_B;
    const newTotal = A!.price! + QTY_B * B!.price!;
    // каждый CART — в пределе INTENT, оба вместе — нет: резерв остатка прежним CART дал бы LIMIT_EXCEEDED (риск 4а)
    expect(newTotal).toBeLessThanOrEqual(INTENT.amountLimit.amount);
    expect(oldTotal + newTotal).toBeGreaterThan(INTENT.amountLimit.amount);

    await r.purchase.search();
    const lines = [{ sku: A!.sku, qty: 1 }, { sku: B!.sku, qty: QTY_B }];
    const old = await r.purchase.cart({ merchantId: NORMAL.merchant_id, lines, keyTermsShown: true }, { idempotencyKey: "idem-cart-p11-1" });
    expect(old.cart?.total).toEqual(RUB(oldTotal));
    await r.signWhileWaiting(old.id, () => r.purchase.awaitCart());

    // продавец «поднял» цену: витрина отдаёт настоящую
    s.cheap = false;
    const before = r.c.calls().length;
    const err = await r.purchase.placeOrder({ idempotencyKey: "idem-order-p11-1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderRefused);
    expect(err).toMatchObject({ next: "NEW_CART_MANDATE", codes: ["LIVE_PRICE_UP"] });
    expect(r.purchase.state).toBe("OFFERS");
    expect(r.purchase.cartMandate).toBeNull();
    // живая проверка позиции A — ok, позиции B — рост цены; заказа нет
    expect(r.c.calls().slice(before).filter((x) => x.target === "merchants").map((x) => `${x.route} ${x.status}`)).toEqual([`GET ${catalog} 200`, `GET ${catalog} 200`]);
    expect(r.c.journal.entries.filter((e) => e.kind === "order.live_refused").map((e) => [e.reason, e.detail, e.ref])).toEqual([["LIVE_PRICE_UP", "NEW_CART_MANDATE", B!.sku]]);
    // выбор 4а: прежний CART у Платформы — ACTIVE, агент его не отзывает
    expect((await r.c.platform.getMandate(old.id)).status).toBe("ACTIVE");

    const zones = await r.purchase.search();
    expect(zones.contour.find((o) => o.sku === B!.sku)!.product.price).toEqual(RUB(B!.price!));
    const fresh = await r.purchase.cart({ merchantId: NORMAL.merchant_id, lines, keyTermsShown: true }, { idempotencyKey: "idem-cart-p11-2" });
    expect(fresh).toMatchObject({ kind: "CART", parentId: intent.id, status: "PENDING_SIGNATURE" });
    expect(fresh.cart?.total).toEqual(RUB(newTotal));
    await r.signWhileWaiting(fresh.id, () => r.purchase.awaitCart());
    const order = await r.purchase.placeOrder({ idempotencyKey: "idem-order-p11-2" });
    expect(order.total).toEqual(RUB(newTotal));
    // итог выше порога подтверждения (порог — из конфигурации): авторизация без предварительного подтверждения — его
    // требует ADP (Р47 п. 2); тестовый порт его не требует
    expect(newTotal).toBeGreaterThan(THRESHOLD);
    expect(r.purchase.needsConfirmation).toBe(true);
    await r.purchase.authorize({ idempotencyKey: "idem-auth-p11" });
    // заказ у витрины — один, по новому CART; оплата — по CART, итог которого равен заказу
    const paid = { cart: fresh.id, total: RUB(newTotal), order: RUB(newTotal) };
    expect(r.payment.calls).toEqual(["authorize"]);
    expect(r.payment.carts).toEqual([paid]);
    // полный журнал обращений от первого заказа (ленту не считаем): по прежнему CART после отказа — ни verify, ни заказа,
    // ни отзыва, ни повторного запроса; единственное чтение прежнего CART — проверка теста (выбор 4а)
    const ids = (x: string) => x.replaceAll(intent.id, "{intent}").replaceAll(old.id, "{old}").replaceAll(fresh.id, "{fresh}");
    const all = r.c.calls().slice(before).filter((x) => !x.route.startsWith("GET /pao/v1/events")).map((x) => ids(`${x.target} ${x.route} ${x.status}`));
    const shop = (id: string) => `merchants GET /v1/shops/${id}/catalog 200`;
    // знак готовности по ПАО — перед каталогом каждой витрины (Р53 п. 3)
    const search = ["merchants GET /v1/shops 200", ...MERCHANT_FIXTURES.flatMap((m) => [`pao GET /pao/v1/merchants/${m.merchant_id}/readiness 200`, shop(m.id)])];
    expect(all).toEqual([
      shop(NORMAL.id),
      shop(NORMAL.id),
      "pao GET /pao/v1/mandates/{old} 200",
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      ...search,
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      shop(NORMAL.id),
      shop(NORMAL.id),
      "pao POST /pao/v1/mandates 201",
      "pao GET /pao/v1/mandates/{fresh} 200",
      "pao POST /participants/v1/mandates/{fresh}/sign 200",
      "pao GET /pao/v1/mandates/{fresh} 200",
      shop(NORMAL.id),
      shop(NORMAL.id),
      // проверка по мандату непосредственно перед заказом (Р44 п. 5)
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "pao GET /pao/v1/mandates/{fresh}/verify 200",
      `merchants POST /v1/shops/${NORMAL.id}/orders 201`,
      // ворота стадии 5 — verify INTENT и нового CART (стадия 4 — после авторизации, по требованию ADP, Р47 п. 2)
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "pao GET /pao/v1/mandates/{fresh}/verify 200",
    ]);
    const secrets = r.c.calls().flatMap((x) => [x.nonce, x.idempotencyKey]).filter((v): v is string => typeof v === "string");
    expectJournalClean(r.c.journal.entries, null, [], secrets);
  });
});
