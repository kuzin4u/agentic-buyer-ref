// Подтверждение человеком по событиям confirmation.* (Р47 п. 3–5, 8; уточнения В1–В3). Событие — только сигнал: статус —
// по GET /pao/v1/confirmations/{id}, событие без GET ничего не меняет (Р34). Запрос создаёт ADP на отказе авторизации
// продавца; в ответе Платформы нет ни мандата, ни order_ref, поэтому запрос относится к покупке, только если его ждёт
// ровно одна покупка (4а): ошибка привязки денег не стоит — ADP сверяет ссылку с мандатом, продавцом, суммой и order_ref.
// link и confirmation_ref дальше разбора ответа не идут: ни в журнал, ни в исход, ни человеку (инвариант 1, Р47 п. 5).
import { poll } from "../events/poll.js";
import { SeenWindow } from "../events/seen.js";
import type { FeedItem } from "../ports/events.js";
import type { ConfirmationOutcome } from "../ports/shop.js";
import { PlatformFailure, type Confirmation } from "../../shared/domain.js";
import { TIMER_MAX_MS } from "../../shared/config.js";
import { CONFIRMATION_ID } from "../../shared/ids.js";

/** Часть порта платформы, которую видит модуль. */
export interface ConfirmationsPort {
  getConfirmation(id: string): Promise<Confirmation>;
}

/** Часть журнала агента, которую видит модуль (Journal подходит): ref — confirmation_id по маске. */
export interface ConfirmationsJournal {
  record(
    entry:
      | { at: string; kind: "confirmation.status"; ref: string; detail: Confirmation["status"] }
      | { at: string; kind: "confirmation.foreign" | "confirmation.unclaimed" | "confirmation.discarded"; ref: string }
      | { at: string; kind: "confirmation.unbound"; ref?: string }
      | { at: string; kind: "notify.failed"; reason: "CONFIRMATION_PENDING" },
  ): void;
}

/** Исход ожидания — тип порта шагов оплаты (UNKNOWN — сбой GET, ответ не по схеме, PENDING после срока). */
export type { ConfirmationOutcome };

export interface ConfirmationsOptions {
  port: ConfirmationsPort;
  journal: ConfirmationsJournal;
  /** event_poll_interval_ms — пауза опроса после отказа ленты (ревью КТ1 AG-11 ч. 2 № 3); нет — опрос прекращается */
  params: { confirmation_wait_ms: number; signature_skew_sec: number; event_seen_max: number; event_poll_interval_ms?: number };
  /** прочитать ленту (`EventFeed.signal`): ожидание будит её, пока не решится; частоту чтений ограничивает лента */
  wake?: () => Promise<void>;
  now?: () => Date;
  /** таймер: вернуть — отмена */
  timer?: (fn: () => void, ms: number) => () => void;
}

/** Вход ожидания: `onPending` — один вызов на запрос, когда он PENDING; без link (Р47 п. 5, В3). Модуль его не ждёт:
 *  исключение и отказ обещания — запись notify.failed, исход не меняется. */
export interface WaitOptions {
  signal: AbortSignal;
  onPending?: () => void | Promise<void>;
}

type JournalEntry = Parameters<ConfirmationsJournal["record"]>[0];
type WithoutAt<T> = T extends unknown ? Omit<T, "at"> : never;

/** Статус по GET без link и confirmation_ref; FAILED — GET не дал подтверждённого статуса. */
type Read = { status: Confirmation["status"]; expiresAt: string | null } | "FAILED";

