// Итог стадии 5 в шагах профиля contour (Р49 п. 5; ревью КТ1 AG-11 ч. 2 № 4, 5, 14): ожидание по order_ref — до отправки
// пакета; после DECLINED продавца — гонка операции с запросом подтверждения, пришедшим после отметки; сроки — из параметров.
import { describe, expect, it } from "vitest";
import type { OperationOutcome, OperationSkip, OperationWait, SettleOutcome } from "../../src/agent/operations/index.js";
import { ContourPayment } from "../../src/agent/payment-package/index.js";
import { ShopFailure, type PaymentContext, type ShopPaymentReply } from "../../src/agent/ports/index.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { loadParams } from "../../src/shared/config.js";
import { PlatformFailure, type Credential, type Mandate, type Operation, type OperationRecord } from "../../src/shared/domain.js";
import { trackedSignal } from "../support/signal.js";

const PARAMS = loadParams();
const TOTAL = { amount: 250000, currency: "RUB" };
const CART = { id: "m_cart", cart: { merchantId: "shop_1", lines: [], total: TOTAL } } as unknown as Mandate;
const DECLINED: Operation = { opRef: "op_1", orderRef: "ORD-1", channel: "CARD", amount: TOTAL, merchantId: "shop_1", indicator: null, status: "DECLINED", declineReason: "LIMIT_EXCEEDED", fulfilment: null };

