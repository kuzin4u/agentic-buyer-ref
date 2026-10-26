// Лента событий (Р34 п. 1–4, 6, 9; уточнение 1 и ответ (а) владельца): порядок ленты, курсор после каждого события,
// неизвестный тип — пропуск с журналом, курсор не читается или отвергнут — остановка агента EVENTS_CURSOR_INVALID,
// сигналы сливаются: 100 push — не больше двух чтений.
import { describe, expect, it } from "vitest";
import { EVENTS_CURSOR_INVALID, EventFeed, EventsStopped, MemoryCursorStore } from "../../src/agent/events/index.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import type { EventsPort, FeedItem } from "../../src/agent/ports/events.js";
import { loadParams } from "../../src/shared/config.js";
import { PlatformFailure, type PlatformEventType } from "../../src/shared/domain.js";

/** промежуток опроса — из стендовой конфигурации, не литералом */
const POLL = loadParams().event_poll_interval_ms;
const TTL_SEC = loadParams().registry_cache_ttl_sec;

const ev = (id: string, type: PlatformEventType = "mandate.signed", mandateId: string | null = "m_1"): FeedItem => ({
  kind: "event",
  event: { eventId: id, type, at: "2026-10-19T09:00:00.000Z", mandateId, opRef: null, confirmationId: null, declineReason: null },
});

/** Лента Платформы в памяти: страницы по `page`, курсор — event_id; чужой курсор — 400 REQUEST_INVALID. */
class FakeFeed implements EventsPort {
  readonly calls: (string | null)[] = [];
  constructor(
    public items: FeedItem[],
    private readonly page = 2,
  ) {}
  async listEvents(after: string | null): Promise<FeedItem[]> {
    this.calls.push(after);
    const ids = this.items.map((i) => (i.kind === "event" ? i.event.eventId : i.eventId));
    const from = after === null ? 0 : ids.indexOf(after) + 1;
    if (after !== null && from === 0) throw new PlatformFailure("REQUEST_INVALID", "after_fix", "REQUEST_INVALID", 400, null);
    return this.items.slice(from, from + this.page);
  }
  async subscribe(): Promise<void> {}
}

function setup(items: FeedItem[], o: { store?: MemoryCursorStore; interval?: number } = {}) {
  const port = new FakeFeed(items);
  const store = o.store ?? new MemoryCursorStore();
  const journal = new MemoryJournal();
  const stops: [string, string][] = [];
  const suspends: string[] = [];
  let t = Date.parse("2026-10-19T09:00:00Z");
  const sleeps: number[] = [];
  const feed = new EventFeed({
    port,
    store,
    journal,
    stop: (r, d) => void stops.push([r, d]),
    suspend: (r) => void suspends.push(r),
    params: { event_poll_interval_ms: o.interval ?? POLL, registry_cache_ttl_sec: TTL_SEC },
    now: () => new Date(t),
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });
  const seen: FeedItem[] = [];
  feed.listen((i) => void seen.push(i));
  return { feed, port, store, journal, stops, suspends, sleeps, seen, tick: (ms: number) => (t += ms) };
}

