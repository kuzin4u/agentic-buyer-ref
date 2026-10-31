// Знак готовности продавца по ПАО на стенде Платформы (Р53, AG-09 ч. 2б, К2.3; передача #67, PS-30 ч. 2). Знак подаёт
// эквайрер стенда (ПИ-8) по readiness_mark фикстуры: ACTIVE у витрин контура, у витрины рынка (READ_ONLY) — NONE; приостанавливает и снимает
// оператор (`stand.suspendReadiness` / `reinstateReadiness`). Ожидание — из ответа знака стенда эквайреру
// (`acquirerParticipant.getReadiness`), а не из слов витрины и не из журнала агента. Подмен ответов нет. С v0.34.0 —
// способ оплаты витрины при знаке ACTIVE (`paymentMethods` стенда; эмулятор способ не сверяет — Р68 п. 4).
import { afterEach, describe, expect, it } from "vitest";
import { MERCHANT_FIXTURES } from "agentic-ps-platform/fixtures";
import { startFailureCode } from "../../src/agent/compose.js";
import { PurchaseStopped } from "../../src/agent/pipeline/index.js";
import { SignerSuspended } from "../../src/agent/signer/index.js";
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
const OUTSIDE = shopBy("READ_ONLY");
const INCOMPLETE = shopBy("INCOMPLETE");
type Run = Awaited<ReturnType<typeof standPurchase>>;

/** Статус знака продавца у стенда — как его видит эквайрер (ПИ-8 `GET …/readiness`). */
async function standMark(r: Run, merchantId: string): Promise<string> {
  const res = await r.stand.acquirerParticipant.getReadiness(merchantId);
  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({ merchant_id: merchantId, status: expect.any(String) });
  return (res.body as { status: string }).status;
}

/** Знаки, которые агент получил от ПАО при поиске: продавец → статус (запись shop.readiness, ok). */
const agentMarks = (r: Run) =>
  Object.fromEntries(r.c.journal.entries.filter((e) => e.kind === "shop.readiness" && e.result === "ok").map((e) => [e.merchant, e.detail]));

const readinessCall = (merchantId: string) => `GET /pao/v1/merchants/${merchantId}/readiness`;

