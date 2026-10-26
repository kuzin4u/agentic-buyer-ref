// Лента событий Платформы (Р34 п. 1–4, 6, 9). Источник событий — только лента по курсору; push лишь будит чтение
// (push.ts). Событие обрабатывается слушателями, затем курсор сохраняется: сбой между ними — повтор одного события после
// перезапуска, безопасный, потому что действие — по GET (п. 3, 5). Чтений в работе — не больше одного; сигналы во время
// чтения сливаются в одно следующее; чтения — не чаще event_poll_interval_ms (уточнение 1 владельца).
import { PlatformFailure, type PlatformEventType } from "../../shared/domain.js";
import type { DiagCode } from "../../shared/diag-codes.js";
import type { EventsPort, FeedItem } from "../ports/events.js";
import { CursorInvalid, EVENT_ID, type EventCursorStore } from "./cursor.js";

/** Причина остановки агента по курсору (Р34 п. 4, ответ (а) владельца) — причина ядра, не код ПАО; к AG-ДГ — в реестр. */
export const EVENTS_CURSOR_INVALID = "EVENTS_CURSOR_INVALID";

/** Часть журнала агента, которую видит лента (Journal подходит); ref — event_id, detail — тип из перечня или причина. */
export interface EventsJournal {
  record(
    entry:
      | { at: string; kind: "event.handled"; ref: string; detail: PlatformEventType }
      | { at: string; kind: "event.ignored"; ref: string; detail: "UNKNOWN_TYPE" | "INVALID_DATA" }
      | { at: string; kind: "events.cursor_initial" }
      | { at: string; kind: "events.unavailable"; reason: "EVENTS_UNAVAILABLE"; detail: DiagCode },
  ): void;
}

/** Остановка агента целиком (порт подписи, `RequestSigning.stop`); ключ через неё не проходит (инвариант 2). */
export type StopAgent = (reason: DiagCode, detail: string) => void;

/** Приостановка подписи до успешной сверки с реестром (порт подписи, `RequestSigning.suspend`; Р50 дополнение 1). */
export type SuspendAgent = (reason: DiagCode) => void;

/** Лента остановлена: курсор не читается или отвергнут Платформой; агент уже остановлен (Р34 п. 4). */
export class EventsStopped extends Error {
  constructor(readonly detail: "UNREADABLE" | "REJECTED") {
    super(`лента событий остановлена: ${EVENTS_CURSOR_INVALID} (${detail})`);
    this.name = "EventsStopped";
  }
}

export type FeedListener = (item: FeedItem) => void | Promise<void>;

