// Стадии 5–6 на стенде Платформы v0.20.0 (Р49; AG-11 ч. 2, К5): итог стадии 5 — из события operation.authorized и
// GET /pao/v1/operations/{op_ref}, привязка по order_ref и сверка с CART; расчёт — operation.settled и GET, запись об
// исполнении. П15 — авторизация в пределах лимита с клирингом; риск 4а — авторизация по новому CART при ACTIVE прежнем.
// ПОДМЕНА ДО PS-11 (как в confirmation-stand.test.ts, вариант (а) владельца): продавец ADP не достигает, заглушка отвечает
// ему отказом, копию сообщения эквайрера тестовая поддержка передаёт в настоящий ADP стенда (contour.ts, `adpUntilPs11`).
// Ответ эмитента (ISSUER_RESPONSE) и клиринг (PRESENTMENT) шлёт тест как процессинг (ПИ-3); решение ADP, итог, события,
// GET и запись об исполнении — настоящие. Ответ продавца DECLINED — только слова (инвариант 8): итог — по событию.
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DIAG } from "../../src/agent/compose.js";
import { Operations } from "../../src/agent/operations/index.js";
import type { Mandate } from "../../src/shared/domain.js";
import { INTENT } from "../support/consents.js";
import { shopBy, type Contour } from "../support/contour.js";
import { one } from "../support/purchase.js";
import { SHORT_DELAY_SEC, SHORT_WATCH_SEC, STAND_TIMEOUT_MS, standPurchase } from "../support/stand-purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  await c?.close();
  c = undefined;
});

const NORMAL = shopBy("NORMAL");

type Run = Awaited<ReturnType<typeof standPurchase>>;

