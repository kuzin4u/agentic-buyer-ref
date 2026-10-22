// Стадия 5 профиля contour на стенде Платформы v0.15.0 и эмуляторе продавцов (Р45; AG-11 ч. 1): реквизит —
// POST /pao/v1/credentials по CART, пакет агентской оплаты — витрине подписанным обращением, итог до событий операции
// (PS-16) не подтверждается — STOPPED OPERATION_RESULT_UNCONFIRMED. Выдача — с ТЕСТОВЫМ ПРОФИЛЕМ магазина (stand-shop.ts).
import { afterEach, describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { PurchaseStopped, PurchaseTransitionForbidden } from "../../src/agent/pipeline/index.js";
import { PaymentFailure } from "../../src/agent/ports/index.js";
import { SplitWindow } from "../../src/agent/policy/index.js";
import { DIAG } from "../../src/agent/compose.js";
import { INTENT } from "../support/consents.js";
import { shopBy, type Contour, type ContourCall } from "../support/contour.js";
import { luhnTail } from "../support/luhn.js";
import { one } from "../support/purchase.js";
import { STAND_TIMEOUT_MS, standPurchase, type StandPurchaseOptions } from "../support/stand-purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  await c?.close();
  c = undefined;
});

const NORMAL = shopBy("NORMAL");
const CREDENTIALS = "pao POST /pao/v1/credentials";

async function run(o: StandPurchaseOptions = {}) {
  const r = await standPurchase({ ...o, contourPayment: true });
  c = r.c;
  return r;
}

/** До ORDERED: INTENT и CART подписаны эмулятором банка во время ожидания, заказ у витрины. */
async function ordered(r: Awaited<ReturnType<typeof run>>) {
  const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-pay" });
  await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
  const zones = await r.purchase.search();
  const offer = zones.contour.find((o) => o.shopId === NORMAL.id)!;
  const cart = await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-pay" });
  await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
  const order = await r.purchase.placeOrder({ idempotencyKey: "idem-order-pay" });
  return { intent, cart, order };
}

const shape = (x: ContourCall, ids: Record<string, string>) =>
  `${x.target} ${Object.entries(ids).reduce((route, [name, id]) => route.replaceAll(id, `{${name}}`), x.route)} ${x.status}`;

/** Всё, что агент отдаёт наружу по покупке: журнал, снимки конвейера, ошибка, текст человеку по коду остановки. */
function outward(r: Awaited<ReturnType<typeof run>>, err: unknown): string {
  const e = err as Error;
  const code = r.purchase.reason;
  return [
    JSON.stringify(r.c.journal.entries),
    JSON.stringify([r.purchase.state, code, r.purchase.cartMandate, r.purchase.order, r.purchase.operation, r.purchase.offers]),
    String(e),
    e.stack ?? "",
    inspect(e, { depth: 10, showHidden: true }),
    JSON.stringify(code === null ? null : DIAG[code]),
  ].join("\n");
}

