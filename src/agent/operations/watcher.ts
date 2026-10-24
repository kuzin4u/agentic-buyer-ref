// Итог операции по событиям operation.* (Р49 п. 3–6; передачи #57, #59). Событие — только сигнал: данные — только
// {op_ref}, итог — по GET /pao/v1/operations/{op_ref}. op_ref агент узнаёт только из события (продавец его не отдаёт),
// поэтому операция относится к покупке по order_ref — ссылке заказа, которую агент сам передал в реквизите и пакете;
// покупка встаёт в ожидание до отправки пакета. Сверка с заказом и CART — bind.ts. Слова продавца сюда не попадают
// (инвариант 8).
import { poll } from "../events/poll.js";
import { SeenWindow } from "../events/seen.js";
import type { FeedItem } from "../ports/events.js";
import { PlatformFailure, type FailureCode, type Mandate, type Operation, type OperationRecord, type OperationStatus, type ScopeCheck } from "../../shared/domain.js";
import type { DiagCode } from "../../shared/diag-codes.js";
import { TIMER_MAX_MS } from "../../shared/config.js";
import { SAFE_ID } from "../../shared/ids.js";
import { bindOperation, settledOperation, type MismatchField } from "./bind.js";

/** Часть порта платформы, которую видит модуль. */
export interface OperationsPort {
  readOperation(opRef: string): Promise<OperationRecord>;
  /** операции по мандату с итогом (Р51 п. 5) */
  readOperations(mandateId: string): Promise<OperationRecord[]>;
}

/** Исход поиска операции по CART (запись operation.lookup, Р51 п. 5) — закрытым перечнем; отказ — код отказа. */
export type LookupDetail = "BOUND" | "NONE" | "AMBIGUOUS" | "MISMATCH" | FailureCode;

/** scope_check в журнале — закрытым перечнем: значение вне перечня — OTHER, само значение не пишется (инвариант 5). */
export type ScopeCheckDetail = Exclude<ScopeCheck, { other: string | null }> | "OTHER";

/** Часть журнала агента, которую видит модуль (Journal подходит): ref — op_ref по маске. */
export interface OperationsJournal {
  record(
    entry:
      | { at: string; kind: "operation.status"; ref: string; detail: OperationStatus }
      | { at: string; kind: "operation.foreign" | "operation.unclaimed"; ref: string }
      /** reason — OPERATION_UNREAD (диагностика оператора, Р49 дополнение 1 п. 1), detail — код отказа GET */
      | { at: string; kind: "operation.unread"; ref: string; reason: "OPERATION_UNREAD"; detail: DiagCode }
      | { at: string; kind: "operation.mismatch"; ref: string; detail: MismatchField; reason: "OPERATION_REPLY_MISMATCH"; mandate?: string }
      | { at: string; kind: "operation.settled"; ref: string; detail: ScopeCheckDetail }
      | { at: string; kind: "operation.reversed"; ref: string; detail: ReversalDetail }
      /** поиск операции по CART после итога без события (Р51 п. 5): ref — CART по маске, тела ответа нет */
      | { at: string; kind: "operation.lookup"; ref?: string; detail: LookupDetail }
      /** граница reservation_ttl_sec прошла: последний GET — по-прежнему AUTHORIZED или отказ с просьбой повторить; граница
       *  не число — без GET (Р51 п. 2 (б), ревью КТ1 № 1, № 7) */
      | { at: string; kind: "operation.unsettled"; ref: string },
  ): void;
}

/** Причина REVERSED в журнале (Р51 п. 3, передача #63 п. 1, 7) — закрытым перечнем: иное значение — OTHER, само значение
 *  не пишется (инвариант 5). */
export type ReversalDetail = "REVERSAL" | "AUTH_EXPIRED" | "OTHER";

const reversalDetail = (reason: string | null): ReversalDetail => (reason === "REVERSAL" || reason === "AUTH_EXPIRED" ? reason : "OTHER");

