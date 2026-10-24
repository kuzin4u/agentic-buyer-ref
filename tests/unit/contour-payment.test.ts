// Итог стадии 5 в шагах профиля contour (Р49 п. 5; ревью КТ1 AG-11 ч. 2 № 4, 5, 14): ожидание по order_ref — до отправки
// пакета; после DECLINED продавца — гонка операции с запросом подтверждения, пришедшим после отметки; сроки — из параметров.
import { describe, expect, it } from "vitest";
import type { OperationOutcome, OperationWait, SettleOutcome } from "../../src/agent/operations/index.js";
import { ContourPayment } from "../../src/agent/payment-package/index.js";
import type { PaymentContext, ShopPaymentReply } from "../../src/agent/ports/index.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { loadParams } from "../../src/shared/config.js";
import type { Mandate, Operation } from "../../src/shared/domain.js";

const PARAMS = loadParams();
const TOTAL = { amount: 250000, currency: "RUB" };
const CART = { id: "m_cart", cart: { merchantId: "shop_1", lines: [], total: TOTAL } } as unknown as Mandate;
const DECLINED: Operation = { opRef: "op_1", orderRef: "ORD-1", channel: "CARD", amount: TOTAL, merchantId: "shop_1", indicator: null, status: "DECLINED", declineReason: "LIMIT_EXCEEDED", fulfilment: null };

