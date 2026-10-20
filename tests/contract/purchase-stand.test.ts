// Прогон конвейера на стенде Платформы v0.5.0 и эмуляторе продавцов (Р38 п. 8, К6; решение владельца 20.10.2026,
// вариант А). По-настоящему: допуск (итог start() контура), INTENT и CART на стенде — подпись эмулятором банка во время
// ожидания, решение — по событию mandate.signed ленты стенда и GET после него; заказ у витрины подписанным обращением по
// cart_mandate_id; ворота перед стадией 5 — держимые, verify и остаток обоих мандатов на стенде. Выдача — по витринам
// эмулятора с ТЕСТОВЫМ ПРОФИЛЕМ магазина (tests/support/stand-shop.ts): решения каталога здесь доказательством не
// считаются. Стадии 4–6 — тестовый порт PaymentSteps (стенд без /credentials).
// Конвейер собран поверх адаптера контура — повтор места сборки до AG-09 (шапка tests/support/contour.ts); отличия от
// compose: лента — чтение listEvents с курсором (не EventFeed с файловым курсором), failureCode не задан (UNKNOWN), часы —
// системные.
import { afterEach, describe, expect, it } from "vitest";
import { MandateClient, MandateRefused } from "../../src/agent/mandates/index.js";
import { SplitWindow } from "../../src/agent/policy/index.js";
import { Purchase } from "../../src/agent/pipeline/index.js";
import type { FeedItem, PaymentPlatform } from "../../src/agent/ports/index.js";
import { MERCHANT_FIXTURES } from "agentic-ps-platform/fixtures";
import { INTENT } from "../support/consents.js";
import { createContour, shopBy, type Contour, type ContourCall } from "../support/contour.js";
import { payments } from "../support/shop.js";
import { standLive, standOffers, standShop } from "../support/stand-shop.js";

/** Стенд в процессе теста под параллельной нагрузкой прогона бывает медленнее 5 с (нюанс К2.3). */
const STAND_TIMEOUT_MS = 30_000;
let c: Contour | undefined;
afterEach(async () => {
  expect(c?.violations() ?? []).toEqual([]);
  await c?.close();
  c = undefined;
});

/** витрины — из фикстур Платформы, не литералами (contour-fixtures.test.ts) */
const NORMAL = shopBy("NORMAL");
const OUTSIDE = shopBy("READ_ONLY");
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Лента стенда с курсором: читает, пока ожидание не завершится; пустой ответ — пауза и снова (не больше `polls` раз). */
function feedOf(platform: PaymentPlatform, polls = 100) {
  return async function* events(signal?: AbortSignal): AsyncIterable<FeedItem> {
    let cursor: string | null = null;
    for (let i = 0; i < polls && !signal?.aborted; i++) {
      const items = await platform.listEvents(cursor);
      if (items.length === 0) await pause(50);
      for (const item of items) {
        cursor = item.kind === "event" ? item.event.eventId : item.eventId;
        yield item;
      }
    }
  };
}

async function run() {
  c = await createContour({ pao: "stand" });
  const self = await c.start();
  const contour = c;
  const { stand, merchants } = contour;
  if (!stand || !merchants) throw new Error("контур без стенда или витрин");
  const mandates = new MandateClient({ port: contour.platform, params: contour.params, journal: contour.journal });
  const offers = standOffers(merchants);
  const live = standLive(merchants, offers.shopOf);
  const shop = standShop(merchants);
  const payment = payments();
  const purchase = new Purchase({
    mandates,
    events: feedOf(contour.platform),
    offers,
    live,
    shop,
    payment,
    params: contour.params,
    split: new SplitWindow(contour.params, () => new Date()),
    journal: contour.journal,
    admission: () => contour.admission(),
    region: "77",
  });
  /** обращений к ПАО за мандатом id — GET мандата */
  const gets = (id: string) => contour.calls().filter((x) => x.target === "pao" && x.route === `GET /pao/v1/mandates/${id}`).length;
  /** Подпись человека во время ожидания: после первого GET ожидания — эмулятор банка подписывает, решение — по событию. */
  async function signWhileWaiting(id: string, wait: () => Promise<unknown>) {
    const before = gets(id);
    const waiting = wait();
    for (let i = 0; gets(id) === before && i < 200; i++) await pause(10);
    expect(gets(id)).toBe(before + 1);
    expect((await stand!.issuer.sign(id)).statusCode).toBe(200);
    await waiting;
    // GET до ожидания и GET по событию mandate.signed: решение принято по событию ленты (Р29 п. 5, Р34 п. 5)
    expect(gets(id)).toBe(before + 2);
  }
  return { c: contour, self, stand, purchase, live, shop, payment, signWhileWaiting };
}