export interface OperationsOptions {
  port: OperationsPort;
  journal: OperationsJournal;
  /** registry_cache_ttl_sec — предел недоступности GET на стадии 6 (инвариант 4); operation_reread_interval_sec — плановое
   *  перечитывание GET на стадии 6 (Р51 п. 2 (а)); event_poll_interval_ms — пауза опроса ленты после её отказа (без него
   *  опрос прекращается) */
  params: {
    operation_outcome_max_delay_sec: number;
    operation_reread_interval_sec: number;
    registry_cache_ttl_sec: number;
    event_seen_max: number;
    event_poll_interval_ms?: number;
  };
  /** прочитать ленту (`EventFeed.signal`): ожидание будит её, пока не решится; частоту чтений ограничивает лента */
  wake?: () => Promise<void>;
  now?: () => Date;
  /** таймер: вернуть — отмена */
  timer?: (fn: () => void, ms: number) => () => void;
}

/** Итог стадии 5: операция привязана и сверена; MISMATCH — привязана, но не сходится с покупкой (запись
 *  operation.mismatch); NONE — привязанной операции нет за срок; AMBIGUOUS — привязка неоднозначна (два ожидания одной
 *  ссылки заказа): итога нет, и поиск по CART его не ищет (ревью КТ1 Р51 № 3). */
export type OperationOutcome = { kind: "OPERATION"; operation: Operation } | { kind: "MISMATCH" } | { kind: "NONE" } | { kind: "AMBIGUOUS" };

/** Итог стадии 6: SETTLED или иной статус — операция; MISMATCH — другая операция; PENDING — расчёта нет, ожидание прервал
 *  вызывающий; UNREAD — GET не подтверждён и не повторяется; EXPIRED — граница ожидания прошла, итога нет (Р51 п. 2 (б)). */
export type SettleOutcome = { kind: "OPERATION"; operation: Operation } | { kind: "MISMATCH" } | { kind: "PENDING" } | { kind: "UNREAD" } | { kind: "EXPIRED" };

/** Ожидание итога по заказу (стадия 5). */
export interface OperationWait {
  /** Первый привязанный итог; нет за `ms` — NONE. Итог уже есть — сразу. Прерывание `signal` — отказ с его причиной. */
  outcome(ms: number, signal: AbortSignal): Promise<OperationOutcome>;
  /** Снять ожидание: события по заказу дальше — operation.unclaimed. */
  close(): void;
}

/** Отказ GET, после которого событие читается снова (договор ленты, Р34 п. 3): Платформа просит повторить или ответа нет. */
const REREAD: ReadonlySet<FailureCode> = new Set<FailureCode>(["STATE_UNAVAILABLE", "UPSTREAM_UNAVAILABLE", "RATE_LIMITED", "NO_RESPONSE"]);

interface Expectation {
  readonly cart: Mandate;
  /** два ожидания по одной ссылке заказа — привязка неоднозначна, итога нет (fail-closed) */
  ambiguous: boolean;
  result: OperationOutcome | null;
  readonly listeners: Set<() => void>;
}

export class Operations {
  readonly #o: OperationsOptions;
  readonly #now: () => Date;
  readonly #timer: (fn: () => void, ms: number) => () => void;
  /** event_id обработанных событий: дубль ленты или push — без второго GET; окно event_seen_max (Р50 п. 1) */
  readonly #seen: SeenWindow;
  /** order_ref → покупка, ждущая итог стадии 5 */
  readonly #byOrder = new Map<string, Expectation>();
  /** op_ref → ожидания расчёта (стадия 6): событие только будит их, GET делает ожидание */
  readonly #settling = new Map<string, Set<Waker>>();