describe("лента: недоступность дольше registry_cache_ttl_sec (Р50 п. 2, дополнение 1; Т14)", () => {
  const unavailable = () => new PlatformFailure("UPSTREAM_UNAVAILABLE", "same_key", "UPSTREAM_UNAVAILABLE", 503, null);

  it("серия отказов: первая — events.unavailable с кодом; не меньше TTL — приостановка; до TTL — нет", async () => {
    const s = setup([ev("e1")]);
    s.port.listEvents = async () => {
      throw unavailable();
    };
    await expect(s.feed.signal()).rejects.toBeInstanceOf(PlatformFailure);
    s.tick(TTL_SEC * 1000 - 1);
    await expect(s.feed.signal()).rejects.toBeInstanceOf(PlatformFailure);
    expect(s.suspends).toEqual([]);
    s.tick(1);
    await expect(s.feed.signal()).rejects.toBeInstanceOf(PlatformFailure);
    expect(s.suspends).toEqual(["EVENTS_UNAVAILABLE"]);
    const marks = s.journal.entries.filter((e) => e.kind === "events.unavailable");
    expect(marks.map((e) => [e.reason, e.detail])).toEqual([["EVENTS_UNAVAILABLE", "UPSTREAM_UNAVAILABLE"]]);
    expect(s.stops).toEqual([]);
  });

  it("успешное чтение сбрасывает серию: новая серия считается заново", async () => {
    const s = setup([ev("e1")]);
    const real = s.port.listEvents.bind(s.port);
    let down = true;
    s.port.listEvents = async (after) => {
      if (down) throw unavailable();
      return real(after);
    };
    await expect(s.feed.signal()).rejects.toBeInstanceOf(PlatformFailure);
    s.tick(TTL_SEC * 1000 - 1);
    down = false;
    await s.feed.signal();
    down = true;
    s.tick(1);
    await expect(s.feed.signal()).rejects.toBeInstanceOf(PlatformFailure);
    expect(s.suspends).toEqual([]);
    expect(s.journal.entries.filter((e) => e.kind === "events.unavailable")).toHaveLength(2);
  });

  it("отказ слушателя (долгий 503 на GET операции или подтверждения) — та же серия; после снятия приостановки первое неудачное чтение приостанавливает снова", async () => {
    const s = setup([ev("e1", "operation.authorized", null)]);
    s.feed.listen(() => {
      throw unavailable();
    });
    await expect(s.feed.signal()).rejects.toBeInstanceOf(PlatformFailure);
    s.tick(TTL_SEC * 1000);
    await expect(s.feed.signal()).rejects.toBeInstanceOf(PlatformFailure);
    // recheck() снял приостановку снаружи; лента всё ещё не читается — серия не сброшена
    await expect(s.feed.signal()).rejects.toBeInstanceOf(PlatformFailure);
    expect(s.suspends).toEqual(["EVENTS_UNAVAILABLE", "EVENTS_UNAVAILABLE"]);
    expect(s.store.saved).toEqual([]);
  });

  it("остановка по курсору (REJECTED) — не серия недоступности: записи events.unavailable и приостановки нет", async () => {
    const store = new MemoryCursorStore();
    store.after = "evt_foreign";
    const s = setup([ev("e1")], { store });
    await expect(s.feed.signal()).rejects.toBeInstanceOf(EventsStopped);
    s.tick(TTL_SEC * 1000);
    await expect(s.feed.signal()).rejects.toBeInstanceOf(EventsStopped);
    expect(s.journal.entries.filter((e) => e.kind === "events.unavailable")).toEqual([]);
    expect(s.suspends).toEqual([]);
  });
});