/** Шаги с заглушками модулей: `outcome` — итог операции; `arrival` — появление запроса подтверждения (никогда — не задан). */
function steps(o: {
  reply: ShopPaymentReply["status"];
  outcome: (ms: number, signal: AbortSignal) => Promise<OperationOutcome>;
  arrival?: Promise<void> | ((signal: AbortSignal) => Promise<void>);
  lookup?: OperationOutcome;
  /** Р69 п. 4: исход каждой попытки оплаты (UNKNOWN — нет ответа, REFUSED — отказ витрины); нет — `reply` */
  pays?: (ShopPaymentReply["status"] | "UNKNOWN" | "REFUSED")[];
  /** заказ CREATED у витрины (true), иначе (false) или ждёт подтверждения (К1.3); не задан — метода payable нет */
  payable?: boolean | "AWAITING_CONFIRMATION" | (() => Promise<boolean>);
  /** срок реквизита */
  validTo?: string | null;
  /** журнал шагов; не задан — MemoryJournal */
  journal?: MemoryJournal;
  /** статус реквизита у Платформы перед повтором (дополнение 1 к Р69 п. 4); Error — отказ чтения; не задан — ISSUED */
  credential?: string | Error;
  /** срок реквизита в ответе GET; не задан — `validTo` (ревью КТ2 № 1) */
  credentialValidTo?: string | null;
  /** вызывается внутри чтения реквизита (ревью КТ2 № 3) */
  onCredential?: () => void;
  /** часы после чтения заказа у витрины (ревью КТ2 № 1) */
  nowAfterPayable?: Date;
  /** признак payment.confirmation_required в ответе продавца (стенд v0.37.0, К1.1 AG-13 ч. 2б) */
  flag?: boolean;
  /** Р70: исход стадии 4 (APPROVED — со ссылкой и сроком `approve`); не задан — NONE */
  approve?: { ref: string; expiresAt: string } | "UNKNOWN";
  /** Р70: исход каждого POST …/confirmation (OK — 200, UNKNOWN — неизвестный исход, REFUSED — отказ витрины); нет метода — null */
  confirms?: ("OK" | "UNKNOWN" | "REFUSED")[] | null;
}) {
  let clockNow = NOW;
  const log: string[] = [];
  const journal = o.journal ?? new MemoryJournal();
  // запечатанный пакет выдачи и пакеты, ушедшие витрине (ревью КТ сессии 57 № 2)
  const sealed = {};
  const packages: unknown[] = [];
  let issued = 0;
  const wait: OperationWait = {
    outcome: (ms, signal) => (log.push(`outcome ${ms}`), o.outcome(ms, signal)),
    // какие операции пропускает (дополнение 2 к Р69 п. 3–4): CI — отказ CREDENTIAL_INVALID, CR — CONFIRMATION_REQUIRED
    skip: (skip) => void log.push(`skip ${skipped(skip)}`),
    close: () => void log.push("close"),
  };
  let paid = 0;
  let confirmed = 0;
  /** confirmation_ref, ушедшие продавцу (Р70) */
  const refs: string[] = [];
  const payable = o.payable;
  const p = new ContourPayment({
    platform: {
      issuePaymentPackage: async () => (issued++, { credential: { credentialRef: "cr_1", kind: "CARD", indicator: { agentCode: "a", mandateId: "m_cart" }, status: "ISSUED", validTo: o.validTo ?? null }, sealed }) as never,
      credentialStatus: async (ref, mandateId) => {
        log.push(`credential ${ref} ${mandateId}`);
        o.onCredential?.();
        const st = o.credential ?? "ISSUED";
        if (st instanceof Error) throw st;
        const validTo = o.credentialValidTo !== undefined ? o.credentialValidTo : (o.validTo ?? null);
        return { credentialRef: ref, channel: "CARD", indicator: { agentCode: "a", mandateId }, status: st, validTo } as Credential;
      },
    },
    shop: {
      pay: async (req, attempt) => {
        log.push(`pay ${attempt ?? 1}`);
        packages.push(req.package);
        const r = o.pays?.[paid++] ?? o.reply;
        if (r === "UNKNOWN") throw new ShopFailure("SHOP_ORDER_STATE_UNKNOWN");
        if (r === "REFUSED") throw new ShopFailure("SHOP_ORDER_REFUSED");
        return o.flag === true ? { status: r, confirmationRequired: true } : { status: r };
      },
      ...(payable !== undefined && {
        payable: async (_req, signal) => {
          log.push(`payable${signal === undefined ? " без сигнала" : ""}`);
          const r = typeof payable === "function" ? await payable() : payable;
          if (o.nowAfterPayable !== undefined) clockNow = o.nowAfterPayable;
          return r === true ? "CREATED" : r === false ? "NO" : r;
        },
      }),
      ...(o.confirms !== null && {
        confirm: async (req, attempt) => {
          log.push(`confirm ${attempt ?? 1} ${req.orderId} ${req.cartMandateId}`);
          refs.push(req.confirmationRef);
          const r = (o.confirms ?? ["OK"])[confirmed++] ?? "OK";
          if (r === "UNKNOWN") throw new ShopFailure("SHOP_ORDER_STATE_UNKNOWN");
          if (r === "REFUSED") throw new ShopFailure("SHOP_ORDER_REFUSED");
          return { status: "PAID" as const };
        },
      }),
    },
    journal,
    confirmations: {
      wait: async (w) => {
        if (o.approve === undefined) return "NONE";
        if (o.approve === "UNKNOWN") return "UNKNOWN";
        w.onApproved?.(o.approve.ref, o.approve.expiresAt);
        return "APPROVED";
      },
      mark: () => (log.push("mark"), 7),
      arrival: (signal, after) => {
        log.push(`arrival ${after}`);
        if (typeof o.arrival === "function") return o.arrival(signal);
        return o.arrival ?? new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    },
    operations: {
      expect: () => (log.push("expect"), wait),
      lookup: async (orderRef, cart, notice, skip) => {
        log.push(`lookup ${orderRef} ${cart.id}${notice ? " notice" : ""}`);
        if (skip !== undefined) log.push(`lookup-skip ${skipped(skip)}`);
        return o.lookup ?? { kind: "NONE" };
      },
      settle: async () => ({ kind: "PENDING" }),
      watch: (op, after) => void log.push(`watch ${op.opRef} ${after}`),
    },
    params: PARAMS,
    now: () => clockNow,
  });
  return { p, log, journal, sealed, packages, refs, issued: () => issued };
}

/** Что пропускает `skip`: по образцам записей (CI — отказ CREDENTIAL_INVALID, CR — CONFIRMATION_REQUIRED, A — AUTHORIZED) */
function skipped(skip: OperationSkip): string {
  const base: OperationRecord = { opRef: "op_s", orderRef: "ORD-1", channel: "CARD", amountMinor: 250000, merchantId: "shop_1", indicator: null, status: "AUTHORIZED", declineReason: null, fulfilment: null };
  const samples: [string, OperationRecord][] = [
    ["CI", { ...base, status: "DECLINED", declineReason: "CREDENTIAL_INVALID" }],
    ["DL", { ...base, status: "DECLINED", declineReason: "LIMIT_EXCEEDED" }],
    ["CR", { ...base, status: "CONFIRMATION_REQUIRED", declineReason: "CONFIRMATION_REQUIRED" }],
    ["A", base],
  ];
  return samples.filter(([, r]) => skip(r)).map(([k]) => k).join(",") || "-";
}

const NOW = new Date("2026-11-01T12:00:00.000Z");
const LATER = new Date(NOW.getTime() + 600_000).toISOString();

const ctx = (signal = new AbortController().signal): PaymentContext => ({ intent: { id: "m_intent" } as Mandate, cart: CART, shopId: "SHOP-1", merchantId: "shop_1", channel: "CARD", order: { orderId: "ORD-1", total: TOTAL }, signal, sending: () => {} });

describe("ContourPayment: итог стадии 5 (Р49 п. 5)", () => {
  it("PAID — ожидание по order_ref до отправки пакета, срок operation_outcome_max_delay_sec; NONE — один поиск по CART (Р51 п. 5), ничего — OPERATION_RESULT_UNCONFIRMED; ожидание снято", async () => {
    const { p, log } = steps({ reply: "PAID", outcome: async () => ({ kind: "NONE" }) });
    await expect(p.authorize(ctx(), { idempotencyKey: "k" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(log).toEqual(["expect", "mark", "pay 1", `outcome ${PARAMS.operation_outcome_max_delay_sec * 1000}`, "lookup ORD-1 m_cart", "close"]);
  });

  it("Р51 п. 5: итог найден поиском по CART — итог стадии 5 (в том числе REVERSED до ответа эмитента); поиск не сходится — OPERATION_REPLY_MISMATCH; итог по событию — без поиска", async () => {
    const reversed: Operation = { ...DECLINED, status: "REVERSED", declineReason: "REVERSAL" };
    const a = steps({ reply: "PAID", outcome: async () => ({ kind: "NONE" }), lookup: { kind: "OPERATION", operation: reversed } });
    await expect(a.p.authorize({ ...ctx(), notice: () => {} }, { idempotencyKey: "k" })).resolves.toMatchObject({ status: "REVERSED", declineReason: "REVERSAL" });
    // оплата отменена — под наблюдением после итога (Р51 п. 4)
    // уведомление покупки — поиску (под наблюдение ставит модуль, ревью чата К5) и постановка по итогу шага
    expect(a.log).toContain("lookup ORD-1 m_cart notice");
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

  describe("К1.1 AG-13 ч. 2б: AWAITING_CONFIRMATION и признак confirmation_required продавца (РП72 п. 1; Р69 п. 0; инвариант 8)", () => {
    const WAIT = Math.max(PARAMS.operation_outcome_max_delay_sec * 1000, PARAMS.confirmation_wait_ms);

    it.each([
      ["AWAITING_CONFIRMATION с признаком", "AWAITING_CONFIRMATION", true],
      ["AWAITING_CONFIRMATION без поля payment", "AWAITING_CONFIRMATION", false],
      ["признак при ином статусе (PAID)", "PAID", true],
    ] as [string, ShopPaymentReply["status"], boolean][])("%s, запрос Платформы после отметки — CONFIRMATION_REQUIRED (стадия 4), пакет один", async (_, reply, flag) => {
      const { p, log } = steps({ reply, flag, outcome: () => new Promise(() => {}), arrival: Promise.resolve() });
      await expect(p.authorize(ctx(), { idempotencyKey: "k" })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
      expect(log).toEqual(["expect", "mark", "pay 1", `outcome ${WAIT}`, "arrival 7", "close"]);
    });

    it("поломка (1): признак без запроса Платформы — не стадия 4 и не повтор оплаты: ожидание по большему из сроков, поиск по CART «операций нет» — OPERATION_RESULT_UNCONFIRMED, второго POST, GET реквизита и чтения заказа нет", async () => {
      const { p, log, journal } = steps({ reply: "AWAITING_CONFIRMATION", flag: true, outcome: async () => ({ kind: "NONE" }), lookup: { kind: "ABSENT", skipped: 0 }, payable: true, validTo: LATER });
      await expect(p.authorize(ctx(), { idempotencyKey: "k" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
      expect(log).toEqual(["expect", "mark", "pay 1", `outcome ${WAIT}`, "arrival 7", "lookup ORD-1 m_cart", "close"]);
      expect(journal.entries.some((e) => e.kind === "payment.retry")).toBe(false);
    });

    it("поломка (2): AWAITING_CONFIRMATION — не итог операции: итог — операция по событию (одобрение после повтора авторизации эквайрером или отказ)", async () => {
      const AUTHORIZED: Operation = { ...DECLINED, status: "AUTHORIZED", declineReason: null };
      const a = steps({ reply: "AWAITING_CONFIRMATION", flag: true, outcome: async () => ({ kind: "OPERATION", operation: AUTHORIZED }) });
      await expect(a.p.authorize(ctx(), { idempotencyKey: "k" })).resolves.toMatchObject({ opRef: "op_1", status: "AUTHORIZED" });
      const b = steps({ reply: "AWAITING_CONFIRMATION", flag: true, outcome: async () => ({ kind: "OPERATION", operation: DECLINED }) });
      await expect(b.p.authorize(ctx(), { idempotencyKey: "k" })).resolves.toMatchObject({ status: "DECLINED", declineReason: "LIMIT_EXCEEDED" });
    });
  });

  it("AG-12 ч. 3б (ревью КТ1 Р49 № 14 (в)): гонка решена операцией или запросом подтверждения — проигравшая сторона снята прерыванием, на сигнале покупки слушателя не остаётся", async () => {
    // ожидание операции и появление запроса честно слушают сигнал гонки — его прерывание и есть снятие проигравшей стороны
    const honest = <T>(signal: AbortSignal, seen: string[], name: string) =>
      new Promise<T>((_, reject) => signal.addEventListener("abort", () => (seen.push(name), reject(signal.reason)), { once: true }));
    for (const winner of ["OPERATION", "CONFIRMATION"] as const) {
      const seen: string[] = [];
      let arrivalSignal: AbortSignal | undefined;
      const { p } = steps({
        reply: "DECLINED",
        outcome: (_ms, signal) => (winner === "OPERATION" ? Promise.resolve({ kind: "OPERATION", operation: DECLINED }) : honest(signal, seen, "outcome")),
        // при победе операции появление запроса должно быть снято
        arrival: (signal) => ((arrivalSignal = signal), winner === "CONFIRMATION" ? Promise.resolve() : honest(signal, seen, "arrival")),
      });
      const t = trackedSignal();
      const paying = p.authorize(ctx(t.signal), { idempotencyKey: "k" }).then(
        () => "OPERATION",
        (e: { code?: string }) => e.code,
      );
      expect(await paying, winner).toBe(winner === "OPERATION" ? "OPERATION" : "CONFIRMATION_REQUIRED");
      await new Promise<void>((r) => setImmediate(r));
      expect(seen, winner).toEqual([winner === "OPERATION" ? "arrival" : "outcome"]);
      expect(arrivalSignal?.aborted, winner).toBe(true);
      expect(t.live(), winner).toBe(0);
    }
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

describe("повтор оплаты после обрыва ответа — по проверке через Платформу (Р69 п. 4; Р55 п. 5)", () => {
  const AUTHORIZED: Operation = { ...DECLINED, status: "AUTHORIZED", declineReason: null };
  /** первая попытка — итога нет, вторая — операция */
  const thenAuthorized = () => {
    let n = 0;
    return async (): Promise<OperationOutcome> => (n++ === 0 ? { kind: "NONE" } : { kind: "OPERATION", operation: AUTHORIZED });
  };

  it("неизвестный исход + «операций нет» + срок реквизита + заказ CREATED — один повтор тем же пакетом, запись payment.retry без реквизита", async () => {
    const s = steps({ reply: "PAID", pays: ["UNKNOWN", "PAID"], outcome: thenAuthorized(), lookup: { kind: "ABSENT", skipped: 0 }, validTo: LATER, payable: true });
    await expect(s.p.authorize(ctx(), { idempotencyKey: "k" })).resolves.toMatchObject({ status: "AUTHORIZED" });
    // дополнение 2 к Р69 п. 3: после payment.retry ожидание пропускает отказ повтора CREDENTIAL_INVALID (и только его)
    expect(s.log).toEqual(["expect", "mark", "pay 1", `outcome ${PARAMS.operation_outcome_max_delay_sec * 1000}`, "lookup ORD-1 m_cart", "credential cr_1 m_cart", "payable", "skip CI", "mark", "pay 2", `outcome ${PARAMS.operation_outcome_max_delay_sec * 1000}`, "close"]);
    const retries = s.journal.entries.filter((e) => e.kind === "payment.retry");
    expect(retries).toEqual([expect.objectContaining({ kind: "payment.retry", ref: "ORD-1", mandate: "m_cart" })]);
    expect(JSON.stringify(s.journal.entries)).not.toContain("cr_1");
  });

  it("дополнение 2 к Р69 п. 3: на попытке 2 поиск по CART — без отказа CREDENTIAL_INVALID; ничего другого — OPERATION_RESULT_UNCONFIRMED, третьего POST нет; на попытке 1 — без пропуска", async () => {
    const s = steps({ reply: "PAID", pays: ["UNKNOWN", "UNKNOWN"], outcome: async () => ({ kind: "NONE" }), lookup: { kind: "ABSENT", skipped: 0 }, validTo: LATER, payable: true });
    await expect(s.p.authorize(ctx(), { idempotencyKey: "k" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    const lookups = s.log.filter((x) => x.startsWith("lookup"));
    expect(lookups).toEqual(["lookup ORD-1 m_cart", "lookup ORD-1 m_cart", "lookup-skip CI"]);
    expect(s.log.filter((x) => x.startsWith("pay "))).toEqual(["pay 1", "pay 2"]);
  });

  it("К1.3 (Р69 п. 4, правка ревью): обрыв ответа, «операций нет», заказ AWAITING_CONFIRMATION, запрос Платформы после отметки — стадия 4 (CONFIRMATION_REQUIRED), повтора оплаты нет", async () => {
    const s = steps({ reply: "PAID", pays: ["UNKNOWN"], outcome: async () => ({ kind: "NONE" }), lookup: { kind: "ABSENT", skipped: 0 }, validTo: LATER, payable: "AWAITING_CONFIRMATION", arrival: Promise.resolve() });
    await expect(s.p.authorize(ctx(), { idempotencyKey: "k" })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    // запрос — после отметки первой попытки; сигнал покупки — у чтения заказа (КТ сессии 57 № 12)
    expect(s.log).toEqual(["expect", "mark", "pay 1", `outcome ${PARAMS.operation_outcome_max_delay_sec * 1000}`, "lookup ORD-1 m_cart", "credential cr_1 m_cart", "payable", "arrival 7", "close"]);
    expect(s.journal.entries.some((e) => e.kind === "payment.retry")).toBe(false);
  });

  it("К1.3: заказ AWAITING_CONFIRMATION, а запроса Платформы нет (признак продавца без запроса — не стадия 4, К1.1) — OPERATION_RESULT_UNCONFIRMED; остановка покупки в ожидании — её причина", async () => {
    const none = steps({ reply: "PAID", pays: ["UNKNOWN"], outcome: async () => ({ kind: "NONE" }), lookup: { kind: "ABSENT", skipped: 0 }, validTo: LATER, payable: "AWAITING_CONFIRMATION", arrival: () => Promise.reject(new Error("срок ожидания запроса")) });
    await expect(none.p.authorize(ctx(), { idempotencyKey: "k" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(none.log.filter((x) => x.startsWith("pay "))).toEqual(["pay 1"]);
    const ac = new AbortController();
    const reason = new Error("покупка остановлена");
    const stopped = steps({ reply: "PAID", pays: ["UNKNOWN"], outcome: async () => ({ kind: "NONE" }), lookup: { kind: "ABSENT", skipped: 0 }, validTo: LATER, payable: "AWAITING_CONFIRMATION", arrival: (signal) => (ac.abort(reason), Promise.reject(signal.reason)) });
    await expect(stopped.p.authorize(ctx(ac.signal), { idempotencyKey: "k" })).rejects.toBe(reason);
  });

  it("КТ сессии 57 № 5: срок реквизита ближе запаса shop_request_timeout_ms — повтора нет, GET реквизита нет", async () => {
    const soon = new Date(NOW.getTime() + PARAMS.shop_request_timeout_ms).toISOString();
    const s = steps({ reply: "PAID", pays: ["UNKNOWN", "PAID"], outcome: thenAuthorized(), lookup: { kind: "ABSENT", skipped: 0 }, validTo: soon, payable: true });
    await expect(s.p.authorize(ctx(), { idempotencyKey: "k" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(s.log.filter((x) => x.startsWith("pay ") || x.startsWith("credential"))).toEqual(["pay 1"]);
    // срок из GET в пределах запаса — тоже без повтора
    const g = steps({ reply: "PAID", pays: ["UNKNOWN", "PAID"], outcome: thenAuthorized(), lookup: { kind: "ABSENT", skipped: 0 }, validTo: LATER, credentialValidTo: soon, payable: true });
    await expect(g.p.authorize(ctx(), { idempotencyKey: "k" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(g.log.filter((x) => x.startsWith("pay "))).toEqual(["pay 1"]);
  });

  it("дополнение 2 к Р69 п. 3: без повтора CREDENTIAL_INVALID первой попытки — итог, ожидание ничего не пропускает", async () => {
    const declined: Operation = { ...DECLINED, declineReason: "CREDENTIAL_INVALID" };
    const s = steps({ reply: "PAID", outcome: async () => ({ kind: "OPERATION", operation: declined }) });
    await expect(s.p.authorize(ctx(), { idempotencyKey: "k" })).resolves.toMatchObject({ status: "DECLINED", declineReason: "CREDENTIAL_INVALID" });
    expect(s.log.some((x) => x.startsWith("skip"))).toBe(false);
  });

  it("ревью КТ сессии 57 № 2: повтор — тем же запечатанным пакетом, реквизит выдан один раз", async () => {
    const s = steps({ reply: "PAID", pays: ["UNKNOWN", "PAID"], outcome: thenAuthorized(), lookup: { kind: "ABSENT", skipped: 0 }, validTo: LATER, payable: true });
    await expect(s.p.authorize(ctx(), { idempotencyKey: "k" })).resolves.toMatchObject({ status: "AUTHORIZED" });
    expect(s.packages).toHaveLength(2);
    expect(s.packages[0]).toBe(s.sealed);
    expect(s.packages[1]).toBe(s.sealed);
    expect(s.issued()).toBe(1);
  });

  it("ревью КТ сессии 57 № 3: сбой журнала на payment.retry — второго POST нет, ошибка журнала наружу (инвариант 4)", async () => {
    class Failing extends MemoryJournal {
      override record(e: Parameters<MemoryJournal["record"]>[0]): void {
        if (e.kind === "payment.retry") throw new Error("журнал недоступен");
        super.record(e);
      }
    }
    const s = steps({ reply: "PAID", pays: ["UNKNOWN", "PAID"], outcome: thenAuthorized(), lookup: { kind: "ABSENT", skipped: 0 }, validTo: LATER, payable: true, journal: new Failing() });
    await expect(s.p.authorize(ctx(), { idempotencyKey: "k" })).rejects.toThrow("журнал недоступен");
    expect(s.log.filter((x) => x.startsWith("pay "))).toEqual(["pay 1"]);
    // ожидание снято и при сбое журнала
    expect(s.log.at(-1)).toBe("close");
  });

  it("условие не выполнено — повтора нет, OPERATION_RESULT_UNCONFIRMED", async () => {
    const cases: [string, Parameters<typeof steps>[0]][] = [
      ["отказ витрины, а не неизвестный исход", { reply: "PAID", pays: ["REFUSED"], outcome: thenAuthorized(), lookup: { kind: "ABSENT", skipped: 0 }, validTo: LATER, payable: true }],
      ["ответ витрины есть (PAID)", { reply: "PAID", outcome: thenAuthorized(), lookup: { kind: "ABSENT", skipped: 0 }, validTo: LATER, payable: true }],
      ["Платформа не ответила (NONE)", { reply: "PAID", pays: ["UNKNOWN"], outcome: thenAuthorized(), lookup: { kind: "NONE" }, validTo: LATER, payable: true }],
      ["срок реквизита наступил", { reply: "PAID", pays: ["UNKNOWN"], outcome: thenAuthorized(), lookup: { kind: "ABSENT", skipped: 0 }, validTo: NOW.toISOString(), payable: true }],
      ["срока реквизита нет", { reply: "PAID", pays: ["UNKNOWN"], outcome: thenAuthorized(), lookup: { kind: "ABSENT", skipped: 0 }, validTo: null, payable: true }],
      ["заказ не CREATED", { reply: "PAID", pays: ["UNKNOWN"], outcome: thenAuthorized(), lookup: { kind: "ABSENT", skipped: 0 }, validTo: LATER, payable: false }],
      ["у витрины нет чтения заказа", { reply: "PAID", pays: ["UNKNOWN"], outcome: thenAuthorized(), lookup: { kind: "ABSENT", skipped: 0 }, validTo: LATER }],
    ];
    // чтение реквизита — только на пути повтора (дополнение 1 к Р69 п. 6; ревью КТ2 № 4): до него доходит лишь «заказ не CREATED»
    const withGet = new Set(["заказ не CREATED"]);
    for (const [name, o] of cases) {
      const s = steps(o);
      await expect(s.p.authorize(ctx(), { idempotencyKey: "k" }), name).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
      expect(s.log.filter((x) => x.startsWith("pay ")), name).toEqual(["pay 1"]);
      expect(s.journal.entries.some((e) => e.kind === "payment.retry"), name).toBe(false);
      expect(s.log.filter((x) => x.startsWith("credential")), name).toHaveLength(withGet.has(name) ? 1 : 0);
    }
  });

  it("дополнение 1 к Р69 п. 4: реквизит у Платформы не ISSUED или чтение отказано — повтора нет, заказ у витрины не читается", async () => {
    const base = { reply: "PAID" as const, pays: ["UNKNOWN", "PAID"] as ("UNKNOWN" | "PAID")[], lookup: { kind: "ABSENT", skipped: 0 } as const, validTo: LATER, payable: true };
    const cases: [string, string | Error][] = [
      ["USED — первая авторизация дошла до ADP", "USED"],
      ["EXPIRED", "EXPIRED"],
      ["REVOKED (В3)", "REVOKED"],
      ["значение не из перечня (В3)", "SOMETHING_NEW"],
      ["409 CREDENTIAL_INVALID", new PlatformFailure("CREDENTIAL_INVALID", "never", "CREDENTIAL_INVALID", 409, null)],
      ["503 STATE_UNAVAILABLE", new PlatformFailure("STATE_UNAVAILABLE", "after_fix", "STATE_UNAVAILABLE", 503, null)],
      ["ответ не по схеме", new PlatformFailure("BAD_RESPONSE", "never", null, 200, null)],
    ];
    for (const [name, credential] of cases) {
      const s = steps({ ...base, outcome: thenAuthorized(), credential });
      await expect(s.p.authorize(ctx(), { idempotencyKey: "k" }), name).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
      expect(s.log.filter((x) => x.startsWith("pay ")), name).toEqual(["pay 1"]);
      expect(s.log, name).toContain("credential cr_1 m_cart");
      // сначала Платформа (В1 (а)): при отказе к витрине не ходим
      expect(s.log, name).not.toContain("payable");
      expect(s.journal.entries.some((e) => e.kind === "payment.retry"), name).toBe(false);
    }
  });

  it("дополнение 1 к Р69 п. 4: чтение реквизита — после срока реквизита; срок наступил — ни GET, ни повтора; сбой не PlatformFailure — наружу", async () => {
    const a = steps({ reply: "PAID", pays: ["UNKNOWN", "PAID"], outcome: thenAuthorized(), lookup: { kind: "ABSENT", skipped: 0 }, validTo: NOW.toISOString(), payable: true });
    await expect(a.p.authorize(ctx(), { idempotencyKey: "k" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(a.log.some((x) => x.startsWith("credential"))).toBe(false);
    const b = steps({ reply: "PAID", pays: ["UNKNOWN", "PAID"], outcome: thenAuthorized(), lookup: { kind: "ABSENT", skipped: 0 }, validTo: LATER, payable: true, credential: new Error("журнал недоступен") });
    await expect(b.p.authorize(ctx(), { idempotencyKey: "k" })).rejects.toThrow("журнал недоступен");
    expect(b.log.filter((x) => x.startsWith("pay "))).toEqual(["pay 1"]);
  });

  it("ревью КТ2 № 1: срок — меньший из выданного и из ответа GET; в GET срока нет или он прошёл — повтора нет; срок прошёл, пока читали заказ, — повтора нет", async () => {
    const base = { reply: "PAID" as const, pays: ["UNKNOWN", "PAID"] as ("UNKNOWN" | "PAID")[], lookup: { kind: "ABSENT", skipped: 0 } as const, validTo: LATER, payable: true };
    const cases: [string, Partial<Parameters<typeof steps>[0]>][] = [
      ["в GET срока нет", { credentialValidTo: null }],
      ["в GET срок прошёл", { credentialValidTo: NOW.toISOString() }],
      ["срок прошёл, пока читали заказ", { nowAfterPayable: new Date(LATER) }],
    ];
    for (const [name, over] of cases) {
      const s = steps({ ...base, outcome: thenAuthorized(), ...over });
      await expect(s.p.authorize(ctx(), { idempotencyKey: "k" }), name).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
      expect(s.log.filter((x) => x.startsWith("pay ")), name).toEqual(["pay 1"]);
      expect(s.journal.entries.some((e) => e.kind === "payment.retry"), name).toBe(false);
    }
    // в GET срок позже выданного — действует выданный (пакет несёт прежнюю криптограмму): срок выданного прошёл к чтению заказа — повтора нет
    const later = new Date(Date.parse(LATER) + 600_000).toISOString();
    const s = steps({ ...base, outcome: thenAuthorized(), credentialValidTo: later, nowAfterPayable: new Date(LATER) });
    await expect(s.p.authorize(ctx(), { idempotencyKey: "k" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(s.log.filter((x) => x.startsWith("pay "))).toEqual(["pay 1"]);
  });

  it("ревью КТ2 № 3: покупку остановили, пока читали реквизит, — заказ у витрины не читается, повтора нет", async () => {
    const ac = new AbortController();
    const s = steps({ reply: "PAID", pays: ["UNKNOWN", "PAID"], outcome: thenAuthorized(), lookup: { kind: "ABSENT", skipped: 0 }, validTo: LATER, payable: true, onCredential: () => ac.abort(new Error("остановлена")) });
    await expect(s.p.authorize(ctx(ac.signal), { idempotencyKey: "k" })).rejects.toBeDefined();
    expect(s.log).toContain("credential cr_1 m_cart");
    expect(s.log).not.toContain("payable");
    expect(s.log.filter((x) => x.startsWith("pay "))).toEqual(["pay 1"]);
    expect(s.journal.entries.some((e) => e.kind === "payment.retry")).toBe(false);
  });

  it("второй неизвестный исход — без третьего POST; покупку остановили, пока читали заказ, — повтора нет", async () => {
    const a = steps({ reply: "PAID", pays: ["UNKNOWN", "UNKNOWN", "PAID"], outcome: async () => ({ kind: "NONE" }), lookup: { kind: "ABSENT", skipped: 0 }, validTo: LATER, payable: true });
    await expect(a.p.authorize(ctx(), { idempotencyKey: "k" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(a.log.filter((x) => x.startsWith("pay "))).toEqual(["pay 1", "pay 2"]);
    // GET реквизита — один на покупку: на второй попытке пути повтора нет (ревью КТ2 № 2)
    expect(a.log.filter((x) => x.startsWith("credential"))).toHaveLength(1);
    const ac = new AbortController();
    const b = steps({ reply: "PAID", pays: ["UNKNOWN", "PAID"], outcome: thenAuthorized(), lookup: { kind: "ABSENT", skipped: 0 }, validTo: LATER, payable: async () => (ac.abort(new Error("остановлена")), true) });
    await expect(b.p.authorize(ctx(ac.signal), { idempotencyKey: "k" })).rejects.toThrow("остановлена");
    expect(b.log.filter((x) => x.startsWith("pay "))).toEqual(["pay 1"]);
    expect(b.journal.entries.some((e) => e.kind === "payment.retry")).toBe(false);
  });
});

describe("Р70: ссылка подтверждения продавцу после одобрения человеком (Р69 п. 0; РП72 п. 2–5; инварианты 1, 8, 9)", () => {
  const AUTHORIZED: Operation = { ...DECLINED, opRef: "op_2", status: "AUTHORIZED", declineReason: null };
  const REF = "cr_secret_ref_1";
  const approve = { ref: REF, expiresAt: LATER };
  const stage4 = async (s: ReturnType<typeof steps>) => s.p.confirm(ctx(), () => {}, new AbortController().signal);
  const DELAY = PARAMS.operation_outcome_max_delay_sec * 1000;

  it("APPROVED — одна ссылка продавцу с confirmation_ref из GET, ожидание по order_ref до отправки, итог — новая операция; реквизита и пакета нет", async () => {
    const s = steps({ reply: "PAID", outcome: async () => ({ kind: "OPERATION", operation: AUTHORIZED }), approve });
    expect(await stage4(s)).toBe("APPROVED");
    await expect(s.p.resume(ctx())).resolves.toMatchObject({ opRef: "op_2", status: "AUTHORIZED" });
    // дополнение 2 к Р69 п. 4: операции CONFIRMATION_REQUIRED — не кандидаты итога (и только они)
    expect(s.log).toEqual(["expect", "skip CR", "confirm 1 ORD-1 m_cart", `outcome ${DELAY}`, "close"]);
    expect(s.refs).toEqual([REF]);
    expect(s.issued()).toBe(0);
    expect(s.packages).toEqual([]);
    // ссылка берётся один раз: второй resume — без POST
    await expect(s.p.resume(ctx())).rejects.toMatchObject({ code: "CONFIRMATION_NOT_DELIVERED" });
    expect(s.refs).toEqual([REF]);
  });

  it("поломка: второй POST …/confirmation после ответа 200 — его нет (инвариант 9)", async () => {
    const s = steps({ reply: "PAID", outcome: async () => ({ kind: "NONE" }), lookup: { kind: "ABSENT", skipped: 0 }, approve, confirms: ["OK", "OK"] });
    await stage4(s);
    await expect(s.p.resume(ctx())).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(s.log.filter((x) => x.startsWith("confirm"))).toEqual(["confirm 1 ORD-1 m_cart"]);
  });

  it("В1 (а): неизвестный исход — один повтор того же запроса (та же ссылка), второй неизвестный — без третьего; итог — по событию", async () => {
    const a = steps({ reply: "PAID", outcome: async () => ({ kind: "OPERATION", operation: AUTHORIZED }), approve, confirms: ["UNKNOWN", "OK"] });
    await stage4(a);
    await expect(a.p.resume(ctx())).resolves.toMatchObject({ opRef: "op_2" });
    expect(a.log.filter((x) => x.startsWith("confirm"))).toEqual(["confirm 1 ORD-1 m_cart", "confirm 2 ORD-1 m_cart"]);
    expect(a.refs).toEqual([REF, REF]);
    const b = steps({ reply: "PAID", outcome: async () => ({ kind: "NONE" }), lookup: { kind: "ABSENT", skipped: 0 }, approve, confirms: ["UNKNOWN", "UNKNOWN", "OK"] });
    await stage4(b);
    await expect(b.p.resume(ctx())).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(b.log.filter((x) => x.startsWith("confirm"))).toHaveLength(2);
  });

  it("поломка В1 (а): отказ витрины (409 после потерянного ответа — авторизация со ссылкой идёт) — без повтора, но итог по событию и поиску по CART, а не остановка", async () => {
    const a = steps({ reply: "PAID", outcome: async () => ({ kind: "OPERATION", operation: AUTHORIZED }), approve, confirms: ["REFUSED"] });
    await stage4(a);
    await expect(a.p.resume(ctx())).resolves.toMatchObject({ opRef: "op_2", status: "AUTHORIZED" });
    expect(a.log).toEqual(["expect", "skip CR", "confirm 1 ORD-1 m_cart", `outcome ${DELAY}`, "close"]);
    // событие не пришло, поиск по CART нашёл операцию — итог по ней
    const b = steps({ reply: "PAID", outcome: async () => ({ kind: "NONE" }), lookup: { kind: "OPERATION", operation: AUTHORIZED }, approve, confirms: ["REFUSED"] });
    await stage4(b);
    await expect(b.p.resume(ctx())).resolves.toMatchObject({ opRef: "op_2" });
    expect(b.log).toContain("lookup ORD-1 m_cart");
  });

  it("отказ витрины и операций нет — CONFIRMATION_NOT_DELIVERED; неизвестный исход и операций нет — OPERATION_RESULT_UNCONFIRMED; неоднозначно — OPERATION_RESULT_UNCONFIRMED", async () => {
    const a = steps({ reply: "PAID", outcome: async () => ({ kind: "NONE" }), lookup: { kind: "ABSENT", skipped: 0 }, approve, confirms: ["REFUSED"] });
    await stage4(a);
    await expect(a.p.resume(ctx())).rejects.toMatchObject({ code: "CONFIRMATION_NOT_DELIVERED" });
    const b = steps({ reply: "PAID", outcome: async () => ({ kind: "NONE" }), lookup: { kind: "ABSENT", skipped: 0 }, approve, confirms: ["UNKNOWN", "UNKNOWN"] });
    await stage4(b);
    await expect(b.p.resume(ctx())).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    const c = steps({ reply: "PAID", outcome: async () => ({ kind: "NONE" }), lookup: { kind: "NONE" }, approve, confirms: ["REFUSED"] });
    await stage4(c);
    await expect(c.p.resume(ctx())).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
  });

  it("дополнение 2 к Р69 п. 4 (правило по стенду v0.37.0): поиск по CART без CONFIRMATION_REQUIRED; других нет и их больше одной — DECLINED_CONFIRMATION_REQUIRED; ровно одна — OPERATION_RESULT_UNCONFIRMED (и при отказе витрины)", async () => {
    for (const confirms of [["OK"], ["REFUSED"]] as const) {
      const two = steps({ reply: "PAID", outcome: async () => ({ kind: "NONE" }), lookup: { kind: "ABSENT", skipped: 2 }, approve, confirms: [...confirms] });
      await stage4(two);
      await expect(two.p.resume(ctx())).rejects.toMatchObject({ code: "DECLINED_CONFIRMATION_REQUIRED" });
      expect(two.log).toContain("lookup-skip CR");
      const one = steps({ reply: "PAID", outcome: async () => ({ kind: "NONE" }), lookup: { kind: "ABSENT", skipped: 1 }, approve, confirms: [...confirms] });
      await stage4(one);
      await expect(one.p.resume(ctx())).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    }
    // одна другая операция — итог по ней (повторного требования нет)
    const ok = steps({ reply: "PAID", outcome: async () => ({ kind: "NONE" }), lookup: { kind: "OPERATION", operation: AUTHORIZED }, approve });
    await stage4(ok);
    await expect(ok.p.resume(ctx())).resolves.toMatchObject({ opRef: "op_2", status: "AUTHORIZED" });
  });

  it("поломка В3 (а): срок запроса Платформы прошёл — POST нет, CONFIRMATION_EXPIRED; ровно «сейчас» — тоже прошёл", async () => {
    for (const expiresAt of [new Date(NOW.getTime() - 1).toISOString(), NOW.toISOString()]) {
      const s = steps({ reply: "PAID", outcome: async () => ({ kind: "OPERATION", operation: AUTHORIZED }), approve: { ref: REF, expiresAt } });
      await stage4(s);
      await expect(s.p.resume(ctx())).rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });
      expect(s.log).toEqual([]);
      expect(s.refs).toEqual([]);
    }
  });

  it("без одобрения (исход не APPROVED) или без метода витрины — POST нет, CONFIRMATION_NOT_DELIVERED; покупку остановили — POST нет", async () => {
    const a = steps({ reply: "PAID", outcome: async () => ({ kind: "NONE" }), approve: "UNKNOWN" });
    expect(await stage4(a)).toBe("UNKNOWN");
    await expect(a.p.resume(ctx())).rejects.toMatchObject({ code: "CONFIRMATION_NOT_DELIVERED" });
    const b = steps({ reply: "PAID", outcome: async () => ({ kind: "NONE" }), approve, confirms: null });
    await stage4(b);
    await expect(b.p.resume(ctx())).rejects.toMatchObject({ code: "CONFIRMATION_NOT_DELIVERED" });
    const ac = new AbortController();
    const c = steps({ reply: "PAID", outcome: async () => ({ kind: "NONE" }), approve });
    await stage4(c);
    ac.abort(new Error("остановлена"));
    await expect(c.p.resume(ctx(ac.signal))).rejects.toThrow("остановлена");
    expect(c.refs).toEqual([]);
  });

  it("поломка: confirmation_ref не в журнале шагов, не в исходе и не в ошибках", async () => {
    const journal = new MemoryJournal();
    const a = steps({ reply: "PAID", outcome: async () => ({ kind: "OPERATION", operation: AUTHORIZED }), approve, journal });
    await stage4(a);
    const op = await a.p.resume(ctx());
    const b = steps({ reply: "PAID", outcome: async () => ({ kind: "NONE" }), lookup: { kind: "ABSENT", skipped: 0 }, approve, confirms: ["REFUSED"], journal });
    await stage4(b);
    const err = await b.p.resume(ctx()).catch((e: unknown) => e);
    const text = [JSON.stringify(journal.entries), JSON.stringify(op), String(err), (err as Error).stack ?? "", JSON.stringify(err)].join("\n");
    expect(text).not.toContain(REF);
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
        settle: async (_op, _signal, deadline, notice) => (deadlines.push(deadline), notices.push(notice), outcome),
        watch: (op, after) => void watched.push(`${op.opRef} ${op.status} ${after}`),
      },
      params: PARAMS,
      now: () => now,
    });
    const notices: unknown[] = [];
    return { p, deadlines, now, watched, notices };
  }

  it("Р51 п. 4, ревью чата К5: уведомление покупки — модулю операций в settle (под наблюдение он ставит сам, в момент итога); шаги сами не ставят", async () => {
    const notice = () => {};
    const s = settling({ kind: "OPERATION", operation: { ...AUTHORIZED, status: "SETTLED" } });
    await s.p.settle(AUTHORIZED, undefined, undefined, notice);
    expect(s.notices).toEqual([notice]);
    expect(s.watched).toEqual([]);
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