interface Waiter {
  readonly onPending: WaitOptions["onPending"];
  /** привязанный запрос; null — ждёт запрос */
  id: string | null;
  settled: boolean;
  cancel: (() => void) | null;
  finish(o: ConfirmationOutcome): void;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const STATUSES: ReadonlySet<string> = new Set(["PENDING", "APPROVED", "REJECTED", "EXPIRED"]);

export class Confirmations {
  readonly #o: ConfirmationsOptions;
  readonly #now: () => Date;
  readonly #timer: (fn: () => void, ms: number) => () => void;
  /** event_id обработанных событий: дубль ленты или push — без второго GET и уведомления; окно event_seen_max (Р50 п. 1) */
  readonly #seen: SeenWindow;
  /** покупки, ждущие запрос (В2: привязанные к запросу в счёт не входят) */
  readonly #waiters = new Set<Waiter>();
  /** запрос → покупка, ждущая решения */
  readonly #bound = new Map<string, Waiter>();
  /** невостребованные запросы (В1а): пришли без ожидающих, хранятся не дольше confirmation_wait_ms */
  readonly #unclaimed = new Map<string, { read: Read; drop: () => void; seq: number }>();
  /** запросы, по которым решено (исход, чужой, неоднозначный, выброшен): события по ним больше ничего не делают. Без
   *  окна (Р50, нюанс; условие владельца 1): растёт по запросам подтверждения, а не по событиям — пересмотр при пилоте */
  readonly #done = new Set<string>();
  /** запросы, о которых человеку уже сообщили */
  readonly #notified = new Set<string>();
  /** ждущие появления невостребованного запроса (Р49 п. 5: гонка итога операции с запросом подтверждения): после — номер
   *  отметки, раньше которой запросы не в счёт */
  readonly #arrivals = new Set<{ after: number; arrived: () => void }>();
  /** номер последнего невостребованного запроса (отметка для гонки стадии 5) */
  #held = 0;