describe("лента: порядок и курсор (Р34 п. 1, 3, 4)", () => {
  it("первый запуск — с начала, страницы до пустой; курсор — после каждого события; журнал — event_id и тип", async () => {
    const s = setup([ev("e1"), ev("e2", "operation.authorized", null), ev("e3")]);
    await s.feed.signal();
    expect(s.seen.map((i) => (i.kind === "event" ? i.event.eventId : i.eventId))).toEqual(["e1", "e2", "e3"]);
    expect(s.port.calls).toEqual([null, "e2", "e3"]);
    expect(s.store.saved).toEqual(["e1", "e2", "e3"]);
    expect(s.journal.entries.map((e) => [e.kind, e.ref, e.detail])).toEqual([
      ["events.cursor_initial", undefined, undefined],
      ["event.handled", "e1", "mandate.signed"],
      ["event.handled", "e2", "operation.authorized"],
      ["event.handled", "e3", "mandate.signed"],
    ]);
    expect(s.stops).toEqual([]);
  });

  it("перезапуск: лента с сохранённого курсора, прежние события повторно не обрабатываются", async () => {
    const store = new MemoryCursorStore();
    store.after = "e2";
    const s = setup([ev("e1"), ev("e2"), ev("e3")], { store });
    await s.feed.signal();
    expect(s.port.calls[0]).toBe("e2");
    expect(s.seen).toHaveLength(1);
    expect(s.journal.entries.some((e) => e.kind === "events.cursor_initial")).toBe(false);
  });

  it("повтор того же event_id — один раз: второе чтение после курсора пусто", async () => {
    const s = setup([ev("e1")], { interval: 0 });
    await s.feed.signal();
    await s.feed.signal();
    expect(s.seen).toHaveLength(1);
    expect(s.port.calls).toEqual([null, "e1", "e1"]);
  });

  it("слушатель упал — курсор не сдвинут, следующее чтение обрабатывает событие снова (не менее одного раза)", async () => {
    const s = setup([ev("e1"), ev("e2")], { interval: 0 });
    let fail = true;
    s.feed.listen((i) => {
      if (fail && i.kind === "event" && i.event.eventId === "e2") throw new Error("GET мандата: 503");
    });
    await expect(s.feed.signal()).rejects.toThrow("503");
    expect(s.store.saved).toEqual(["e1"]);
    // «обработано» — только после слушателей: у e2 записи нет (ревью К2.2 № 2)
    expect(s.journal.entries.filter((e) => e.kind === "event.handled").map((e) => e.ref)).toEqual(["e1"]);
    fail = false;
    await s.feed.signal();
    expect(s.store.saved).toEqual(["e1", "e2"]);
    expect(s.port.calls.at(-2)).toBe("e1");
    expect(s.journal.entries.filter((e) => e.kind === "event.handled").map((e) => e.ref)).toEqual(["e1", "e2"]);
  });
});

describe("неизвестный тип и data не по схеме — пропуск с журналом (Р34 п. 6)", () => {
  it("курсор двигается, агент не останавливается; тип вне перечня в журнал не пишется", async () => {
    const items: FeedItem[] = [
      { kind: "ignored", eventId: "e1", detail: "UNKNOWN_TYPE" },
      { kind: "ignored", eventId: "e2", detail: "INVALID_DATA", type: "mandate.signed" },
      ev("e3"),
    ];
    const s = setup(items);
    await s.feed.signal();
    expect(s.store.saved).toEqual(["e1", "e2", "e3"]);
    expect(s.stops).toEqual([]);
    expect(s.journal.entries.filter((e) => e.kind === "event.ignored").map((e) => [e.ref, e.detail])).toEqual([
      ["e1", "UNKNOWN_TYPE"],
      ["e2", "INVALID_DATA"],
    ]);
    // слушатели получают и пропуски: mandate.* без mandate_id — перечитать мандаты (ответ (б), К2.4)
    expect(s.seen).toEqual(items);
  });
});

describe("курсор не читается или отвергнут — остановка агента (Р34 п. 4, ответ (а))", () => {
  it("хранилище не читается — EVENTS_CURSOR_INVALID / UNREADABLE, обращений нет", async () => {
    const store = new MemoryCursorStore();
    store.invalid = true;
    const s = setup([ev("e1")], { store });
    await expect(s.feed.signal()).rejects.toBeInstanceOf(EventsStopped);
    expect(s.stops).toEqual([[EVENTS_CURSOR_INVALID, "UNREADABLE"]]);
    expect(s.port.calls).toEqual([]);
  });

  it("Платформа отвергла курсор (400) — REJECTED; курсор не сбрасывается, дальше — без обращений", async () => {
    const store = new MemoryCursorStore();
    store.after = "evt_foreign";
    const s = setup([ev("e1")], { store });
    await expect(s.feed.signal()).rejects.toMatchObject({ detail: "REJECTED" });
    expect(s.stops).toEqual([[EVENTS_CURSOR_INVALID, "REJECTED"]]);
    expect(store.after).toBe("evt_foreign");
    await expect(s.feed.signal()).rejects.toBeInstanceOf(EventsStopped);
    expect(s.port.calls).toEqual(["evt_foreign"]);
  });

  it("Р58 п. 1: REQUEST_INVALID ответа транспорта (404, 414) с курсором — не «курсор отвергнут»: отказ как есть, лента не остановлена", async () => {
    for (const status of [404, 414]) {
      const store = new MemoryCursorStore();
      store.after = "e1";
      const s = setup([], { store });
      s.port.listEvents = async () => {
        throw new PlatformFailure("REQUEST_INVALID", "after_fix", "REQUEST_INVALID", status, null);
      };
      await expect(s.feed.signal(), String(status)).rejects.toMatchObject({ code: "REQUEST_INVALID", httpStatus: status });
      expect(s.stops, String(status)).toEqual([]);
    }
  });

  it("400 без курсора — не курсор: отказ как есть, ленту не останавливает", async () => {
    const s = setup([]);
    s.port.listEvents = async () => {
      throw new PlatformFailure("REQUEST_INVALID", "after_fix", "REQUEST_INVALID", 400, null);
    };
    await expect(s.feed.signal()).rejects.toBeInstanceOf(PlatformFailure);
    expect(s.stops).toEqual([]);
  });
});

