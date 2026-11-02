// Стадия 4 на стенде Платформы и эмуляторе продавцов (Р47; AG-13 ч. 1, К4; стенд v0.37.0 — Р69 п. 0, Р70): итог выше
// порога ADP — продавец отвечает AWAITING_CONFIRMATION (до v0.37.0 — DECLINED), ADP создала запрос подтверждения и
// событие confirmation.required; агент читает GET, уведомляет человека (со ссылкой страницы УПК, Р69 п. 5) и ждёт
// решения в приложении банка (stand.issuer.confirm) или на странице УПК (stand.upk, код — stand.issuer.upkCode).
// Одобрение — ворота заново, ссылка продавцу (POST …/confirmation, один раз), продавец повторяет авторизацию новой
// операцией с прежним реквизитом: итог — operation.authorized и GET новой операции → SETTLING (Р70; #56 п. 3, 5); отказ —
// CONFIRMATION_REJECTED; срок — CONFIRMATION_EXPIRED по GET после expires_at.
// ПОДМЕНА ДО PS-11 (решение владельца, вариант (а)): ОПКЦ стенда — заглушка, продавец ADP не достигает; заглушка отвечает
// отказом, копию сообщения эквайрера тестовая поддержка передаёт в настоящий ADP стенда (contour.ts, `adpUntilPs11`):
// запрос, событие, GET, решение банка и решение ADP по ссылке — настоящие; ответ эмитента (ISSUER_RESPONSE) шлёт тест
// как процессинг (ПИ-3). Продавцу заглушка и на повторе отвечает отказом — его слова DECLINED, итог — по событию.
import { afterEach, describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { DIAG } from "../../src/agent/compose.js";
import { INTENT } from "../support/consents.js";
import { shopBy, type Contour } from "../support/contour.js";
import { one } from "../support/purchase.js";
import { STAND_TIMEOUT_MS, standPurchase, type StandPurchaseOptions } from "../support/stand-purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  await c?.close();
  c = undefined;
});

const NORMAL = shopBy("NORMAL");
const QTY = 2;
/** Товар витрины, у которого QTY штук — выше порога ADP стенда и в пределах INTENT (проверка — в `above`); из фикстур */
const ITEM = [...NORMAL.agent_items].sort((x, y) => (y.price ?? 0) - (x.price ?? 0))[0]!;

/** Покупка до ORDERED выше порога ADP; уведомление оболочки — обещание `notified`. */
async function above(o: StandPurchaseOptions = {}) {
  let notified: () => void = () => {};
  const pending = new Promise<void>((res) => (notified = res));
  const codes: string[] = [];
  /** второй аргумент уведомления: у CONFIRMATION_PENDING — `{ link }` страницы УПК (Р69 п. 5) */
  const details: unknown[] = [];
  const r = await standPurchase({
    ...o,
    contourPayment: true,
    adpUntilPs11: true,
    notify: (code, detail) => {
      codes.push(code);
      details.push(detail);
      notified();
    },
  });
  c = r.c;
  const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-cnf" });
  await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
  const zones = await r.purchase.search();
  const offer = zones.contour.find((x) => x.shopId === NORMAL.id && x.sku === ITEM.sku)!;
  const cart = await r.purchase.cart(one(offer, QTY), { idempotencyKey: "idem-cart-cnf" });
  await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
  const order = await r.purchase.placeOrder({ idempotencyKey: "idem-order-cnf" });
  expect(order.total.amount).toBeGreaterThan(r.c.stand!.params.confirm_above_kop);
  expect(order.total.amount).toBeLessThanOrEqual(INTENT.amountLimit.amount);
  return { r, codes, details, pending, intent, cart, order };
}

/** id запроса подтверждения — из записи журнала (GET дал PENDING). */
const confirmationId = (r: Awaited<ReturnType<typeof above>>["r"]) => {
  const e = r.c.journal.entries.find((x) => x.kind === "confirmation.status" && x.detail === "PENDING");
  expect(e?.ref).toMatch(/^cnf_/);
  return e!.ref!;
};

const stagesOf = (r: Awaited<ReturnType<typeof above>>["r"]) => r.c.journal.entries.filter((e) => e.kind === "purchase.stage").map((e) => e.detail);
const count = (r: Awaited<ReturnType<typeof above>>["r"], route: string) => r.c.calls().filter((x) => `${x.target} ${x.route.split("?")[0]}` === route).length;

/** Всё, что агент отдаёт наружу: журнал, снимки покупки, исход (ошибка или операция), тексты реестра по коду остановки. */
function outward(r: Awaited<ReturnType<typeof above>>["r"], result: unknown): string {
  const code = r.purchase.reason;
  const e = result instanceof Error ? result : null;
  return [
    JSON.stringify(r.c.journal.entries),
    JSON.stringify([r.purchase.state, code, r.purchase.cartMandate, r.purchase.order, r.purchase.operation]),
    e === null ? JSON.stringify(result) : String(e),
    e?.stack ?? "",
    inspect(result, { depth: 10, showHidden: true }),
    JSON.stringify(code === null ? null : DIAG[code]),
    JSON.stringify(DIAG.CONFIRMATION_PENDING),
  ].join("\n");
}