  constructor(o: ConfirmationsOptions) {
    this.#o = o;
    this.#seen = new SeenWindow(o.params.event_seen_max);
    this.#now = o.now ?? (() => new Date());
    this.#timer =
      o.timer ??
      ((fn, ms) => {
        // без unref: пока покупка ждёт, процесс не завершается молча, без исхода (инвариант 4; ревью reviewer К2 № 7)
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
  }

  /** Слушатель ленты (`EventFeed.listen`). Сбой GET — исход ожидающей покупки, а не остановка ленты; бросает только
   *  сбой журнала — тогда событие не отмечено обработанным и прочитается снова (договор ленты, Р34 п. 3). */
  readonly listener = async (item: FeedItem): Promise<void> => {
    if (item.kind !== "event" || !item.event.type.startsWith("confirmation.")) return;
    const { eventId, confirmationId: id } = item.event;
    if (this.#seen.has(eventId)) return;
    this.#seen.add(eventId);
    try {
      // id уже по маске CONFIRMATION_ID (разбор ленты); иначе событие пропущено как INVALID_DATA и сюда не дошло
      if (id === null || !CONFIRMATION_ID.test(id) || this.#done.has(id)) return;
      const bound = this.#bound.get(id);
      if (bound) return await this.#refresh(id, bound);
      if (this.#unclaimed.has(id)) return await this.#reheld(id);
      return await this.#arrived(id);
    } catch (e) {
      this.#seen.delete(eventId);
      throw e;
    }
  };

  /**
   * Ожидание запроса и решения человека — после ответа продавца DECLINED на переданный пакет (Р47 п. 4). Вход — снимком
   * до первого await (Р-205). Невостребованный запрос берётся, только если он один и ожидающая — эта одна (В1а); иначе
   * UNBOUND. Прерывание `signal` — отказ с его причиной.
   */
  wait(o: WaitOptions): Promise<ConfirmationOutcome> {
    const signal = o.signal;
    const onPending = o.onPending;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<ConfirmationOutcome>((resolve, reject) => {
      const onAbort = () => end(() => reject(signal.reason));
      const end = (done: () => void) => {
        if (w.settled) return;
        w.settled = true;
        w.cancel?.();
        w.cancel = null;
        this.#waiters.delete(w);
        if (w.id !== null) {
          this.#bound.delete(w.id);
          this.#done.add(w.id);
        }
        signal.removeEventListener("abort", onAbort);
        done();
      };
      const w: Waiter = { onPending, id: null, settled: false, cancel: null, finish: (outcome) => end(() => resolve(outcome)) };
      signal.addEventListener("abort", onAbort, { once: true });
      if (this.#unclaimed.size === 1 && this.#waiters.size === 0) {
        const [id, held] = [...this.#unclaimed][0]!;
        held.drop();
        this.#unclaimed.delete(id);
        this.#bind(id, w, held.read);
      } else if (this.#unclaimed.size > 0) {
        this.#unbound(undefined, [w]);
      } else {
        this.#waiters.add(w);
        w.cancel = this.#timer(() => w.finish("NONE"), this.#o.params.confirmation_wait_ms);
      }
      void this.#poll(w);
    });
  }

  /** Лента читается, пока покупка ждёт: push может не прийти. Между чтениями — макрозадача: лента без своей паузы не
   *  займёт процессор и не задержит таймеры исхода. Отказ ленты (слушатель упал — событие прочитается снова, Р34 п. 3) —
   *  пауза event_poll_interval_ms и опрос дальше (ревью КТ1 AG-11 ч. 2 № 3); без параметра — опрос прекращается, исход — по
   *  таймерам. */
  async #poll(w: Waiter): Promise<void> {
    await poll(this.#o.wake, () => w.settled, this.#o.params.event_poll_interval_ms);
  }

  /** Событие по невостребованному запросу: GET; пока он шёл, запрос могла взять покупка — тогда исход ей (ревью
   *  reviewer К2 № 1). 400 — запрос не этого агента; сбой — запрос не хранится (статуса нет, как в #arrived). */
  async #reheld(id: string): Promise<void> {
    const read = await this.#read(id);
    const bound = this.#bound.get(id);
    if (bound) return this.#apply(id, bound, read === "FOREIGN" ? "FAILED" : read);
    const held = this.#unclaimed.get(id);
    if (held === undefined) return;
    if (read === "FOREIGN" || read === "FAILED") {
      held.drop();
      this.#unclaimed.delete(id);
      this.#done.add(id);
      if (read === "FOREIGN") this.#record({ kind: "confirmation.foreign", ref: id });
      return;
    }
    held.read = read;
  }

  /** Первый сигнал по запросу: GET, затем привязка по числу ожидающих (4а). */
  async #arrived(id: string): Promise<void> {
    const read = await this.#read(id);
    // пока шёл GET, запрос мог появиться по другому событию или таймеру
    if (this.#done.has(id) || this.#bound.has(id) || this.#unclaimed.has(id)) return;
    if (read === "FOREIGN") {
      this.#done.add(id);
      this.#record({ kind: "confirmation.foreign", ref: id });
      return;
    }
    const waiting = [...this.#waiters];
    if (waiting.length === 0) {
      // статус не подтверждён — хранить нечего: покупка, начавшая ждать, его не получит (NONE, fail-closed)
      if (read === "FAILED") {
        this.#done.add(id);
        return;
      }
      this.#hold(id, read);
      return;
    }
    if (waiting.length > 1) {
      this.#done.add(id);
      this.#unbound(id, waiting);
      return;
    }
    this.#bind(id, waiting[0]!, read);
  }

  #hold(id: string, read: Read): void {
    const drop = this.#timer(() => {
      if (!this.#unclaimed.delete(id)) return;
      this.#done.add(id);
      // запрос уже выброшен; исключение в таймере ловить некому — оно уронило бы процесс (КТ1 сессии 39 № 8)
      try {
        this.#record({ kind: "confirmation.discarded", ref: id });
      } catch {
        // журнал недоступен: записи нет, действие состоялось
      }
    }, this.#o.params.confirmation_wait_ms);
    const seq = ++this.#held;
    this.#unclaimed.set(id, { read, drop, seq });
    this.#record({ kind: "confirmation.unclaimed", ref: id });
    for (const a of [...this.#arrivals]) if (seq > a.after) a.arrived();
  }

  /** Отметка до отправки пакета (Р49 п. 5): запросы, невостребованные до неё, в гонке этой покупки не в счёт. */
  mark(): number {
    return this.#held;
  }

  /**
   * Появился невостребованный запрос подтверждения позже отметки `after` (Р49 п. 5; ревью КТ1 № 5): уже есть — сразу. Не
   * привязывает и не уведомляет: запрос берёт `wait` стадии 4 (В1а). Прерывание `signal` — отказ с его причиной.
   */
  arrival(signal: AbortSignal, after: number): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if ([...this.#unclaimed.values()].some((h) => h.seq > after)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const end = (done: () => void) => {
        this.#arrivals.delete(a);
        signal.removeEventListener("abort", onAbort);
        done();
      };
      const a = { after, arrived: () => end(resolve) };
      const onAbort = () => end(() => reject(signal.reason));
      this.#arrivals.add(a);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  #unbound(id: string | undefined, waiting: Waiter[]): void {
    this.#record({ kind: "confirmation.unbound", ...(id !== undefined && { ref: id }) });
    for (const w of waiting) w.finish("UNBOUND");
  }

  #bind(id: string, w: Waiter, read: Read): void {
    this.#waiters.delete(w);
    w.cancel?.();
    w.cancel = null;
    w.id = id;
    this.#bound.set(id, w);
    this.#apply(id, w, read);
  }

  /** Исход по статусу: PENDING — уведомление (один раз на запрос) и ожидание решения до срока; иначе — исход. */
  #apply(id: string, w: Waiter, read: Read): void {
    if (w.settled) return;
    if (read === "FAILED") return w.finish("UNKNOWN");
    if (read.status !== "PENDING") return w.finish(read.status);
    if (!this.#notified.has(id)) {
      this.#notified.add(id);
      this.#notify(w);
    }
    if (w.cancel === null) this.#schedule(id, w, read.expiresAt);
  }

  /** Уведомление — не часть исхода (В3): ни исключение, ни отказ обещания оболочки покупку не меняют и не ждутся. */
  #notify(w: Waiter): void {
    const failed = () => this.#record({ kind: "notify.failed", reason: "CONFIRMATION_PENDING" });
    try {
      const r = w.onPending?.();
      if (r !== undefined) Promise.resolve(r).catch(failed);
    } catch {
      failed();
    }
  }

  /** Истечение отмечается только при обращении (РП51 п. 6): после expires_at + signature_skew_sec — один GET. */
  #schedule(id: string, w: Waiter, expiresAt: string | null): void {
    // только RFC 3339 (`format: date-time` ПАО): Date.parse принимает и «2026» (ревью reviewer К2 № 8)
    const deadline = expiresAt === null || !RFC3339.test(expiresAt) ? Number.NaN : Date.parse(expiresAt) + this.#o.params.signature_skew_sec * 1000;
    if (Number.isNaN(deadline)) return w.finish("UNKNOWN");
    const ms = Math.min(Math.max(deadline - this.#now().getTime(), 0), TIMER_MAX_MS);
    // прежний таймер — отменить: событие и ранний таймер могли поставить по таймеру (ревью reviewer К2 № 5)
    w.cancel?.();
    w.cancel = this.#timer(() => {
      w.cancel = null;
      // отказ из таймера ловить некому: сбой журнала (запись confirmation.status в #read) — исход UNKNOWN (fail-closed),
      // иначе необработанный отказ обещания уронил бы процесс, а стадия 4 ждала бы до внешнего signal (КТ1 сессии 39 № 8)
      this.#expire(id, w, deadline).catch(() => {
        if (!w.settled) w.finish("UNKNOWN");
      });
    }, ms);
  }

  async #expire(id: string, w: Waiter, deadline: number): Promise<void> {
    const read = await this.#read(id);
    if (w.settled) return;
    if (read === "FOREIGN" || read === "FAILED") return w.finish("UNKNOWN");
    // таймер сработал раньше срока (предел таймера, ранний таймер — Р46 К2а) — ждать дальше; после срока PENDING —
    // состояние не подтверждено
    if (read.status === "PENDING") {
      if (this.#now().getTime() < deadline) return this.#schedule(id, w, read.expiresAt);
      return w.finish("UNKNOWN");
    }
    w.finish(read.status);
  }

  /** Решение человека или истечение по событию: GET; запрос перестал быть своим — UNKNOWN. */
  async #refresh(id: string, w: Waiter): Promise<void> {
    const read = await this.#read(id);
    if (w.settled) return;
    this.#apply(id, w, read === "FOREIGN" ? "FAILED" : read);
  }