describe("слияние сигналов (уточнение 1 владельца)", () => {
  it("100 push подряд — не больше двух чтений ленты", async () => {
    const s = setup([ev("e1")]);
    await Promise.all(Array.from({ length: 100 }, () => s.feed.signal()));
    expect(s.feed.reads).toBe(2);
    // первое чтение: страница с e1 и пустая после него; второе — пустая после e1, через промежуток опроса
    expect(s.port.calls).toEqual([null, "e1", "e1"]);
    expect(s.sleeps).toEqual([POLL]);
    expect(s.seen).toHaveLength(1);
  });

  it("сигнал на любой глубине микрозадач после последнего чтения даёт новое чтение (ревью К2.2 № 1)", async () => {
    for (let depth = 0; depth < 12; depth++) {
      const s = setup([], { interval: 0 });
      let late: Promise<void> | undefined;
      const inner = s.port.listEvents.bind(s.port);
      s.port.listEvents = async (after) => {
        const page = await inner(after);
        if (late === undefined) {
          // сигнал приходит, когда последнее чтение уже вернуло пустую страницу, — через depth микрозадач
          let p: Promise<unknown> = Promise.resolve();
          for (let i = 0; i < depth; i++) p = p.then(() => undefined);
          late = p.then(() => s.feed.signal());
        }
        return page;
      };
      await s.feed.signal();
      await late;
      // после сигнала из окна было ещё одно чтение, а не возврат завершённого цикла
      expect(s.feed.reads, `глубина ${depth}`).toBe(2);
    }
  });

  it("сигнал сразу после последнего чтения цикла не теряется (ревью К2.2 № 1)", async () => {
    const s = setup([], { interval: 0 });
    const first = s.feed.signal();
    await first;
    // цикл завершён — новый сигнал обязан дать новое чтение, а не вернуть прежнее обещание
    const second = s.feed.signal();
    expect(second).not.toBe(first);
    await second;
    expect(s.feed.reads).toBe(2);
  });

  it("чтения — не чаще event_poll_interval_ms: второе ждёт остаток промежутка", async () => {
    const s = setup([]);
    const part = Math.floor(POLL / 3);
    await s.feed.signal();
    s.tick(part);
    await s.feed.signal();
    expect(s.sleeps).toEqual([POLL - part]);
    s.tick(POLL * 5);
    await s.feed.signal();
    expect(s.sleeps).toEqual([POLL - part]);
  });
});

describe("items(): события по мере чтения, пока не прерван", () => {
  it("отдаёт события ленты и останавливается по abort", async () => {
    const s = setup([ev("e1"), ev("e2")]);
    const abort = new AbortController();
    const got: string[] = [];
    for await (const i of s.feed.items(abort.signal)) {
      if (i.kind === "event") got.push(i.event.eventId);
      if (got.length === 2) abort.abort();
    }
    expect(got).toEqual(["e1", "e2"]);
  });
});