/** Решение ADP стенда по копии n-го сообщения эквайрера (подмена до PS-11): ждать, пока продавец его запросит. */
async function adpDecision(r: Awaited<ReturnType<typeof above>>["r"], n: number): Promise<{ op_ref: string; decision: string }> {
  for (let i = 0; i < 250; i++) {
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

/** После одобрения человеком (Р70): ADP одобрила авторизацию со ссылкой — новая операция; ответ эмитента — тест как
 *  процессинг (ПИ-3); итог агента — operation.authorized и GET → SETTLING. Возвращает op_ref новой операции. */
async function issuerApproves(r: Awaited<ReturnType<typeof above>>["r"]): Promise<string> {
  const d = await adpDecision(r, 2);
  expect(d.decision).toBe("APPROVE");
  const res = await r.c.stand!.app.inject({ method: "POST", url: "/adp/v1/events", payload: { op_ref: d.op_ref, msg_type: "ISSUER_RESPONSE", issuer_approved: true } });
  expect(res.statusCode).toBe(202);
  return d.op_ref;
}

describe("стадия 4 на стенде v0.17.0: подтверждение человеком по confirmation.* (Р47)", { timeout: STAND_TIMEOUT_MS }, () => {
  it("Р70: одобрение в приложении банка — ворота заново, ссылка продавцу один раз, новая операция → SETTLING; реквизит и пакет — прежние, confirmation_ref и link нигде", async () => {
    const { r, codes, details, pending, order, cart } = await above();
    const paying = r.purchase.authorize({ idempotencyKey: "idem-pay-cnf" }).catch((e: unknown) => e);
    await pending;
    expect(codes).toEqual(["CONFIRMATION_PENDING"]);
    // подмена до PS-11: настоящий ADP стенда по копии сообщения эквайрера потребовал подтверждения (РП50 п. 1)
    expect(await r.c.adpDecisions!()).toEqual([expect.objectContaining({ decision: "CONFIRMATION_REQUIRED" })]);
    const id = confirmationId(r);
    // продавец ответил AWAITING_CONFIRMATION (ADP: CONFIRMATION_REQUIRED; стенд v0.37.0, РП72; до него — DECLINED) — слова
    // продавца только в журнале
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.call" && e.method?.endsWith("/payment")).map((e) => e.detail)).toEqual(["AWAITING_CONFIRMATION"]);
    const decided = await r.c.stand!.issuer.confirm(id);
    expect(decided.statusCode).toBe(200);
    const ref = (decided.body as { confirmation_ref: string }).confirmation_ref;
    expect(ref).toMatch(/^cr_/);
    const first = (await adpDecision(r, 1)).op_ref;
    const opRef = await issuerApproves(r);
    const op = await paying;
    // итог — новая операция по order_ref (новый op_ref, РП72 п. 2), сверенная с CART; у первой попытки событий нет
    expect(op).toMatchObject({ opRef: opRef, orderRef: order.orderId, status: "AUTHORIZED", amount: cart.cart!.total, indicator: { mandateId: cart.id } });
    expect(opRef).not.toBe(first);
    expect(r.purchase.state).toBe("SETTLING");
    expect(r.purchase.reason).toBeNull();
    // стадия 4 → ворота заново → AUTHORIZING (Р70; пропуск ворот не живёт после стадии 4, К4) → SETTLING
    expect(stagesOf(r).slice(-4)).toEqual(["AUTHORIZING", "CONFIRMING", "AUTHORIZING", "SETTLING"]);
    expect(r.c.journal.entries.filter((e) => e.kind === "confirmation.status").map((e) => [e.ref, e.detail])).toEqual([
      [id, "PENDING"],
      [id, "APPROVED"],
    ]);
    expect(r.c.journal.entries.filter((e) => e.kind === "operation.status").map((e) => [e.ref, e.detail])).toEqual([[opRef, "AUTHORIZED"]]);
    // слова продавца: на оплату — «ждёт», на ссылку — его ответ (подмена отвечает отказом; итог — по событию)
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.call" && e.method?.endsWith("/confirmation")).map((e) => [e.attempt, e.result])).toEqual([[1, "ok"]]);
    // реквизит один, пакет один, ссылка продавцу — ровно одна (инвариант 9; РП72 п. 3); нового реквизита нет (РП72 п. 2)
    expect(count(r, "pao POST /pao/v1/credentials")).toBe(1);
    expect(count(r, `merchants POST /v1/shops/${NORMAL.id}/orders/${order.orderId}/payment`)).toBe(1);
    expect(count(r, `merchants POST /v1/shops/${NORMAL.id}/orders/${order.orderId}/confirmation`)).toBe(1);
    expect(count(r, `pao GET /pao/v1/confirmations/${id}`)).toBe(2);
    expect(count(r, "pao POST /pao/v1/confirmations")).toBe(0);
    // ворота стадии 5 заново: verify обоих мандатов и знак продавца — дважды за покупку
    expect(count(r, `pao GET /pao/v1/mandates/${cart.id}/verify`)).toBeGreaterThanOrEqual(2);
    const text = outward(r, op);
    expect(text).not.toContain(ref);
    // хост страницы — из ссылки уведомления (ревью КТ2 № 8)
    expect(text).not.toContain(new URL((details[0] as { link: string }).link).host);
    expect(text).not.toContain(`/c/${id}`);
    // повторной оплаты нет
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-cnf" })).rejects.toThrow();
    expect(count(r, "pao POST /pao/v1/credentials")).toBe(1);
  });

  it("Р69 п. 5, Р70: страница УПК — link оболочке (https:), человек решает на странице кодом из банка → APPROVED → ссылка продавцу → новая операция; ссылки и кода нет в журнале и текстах", async () => {
    const { r, codes, details, pending } = await above();
    const paying = r.purchase.authorize({ idempotencyKey: "idem-pay-upk" }).catch((e: unknown) => e);
    await pending;
    expect(codes).toEqual(["CONFIRMATION_PENDING"]);
    const id = confirmationId(r);
    const link = (details[0] as { link?: string } | undefined)?.link;
    expect(link).toBeDefined();
    const url = new URL(link!);
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe(`/c/${id}`);
    // код страницы человек получает в банке — вне ПАО, агенту недоступен (РП51 п. 15)
    const code = await r.c.stand!.issuer.upkCode(id);
    expect(code).toMatch(/\S/);
    const page = await r.c.stand!.upk.app.inject({
      method: "POST",
      url: url.pathname,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ decision: "APPROVE", instrument: "CARD", code: code! }).toString(),
    });
    expect(page.statusCode).toBe(200);
    const opRef = await issuerApproves(r);
    const err = await paying;
    // ссылка продавцу — канал, выбранный человеком на странице (карта, до PS-21 — только она; #56 п. 3)
    expect(err).toMatchObject({ opRef, status: "AUTHORIZED" });
    expect(r.purchase.state).toBe("SETTLING");
    expect(r.c.journal.entries.filter((e) => e.kind === "confirmation.status").map((e) => [e.ref, e.detail])).toEqual([
      [id, "PENDING"],
      [id, "APPROVED"],
    ]);
    const text = outward(r, err);
    expect(text).not.toContain(link!);
    // хост страницы — из самой ссылки, а не литералом настройки стенда (ревью КТ2 № 8)
    expect(text).not.toContain(url.host);
    expect(text).not.toContain(code!);
  });

  it("отказ в приложении банка — STOPPED CONFIRMATION_REJECTED, ничего не повторяется", async () => {
    const { r, pending } = await above();
    const paying = r.purchase.authorize({ idempotencyKey: "idem-pay-cnf" }).catch((e: unknown) => e);
    await pending;
    const id = confirmationId(r);
    expect((await r.c.stand!.issuer.confirm(id, { decision: "REJECT" })).statusCode).toBe(200);
    expect(await paying).toMatchObject({ code: "CONFIRMATION_REJECTED" });
    expect(r.c.journal.entries.filter((e) => e.kind === "confirmation.status").map((e) => e.detail)).toEqual(["PENDING", "REJECTED"]);
    expect(count(r, "pao POST /pao/v1/credentials")).toBe(1);
  });

  it("срок вышел — GET после expires_at переводит запрос в EXPIRED (РП51 п. 6): STOPPED CONFIRMATION_EXPIRED", async () => {
    let shift = 0;
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const { r, pending } = await above({
      now: () => new Date(Date.now() + shift),
      confirmationTimer: (fn, ms) => {
        const t = { fn, ms, live: true };
        timers.push(t);
        return () => void (t.live = false);
      },
    });
    const paying = r.purchase.authorize({ idempotencyKey: "idem-pay-cnf" }).catch((e: unknown) => e);
    await pending;
    const id = confirmationId(r);
    // таймер истечения — expires_at (order_hold_sec Платформы) + signature_skew_sec; срабатывает раньше — продление
    const expiry = timers.filter((t) => t.live && t.ms > r.params.confirmation_wait_ms);
    expect(expiry).toHaveLength(1);
    shift = (r.c.stand!.params.order_hold_sec + r.params.signature_skew_sec + 1) * 1000;
    r.c.stand!.setClock(new Date(Date.now() + shift));
    expiry[0]!.live = false;
    expiry[0]!.fn();
    expect(await paying).toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    expect(r.c.journal.entries.filter((e) => e.kind === "confirmation.status").map((e) => [e.ref, e.detail])).toEqual([
      [id, "PENDING"],
      [id, "EXPIRED"],
    ]);
    // решение после срока — 409, покупка уже остановлена
    expect((await r.c.stand!.issuer.confirm(id)).statusCode).toBe(409);
  });
});