  constructor(o: OperationsOptions) {
    this.#o = o;
    this.#seen = new SeenWindow(o.params.event_seen_max);
    this.#now = o.now ?? (() => new Date());
    this.#timer =
      o.timer ??
      ((fn, ms) => {
        // без unref: пока покупка ждёт, процесс не завершается молча, без исхода (инвариант 4)
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
  }

  /** Слушатель ленты (`EventFeed.listen`). Бросает только сбой журнала и отказ GET, после которого Платформа просит
   *  повторить, — тогда событие не отмечено обработанным и прочитается снова (Р34 п. 3, Р49 п. 3). */
  readonly listener = async (item: FeedItem): Promise<void> => {
    if (item.kind !== "event" || !item.event.type.startsWith("operation.")) return;
    const { eventId, opRef } = item.event;
    if (this.#seen.has(eventId)) return;
    this.#seen.add(eventId);
    try {
      // op_ref уже по маске (разбор ленты); иначе событие пропущено как INVALID_DATA и сюда не дошло
      if (opRef === null || !SAFE_ID.test(opRef)) return;
      const settling = this.#settling.get(opRef);
      if (settling) {
        for (const w of [...settling]) w.poke();
        return;
      }
      const r = await this.#read(opRef);
      if (r === null) return;
      const exp = r.orderRef === null ? undefined : this.#byOrder.get(r.orderRef);
      if (exp === undefined) return this.#record({ kind: "operation.unclaimed", ref: opRef });
      this.#offer(exp, r);
    } catch (e) {
      this.#seen.delete(eventId);
      throw e;
    }
  };

  /** Встать в ожидание итога по заказу — до отправки пакета (Р49 п. 3). Вход — снимком: `orderRef` уже по маске ссылки
   *  агента (стадия 5 проверила его до реквизита). */
  expect(orderRef: string, cart: Mandate): OperationWait {
    const exp: Expectation = { cart: structuredClone(cart), ambiguous: false, result: null, listeners: new Set() };
    const prior = this.#byOrder.get(orderRef);
    if (prior !== undefined) {
      prior.ambiguous = exp.ambiguous = true;
      for (const l of [...prior.listeners]) l();
    }
    this.#byOrder.set(orderRef, exp);
    return {
      outcome: (ms, signal) => this.#outcome(exp, ms, signal),
      close: () => {
        if (this.#byOrder.get(orderRef) === exp) this.#byOrder.delete(orderRef);
      },
    };
  }

  #outcome(exp: Expectation, ms: number, signal: AbortSignal): Promise<OperationOutcome> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<OperationOutcome>((resolve, reject) => {
      let settled = false;
      const end = (done: () => void) => {
        if (settled) return;
        settled = true;
        cancel();
        exp.listeners.delete(check);
        signal.removeEventListener("abort", onAbort);
        done();
      };
      const check = () => {
        if (exp.ambiguous) return end(() => resolve({ kind: "AMBIGUOUS" }));
        if (exp.result !== null) {
          const r = exp.result;
          end(() => resolve(r));
        }
      };
      const onAbort = () => end(() => reject(signal.reason));
      const cancel = this.#timer(() => end(() => resolve({ kind: "NONE" })), Math.min(ms, TIMER_MAX_MS));
      signal.addEventListener("abort", onAbort, { once: true });
      exp.listeners.add(check);
      check();
      void this.#poll(() => settled);
    });
  }

  /**
   * Восстановление op_ref (Р51 п. 5; РП55 п. 6): итога по событию нет за срок стадии 5 — один раз операции по CART покупки
   * (только с итогом). Кандидаты — операции с её order_ref; ровно одна — сверка с CART той же привязкой, что у события
   * (bind.ts): итог или MISMATCH (запись operation.mismatch). Ни одной или больше одной — NONE. Отказ Платформы — NONE,
   * код — в записи operation.lookup (403 AGENT_SUSPENDED подпись уже остановил адаптер); сбой журнала — наружу. Повтора нет.
   */
  async lookup(orderRef: string, cart: Mandate): Promise<OperationOutcome> {
    const ref = mandateRef(cart.id).mandate;
    const done = (detail: LookupDetail, outcome: OperationOutcome): OperationOutcome => {
      this.#record({ kind: "operation.lookup", ...(ref !== undefined && { ref }), detail });
      return outcome;
    };
    let list: OperationRecord[];
    try {
      list = await this.#o.port.readOperations(cart.id);
    } catch (e) {
      if (!(e instanceof PlatformFailure)) throw e;
      return done(e.code, { kind: "NONE" });
    }
    const mine = list.filter((r) => r.orderRef === orderRef);
    if (mine.length === 0) return done("NONE", { kind: "NONE" });
    if (mine.length > 1) return done("AMBIGUOUS", { kind: "NONE" });
    const r = mine[0]!;
    const bound = bindOperation(r, cart);
    if (typeof bound === "string") {
      this.#record({ kind: "operation.mismatch", ref: r.opRef, detail: bound, reason: "OPERATION_REPLY_MISMATCH", ...mandateRef(cart.id) });
      return done("MISMATCH", { kind: "MISMATCH" });
    }
    this.#record({ kind: "operation.status", ref: r.opRef, detail: r.status });
    if (bound.status === "REVERSED") this.#record({ kind: "operation.reversed", ref: r.opRef, detail: reversalDetail(bound.declineReason) });
    return done("BOUND", { kind: "OPERATION", operation: bound });
  }

  /** Первый привязанный итог — итог стадии 5; следующие события по заказу его не меняют. */
  #offer(exp: Expectation, r: OperationRecord): void {
    if (exp.result !== null) return;
    const bound = bindOperation(r, exp.cart);
    if (typeof bound === "string") {
      this.#record({ kind: "operation.mismatch", ref: r.opRef, detail: bound, reason: "OPERATION_REPLY_MISMATCH", ...mandateRef(exp.cart.id) });
      exp.result = { kind: "MISMATCH" };
    } else {
      exp.result = { kind: "OPERATION", operation: bound };
    }
    for (const l of [...exp.listeners]) l();
  }