/** Решение ADP стенда по копии сообщения эквайрера: ждать, пока продавец его запросит; op_ref — из сообщения. */
async function decided(r: Run, n = 1): Promise<{ op_ref: string; decision: string }> {
  for (let i = 0; i < 200; i++) {
    const all = (await r.c.adpDecisions!()) as { op_ref?: string; decision?: string }[];
    if (all.length >= n) {
      const d = all[n - 1]!;
      expect(d.op_ref).toEqual(expect.any(String));
      return d as { op_ref: string; decision: string };
    }
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("продавец не дошёл до ADP стенда");
}

/** Сообщение процессинга ПИ-3 на стенд (ответ эмитента, клиринг): 202 — принято. */
async function processing(r: Run, payload: Record<string, unknown>): Promise<void> {
  const res = await r.c.stand!.app.inject({ method: "POST", url: "/adp/v1/events", payload });
  expect(res.statusCode, JSON.stringify(payload)).toBe(202);
}

const entries = (r: Run, kind: string) => r.c.journal.entries.filter((e) => e.kind === kind).map((e) => [e.ref, e.detail]);

describe("стадии 5–6 на стенде v0.20.0: итог из события и GET операции, расчёт (Р49)", { timeout: STAND_TIMEOUT_MS * 2 }, () => {
  it("П15: авторизация в пределах лимита — эмитент одобрил → operation.authorized → GET → SETTLING; остаток CART уменьшен; клиринг → operation.settled → DONE, запись об исполнении WITHIN_LIMITS", async () => {
    const notices: string[] = [];
    const r = await standPurchase({ contourPayment: true, adpUntilPs11: true, notify: (code) => void notices.push(code) });
    c = r.c;
    const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-p15" });
    await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
    const offer = (await r.purchase.search()).contour.find((o) => o.shopId === NORMAL.id)!;
    const cart = await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-p15" });
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    const order = await r.purchase.placeOrder({ idempotencyKey: "idem-order-p15" });
    const total = cart.cart!.total;
    expect(total.amount).toBeLessThanOrEqual(r.c.stand!.params.confirm_above_kop);

    const authorizing = r.purchase.authorize({ idempotencyKey: "idem-pay-p15" });
    const d = await decided(r);
    // ADP одобрила по пределам мандата и ждёт эмитента: итога ещё нет, события нет
    expect(d.decision).toBe("APPROVE");
    await processing(r, { op_ref: d.op_ref, msg_type: "ISSUER_RESPONSE", issuer_approved: true });
    const op = await authorizing;
    expect(op).toMatchObject({ opRef: d.op_ref, orderRef: order.orderId, status: "AUTHORIZED", amount: total, merchantId: cart.cart!.merchantId, indicator: { mandateId: cart.id }, channel: "CARD" });
    expect(r.purchase.state).toBe("SETTLING");
    // продавец ответил отказом (подмена до PS-11) — слова продавца только в журнале, итог — по событию Платформы
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.call" && e.method?.endsWith("/payment")).map((e) => e.detail)).toEqual(["DECLINED"]);
    expect(entries(r, "operation.status")).toEqual([[d.op_ref, "AUTHORIZED"]]);
    // П15: остаток бюджета CART уменьшен — по verify Платформы, агент его не вычисляет (инвариант 6)
    const left = await r.c.platform.verifyMandate({ id: cart.id, currency: total.currency });
    expect(left.amountLeft.amount).toBe(0);

    // клиринг — PRESENTMENT суммой одобрения; расчёт ждёт operation.settled и читает GET
    const ac = new AbortController();
    const settling = r.purchase.settle(ac.signal);
    await processing(r, { op_ref: d.op_ref, msg_type: "PRESENTMENT", amount: total.amount, currency: total.currency });
    const settled = await settling;
    expect(settled).toMatchObject({ status: "SETTLED", fulfilment: { finalAmount: total, spentPosition: total, scopeCheck: "WITHIN_LIMITS" } });
    expect(settled.fulfilment!.ref).toMatch(/^ful_/);
    expect(r.purchase.state).toBe("DONE");
    expect(entries(r, "operation.settled")).toEqual([[d.op_ref, "WITHIN_LIMITS"]]);
    expect(notices).toEqual([]);
    // Р65 п. 1–3 (Т12, стадия 7): выписка по CART после покупки — цепочка INTENT и CART, integrity OK, в журнале только признак
    const ev = await r.mandates.evidence(cart.id);
    expect(ev).toMatchObject({ integrity: "OK" });
    expect(ev.mandateChain.map((m) => [m.id, m.kind])).toEqual([[intent.id, "INTENT"], [cart.id, "CART"]]);
    expect(r.c.journal.entries.filter((e) => e.kind === "mandate.evidence")).toEqual([expect.objectContaining({ mandate: cart.id, detail: "OK" })]);
    expect(r.c.calls().filter((x) => x.target === "pao" && x.route === `GET /pao/v1/mandates/${cart.id}/evidence`)).toHaveLength(1);
    // реквизит нигде не встречается (инвариант 1)
    const out = JSON.stringify([r.c.journal.entries, r.purchase.operation]);
    for (const s of r.c.issuedSecrets!()) expect(out.includes(s)).toBe(false);
  });

  /** Покупка у NORMAL до расчёта (DONE) — операция под наблюдением после итога (Р65 п. 5). */
  async function settledRun(params: { watch_poll_interval_sec: number } | undefined, notices: [string, unknown][]) {
    const r = await standPurchase({ contourPayment: true, adpUntilPs11: true, ...(params && { params }), notify: (code, amount) => void notices.push([code, amount]) });
    c = r.c;
    const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-bg" });
    await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
    const offer = (await r.purchase.search()).contour.find((o) => o.shopId === NORMAL.id)!;
    const cart = await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-bg" });
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-bg" });
    const total = cart.cart!.total;
    const authorizing = r.purchase.authorize({ idempotencyKey: "idem-pay-bg" });
    const d = await decided(r);
    await processing(r, { op_ref: d.op_ref, msg_type: "ISSUER_RESPONSE", issuer_approved: true });
    await authorizing;
    expect(r.operations.polling).toBe(false); // до итога — ожидание читает ленту само, фонового чтения нет
    const settling = r.purchase.settle(new AbortController().signal);
    await processing(r, { op_ref: d.op_ref, msg_type: "PRESENTMENT", amount: total.amount, currency: total.currency });
    await settling;
    expect(r.purchase.state).toBe("DONE");
    expect(r.operations.polling).toBe(true); // операция под наблюдением — фоновое чтение идёт
    return { r, d, total };
  }

  const afterFrom = (r: Run, from: number, route: string) => r.c.calls().slice(from).filter((x) => x.source === "agent" && x.target === "pao" && x.route.startsWith(route));

  it("Р65 п. 5 (Р51 п. 4): возврат после расчёта — ленту не читают ни тест, ни оболочка; фоновое чтение по watch_poll_interval_sec → operation.refunded → GET → OPERATION_REFUNDED", async () => {
    const notices: [string, unknown][] = [];
    const { r, d, total } = await settledRun({ watch_poll_interval_sec: SHORT_WATCH_SEC }, notices);

    // возврат процессинга; тест ленту не читает (r.readFeed не вызывается) — только фоновое чтение модуля операций
    const from = r.c.calls().length;
    await processing(r, { op_ref: d.op_ref, msg_type: "REFUND", amount: total.amount, currency: total.currency });
    for (let i = 0; i < 50 && notices.length === 0; i++) await new Promise((res) => setTimeout(res, 100));
    expect(notices).toEqual([["OPERATION_REFUNDED", total]]);
    expect(r.purchase.state).toBe("DONE");
    // фоновое чтение было; число GET операции здесь не считается: settle() узнаёт расчёт по GET и ленту не читает, так что
    // фоновое чтение может застать непрочитанный operation.settled — второй GET (вариант (б), решение владельца 30.10);
    // точный подсчёт — в тесте ниже
    expect(afterFrom(r, from, "GET /pao/v1/events").length).toBeGreaterThan(0);
    // возврат — конечный: операция ушла из окна, окно пустое — фоновое чтение снято (дополнение 1 к Р65 п. 1, 3)
    expect(r.operations.polling).toBe(false);
    expect(r.c.violations()).toEqual([]);
  });

  it("Р65 п. 5, нюанс К2.4 (вариант (б)): без фонового чтения (стендовый watch_poll_interval_sec за время теста не срабатывает) — ленту после возврата читает тест; ровно один GET операции", async () => {
    const notices: [string, unknown][] = [];
    const { r, d, total } = await settledRun(undefined, notices);
    // расчёт settle() узнаёт по GET операции, ленту не читает: operation.settled в ленте ещё не прочитан — тест дочитывает
    // его до возврата (второй GET со статусом SETTLED), иначе первое чтение после возврата даст GET и на него
    const settledReads = () => r.c.journal.entries.filter((e) => e.kind === "operation.status" && e.ref === d.op_ref && e.detail === "SETTLED").length;
    for (let i = 0; i < 50 && settledReads() < 2; i++) await r.readFeed();
    expect(settledReads()).toBe(2);
    expect(notices).toEqual([]);

    const from = r.c.calls().length;
    await processing(r, { op_ref: d.op_ref, msg_type: "REFUND", amount: total.amount, currency: total.currency });
    for (let i = 0; i < 50 && notices.length === 0; i++) await r.readFeed();
    expect(notices).toEqual([["OPERATION_REFUNDED", total]]);
    // operation.settled прочитан до from, таймер фонового чтения не сработал — по возврату ровно один GET
    expect(afterFrom(r, from, `GET /pao/v1/operations/${d.op_ref}`).length).toBe(1);
    expect(r.operations.polling).toBe(false);
    expect(r.c.violations()).toEqual([]);
  });

  it("риск 4а (авторизация): новый CART после нового поиска — операция привязана к новому CART; от прежнего агент отказался (Р63, дополнение 1 п. 6), он не используется", async () => {
    const r = await standPurchase({ contourPayment: true, adpUntilPs11: true });
    c = r.c;
    const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-4a2" });
    await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
    const first = (await r.purchase.search()).contour.find((o) => o.shopId === NORMAL.id)!;
    const old = await r.purchase.cart(one(first, 1), { idempotencyKey: "idem-cart-4a2-old" });
    await r.signWhileWaiting(old.id, () => r.purchase.awaitCart());
    const offer = (await r.purchase.search()).contour.find((o) => o.shopId === NORMAL.id)!;
    const cart = await r.purchase.cart(one(offer, 2), { idempotencyKey: "idem-cart-4a2-new" });
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-4a2" });
    expect((await r.c.platform.getMandate(old.id)).status).toBe("REVOKED");

    const authorizing = r.purchase.authorize({ idempotencyKey: "idem-pay-4a2" });
    const d = await decided(r);
    expect(d.decision).toBe("APPROVE");
    await processing(r, { op_ref: d.op_ref, msg_type: "ISSUER_RESPONSE", issuer_approved: true });
    const op = await authorizing;
    expect(op).toMatchObject({ status: "AUTHORIZED", amount: cart.cart!.total, indicator: { mandateId: cart.id } });
    expect(r.c.journal.entries.some((e) => e.kind === "operation.mismatch")).toBe(false);
    // было: прежний CART ACTIVE с полным остатком (операция по нему не шла); стало (Р63, дополнение 1 п. 6): прежний отозван
    // агентом — verify отозванного отдаёт 0, поэтому остаток — после итога отказа: по прежнему операций нет, остаток INTENT
    // уменьшен ровно на новый CART
    expect(await r.purchase.cartReleased()).toBe("NONE"); // новый CART сбросил итог прежнего — он в журнале
    expect(r.c.journal.entries.filter((e) => e.kind === "cart.relinquished").map((e) => e.mandate)).toEqual([old.id]);
    expect((await r.c.platform.getMandate(old.id)).status).toBe("REVOKED");
    expect(await r.c.platform.readOperations(old.id)).toEqual([]);
    expect((await r.c.platform.verifyMandate({ id: intent.id, currency: "RUB" })).amountLeft).toEqual({
      amount: intent.amountLimit.amount - cart.cart!.total.amount,
      currency: "RUB",
    });
  });

  it("Р51 п. 5: реверсал до ответа эмитента — событий нет вовсе; итог находит поиск GET ?mandate_id по CART — STOPPED OPERATION_REVERSED, текст Р51 п. 3; бюджет CART освобождён", async () => {
    // сроки стадии 5 — короткие: событий не будет, ждать полный срок незачем (сравнение — с одним поиском после срока)
    const notices: [string, unknown][] = [];
    const r = await standPurchase({
      contourPayment: true,
      adpUntilPs11: true,
      params: { operation_outcome_max_delay_sec: SHORT_DELAY_SEC, confirmation_wait_ms: SHORT_DELAY_SEC * 1000 },
      notify: (code, amount) => void notices.push([code, amount]),
    });
    c = r.c;
    const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-rev" });
    await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
    const offer = (await r.purchase.search()).contour.find((o) => o.shopId === NORMAL.id)!;
    const cart = await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-rev" });
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    const order = await r.purchase.placeOrder({ idempotencyKey: "idem-order-rev" });
    const total = cart.cart!.total;

    const start = r.c.calls().length;
    const authorizing = r.purchase.authorize({ idempotencyKey: "idem-pay-rev" }).catch((e: unknown) => e);
    const d = await decided(r);
    expect(d.decision).toBe("APPROVE");
    // процессинг отменил авторизацию до ответа эмитента: ни operation.authorized, ни operation.declined (передача #63 п. 3)
    await processing(r, { op_ref: d.op_ref, msg_type: "REVERSAL", amount: total.amount, currency: total.currency });
    const err = await authorizing;
    expect(err).toMatchObject({ name: "PurchaseStopped", code: "OPERATION_REVERSED" });
    expect(r.purchase.reason).toBe("OPERATION_REVERSED");
    expect(r.purchase.next).toBe("NOTIFY_HUMAN");
    expect(DIAG.OPERATION_REVERSED!.human.ru).toBe("Оплата отменена; списания быть не должно — если оно всё же придёт, сообщим отдельно. Покупка остановлена; итог проверьте в приложении банка.");
    // полный журнал обращений стадии 5 (ленту не считаем): ворота, реквизит, пакет и один поиск по CART — ни GET одной
    // операции, ни второй выдачи (ревью КТ1 Р51 № 4)
    const ids: Record<string, string> = { intent: intent.id, cart: cart.id, shop: NORMAL.id, order: order.orderId };
    const shape = (x: { target: string; route: string; status: number }) =>
      `${x.target} ${Object.entries(ids).reduce((route, [name, id]) => route.replaceAll(id, `{${name}}`), x.route)} ${x.status}`;
    // только обращения агента (по сети): копия сообщения эквайрера в ADP (подмена до PS-11) и REVERSAL процессинга — от
    // тестовой поддержки (source "test"); обращение агента к /adp/* попало бы сюда и в violations (ревью чата К4)
    expect(r.c.calls().slice(start).filter((x) => x.source === "agent" && !x.route.startsWith("GET /pao/v1/events")).map(shape)).toEqual([
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "pao GET /pao/v1/mandates/{cart}/verify 200",
      `pao GET /pao/v1/merchants/${NORMAL.merchant_id}/readiness 200`,
      "pao POST /pao/v1/credentials 201",
      "merchants POST /v1/shops/{shop}/orders/{order}/payment 200",
      "pao GET /pao/v1/operations 200",
    ]);
    expect(r.c.calls().slice(start).filter((x) => x.source === "test").map(shape)).toEqual([
      "pao POST /adp/v1/decide 200",
      // метаданные пакета эквайрером стенда после авторизации (ПИ-8, v0.24.0, #67; Р52 К2)
      `pao POST /participants/v1/merchants/${NORMAL.merchant_id}/payments 200`,
      "pao POST /adp/v1/events 202",
    ]);
    expect(r.c.violations()).toEqual([]);
    // запись поиска — CART и BOUND, без тела ответа
    expect(entries(r, "operation.lookup")).toEqual([[cart.id, "BOUND"]]);
    expect(entries(r, "operation.reversed")).toEqual([[d.op_ref, "REVERSAL"]]);
    // снимок операции покупки — REVERSED с причиной (ревью КТ1 Р51 № 2)
    expect(r.purchase.operation).toMatchObject({ opRef: d.op_ref, status: "REVERSED", declineReason: "REVERSAL" });
    // реквизит нигде не встречается (инвариант 1)
    const out = JSON.stringify([r.c.journal.entries, r.purchase.operation]);
    for (const s of r.c.issuedSecrets!()) expect(out.includes(s)).toBe(false);
    // бюджет освободила Платформа — по verify (инвариант 6)
    expect((await r.c.platform.verifyMandate({ id: cart.id, currency: total.currency })).amountLeft).toEqual(total);

    // Р51 п. 4: клиринг старше реверсала (передача #63 п. 4) — operation.settled, GET SETTLED с NOT_RESERVED: наблюдение
    // после итога — одно уведомление OPERATION_SETTLED_LATE с суммой и валютой; покупка остаётся STOPPED
    expect(notices).toEqual([]);
    await processing(r, { op_ref: d.op_ref, msg_type: "PRESENTMENT", amount: total.amount, currency: total.currency });
    // после итога ленту читает оболочка или push, не конвейер (compose: events.items) — здесь тест
    for (let i = 0; i < 50 && notices.length === 0; i++) await r.readFeed();
    expect(notices).toEqual([["OPERATION_SETTLED_LATE", total]]);
    expect(r.purchase.reason).toBe("OPERATION_REVERSED");
  });

  it("ревью чата К4: журнал обращений по источнику — /adp/* по сети (как клиент агента) — обращение агента и нарушение контура; через app.inject — тестовая поддержка", async () => {
    const r = await standPurchase();
    c = r.c;
    const start = r.c.calls().length;
    // по сети, как ходил бы клиент агента: в журнале агента и в violations
    const { port } = r.c.stand!.app.server.address() as AddressInfo;
    await fetch(`http://127.0.0.1:${port}/adp/v1/events`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    // через inject — тестовая поддержка: не нарушение
    await r.c.stand!.app.inject({ method: "POST", url: "/adp/v1/events", payload: {} });
    const calls = r.c.calls().slice(start);
    expect(calls.map((x) => [x.source, x.route])).toEqual([
      ["agent", "POST /adp/v1/events"],
      ["test", "POST /adp/v1/events"],
    ]);
    expect(r.c.violations()).toEqual(["агент обратился к пути участника: POST /adp/v1/events"]);
  });

  it("Р51 п. 5, ревью КТ1 Р51 № 9: поиск по неизвестному CART на стенде — 404 MANDATE_NOT_FOUND, исход NONE (дальше OPERATION_RESULT_UNCONFIRMED), код в operation.lookup, подпись не остановлена", async () => {
    const r = await standPurchase({ contourPayment: true });
    c = r.c;
    await expect(r.c.platform.readOperations("m_cart_unknown")).rejects.toMatchObject({ code: "MANDATE_NOT_FOUND", httpStatus: 404 });
    const ops = new Operations({ port: r.c.platform, journal: r.c.journal, params: r.params });
    const unknown = { ...INTENT, id: "m_cart_unknown", kind: "CART", cart: { merchantId: NORMAL.merchant_id, lines: [], total: { amount: 1, currency: "RUB" } } } as unknown as Mandate;
    expect(await ops.lookup("ord_unknown", unknown)).toEqual({ kind: "NONE" });
    expect(entries(r, "operation.lookup")).toEqual([["m_cart_unknown", "MANDATE_NOT_FOUND"]]);
    expect(r.c.admission()).toBeNull();
  });
});