describe("знак готовности по ПАО на стенде (Р53)", { timeout: STAND_TIMEOUT_MS }, () => {
  it("зона — по знаку стенда: ACTIVE — контур, NONE (витрина READ_ONLY) — рынок со ссылкой; агент получил те же знаки, что у стенда", async () => {
    const r = await standPurchase();
    c = r.c;
    await r.signedIntent();
    const zones = await r.purchase.search();
    const marks = Object.fromEntries(await Promise.all(MERCHANT_FIXTURES.map(async (f) => [f.merchant_id, await standMark(r, f.merchant_id)] as const)));
    expect(marks[OUTSIDE.merchant_id]).toBe("NONE");
    expect(marks[NORMAL.merchant_id]).toBe("ACTIVE");
    expect(agentMarks(r)).toEqual(marks);
    // контур — ровно витрины с ACTIVE у стенда, кроме неполной (все карточки не проходят модель, П09); рынок — прочие
    const active = MERCHANT_FIXTURES.filter((f) => marks[f.merchant_id] === "ACTIVE");
    expect(new Set(zones.contour.map((o) => o.shopId))).toEqual(new Set(active.filter((f) => f.id !== INCOMPLETE.id).map((f) => f.id)));
    expect(new Set(zones.market.map((o) => o.shopId))).toEqual(new Set(MERCHANT_FIXTURES.filter((f) => marks[f.merchant_id] !== "ACTIVE").map((f) => f.id)));
    expect(zones.market.every((o) => o.link !== undefined)).toBe(true);
    expect(zones.unavailable).toEqual([]);
    // способ оплаты агента (дополнение 1 к Р66 п. 3): витрины эмулятора — card и sbp; из контура не уходит ни одна —
    // канал CARD без причины рынка; рынок — по знаку, не по способу; записей shop.zone_market нет
    expect(zones.contour.length).toBeGreaterThan(0);
    for (const o of zones.contour) {
      expect(o.channel).toBe("CARD");
      expect(o.marketReason).toBeUndefined();
      expect(o.link).toBeUndefined(); // у товара контура ссылки нет (ревью КТ1 № 7)
    }
    for (const o of zones.market) expect(o.marketReason).toBeUndefined();
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.zone_market")).toEqual([]);
  });

  it("знак приостановлен оператором до поиска (suspendReadiness) — витрина в зоне рынка со ссылкой, хотя витрина говорит «контур»; расхождение — в журнал", async () => {
    const r = await standPurchase();
    c = r.c;
    await r.stand.suspendReadiness(NORMAL.merchant_id, "DISCREPANCY");
    expect(await standMark(r, NORMAL.merchant_id)).toBe("SUSPENDED");
    await r.signedIntent();
    const zones = await r.purchase.search();
    expect(zones.contour.some((o) => o.shopId === NORMAL.id)).toBe(false);
    expect(zones.market.filter((o) => o.shopId === NORMAL.id).map((o) => o.link)).toEqual(
      NORMAL.agent_items.map(() => `${r.c.merchants!.baseUrl}/v1/shops/${NORMAL.id}/catalog`),
    );
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.readiness_mismatch").map((e) => [e.merchant, e.detail])).toEqual([
      [NORMAL.merchant_id, "SUSPENDED:CONTOUR"],
    ]);
  });

  it("приостановление снято (reinstateReadiness) — знак снова ACTIVE, витрина в контуре", async () => {
    const r = await standPurchase();
    c = r.c;
    await r.stand.suspendReadiness(NORMAL.merchant_id, "AGENT_REFUSALS");
    await r.stand.reinstateReadiness(NORMAL.merchant_id);
    expect(await standMark(r, NORMAL.merchant_id)).toBe("ACTIVE");
    await r.signedIntent();
    const zones = await r.purchase.search();
    expect(zones.contour.filter((o) => o.shopId === NORMAL.id).map((o) => o.sku).sort()).toEqual(NORMAL.agent_items.map((i) => i.sku).sort());
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.readiness_mismatch")).toEqual([]);
  });

  it("знак приостановлен между поиском и оплатой — ворота стадии 5: STOPPED MERCHANT_NOT_READY, реквизит не запрашивается, пакета нет (Р53 п. 6, A5 п. 5.3)", async () => {
    const r = await standPurchase({ contourPayment: true });
    c = r.c;
    const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-ready" });
    await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
    const offer = (await r.purchase.search()).contour.find((o) => o.shopId === NORMAL.id)!;
    const cart = await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-ready" });
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-ready" });
    await r.stand.suspendReadiness(NORMAL.merchant_id, "SYSTEMATIC_CANCELLATION");
    const start = r.c.agentCalls().length;
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-ready" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("MERCHANT_NOT_READY");
    // ворота: verify INTENT и CART, знак — SUSPENDED; ни реквизита, ни пакета продавцу
    expect(
      r.c
        .agentCalls()
        .slice(start)
        .filter((x) => !x.route.startsWith("GET /pao/v1/events"))
        .map((x) => `${x.target} ${x.route.replaceAll(intent.id, "{intent}").replaceAll(cart.id, "{cart}")} ${x.status}`),
    ).toEqual(["pao GET /pao/v1/mandates/{intent}/verify 200", "pao GET /pao/v1/mandates/{cart}/verify 200", `pao ${readinessCall(NORMAL.merchant_id)} 200`]);
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.readiness").at(-1)).toMatchObject({ merchant: NORMAL.merchant_id, result: "ok", detail: "SUSPENDED" });
    expect(r.c.journal.entries.filter((e) => e.kind === "purchase.stage" && e.detail === "STOPPED").map((e) => e.reason)).toEqual(["MERCHANT_NOT_READY"]);
    // со стороны стенда: реквизит не выпущен (эмулятор токенов пуст), агенту ничего не выдано
    expect(r.stand.tsp.issued.size).toBe(0);
    expect(r.c.issuedSecrets()).toEqual([]);
  });

  it("агент приостановлен оператором, пока шли ворота (после verify, до знака), — 403 AGENT_SUSPENDED на знак: подпись приостановлена (Р60 п. 1), STOPPED тем же кодом, реквизита нет (Р53 п. 5; ревью КТ1 № 4)", async () => {
    // знак после заказа — только в воротах: перед ним оператор приостанавливает агента, запрос уходит на стенд как есть
    const hook: { beforeMark?: () => Promise<unknown> } = {};
    const f: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === readinessCall(NORMAL.merchant_id).slice(4)) await hook.beforeMark?.();
      return fetch(input, init);
    };
    const r = await standPurchase({ contourPayment: true, fetch: f, failureCode: startFailureCode });
    c = r.c;
    const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-agent" });
    await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
    const offer = (await r.purchase.search()).contour.find((o) => o.shopId === NORMAL.id)!;
    const cart = await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-agent" });
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-agent" });
    hook.beforeMark = () => ((hook.beforeMark = undefined), r.stand.suspendAgent(r.c.agentCode, "OUT_OF_MANDATE"));
    const start = r.c.agentCalls().length;
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-agent" })).rejects.toMatchObject({ name: "PlatformFailure", code: "AGENT_SUSPENDED" });
    expect(r.purchase.reason).toBe("AGENT_SUSPENDED");
    expect(r.c.admission()).toBe("AGENT_SUSPENDED");
    const after = r.c.agentCalls().slice(start).filter((x) => !x.route.startsWith("GET /pao/v1/events"));
    expect(after.map((x) => [x.route.replaceAll(intent.id, "{intent}").replaceAll(cart.id, "{cart}"), x.status, x.code])).toEqual([
      ["GET /pao/v1/mandates/{intent}/verify", 200, undefined],
      ["GET /pao/v1/mandates/{cart}/verify", 200, undefined],
      [readinessCall(NORMAL.merchant_id), 403, "AGENT_SUSPENDED"],
    ]);
    expect(r.stand.tsp.issued.size).toBe(0);
    // приостановка, а не остановка (Р60 п. 1; ревью К1.1 № 3): рабочая подпись — SignerSuspended, обращения нет
    const before = r.c.agentCalls().length;
    await expect(r.c.platform.agentSelf()).rejects.toBeInstanceOf(SignerSuspended);
    expect(r.c.agentCalls()).toHaveLength(before);
  });

  // Р68 п. 4, дополнение 1 к Р66 п. 3 (AG-09 ч. 2д, хвост): эмулятор способ оплаты не сверяет (оплата пакетом CARD у
  // ["cash"] прошла бы) — проверяется решение агента, а не отказ витрины; отсутствие выдачи реквизита видно и стенду.
  it("витрина NORMAL с [\"cash\"] при знаке ACTIVE — зона рынка со ссылкой и ZONE_MARKET_NO_METHOD, shop.zone_market; выбор — OFFER_NOT_IN_CONTOUR, реквизит не запрашивается (Р68 п. 4)", async () => {
    const r = await standPurchase({ paymentMethods: { [NORMAL.merchant_id]: ["cash"] } });
    c = r.c;
    const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-nomethod" });
    await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
    const zones = await r.purchase.search();
    // знак у стенда прежний — в рынок витрину уводит способ оплаты, а не знак
    expect(await standMark(r, NORMAL.merchant_id)).toBe("ACTIVE");
    expect(agentMarks(r)[NORMAL.merchant_id]).toBe("ACTIVE");
    expect(zones.contour.filter((o) => o.shopId === NORMAL.id)).toEqual([]);
    const market = zones.market.filter((o) => o.shopId === NORMAL.id);
    expect(market.length).toBeGreaterThan(0);
    // ни один товар витрины не отброшен — ни молча, ни исключением: в рынке ровно товары витрины для агента (ревью КТ № 4)
    expect(new Set(market.map((o) => o.sku))).toEqual(new Set(NORMAL.agent_items.map((i) => i.sku)));
    expect(r.c.journal.entries.filter((e) => e.kind === "offer.excluded" && e.merchant === NORMAL.merchant_id)).toEqual([]);
    for (const o of market) {
      expect(o).toMatchObject({ merchantId: NORMAL.merchant_id, marketReason: "ZONE_MARKET_NO_METHOD" });
      expect(o.link).toMatch(/\S/);
      expect(o.channel).toBeUndefined();
    }
    const records = r.c.journal.entries.filter((e) => e.kind === "shop.zone_market");
    expect(records.map((e) => [e.merchant, e.reason])).toEqual([[NORMAL.merchant_id, "NO_AGENT_PAYMENT_METHOD"]]);
    // строки payment_methods витрины в журнал не попадают ни в каком виде (инвариант 5; ревью КТ № 5)
    expect(JSON.stringify(r.c.journal.entries)).not.toMatch(/\bcash\b/i);
    // выбор товара зоны рынка — отказ без оплаты и без обращений (инвариант 10; ревью КТ № 1, № 3)
    const before = r.c.agentCalls().length;
    await expect(r.purchase.cart(one(market[0]!, 1), { idempotencyKey: "idem-cart-nomethod" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.reason).toBe("OFFER_NOT_IN_CONTOUR");
    expect(r.c.agentCalls()).toHaveLength(before);
    expect(r.c.journal.entries.filter((e) => e.kind === "agent.refused").map((e) => [e.reason, e.ref])).toEqual([["OFFER_NOT_IN_CONTOUR", market[0]!.sku]]);
    // реквизит не запрашивался — ни в журнале обращений контура, ни у стенда (инварианты 1, 10); стенд обращения агента
    // видел (знак продавца), то есть отсутствие выдачи — не пустой журнал
    const credentials = (m: string, p: string) => m === "POST" && p === "/pao/v1/credentials";
    expect(r.c.calls().filter((x) => x.target === "pao" && credentials(x.route.split(" ")[0]!, x.route.split(" ")[1]!.split("?")[0]!))).toEqual([]);
    const standCalls = r.stand.calls();
    expect(standCalls.some((x) => x.method === "GET" && x.path === readinessCall(NORMAL.merchant_id).split(" ")[1])).toBe(true);
    expect(standCalls.filter((x) => credentials(x.method, x.path))).toEqual([]);
    // выданных реквизитов нет ни у стенда, ни в перехвате контура (Р68 п. 3; ревью КТ № 2)
    expect(r.stand.issuedCredentials()).toEqual([]);
    expect(r.c.issuedSecrets()).toEqual([]);
  });
});
