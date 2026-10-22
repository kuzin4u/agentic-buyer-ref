// Стадия 4 на стенде Платформы v0.17.0 и эмуляторе продавцов (Р47; AG-13 ч. 1, К4): итог выше порога ADP — продавец
// отвечает DECLINED, ADP создала запрос подтверждения и событие confirmation.required; агент читает GET, уведомляет
// человека (без link) и ждёт решения в приложении банка (stand.issuer.confirm). Канала confirmation_ref к продавцу на
// стенде нет — одобрение: STOPPED CONFIRMATION_NOT_DELIVERED, повтора нет; отказ — CONFIRMATION_REJECTED; срок —
// CONFIRMATION_EXPIRED по GET после expires_at. П12 — до решения человека (в счёт не идёт до AG-13 ч. 2).
// ПОДМЕНА ДО PS-11 (решение владельца, вариант (а)): ОПКЦ стенда — заглушка, продавец ADP не достигает; заглушка отвечает
// отказом, копию сообщения эквайрера тестовая поддержка передаёт в настоящий ADP стенда (contour.ts, `adpUntilPs11`):
// запрос, событие, GET и решение банка — настоящие.
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
  const r = await standPurchase({
    ...o,
    contourPayment: true,
    adpUntilPs11: true,
    notify: (code) => {
      codes.push(code);
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
  return { r, codes, pending, intent, cart, order };
}

/** id запроса подтверждения — из записи журнала (GET дал PENDING). */
const confirmationId = (r: Awaited<ReturnType<typeof above>>["r"]) => {
  const e = r.c.journal.entries.find((x) => x.kind === "confirmation.status" && x.detail === "PENDING");
  expect(e?.ref).toMatch(/^cnf_/);
  return e!.ref!;
};

const stagesOf = (r: Awaited<ReturnType<typeof above>>["r"]) => r.c.journal.entries.filter((e) => e.kind === "purchase.stage").map((e) => e.detail);
const count = (r: Awaited<ReturnType<typeof above>>["r"], route: string) => r.c.calls().filter((x) => `${x.target} ${x.route.split("?")[0]}` === route).length;

/** Всё, что агент отдаёт наружу: журнал, снимки покупки, ошибка, тексты реестра по коду остановки. */
function outward(r: Awaited<ReturnType<typeof above>>["r"], err: unknown): string {
  const e = err as Error;
  const code = r.purchase.reason;
  return [
    JSON.stringify(r.c.journal.entries),
    JSON.stringify([r.purchase.state, code, r.purchase.cartMandate, r.purchase.order, r.purchase.operation]),
    String(e),
    e.stack ?? "",
    inspect(e, { depth: 10, showHidden: true }),
    JSON.stringify(code === null ? null : DIAG[code]),
    JSON.stringify(DIAG.CONFIRMATION_PENDING),
  ].join("\n");
}

describe("стадия 4 на стенде v0.17.0: подтверждение человеком по confirmation.* (Р47)", { timeout: STAND_TIMEOUT_MS }, () => {
  it("одобрение в приложении банка — STOPPED CONFIRMATION_NOT_DELIVERED: ссылка продавцу не уходит, повтора нет, link и confirmation_ref нигде", async () => {
    const { r, codes, pending, order } = await above();
    const paying = r.purchase.authorize({ idempotencyKey: "idem-pay-cnf" }).catch((e: unknown) => e);
    await pending;
    expect(codes).toEqual(["CONFIRMATION_PENDING"]);
    // подмена до PS-11: настоящий ADP стенда по копии сообщения эквайрера потребовал подтверждения (РП50 п. 1)
    expect(await r.c.adpDecisions!()).toEqual([expect.objectContaining({ decision: "CONFIRMATION_REQUIRED" })]);
    const id = confirmationId(r);
    // продавец ответил DECLINED (ADP: CONFIRMATION_REQUIRED) — слова продавца только в журнале
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.call" && e.method?.endsWith("/payment")).map((e) => e.detail)).toEqual(["DECLINED"]);
    const decided = await r.c.stand!.issuer.confirm(id);
    expect(decided.statusCode).toBe(200);
    const ref = (decided.body as { confirmation_ref: string }).confirmation_ref;
    expect(ref).toMatch(/^cr_/);
    const err = await paying;
    expect(err).toMatchObject({ code: "CONFIRMATION_NOT_DELIVERED" });
    expect(r.purchase.reason).toBe("CONFIRMATION_NOT_DELIVERED");
    expect(stagesOf(r).slice(-3)).toEqual(["AUTHORIZING", "CONFIRMING", "STOPPED"]);
    expect(r.c.journal.entries.filter((e) => e.kind === "confirmation.status").map((e) => [e.ref, e.detail])).toEqual([
      [id, "PENDING"],
      [id, "APPROVED"],
    ]);
    // один реквизит и одна оплата — повтора авторизации нет (Р47 п. 6); GET запроса — по событиям
    expect(count(r, "pao POST /pao/v1/credentials")).toBe(1);
    expect(count(r, `merchants POST /v1/shops/${NORMAL.id}/orders/${order.orderId}/payment`)).toBe(1);
    expect(count(r, `pao GET /pao/v1/confirmations/${id}`)).toBe(2);
    expect(count(r, "pao POST /pao/v1/confirmations")).toBe(0);
    const text = outward(r, err);
    expect(text).not.toContain(ref);
    expect(text).not.toContain("upk.stand");
    expect(text).not.toContain(`/c/${id}`);
    // повторной оплаты нет
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-cnf" })).rejects.toThrow();
    expect(count(r, "pao POST /pao/v1/credentials")).toBe(1);
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
