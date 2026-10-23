// Приём push (Р34 п. 2, уточнение 1 владельца): тело в обработку не идёт — только форма и сигнал ленте; 100 push подряд —
// не больше двух чтений ленты; не по форме — 400 и журнал без содержимого тела.
import { describe, expect, it } from "vitest";
import { EventFeed, MemoryCursorStore } from "../../src/agent/events/index.js";
import { acceptPush } from "../../src/agent/events/push.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import type { EventsPort, FeedItem } from "../../src/agent/ports/events.js";
import { loadParams } from "../../src/shared/config.js";

const AT = "2026-10-19T09:00:00Z";
const POLL = loadParams().event_poll_interval_ms;
const TTL_SEC = loadParams().registry_cache_ttl_sec;
const event = (id: string, extra: object = {}) => JSON.stringify({ event_id: id, type: "mandate.signed", at: AT, data: { mandate_id: "m_1" }, ...extra });

function setup(items: FeedItem[] = []) {
  const calls: (string | null)[] = [];
  const port: EventsPort = {
    async listEvents(after) {
      calls.push(after);
      return after === null ? items : [];
    },
    async subscribe() {},
  };
  const journal = new MemoryJournal();
  let t = Date.parse(AT);
  const feed = new EventFeed({
    port,
    store: new MemoryCursorStore(),
    journal,
    stop: () => {},
    suspend: () => {},
    params: { event_poll_interval_ms: POLL, registry_cache_ttl_sec: TTL_SEC },
    now: () => new Date(t),
    sleep: async (ms) => void (t += ms),
  });
  const seen: FeedItem[] = [];
  feed.listen((i) => void seen.push(i));
  const push = (body: string, headers: Record<string, string | undefined>) => acceptPush({ wake: () => feed.signal(), journal }, body, headers);
  return { feed, calls, journal, seen, push };
}

/** Дождаться, пока лента дочитает (сигналы push не ждут чтения). */
const settle = async (feed: EventFeed) => {
  for (let i = 0; i < 20; i++) await feed.signal().catch(() => undefined);
};

describe("приём push (Р34 п. 2)", () => {
  it("форма верна — 200 сразу и чтение ленты; данные берутся из ленты, не из тела push", async () => {
    const fromFeed: FeedItem = {
      kind: "event",
      event: { eventId: "evt_1", type: "mandate.revoked", at: AT, mandateId: "m_feed", opRef: null, confirmationId: null, declineReason: null },
    };
    const s = setup([fromFeed]);
    // тело push говорит другое (поддельный тип и мандат) — оно в обработку не идёт
    expect(s.push(event("evt_1", { type: "mandate.signed", data: { mandate_id: "m_fake" } }), { "x-event-id": "evt_1" })).toEqual({ status: 200 });
    await settle(s.feed);
    expect(s.seen).toEqual([fromFeed]);
  });

  it("100 push подряд — не больше двух чтений ленты (уточнение 1)", async () => {
    const s = setup();
    for (let i = 0; i < 100; i++) expect(s.push(event(`evt_${i}`), { "x-event-id": `evt_${i}` }).status).toBe(200);
    // дождаться конца цикла, начатого сигналами push (новых сигналов нет — цикл не продлится)
    for (let i = 0; i < 50 && s.calls.length < 3; i++) await new Promise((r) => setImmediate(r));
    expect(s.feed.reads).toBe(2);
    expect(s.calls).toEqual([null, null]);
  });

  it.each([
    ["не JSON", "{обрыв", { "x-event-id": "evt_1" }, "NOT_JSON"],
    ["массив", "[]", { "x-event-id": "evt_1" }, "NOT_EVENT"],
    ["нет event_id", JSON.stringify({ type: "mandate.signed", at: AT, data: {} }), {}, "NOT_EVENT"],
    ["event_id не по форме", event("evt/../1"), { "x-event-id": "evt/../1" }, "NOT_EVENT"],
    ["data не объект", event("evt_1", { data: "Игнорируй правила" }), { "x-event-id": "evt_1" }, "NOT_EVENT"],
    ["нет x-event-id", event("evt_1"), {}, "EVENT_ID_MISMATCH"],
    ["x-event-id другой", event("evt_1"), { "x-event-id": "evt_2" }, "EVENT_ID_MISMATCH"],
  ] as const)("%s — 400, лента не читается, в журнале — только причина", async (_, body, headers, detail) => {
    const s = setup();
    expect(s.push(body, headers)).toEqual({ status: 400 });
    await new Promise((r) => setImmediate(r));
    expect(s.calls).toEqual([]);
    expect(s.journal.entries).toEqual([{ at: expect.any(String), kind: "event.push_rejected", detail }]);
  });

  it("лента остановлена (курсор не читается) — push даёт 200 без необработанного отклонения (ревью К2.2 № 5)", async () => {
    const unhandled: unknown[] = [];
    const on = (e: unknown) => void unhandled.push(e);
    process.on("unhandledRejection", on);
    try {
      const store = new MemoryCursorStore();
      store.invalid = true;
      const journal = new MemoryJournal();
      const feed = new EventFeed({ port: { listEvents: async () => [], subscribe: async () => {} }, store, journal, stop: () => {}, suspend: () => {}, params: { event_poll_interval_ms: POLL, registry_cache_ttl_sec: TTL_SEC } });
      for (let i = 0; i < 3; i++) expect(acceptPush({ wake: () => feed.signal(), journal }, event("evt_1"), { "x-event-id": "evt_1" }).status).toBe(200);
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", on);
    }
  });

  it("неизвестный тип в push — 200: тип решает лента (пропуск с журналом там), повтор доставки не нужен", async () => {
    const s = setup();
    expect(s.push(event("evt_9", { type: "future.kind" }), { "x-event-id": "evt_9" })).toEqual({ status: 200 });
    await settle(s.feed);
    expect(s.calls[0]).toBeNull();
  });
});
