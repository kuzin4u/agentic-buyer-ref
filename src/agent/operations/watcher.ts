// Итог операции по событиям operation.* (Р49 п. 3–6; передачи #57, #59). Событие — только сигнал: данные — только
// {op_ref}, итог — по GET /pao/v1/operations/{op_ref}. op_ref агент узнаёт только из события (продавец его не отдаёт),
// поэтому операция относится к покупке по order_ref — ссылке заказа, которую агент сам передал в реквизите и пакете;
// покупка встаёт в ожидание до отправки пакета. Сверка с заказом и CART — bind.ts. Слова продавца сюда не попадают
// (инвариант 8).
import type { FeedItem } from "../ports/events.js";
import { PlatformFailure, type FailureCode, type Mandate, type Operation, type OperationRecord, type OperationStatus, type ScopeCheck } from "../../shared/domain.js";
import type { DiagCode } from "../../shared/diag-codes.js";
import { TIMER_MAX_MS } from "../../shared/config.js";
import { SAFE_ID } from "../../shared/ids.js";
import { bindOperation, settledOperation, type MismatchField } from "./bind.js";

/** Часть порта платформы, которую видит модуль. */
export interface OperationsPort {
  readOperation(opRef: string): Promise<OperationRecord>;
}

/** scope_check в журнале — закрытым перечнем: значение вне перечня — OTHER, само значение не пишется (инвариант 5). */
export type ScopeCheckDetail = Exclude<ScopeCheck, { other: string | null }> | "OTHER";

/** Часть журнала агента, которую видит модуль (Journal подходит): ref — op_ref по маске. */
export interface OperationsJournal {
  record(
    entry:
      | { at: string; kind: "operation.status"; ref: string; detail: OperationStatus }
      | { at: string; kind: "operation.foreign" | "operation.unclaimed"; ref: string }
      | { at: string; kind: "operation.unread"; ref: string; reason: DiagCode }
      | { at: string; kind: "operation.mismatch"; ref: string; detail: MismatchField; reason: "OPERATION_REPLY_MISMATCH"; mandate?: string }
      | { at: string; kind: "operation.settled"; ref: string; detail: ScopeCheckDetail },
  ): void;
}

export interface OperationsOptions {
  port: OperationsPort;
  journal: OperationsJournal;
  params: { operation_outcome_max_delay_sec: number };
  /** прочитать ленту (`EventFeed.signal`): ожидание будит её, пока не решится; частоту чтений ограничивает лента */
  wake?: () => Promise<void>;
  now?: () => Date;
  /** таймер: вернуть — отмена */
  timer?: (fn: () => void, ms: number) => () => void;
}

/** Итог стадии 5: операция привязана и сверена; MISMATCH — привязана, но не сходится с покупкой (запись
 *  operation.mismatch); NONE — привязанной операции нет за срок или привязка неоднозначна. */
export type OperationOutcome = { kind: "OPERATION"; operation: Operation } | { kind: "MISMATCH" } | { kind: "NONE" };

/** Итог стадии 6: SETTLED или иной статус — операция; MISMATCH — другая операция; PENDING — расчёта нет, ожидание прервал
 *  вызывающий; UNREAD — GET не подтверждён и не повторяется. */
export type SettleOutcome = { kind: "OPERATION"; operation: Operation } | { kind: "MISMATCH" } | { kind: "PENDING" } | { kind: "UNREAD" };

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
  /** event_id обработанных событий: дубль ленты или push — без второго GET */
  readonly #seen = new Set<string>();
  /** order_ref → покупка, ждущая итог стадии 5 */
  readonly #byOrder = new Map<string, Expectation>();
  /** op_ref → ожидание расчёта (стадия 6): событие только будит его, GET делает ожидание */
  readonly #settling = new Map<string, Set<() => void>>();

  constructor(o: OperationsOptions) {
    this.#o = o;
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
        for (const poke of [...settling]) poke();
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
        if (exp.ambiguous) return end(() => resolve({ kind: "NONE" }));
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
   * Стадия 6 (Р49 п. 6): GET по известному op_ref; не SETTLED — ждать operation.settled, без события дольше
   * operation_outcome_max_delay_sec — снова GET (#59 п. 3), пока вызывающий не прервёт (`signal` → PENDING, не отказ).
   * Отказ GET, после которого Платформа просит повторить, — повтор в тот же срок; иной — UNREAD.
   */
  async settle(authorized: Operation, signal: AbortSignal): Promise<SettleOutcome> {
    const opRef = authorized.opRef;
    const pokes = this.#settling.get(opRef) ?? new Set<() => void>();
    this.#settling.set(opRef, pokes);
    try {
      for (;;) {
        if (signal.aborted) return { kind: "PENDING" };
        let r: OperationRecord | null;
        try {
          r = await this.#read(opRef);
        } catch (e) {
          // Платформа просит повторить — после паузы; сбой журнала — наружу
          if (!(e instanceof PlatformFailure)) throw e;
          if (!(await this.#pause(pokes, signal))) return { kind: "PENDING" };
          continue;
        }
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
        if (op.status !== "AUTHORIZED") return { kind: "OPERATION", operation: op };
        if (!(await this.#pause(pokes, signal))) return { kind: "PENDING" };
      }
    } finally {
      // ожидание по op_ref снимается, когда его больше никто не ждёт
      if (pokes.size === 0) this.#settling.delete(opRef);
    }
  }

  /** Пауза стадии 6: до события по op_ref или operation_outcome_max_delay_sec; false — прервал вызывающий. */
  #pause(pokes: Set<() => void>, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const end = (v: boolean) => {
        if (settled) return;
        settled = true;
        cancel();
        pokes.delete(poke);
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const poke = () => end(true);
      const onAbort = () => end(false);
      const cancel = this.#timer(() => end(true), Math.min(this.#o.params.operation_outcome_max_delay_sec * 1000, TIMER_MAX_MS));
      pokes.add(poke);
      signal.addEventListener("abort", onAbort, { once: true });
      void this.#poll(() => settled);
    });
  }

  /** Лента читается, пока покупка ждёт: push может не прийти (как у модуля подтверждений). Отказ ленты — опрос
   *  прекращается, исход — по таймерам. */
  async #poll(done: () => boolean): Promise<void> {
    const wake = this.#o.wake;
    if (wake === undefined) return;
    while (!done()) {
      try {
        await wake();
      } catch {
        return;
      }
      await new Promise<void>((r) => setImmediate(r));
    }
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
      this.#record({ kind: "operation.unread", ref: opRef, reason: e instanceof PlatformFailure ? e.code : "UNKNOWN" });
      return null;
    }
    if (r.opRef !== opRef) {
      this.#record({ kind: "operation.unread", ref: opRef, reason: "BAD_RESPONSE" });
      return null;
    }
    this.#record({ kind: "operation.status", ref: opRef, detail: r.status });
    return r;
  }

  #record(e: WithoutAt<JournalEntry>): void {
    this.#o.journal.record({ at: this.#now().toISOString(), ...e } as JournalEntry);
  }
}

type JournalEntry = Parameters<OperationsJournal["record"]>[0];
type WithoutAt<T> = T extends unknown ? Omit<T, "at"> : never;

const mandateRef = (id: string): { mandate?: string } => (SAFE_ID.test(id) ? { mandate: id } : {});