export interface EventFeedOptions {
  port: EventsPort;
  store: EventCursorStore;
  journal: EventsJournal;
  stop: StopAgent;
  suspend: SuspendAgent;
  params: { event_poll_interval_ms: number; registry_cache_ttl_sec: number };
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export class EventFeed {
  readonly #o: EventFeedOptions;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #listeners = new Set<FeedListener>();
  /** undefined — курсор ещё не загружен; null — лента с начала */
  #after: string | null | undefined;
  #stopped: EventsStopped | null = null;
  #running: Promise<void> | null = null;
  #again = false;
  #lastStart = Number.NEGATIVE_INFINITY;
  /** начало серии неудачных чтений (Р50 п. 2); null — последнее чтение дошло до пустой страницы */
  #failingSince: number | null = null;
  /** число чтений ленты (первых страниц) — для проверки слияния сигналов */
  reads = 0;

  constructor(o: EventFeedOptions) {
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Слушатель событий ленты (разбор по типам — dispatch.ts, ожидание подписи — клиент мандатов); вернуть — отписка.
   *  Курсор сохраняется после всех слушателей; упавший слушатель — курсор на месте, событие прочитается снова.
   *  Слушатель не ждёт `signal()` и `items()`: цикл ждёт слушателя, и ожидание было бы взаимным (ревью К2.2 № 4). Флага
   *  «внутри слушателя» нет намеренно: `items()` возобновляется потребителем и в это время, с флагом его опрос крутился
   *  бы без паузы. Слушатели ядра — разбор по типам (GET объекта) и очередь `items()`. */
  listen(l: FeedListener): () => void {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }

  /** Курсор, на котором стоит лента (null — с начала); до первого чтения — загрузка из хранилища. */
  cursor(): string | null {
    return this.#load();
  }

  /**
   * Сигнал «прочитай ленту» (push, опрос, ожидающий). Чтение идёт сейчас — сигнал сливается в одно следующее чтение
   * и возвращается обещание текущего цикла; иначе — новый цикл. Цикл кончается, когда за время чтения сигналов не было.
   */
  signal(): Promise<void> {
    if (this.#stopped) return Promise.reject(this.#stopped);
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = this.#loop();
    return this.#running;
  }

  /**
   * События ленты по мере чтения, пока не прерван `abort`: опрос — не чаще event_poll_interval_ms. Только сигнал для
   * ожидающего, а не обработка: курсор сохраняется, когда событие положено в очередь, а не когда потребитель его взял
   * (прерванный или упавший потребитель остаток очереди теряет). Потому потребитель обязан сверять состояние по GET
   * (Р29 п. 5) — и до ожидания: событие, прочитанное раньше регистрации, сюда не попадает (ревью К2.2 № 3).
   */
  async *items(abort?: AbortSignal): AsyncGenerator<FeedItem> {
    const queue: FeedItem[] = [];
    const off = this.listen((i) => void queue.push(i));
    try {
      while (!abort?.aborted) {
        await this.signal();
        while (queue.length > 0) {
          yield queue.shift() as FeedItem;
          if (abort?.aborted) return;
        }
      }
    } finally {
      off();
    }
  }

  /** #running обнуляется в том же такте, что проверка #again: сигнал не попадёт в окно «цикл кончился, а #running
   *  ещё стоит» и не потеряется (ревью К2.2 № 1). */
  async #loop(): Promise<void> {
    try {
      for (;;) {
        this.#again = false;
        const wait = this.#lastStart + this.#o.params.event_poll_interval_ms - this.#now().getTime();
        if (wait > 0) await this.#sleep(wait);
        this.#lastStart = this.#now().getTime();
        await this.#readToEnd();
        this.#failingSince = null;
        if (!this.#again) {
          this.#running = null;
          return;
        }
      }
    } catch (e) {
      this.#running = null;
      if (!(e instanceof EventsStopped)) this.#failed(e);
      throw e;
    }
  }

  /** Чтение не дошло до пустой страницы (отказ Платформы, слушатель упал — в том числе долгий 503 на GET операции или
   *  подтверждения, подпись приостановлена): первое в серии — запись events.unavailable; серия не меньше
   *  registry_cache_ttl_sec — приостановка подписи (Р50 п. 2, дополнение 1; Т14). Серию сбрасывает только успешное
   *  чтение: после снятия приостановки recheck() первое неудачное чтение приостанавливает снова. Сбой журнала — наружу. */
  #failed(e: unknown): void {
    const now = this.#now().getTime();
    if (this.#failingSince === null) {
      this.#failingSince = now;
      this.#o.journal.record({ at: this.#at(), kind: "events.unavailable", reason: "EVENTS_UNAVAILABLE", detail: e instanceof PlatformFailure ? e.code : "UNKNOWN" });
    }
    if (now - this.#failingSince >= this.#o.params.registry_cache_ttl_sec * 1000) this.#o.suspend("EVENTS_UNAVAILABLE");
  }

  /** Самопроверка при старте (Р36 п. 6): курсор читается до обращений к Платформе; не читается — остановка агента
   *  (EVENTS_CURSOR_INVALID, UNREADABLE) и EventsStopped; файла нет — events.cursor_initial. */
  checkCursor(): void {
    this.#load();
  }

  #load(): string | null {
    if (this.#stopped) throw this.#stopped;
    if (this.#after !== undefined) return this.#after;
    try {
      this.#after = this.#o.store.load();
    } catch (e) {
      if (e instanceof CursorInvalid) throw this.#halt("UNREADABLE");
      throw e;
    }
    if (this.#after === null) this.#o.journal.record({ at: this.#at(), kind: "events.cursor_initial" });
    return this.#after;
  }

  /** Страницы до пустой; каждое событие — слушателям, затем курсор (п. 3). */
  async #readToEnd(): Promise<void> {
    let after = this.#load();
    this.reads++;
    for (;;) {
      let page: FeedItem[];
      try {
        page = await this.#o.port.listEvents(after);
      } catch (e) {
        // Курсор отвергнут Платформой (чужой, неизвестный, не по форме — РП39 п. 7): молча с начала нельзя (п. 4).
        // Только 400 по x-pao-errors: 404 / 413 / 414 — ответ транспорта §6, о курсоре не говорит (Р58 п. 1).
        if (after !== null && e instanceof PlatformFailure && e.code === "REQUEST_INVALID" && e.httpStatus === 400) throw this.#halt("REJECTED");
        throw e;
      }
      if (page.length === 0) return;
      for (const item of page) {
        const ref = item.kind === "event" ? item.event.eventId : item.eventId;
        // маска — и здесь, до журнала и курсора, а не только в адаптере (ревью К2.2 № 7)
        if (!EVENT_ID.test(ref)) throw new PlatformFailure("BAD_RESPONSE", "never", null, 200, null, "event_id не по форме");
        for (const l of [...this.#listeners]) await l(item);
        // журнал — после слушателей: «обработано» пишется один раз, когда обработка прошла (ревью К2.2 № 2)
        if (item.kind === "event") this.#o.journal.record({ at: this.#at(), kind: "event.handled", ref, detail: item.event.type });
        else this.#o.journal.record({ at: this.#at(), kind: "event.ignored", ref, detail: item.detail });
        this.#o.store.save(ref);
        this.#after = after = ref;
      }
    }
  }

  #halt(detail: "UNREADABLE" | "REJECTED"): EventsStopped {
    this.#stopped ??= new EventsStopped(detail);
    this.#o.stop(EVENTS_CURSOR_INVALID, detail);
    return this.#stopped;
  }

  #at(): string {
    return this.#now().toISOString();
  }
}