/** До ORDERED на стенде: INTENT и CART подписаны эмулятором банка во время ожидания, заказ у витрины. */
async function ordered(r: Awaited<ReturnType<typeof run>>) {
  const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-stand" });
  expect(intent.status).toBe("PENDING_SIGNATURE");
  await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
  const zones = await r.purchase.search();
  const offer = zones.contour.find((o) => o.shopId === NORMAL.id)!;
  const cart = await r.purchase.cart({ merchantId: offer.merchantId, sku: offer.sku, qty: 1, keyTermsShown: true }, { idempotencyKey: "idem-cart-stand" });
  await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
  const order = await r.purchase.placeOrder({ idempotencyKey: "idem-order-stand" });
  return { intent, cart, offer, zones, order };
}

/** Маршрут без идентификаторов мандата и витрины — для сравнения полного журнала обращений. */
const shape = (x: ContourCall, ids: Record<string, string>) =>
  `${x.target} ${Object.entries(ids).reduce((route, [name, id]) => route.replaceAll(id, `{${name}}`), x.route)} ${x.status}`;

describe("конвейер на стенде Платформы (Р38 п. 8, К6)", { timeout: STAND_TIMEOUT_MS }, () => {
  it("0–3 и ворота по-настоящему, 4–6 тестовым портом: покупка DONE, полный журнал обращений", async () => {
    const r = await run();
    const start = r.c.calls().length;
    const { intent, cart, offer, zones, order } = await ordered(r);
    expect(OUTSIDE.zone).toBe("OUTSIDE");
    expect(zones.market.some((o) => o.shopId === OUTSIDE.id)).toBe(true);
    expect(r.shop.calls).toEqual([{ shopId: NORMAL.id, items: [{ sku: offer.sku, qty: 1 }], cartMandateId: cart.id }]);
    expect(order.total).toEqual(cart.cart!.total);
    expect(r.live.calls).toEqual([{ sku: offer.sku, quantity: 1, region: "77" }]);
    await r.purchase.authorize({ idempotencyKey: "idem-pay-stand" });
    await r.purchase.settle();
    expect(r.purchase.state).toBe("DONE");

    const calls = r.c.calls().slice(start);
    const ids = { intent: intent.id, cart: cart.id, shop: NORMAL.id };
    // лента читается с паузами, число её чтений зависит от времени — в полном журнале без неё
    const all = calls.map((x) => shape(x, ids));
    const seq = all.filter((s) => !s.startsWith("pao GET /pao/v1/events"));
    // исключённые записи — только чтения ленты стенда, все успешные (ревью К6 М1)
    expect(all.filter((s) => s.startsWith("pao GET /pao/v1/events")).every((s) => /^pao GET \/pao\/v1\/events(\?\S*)? 200$/.test(s))).toBe(true);
    // поиск — каталог каждой витрины эмулятора по одному, в порядке фикстур; живая проверка — ещё раз каталог витрины заказа
    const search = MERCHANT_FIXTURES.map((f) => `merchants GET /v1/shops/${f.id === NORMAL.id ? "{shop}" : f.id}/catalog 200`);
    expect(seq).toEqual([
      "pao POST /pao/v1/mandates 201",
      // GET до ожидания, подпись эмулятором банка во время ожидания, GET по событию mandate.signed
      "pao GET /pao/v1/mandates/{intent} 200",
      "pao POST /participants/v1/mandates/{intent}/sign 200",
      "pao GET /pao/v1/mandates/{intent} 200",
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "merchants GET /v1/shops 200",
      ...search,
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "pao POST /pao/v1/mandates 201",
      "pao GET /pao/v1/mandates/{cart} 200",
      "pao POST /participants/v1/mandates/{cart}/sign 200",
      "pao GET /pao/v1/mandates/{cart} 200",
      "merchants GET /v1/shops/{shop}/catalog 200",
      "merchants POST /v1/shops/{shop}/orders 201",
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "pao GET /pao/v1/mandates/{cart}/verify 200",
    ]);
    // изменяющие обращения к ПАО — подписаны ключом агента, с x-nonce и прежним Idempotency-Key (инвариант 8)
    // ключ подписи — действующий ключ агента по реестру стенда (GET /pao/v1/agent при допуске; ревью К6 М2)
    const kid = calls.find((x) => x.target === "pao" && x.kid)!.kid;
    expect(r.self.keys.map((k) => k.kid)).toContain(kid);
    const posts = calls.filter((x) => x.target === "pao" && x.route === "POST /pao/v1/mandates");
    expect(posts.map((x) => [x.kid, typeof x.nonce, x.idempotencyKey])).toEqual([
      [kid, "string", "idem-intent-stand"],
      [kid, "string", "idem-cart-stand"],
    ]);
    // заказ у витрины — подписан тем же ключом агента
    expect(calls.filter((x) => x.target === "merchants" && x.route.endsWith("/orders")).map((x) => x.kid)).toEqual([kid]);
  });

  it("CART отказан (relinquish) на стенде до авторизации — verify CART в воротах OUT_OF_SCOPE, STOPPED, реквизита нет", async () => {
    const r = await run();
    const { intent, cart } = await ordered(r);
    await r.c.platform.relinquishMandate(cart.id, { idempotencyKey: "idem-relinquish-stand" });
    const start = r.c.calls().length;
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-stand" })).rejects.toBeInstanceOf(MandateRefused);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("MANDATE_OUT_OF_SCOPE");
    // ворота: verify INTENT, затем verify CART — отказ по ответу стенда, дальше обращений нет
    expect(r.c.calls().slice(start).map((x) => shape(x, { intent: intent.id, cart: cart.id }))).toEqual([
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "pao GET /pao/v1/mandates/{cart}/verify 200",
    ]);
    expect(r.c.journal.entries.filter((e) => e.kind === "agent.refused").map((e) => [e.reason, e.mandate])).toEqual([["MANDATE_OUT_OF_SCOPE", cart.id]]);
    expect(r.c.journal.entries.some((e) => e.kind === "purchase.stage" && e.detail === "AUTHORIZING")).toBe(false);
    expect(r.payment.calls).toEqual([]);
  });

  it("допуск конвейера до start() контура — STOPPED NOT_ADMITTED до обращений (ревью К6 М3)", async () => {
    c = await createContour({ pao: "stand" });
    const contour = c;
    expect(contour.admission()).toBe("NOT_ADMITTED");
    const mandates = new MandateClient({ port: contour.platform, params: contour.params, journal: contour.journal });
    const merchants = contour.merchants!;
    const offers = standOffers(merchants);
    const p = new Purchase({ mandates, events: feedOf(contour.platform), offers, live: standLive(merchants, offers.shopOf), shop: standShop(merchants), payment: payments(), params: contour.params, split: new SplitWindow(contour.params, () => new Date()), journal: contour.journal, admission: () => contour.admission() });
    const before = contour.calls().length;
    await expect(p.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-stand" })).rejects.toMatchObject({ code: "NOT_ADMITTED" });
    expect(contour.calls().length).toBe(before);
  });

  it("допуск конвейера — итог start() контура: подпись остановлена (контур закрыт) — STOPPED до обращений", async () => {
    const r = await run();
    expect(r.c.admission()).toBeNull();
    const before = r.c.calls().length;
    await r.c.close();
    c = undefined;
    await expect(r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-stand" })).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(r.c.calls().length).toBe(before);
  });
});