  /** GET запроса: 400 — запрос не этого агента; прочий отказ (повторы — у адаптера по таблице §7а) и ответ не по схеме
   *  — FAILED. Ответ сверяется: тот же id, статус из перечня, confirmation_ref только у APPROVED. */
  async #read(id: string): Promise<Read | "FOREIGN"> {
    let c: Confirmation;
    try {
      c = await this.#o.port.getConfirmation(id);
    } catch (e) {
      // чужой запрос — только 400 по x-pao-errors; ответ транспорта §6 (404 / 413 / 414, Р58 п. 1) — FAILED
      if (e instanceof PlatformFailure && e.code === "REQUEST_INVALID" && e.httpStatus === 400) return "FOREIGN";
      return "FAILED";
    }
    const withRef = typeof c.confirmationRef === "string" && c.confirmationRef !== "";
    if (c.id !== id || !STATUSES.has(c.status) || withRef !== (c.status === "APPROVED") || (!withRef && c.confirmationRef !== null)) return "FAILED";
    this.#record({ kind: "confirmation.status", ref: id, detail: c.status });
    return { status: c.status, expiresAt: typeof c.expiresAt === "string" ? c.expiresAt : null };
  }

  #record(e: WithoutAt<JournalEntry>): void {
    this.#o.journal.record({ at: this.#now().toISOString(), ...e } as JournalEntry);
  }
}