describe("стадия 5 на стенде: реквизит по ПАО и пакет продавцу (Р45)", { timeout: STAND_TIMEOUT_MS }, () => {
  it("реквизит по CART, пакет витрине принят, итог не подтверждён — STOPPED OPERATION_RESULT_UNCONFIRMED; реквизит нигде не встречается", async () => {
    const r = await run();
    const { intent, cart, order } = await ordered(r);
    const start = r.c.calls().length;
    const err = await r.purchase.authorize({ idempotencyKey: "idem-pay-stand" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentFailure);
    expect((err as PaymentFailure).code).toBe("OPERATION_RESULT_UNCONFIRMED");
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("OPERATION_RESULT_UNCONFIRMED");
    expect(r.purchase.operation).toBeNull();
    // Р45 п. 5 (ревью reviewer К2 № 6): место в окне дробления занято — вторая операция под тем же INTENT в сумме выше порога
    // — доля (split_min_ops = 2 по стендовым параметрам; без этой операции в окне — не доля)
    const T = r.params.confirm_above_kop;
    const rest = { amount: T - order.total.amount + 1, currency: "RUB" };
    expect(r.params.split_min_ops).toBe(2);
    expect(r.split.isShare(intent.id, rest, T)).toBe(true);
    expect(new SplitWindow(r.params, () => new Date()).isShare(intent.id, rest, T)).toBe(false);

    const calls = r.c.calls().slice(start);
    const ids = { intent: intent.id, cart: cart.id, shop: NORMAL.id, order: order.orderId };
    const all = calls.map((x) => shape(x, ids));
    // вне полного журнала — только чтения ленты стенда, все успешные (ревью reviewer К2 № 13)
    expect(all.filter((s) => s.startsWith("pao GET /pao/v1/events")).every((s) => /^pao GET \/pao\/v1\/events(\?\S*)? 200$/.test(s))).toBe(true);
    expect(all.filter((s) => !s.startsWith("pao GET /pao/v1/events"))).toEqual([
      // ворота стадии 5
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "pao GET /pao/v1/mandates/{cart}/verify 200",
      // реквизит по CART — витрина приняла пакет: order_ref и cart_mandate_id пакета совпали с заказом
      `${CREDENTIALS} 201`,
      "merchants POST /v1/shops/{shop}/orders/{order}/payment 200",
    ]);
    // реквизит — подписанным обращением с ключом вызывающего (инвариант 8, 9); пакет — подписан тем же ключом агента
    const kid = calls.find((x) => x.target === "pao" && x.kid)!.kid;
    expect(calls.filter((x) => `${x.target} ${x.route}` === CREDENTIALS).map((x) => [x.kid, typeof x.nonce, x.idempotencyKey])).toEqual([[kid, "string", "idem-pay-stand"]]);
    expect(calls.filter((x) => x.route.endsWith("/payment")).map((x) => x.kid)).toEqual([kid]);
    // слова продавца — только detail записи shop.call; итога операции, SETTLING и DONE нет
    const pay = r.c.journal.entries.filter((e) => e.kind === "shop.call" && e.method === "POST /v1/shops/{id}/orders/{order_id}/payment");
    expect(pay).toHaveLength(1);
    expect(pay[0]).toMatchObject({ result: "ok", ref: NORMAL.id, mandate: cart.id });
    // ADP стенда одобрил AGENT_TOKEN реквизита (домен токена, криптограмма, MCC витрины) — пакет годный; это слова
    // продавца, итогом для агента они не становятся
    expect(pay[0]!.detail).toBe("PAID");
    expect(r.c.journal.entries.filter((e) => e.kind === "purchase.stage").map((e) => e.detail).slice(-2)).toEqual(["AUTHORIZING", "STOPPED"]);

    // Р45 п. 3: token_ref и криптограмма ответа стенда — ни в журнале, ни в выводе, ни в ошибке
    const secrets = r.c.issuedSecrets();
    expect(secrets).toHaveLength(2);
    const out = outward(r, err);
    for (const s of secrets) expect(out.includes(s), "реквизит в выводе").toBe(false);

    // Р45 п. 5: повторной оплаты того же заказа нет — второй authorize реквизит не запрашивает
    const before = r.c.calls().length;
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-stand" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    expect(r.c.calls().slice(before).filter((x) => `${x.target} ${x.route}` === CREDENTIALS)).toEqual([]);
    expect(r.c.calls().slice(before).filter((x) => x.target === "merchants")).toEqual([]);
  });

  it("тайм-аут отправки пакета витрине: итог не подтверждён (Б1а), реквизита нет в журнале и в ошибке (даже если сеть вернула тело в сообщении)", async () => {
    // сеть не ответила и вернула ошибку с телом запроса в сообщении — худший случай для утечки
    const f: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/payment")) throw new Error(`тайм-аут: ${String(init?.body)}`, { cause: init?.body });
      return fetch(input, init);
    };
    const r = await run({ fetch: f });
    await ordered(r);
    const err = await r.purchase.authorize({ idempotencyKey: "idem-pay-timeout" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentFailure);
    expect(r.purchase.reason).toBe("OPERATION_RESULT_UNCONFIRMED");
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.call" && e.method?.endsWith("/payment")).map((e) => [e.result, e.detail])).toEqual([["unknown", "NO_RESPONSE"]]);
    const secrets = r.c.issuedSecrets();
    expect(secrets).toHaveLength(2);
    const out = outward(r, err);
    for (const s of secrets) expect(out.includes(s), "реквизит в выводе").toBe(false);
    // человеку — «итог не подтверждён», не «деньги не списывались» (Р45, Б1а)
    expect(DIAG.OPERATION_RESULT_UNCONFIRMED!.human.ru).toMatch(/не подтвердила/);
    expect(out).not.toMatch(/не списывались/);
  });

  // Р45, Б1а (ревью reviewer К2 № 5): отказ витрины на оплате и ответ не по схеме — подмена ответа поверх настоящего
  // обращения (эмулятор честный пакет не отклоняет); пакет ушёл — итог не подтверждён, код витрины — в detail shop.call
  it.each([
    ["PACKAGE_MISMATCH", 409, { code: "PACKAGE_MISMATCH" }, "refused", { detail: "PACKAGE_MISMATCH" }],
    ["ORDER_NOT_PAYABLE", 409, { code: "ORDER_NOT_PAYABLE" }, "refused", { detail: "ORDER_NOT_PAYABLE" }],
    ["код вне перечня", 409, { code: "SOMETHING_ELSE" }, "refused", { reason: "MERCHANT_CODE_UNKNOWN" }],
    ["ответ не по схеме", 200, { status: "MAYBE" }, "unknown", { detail: "BAD_RESPONSE" }],
    ["чужой заказ в ответе", 200, { id: "ORD-other", status: "PAID" }, "unknown", { detail: "BAD_RESPONSE" }],
  ])("отказ на оплате: %s — OPERATION_RESULT_UNCONFIRMED, код витрины в журнале", async (_, status, body, result, cause) => {
    const f: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (!String(input).endsWith("/payment")) return res;
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    };
    const r = await run({ fetch: f });
    await ordered(r);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-refused" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(r.purchase.reason).toBe("OPERATION_RESULT_UNCONFIRMED");
    const pay = r.c.journal.entries.filter((e) => e.kind === "shop.call" && e.method?.endsWith("/payment"));
    expect(pay).toHaveLength(1);
    expect(pay[0]).toMatchObject({ result, ...cause });
    expect(r.c.journal.entries.filter((e) => e.kind === "purchase.stage" && e.detail === "STOPPED").map((e) => e.reason)).toEqual(["OPERATION_RESULT_UNCONFIRMED"]);
  });

  it("номер заказа продавца похож на номер карты — STOPPED SHOP_ORDER_REF_INVALID на стадии 3, до снимка (9а); значения нет в снимке, журнале, ошибке и тексте человеку", async () => {
    const pan = luhnTail("900000000000000");
    // витрина отвечает на заказ номером с серией, похожей на номер карты (подмена ответа поверх настоящего заказа)
    const f: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (!(init?.method === "POST" && String(input).endsWith("/orders"))) return res;
      const body = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, id: `ORD-${pan}` }), { status: res.status, headers: res.headers });
    };
    const r = await run({ fetch: f });
    const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-pay" });
    await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
    const offer = (await r.purchase.search()).contour.find((o) => o.shopId === NORMAL.id)!;
    const cart = await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-pay" });
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    const start = r.c.calls().length;
    const err = await r.purchase.placeOrder({ idempotencyKey: "idem-order-pay" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.reason).toBe("SHOP_ORDER_REF_INVALID");
    expect(r.purchase.order).toBeNull();
    // заказ у витрины создан (останется неоплаченным); реквизита нет
    expect(
      r.c
        .calls()
        .slice(start)
        .map((x) => shape(x, { intent: intent.id, cart: cart.id, shop: NORMAL.id }))
        .filter((s) => !s.startsWith("pao GET /pao/v1/events")),
    ).toEqual([
      "merchants GET /v1/shops/{shop}/catalog 200",
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "pao GET /pao/v1/mandates/{cart}/verify 200",
      "merchants POST /v1/shops/{shop}/orders 201",
    ]);
    expect(r.c.journal.entries.filter((e) => e.kind === "agent.refused" && e.reason === "SHOP_ORDER_REF_INVALID").map((e) => [e.detail, e.mandate])).toEqual([["PAN_LIKE", cart.id]]);
    const out = outward(r, err);
    expect(out.includes(pan), "номер с верной суммой Луна в журнале или выводе").toBe(false);
    // покупка остановлена — второго обращения нет
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-pan" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
  });

  it("параллельный вызов до отправки пакета (Б2в (а)): покупка остановлена, пакета нет", async () => {
    let parallel: unknown;
    // замыкание вызывается позже, когда r уже есть
    const r: Awaited<ReturnType<typeof run>> = await run({
      issue: (real) => async (d, m) => {
        const issued = await real(d, m);
        // пока реквизит выдавался, вызывающий вошёл в другую стадию — запрещённый переход, остановка (Р38)
        parallel = await r.purchase.search().catch((e: unknown) => e);
        return issued;
      },
    });
    await ordered(r);
    const err = await r.purchase.authorize({ idempotencyKey: "idem-pay-before" }).catch((e: unknown) => e);
    expect(parallel).toBeInstanceOf(PurchaseTransitionForbidden);
    expect(err).toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.reason).toBe("PIPELINE_TRANSITION_FORBIDDEN");
    expect(r.c.calls().filter((x) => x.route.endsWith("/payment"))).toEqual([]);
    expect(r.c.journal.entries.filter((e) => e.kind === "purchase.stage" && e.detail === "STOPPED").map((e) => e.reason)).toEqual(["PIPELINE_TRANSITION_FORBIDDEN"]);
  });

  it("параллельный вызов после отправки пакета (Б2в (б)): agent.refused без остановки, исход — OPERATION_RESULT_UNCONFIRMED, одна запись STOPPED", async () => {
    let parallel: unknown;
    const f: typeof fetch = async (input, init) => {
      // пакет уходит: вызывающий входит в другую стадию, пока витрина отвечает
      if (String(input).endsWith("/payment")) parallel = await r.purchase.search().catch((e: unknown) => e);
      return fetch(input, init);
    };
    // замыкание fetch вызывается позже, когда r уже есть
    const r: Awaited<ReturnType<typeof run>> = await run({ fetch: f });
    await ordered(r);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-after" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(parallel).toBeInstanceOf(PurchaseTransitionForbidden);
    expect(r.purchase.reason).toBe("OPERATION_RESULT_UNCONFIRMED");
    expect(r.c.calls().filter((x) => x.route.endsWith("/payment")).map((x) => x.status)).toEqual([200]);
    const tail = r.c.journal.entries.filter((e) => e.kind === "agent.refused" || e.kind === "purchase.stage").slice(-3);
    // AUTHORIZING → отказ параллельного вызова без остановки → одна остановка с исходом стадии 5
    expect(tail.map((e) => [e.kind, e.detail, e.reason])).toEqual([
      ["purchase.stage", "AUTHORIZING", undefined],
      ["agent.refused", "AUTHORIZING->OFFERS", "PIPELINE_TRANSITION_FORBIDDEN"],
      ["purchase.stage", "STOPPED", "OPERATION_RESULT_UNCONFIRMED"],
    ]);
    expect(r.c.journal.entries.filter((e) => e.kind === "purchase.stage" && e.detail === "STOPPED")).toHaveLength(1);
  });

  it("стадия 4 профиля contour до AG-13: подтверждение нужно — STOPPED CONFIRMATION_REQUIRED, реквизита нет (Р45 п. 6; ревью reviewer К2 № 7)", async () => {
    // порог ниже итога заказа — нужна стадия 4 (Т7)
    const r = await run({ params: { confirm_above_kop: 1 } });
    await ordered(r);
    expect(r.purchase.needsConfirmation).toBe(true);
    const start = r.c.calls().length;
    await expect(r.purchase.confirm()).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("CONFIRMATION_REQUIRED");
    // проверка по мандату до стадии 4 (Р40 п. 5) — и больше ничего: ни реквизита, ни витрины
    expect(r.c.calls().slice(start).map((x) => `${x.target} ${x.route.split("?")[0]}`).filter((s) => s !== "pao GET /pao/v1/events").map((s) => s.replace(/mandates\/[^/]+/, "mandates/{id}"))).toEqual([
      "pao GET /pao/v1/mandates/{id}/verify",
      "pao GET /pao/v1/mandates/{id}/verify",
    ]);
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-confirm" })).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
  });

  it("П18: в теле выдачи серия, похожая на номер карты (адаптер в обход проверки агента) — 422 CREDENTIALS_FORBIDDEN от Платформы, без повтора, значения в журнале нет", async () => {
    const r = await run();
    const pan = luhnTail("900000000000000");
    const start = r.c.calls().length;
    const err = await r.c.platform
      .issuePaymentPackage({ mandate: { id: "MND-any", currency: "RUB" }, orderRef: `ORD-${pan}`, merchantId: NORMAL.merchant_id, amountMax: { amount: 100, currency: "RUB" }, channel: "CARD" }, { idempotencyKey: "idem-p18" })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CREDENTIALS_FORBIDDEN", retry: "never", httpStatus: 422 });
    expect(r.c.calls().slice(start).map((x) => `${x.target} ${x.route} ${x.status} ${x.code}`)).toEqual([`${CREDENTIALS} 422 CREDENTIALS_FORBIDDEN`]);
    // нарушение зафиксировано в журнале агента (RunReport — AG-19): код, без значения
    expect(r.c.journal.entries.filter((e) => e.kind === "pao.call" && e.method === "POST /pao/v1/credentials").map((e) => [e.result, e.reason, e.attempt])).toEqual([["refused", "CREDENTIALS_FORBIDDEN", 1]]);
    expect(JSON.stringify(r.c.journal.entries).includes(pan)).toBe(false);
  });

  it("409 MANDATE_SCOPE: продавца области CART нет в справочнике оператора — after_human, без повтора, пакета нет (передача #51)", async () => {
    const r = await run();
    const OUT = "MER-NOT-IN-DIRECTORY";
    const total = { amount: 10000, currency: "RUB" };
    const intent = await r.c.platform.requestMandate({ ...INTENT, merchantScope: [OUT] }, { idempotencyKey: "idem-intent-scope" });
    expect((await r.stand.issuer.sign(intent.id)).statusCode).toBe(200);
    const cart = await r.c.platform.requestMandate(
      { ...INTENT, kind: "CART", parentId: intent.id, amountLimit: total, merchantScope: [OUT], cart: { merchantId: OUT, lines: [{ sku: "bread", qty: 1, price: total }], total } },
      { idempotencyKey: "idem-cart-scope" },
    );
    expect((await r.stand.issuer.sign(cart.id)).statusCode).toBe(200);
    const start = r.c.calls().length;
    const err = await r.c.platform
      .issuePaymentPackage({ mandate: { id: cart.id, currency: "RUB" }, orderRef: "ORD-scope-1", merchantId: OUT, amountMax: total, channel: "CARD" }, { idempotencyKey: "idem-cred-scope" })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "MANDATE_SCOPE", retry: "after_human", httpStatus: 409 });
    expect(r.c.calls().slice(start).map((x) => `${x.target} ${x.route} ${x.status} ${x.code}`)).toEqual([`${CREDENTIALS} 409 MANDATE_SCOPE`]);
  });

  it("риск 4а (выдача): новый CART при ACTIVE прежнем — реквизит и пакет по новому CART, прежний остаётся ACTIVE и не используется", async () => {
    const r = await run();
    const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-4a" });
    await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
    const first = (await r.purchase.search()).contour.find((o) => o.shopId === NORMAL.id)!;
    const old = await r.purchase.cart(one(first, 1), { idempotencyKey: "idem-cart-4a-old" });
    await r.signWhileWaiting(old.id, () => r.purchase.awaitCart());
    // новая выдача из CART_ACTIVE (К2а): снимок прежнего CART стёрт, у Платформы он остаётся ACTIVE (выбор 4а Р44)
    const offer = (await r.purchase.search()).contour.find((o) => o.shopId === NORMAL.id)!;
    const cart = await r.purchase.cart(one(offer, 2), { idempotencyKey: "idem-cart-4a-new" });
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    const order = await r.purchase.placeOrder({ idempotencyKey: "idem-order-4a" });
    expect((await r.c.platform.getMandate(old.id)).status).toBe("ACTIVE");
    const start = r.c.calls().length;
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-4a" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    // ворота — по новому CART; реквизит выдан (201) при ACTIVE прежнем; витрина приняла пакет — cart_mandate_id пакета
    // совпал с мандатом заказа (новый CART)
    expect(
      r.c
        .calls()
        .slice(start)
        .map((x) => shape(x, { intent: intent.id, cart: cart.id, old: old.id, shop: NORMAL.id, order: order.orderId }))
        .filter((s) => !s.startsWith("pao GET /pao/v1/events")),
    ).toEqual([
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "pao GET /pao/v1/mandates/{cart}/verify 200",
      `${CREDENTIALS} 201`,
      "merchants POST /v1/shops/{shop}/orders/{order}/payment 200",
    ]);
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.call" && e.method?.endsWith("/payment")).map((e) => [e.mandate, e.detail])).toEqual([[cart.id, "PAID"]]);
    expect((await r.c.platform.getMandate(old.id)).status).toBe("ACTIVE");
  });
});