  /**
   * Стадия 6 (Р49 п. 6, Р51 п. 2): GET по известному op_ref; AUTHORIZED — ждать события по op_ref, без него — снова GET не
   * чаще раза в operation_reread_interval_sec (РП55), пока вызывающий не прервёт (`signal` → PENDING, не отказ) или не
   * пройдёт граница `deadline` (мс по часам модуля): по ней — последний GET, по-прежнему AUTHORIZED — запись
   * operation.unsettled и EXPIRED. Отказ GET, после которого Платформа просит повторить, — запись operation.unread и повтор
   * через operation_outcome_max_delay_sec; Платформа недоступна дольше registry_cache_ttl_sec — UNREAD (инвариант 4; ревью
   * КТ1 № 8); иной отказ — UNREAD сразу. REVERSED — запись operation.reversed с причиной закрытым перечнем.
   */
  async settle(authorized: Operation, signal: AbortSignal, deadline = Number.POSITIVE_INFINITY): Promise<SettleOutcome> {
    const opRef = authorized.opRef;
    const wakers = this.#settling.get(opRef) ?? new Set<Waker>();
    this.#settling.set(opRef, wakers);
    // событие, пришедшее пока шёл GET, не теряется: флаг «разбужен» проверяет следующая пауза (ревью КТ1 № 10)
    const waker = new Waker();
    wakers.add(waker);
    let unavailableSince: number | null = null;
    const expired = (): SettleOutcome => {
      this.#record({ kind: "operation.unsettled", ref: opRef });
      return { kind: "EXPIRED" };
    };
    try {
      // граница не число (недействительная дата от вызывающего) — fail-closed без чтения: иначе пауза NaN — GET без
      // промежутка и без конца (ревью КТ1 Р51 № 1); +∞ — границы нет
      if (Number.isNaN(deadline)) return expired();
      for (;;) {
        if (signal.aborted) return { kind: "PENDING" };
        let r: OperationRecord | null;
        try {
          r = await this.#read(opRef);
        } catch (e) {
          // Платформа просит повторить — после паузы, но не дольше registry_cache_ttl_sec подряд; сбой журнала — наружу
          if (!(e instanceof PlatformFailure)) throw e;
          this.#record({ kind: "operation.unread", ref: opRef, reason: "OPERATION_UNREAD", detail: e.code });
          const now = this.#now().getTime();
          // граница прошла, пока Платформа недоступна, — тот же исход, что по последнему GET (ревью КТ1 Р51 № 7)
          if (now >= deadline) return expired();
          unavailableSince ??= now;
          if (now - unavailableSince >= this.#o.params.registry_cache_ttl_sec * 1000) return { kind: "UNREAD" };
          if (!(await this.#pause(waker, signal, this.#o.params.operation_outcome_max_delay_sec * 1000))) return { kind: "PENDING" };
          continue;
        }
        unavailableSince = null;
        if (r === null) return { kind: "UNREAD" };
        const op = settledOperation(r, authorized);
        if (typeof op === "string") {
          this.#record({ kind: "operation.mismatch", ref: opRef, detail: op, reason: "OPERATION_REPLY_MISMATCH", ...mandateRef(authorized.indicator?.mandateId ?? "") });
          return { kind: "MISMATCH" };
        }
        if (op.status === "SETTLED") {
          const s = op.fulfilment?.scopeCheck;
          this.#record({ kind: "operation.settled", ref: opRef, detail: s === undefined || typeof s === "object" ? "OTHER" : s });
          return { kind: "OPERATION", operation: op };
        }
        if (op.status === "REVERSED") this.#record({ kind: "operation.reversed", ref: opRef, detail: reversalDetail(op.declineReason) });
        if (op.status !== "AUTHORIZED") return { kind: "OPERATION", operation: op };
        // граница прошла, этот GET — последний (Р51 п. 2 (б)); до неё — пауза не дольше остатка срока
        const left = deadline - this.#now().getTime();
        if (left <= 0) return expired();
        if (!(await this.#pause(waker, signal, Math.min(this.#o.params.operation_reread_interval_sec * 1000, left)))) return { kind: "PENDING" };
      }
    } finally {
      // ожидание по op_ref снимается, когда его больше никто не ждёт
      wakers.delete(waker);
      if (wakers.size === 0 && this.#settling.get(opRef) === wakers) this.#settling.delete(opRef);
    }
  }

  /** Пауза стадии 6: до события по op_ref (в том числе пришедшего до паузы) или `ms`; false — прервал вызывающий. */
  #pause(waker: Waker, signal: AbortSignal, ms: number): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (waker.take()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const end = (v: boolean) => {
        if (settled) return;
        settled = true;
        cancel();
        waker.listener = null;
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const onAbort = () => end(false);
      const cancel = this.#timer(() => end(true), Math.min(ms, TIMER_MAX_MS));
      waker.listener = () => {
        waker.take();
        end(true);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void this.#poll(() => settled);
    });
  }

  /** Лента читается, пока покупка ждёт (events/poll.ts): отказ ленты — пауза event_poll_interval_ms и чтение дальше. */
  #poll(done: () => boolean): Promise<void> {
    return poll(this.#o.wake, done, this.#o.params.event_poll_interval_ms);
  }

  /**
   * GET операции: 400 — операция не этого агента (operation.foreign); отказ, после которого Платформа просит повторить, —
   * наружу (событие прочитается снова); иной отказ и ответ не о той операции — operation.unread с кодом. Итог — запись
   * operation.status.
   */
  async #read(opRef: string): Promise<OperationRecord | null> {
    let r: OperationRecord;
    try {
      r = await this.#o.port.readOperation(opRef);
    } catch (e) {
      if (e instanceof PlatformFailure && e.code === "REQUEST_INVALID") {
        this.#record({ kind: "operation.foreign", ref: opRef });
        return null;
      }
      if (e instanceof PlatformFailure && REREAD.has(e.code)) throw e;
      this.#record({ kind: "operation.unread", ref: opRef, reason: "OPERATION_UNREAD", detail: e instanceof PlatformFailure ? e.code : "UNKNOWN" });
      return null;
    }
    if (r.opRef !== opRef) {
      this.#record({ kind: "operation.unread", ref: opRef, reason: "OPERATION_UNREAD", detail: "BAD_RESPONSE" });
      return null;
    }
    this.#record({ kind: "operation.status", ref: opRef, detail: r.status });
    return r;
  }

  #record(e: WithoutAt<JournalEntry>): void {
    this.#o.journal.record({ at: this.#now().toISOString(), ...e } as JournalEntry);
  }
}

/** Будильник ожидания расчёта: событие по op_ref до паузы — флаг, во время паузы — сразу. */
class Waker {
  #woken = false;
  listener: (() => void) | null = null;
  poke(): void {
    this.#woken = true;
    this.listener?.();
  }
  /** Был разбужен — снять флаг. */
  take(): boolean {
    const w = this.#woken;
    this.#woken = false;
    return w;
  }
}

type JournalEntry = Parameters<OperationsJournal["record"]>[0];
type WithoutAt<T> = T extends unknown ? Omit<T, "at"> : never;

const mandateRef = (id: string): { mandate?: string } => (SAFE_ID.test(id) ? { mandate: id } : {});