/** Шаги с заглушками модулей: `outcome` — итог операции; `arrival` — появление запроса подтверждения (никогда — не задан). */
function steps(o: { reply: ShopPaymentReply["status"]; outcome: (ms: number, signal: AbortSignal) => Promise<OperationOutcome>; arrival?: Promise<void>; lookup?: OperationOutcome }) {
  const log: string[] = [];
  const wait: OperationWait = {
    outcome: (ms, signal) => (log.push(`outcome ${ms}`), o.outcome(ms, signal)),
    close: () => void log.push("close"),
  };
  const p = new ContourPayment({
    platform: { issuePaymentPackage: async () => ({ credential: { credentialRef: "cr_1", kind: "CARD", indicator: { agentCode: "a", mandateId: "m_cart" }, status: "ISSUED" }, sealed: {} }) as never },
    shop: { pay: async () => (log.push("pay"), { status: o.reply }) },
    journal: new MemoryJournal(),
    confirmations: {
      wait: async () => "NONE",
      mark: () => (log.push("mark"), 7),
      arrival: (signal, after) => {
        log.push(`arrival ${after}`);
        return o.arrival ?? new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    },
    operations: {
      expect: () => (log.push("expect"), wait),
      lookup: async (orderRef, cart) => (log.push(`lookup ${orderRef} ${cart.id}`), o.lookup ?? { kind: "NONE" }),
      settle: async () => ({ kind: "PENDING" }),
      watch: (op, after) => void log.push(`watch ${op.opRef} ${after}`),
    },
    params: PARAMS,
  });
  return { p, log };
}

const ctx = (signal = new AbortController().signal): PaymentContext => ({ intent: { id: "m_intent" } as Mandate, cart: CART, shopId: "SHOP-1", merchantId: "shop_1", order: { orderId: "ORD-1", total: TOTAL }, signal, sending: () => {} });

describe("ContourPayment: итог стадии 5 (Р49 п. 5)", () => {
  it("PAID — ожидание по order_ref до отправки пакета, срок operation_outcome_max_delay_sec; NONE — один поиск по CART (Р51 п. 5), ничего — OPERATION_RESULT_UNCONFIRMED; ожидание снято", async () => {
    const { p, log } = steps({ reply: "PAID", outcome: async () => ({ kind: "NONE" }) });
    await expect(p.authorize(ctx(), { idempotencyKey: "k" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(log).toEqual(["expect", "mark", "pay", `outcome ${PARAMS.operation_outcome_max_delay_sec * 1000}`, "lookup ORD-1 m_cart", "close"]);
  });

  it("Р51 п. 5: итог найден поиском по CART — итог стадии 5 (в том числе REVERSED до ответа эмитента); поиск не сходится — OPERATION_REPLY_MISMATCH; итог по событию — без поиска", async () => {
    const reversed: Operation = { ...DECLINED, status: "REVERSED", declineReason: "REVERSAL" };
    const a = steps({ reply: "PAID", outcome: async () => ({ kind: "NONE" }), lookup: { kind: "OPERATION", operation: reversed } });
    await expect(a.p.authorize({ ...ctx(), notice: () => {} }, { idempotencyKey: "k" })).resolves.toMatchObject({ status: "REVERSED", declineReason: "REVERSAL" });
    // оплата отменена — под наблюдением после итога (Р51 п. 4)
    expect(a.log).toContain("watch op_1 REVERSED");
    const b = steps({ reply: "PAID", outcome: async () => ({ kind: "NONE" }), lookup: { kind: "MISMATCH" } });
    await expect(b.p.authorize(ctx(), { idempotencyKey: "k" })).rejects.toMatchObject({ code: "OPERATION_REPLY_MISMATCH" });
    const c = steps({ reply: "PAID", outcome: async () => ({ kind: "OPERATION", operation: DECLINED }) });
    await c.p.authorize(ctx(), { idempotencyKey: "k" });
    expect(c.log.some((x) => x.startsWith("lookup"))).toBe(false);
  });

  it("ревью КТ1 Р51 № 3, № 9: привязка неоднозначна — OPERATION_RESULT_UNCONFIRMED без поиска; покупку остановили до поиска — поиска нет", async () => {
    const reversed: Operation = { ...DECLINED, status: "REVERSED", declineReason: "REVERSAL" };
    const a = steps({ reply: "PAID", outcome: async () => ({ kind: "AMBIGUOUS" }), lookup: { kind: "OPERATION", operation: reversed } });
    await expect(a.p.authorize(ctx(), { idempotencyKey: "k" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(a.log.some((x) => x.startsWith("lookup"))).toBe(false);
    // срок вышел (NONE) ровно тогда, когда покупку остановили: сигнал уже прерван — поиска нет
    const ac = new AbortController();
    const b = steps({ reply: "PAID", outcome: async () => (ac.abort(new Error("остановлена")), { kind: "NONE" }), lookup: { kind: "OPERATION", operation: reversed } });
    await expect(b.p.authorize(ctx(ac.signal), { idempotencyKey: "k" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(b.log.some((x) => x.startsWith("lookup"))).toBe(false);
  });

  it("(а) DECLINED продавца, operation.declined раньше запроса подтверждения — операция (код §7б у конвейера), гонка снята", async () => {
    const { p, log } = steps({ reply: "DECLINED", outcome: async () => ({ kind: "OPERATION", operation: DECLINED }) });
    await expect(p.authorize(ctx(), { idempotencyKey: "k" })).resolves.toMatchObject({ status: "DECLINED", declineReason: "LIMIT_EXCEEDED" });
    expect(log).toContain("arrival 7");
  });

  it("(б) DECLINED продавца, ни операции, ни запроса — OPERATION_RESULT_UNCONFIRMED по большему из сроков", async () => {
    const { p, log } = steps({ reply: "DECLINED", outcome: async () => ({ kind: "NONE" }) });
    await expect(p.authorize(ctx(), { idempotencyKey: "k" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(log).toContain(`outcome ${Math.max(PARAMS.operation_outcome_max_delay_sec * 1000, PARAMS.confirmation_wait_ms)}`);
  });

  it("DECLINED продавца, запрос подтверждения после отметки раньше операции — CONFIRMATION_REQUIRED; расхождение — OPERATION_REPLY_MISMATCH", async () => {
    const a = steps({ reply: "DECLINED", outcome: () => new Promise(() => {}), arrival: Promise.resolve() });
    await expect(a.p.authorize(ctx(), { idempotencyKey: "k" })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    const b = steps({ reply: "PAID", outcome: async () => ({ kind: "MISMATCH" }) });
    await expect(b.p.authorize(ctx(), { idempotencyKey: "k" })).rejects.toMatchObject({ code: "OPERATION_REPLY_MISMATCH" });
  });

  it("ревью КТ1 № 4: покупку остановили, пока продавец отвечал DECLINED, — гонка не ждёт срока, отказ с причиной остановки", async () => {
    const ac = new AbortController();
    const reason = new Error("покупка остановлена");
    const { p } = steps({
      reply: "DECLINED",
      // ожидание операции честно слушает свой сигнал
      outcome: (_ms, signal) => new Promise((_, reject) => (signal.aborted ? reject(signal.reason) : signal.addEventListener("abort", () => reject(signal.reason), { once: true }))),
    });
    const c = ctx(ac.signal);
    const paying = p.authorize({ ...c, sending: () => ac.abort(reason) }, { idempotencyKey: "k" });
    await expect(paying).rejects.toBe(reason);
  });
});

describe("стадия 6 в шагах contour (Р51 п. 2 (б)): граница reservation_ttl_sec", () => {
  const AUTHORIZED: Operation = { ...DECLINED, status: "AUTHORIZED", declineReason: null };
  function settling(outcome: SettleOutcome, now = new Date("2026-10-24T10:00:00.000Z")) {
    const deadlines: (number | undefined)[] = [];
    const watched: string[] = [];
    const p = new ContourPayment({
      platform: {} as never,
      shop: {} as never,
      journal: new MemoryJournal(),
      confirmations: {} as never,
      operations: {
        expect: () => ({}) as never,
        lookup: async () => ({ kind: "NONE" }),
        settle: async (_op, _signal, deadline) => (deadlines.push(deadline), outcome),
        watch: (op, after) => void watched.push(`${op.opRef} ${op.status} ${after}`),
      },
      params: PARAMS,
      now: () => now,
    });
    return { p, deadlines, now, watched };
  }

  it("Р51 п. 4: итог расчёта SETTLED / REFUNDED / REVERSED и граница (EXPIRED) — операция под наблюдением после итога; PENDING, MISMATCH, UNREAD и без уведомления покупки — нет", async () => {
    const notice = () => {};
    for (const status of ["SETTLED", "REFUNDED", "REVERSED"] as const) {
      const s = settling({ kind: "OPERATION", operation: { ...AUTHORIZED, status } });
      await s.p.settle(AUTHORIZED, undefined, undefined, notice);
      expect(s.watched).toEqual([`op_1 ${status} ${status}`]);
    }
    const e = settling({ kind: "EXPIRED" });
    await expect(e.p.settle(AUTHORIZED, undefined, undefined, notice)).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(e.watched).toEqual(["op_1 AUTHORIZED UNSETTLED"]);
    for (const outcome of [{ kind: "PENDING" }, { kind: "MISMATCH" }, { kind: "UNREAD" }] as const) {
      const s = settling(outcome);
      await s.p.settle(AUTHORIZED, undefined, undefined, notice).catch(() => undefined);
      expect(s.watched, outcome.kind).toEqual([]);
    }
    const quiet = settling({ kind: "OPERATION", operation: { ...AUTHORIZED, status: "SETTLED" } });
    await quiet.p.settle(AUTHORIZED);
    expect(quiet.watched).toEqual([]);
  });

  it("граница — от момента AUTHORIZED, переданного конвейером; без него — от начала ожидания", async () => {
    const at = new Date("2026-10-20T08:00:00.000Z");
    const s = settling({ kind: "OPERATION", operation: { ...AUTHORIZED, status: "SETTLED" } });
    await s.p.settle(AUTHORIZED, undefined, at);
    await s.p.settle(AUTHORIZED);
    expect(s.deadlines).toEqual([at.getTime() + PARAMS.reservation_ttl_sec * 1000, s.now.getTime() + PARAMS.reservation_ttl_sec * 1000]);
  });

  it("граница прошла без итога (EXPIRED) — OPERATION_RESULT_UNCONFIRMED", async () => {
    await expect(settling({ kind: "EXPIRED" }).p.settle(AUTHORIZED)).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
  });
});
