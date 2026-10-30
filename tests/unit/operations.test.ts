// Модуль операций (Р49 п. 3–7): событие operation.* — сигнал, итог — по GET; привязка к покупке по order_ref, сверка с
// CART (признак, продавец, сумма, канал); дубли по event_id; GET, который Платформа просит повторить, — событие читается
// снова; стадия 6 — GET по op_ref, без события — снова GET не чаще operation_reread_interval_sec, граница — reservation_ttl_sec
// (Р51 п. 2), прерывание — PENDING.
import { describe, expect, it, vi } from "vitest";
import { Operations, type OperationOutcome, type SettleOutcome, type WatchAfter } from "../../src/agent/operations/index.js";
import type { FeedItem } from "../../src/agent/ports/events.js";
import { DIAG } from "../../src/agent/compose.js";
import { loadParams } from "../../src/shared/config.js";
import { PlatformFailure, type Mandate, type Operation, type OperationRecord, type PlatformEventType } from "../../src/shared/domain.js";
import { trackedSignal } from "../support/signal.js";

const T0 = Date.parse("2026-10-23T12:00:00.000Z");
const PARAMS = loadParams();
const DELAY_SEC = PARAMS.operation_outcome_max_delay_sec;
const TTL_SEC = PARAMS.registry_cache_ttl_sec;
const REREAD_SEC = PARAMS.operation_reread_interval_sec;
const AG = "nspk:agent:buyer:v1";
const ORDER = "ord_1";
const CART: Mandate = {
  id: "m_cart_1",
  kind: "CART",
  status: "ACTIVE",
  cart: { merchantId: "MER-T1", lines: [{ sku: "bread", qty: 2, price: { amount: 45_000, currency: "RUB" } }], total: { amount: 90_000, currency: "RUB" } },
} as unknown as Mandate;

function clock() {
  let now = T0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    now: () => new Date(now),
    timer: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => void (t.live = false);
    },
    /** таймеров, которые ещё сработают (не сняты и не сработали) */
    live: () => timers.filter((t) => t.live).length,
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.live = false;
        now = due.at;
        due.fn();
        await tick();
      }
      now = until;
    },
  };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

function record(status: OperationRecord["status"], over: Partial<OperationRecord> = {}): OperationRecord {
  return {
    opRef: "op_1",
    orderRef: ORDER,
    channel: "CARD",
    amountMinor: 90_000,
    merchantId: "MER-T1",
    indicator: { agentCode: AG, mandateId: CART.id },
    status,
    declineReason: null,
    fulfilment: null,
    ...over,
  };
}

function setup(wake?: (ops: Operations) => Promise<void>, pollMs?: number, seenMax = PARAMS.event_seen_max) {
  const c = clock();
  const answers = new Map<string, OperationRecord | Error>();
  /** ответ GET /pao/v1/operations?mandate_id — по id мандата; нет — пустой список */
  const lists = new Map<string, OperationRecord[] | Error>();
  const gets: string[] = [];
  const journal: Record<string, unknown>[] = [];
  const ops: Operations = new Operations({
    port: {
      readOperation: async (opRef: string) => {
        gets.push(opRef);
        const a = answers.get(opRef);
        if (a === undefined) throw new PlatformFailure("REQUEST_INVALID", "after_fix", "REQUEST_INVALID", 400, null);
        if (a instanceof Error) throw a;
        return structuredClone(a);
      },
      readOperations: async (mandateId: string) => {
        gets.push(`list ${mandateId}`);
        const a = lists.get(mandateId) ?? [];
        if (a instanceof Error) throw a;
        return structuredClone(a);
      },
    },
    journal: { record: (e) => void journal.push(e) },
    params: {
      operation_outcome_max_delay_sec: DELAY_SEC,
      operation_reread_interval_sec: REREAD_SEC,
      registry_cache_ttl_sec: TTL_SEC,
      event_seen_max: seenMax,
      ...(pollMs !== undefined && { event_poll_interval_ms: pollMs }),
    },
    ...(wake && { wake: (): Promise<void> => wake(ops) }),
    now: c.now,
    timer: c.timer,
  });
  let seq = 0;
  const event = async (type: PlatformEventType, opRef: string, eventId = `evt_${++seq}`) => {
    const item: FeedItem = { kind: "event", event: { eventId, type, at: c.now().toISOString(), mandateId: null, opRef, confirmationId: null, declineReason: null } };
    await ops.listener(item);
    await tick();
  };
  /** ожидание итога стадии 5 по ORDER со сроком DELAY_SEC */
  const waiting = (orderRef = ORDER) => {
    const ac = new AbortController();
    const w = ops.expect(orderRef, CART);
    let outcome: OperationOutcome | Error | undefined;
    w.outcome(DELAY_SEC * 1000, ac.signal).then((o) => (outcome = o), (e: Error) => (outcome = e));
    return { ac, w, outcome: () => outcome };
  };
  return { c, answers, lists, gets, journal, ops, event, waiting };
}

const kinds = (journal: Record<string, unknown>[]) => journal.map((e) => `${String(e.kind)}:${String(e.detail ?? e.reason ?? "")}`);

describe("стадия 5: итог операции по событию и GET (Р49 п. 3, 5)", () => {
  it("operation.authorized → GET → привязка по order_ref → операция в валюте CART", async () => {
    const s = setup();
    const w = s.waiting();
    s.answers.set("op_1", record("AUTHORIZED"));
    await s.event("operation.authorized", "op_1");
    expect(w.outcome()).toEqual({
      kind: "OPERATION",
      operation: expect.objectContaining({ opRef: "op_1", orderRef: ORDER, status: "AUTHORIZED", amount: { amount: 90_000, currency: "RUB" }, fulfilment: null }),
    });
    expect(kinds(s.journal)).toEqual(["operation.status:AUTHORIZED"]);
  });

  it("событие пришло раньше вызова outcome — итог сразу; следующие события по заказу итог не меняют", async () => {
    const s = setup();
    const w = s.ops.expect(ORDER, CART);
    s.answers.set("op_1", record("DECLINED", { declineReason: "LIMIT_EXCEEDED" }));
    await s.event("operation.declined", "op_1");
    s.answers.set("op_2", record("AUTHORIZED", { opRef: "op_2" }));
    await s.event("operation.authorized", "op_2");
    const o = await w.outcome(1, new AbortController().signal);
    expect(o).toMatchObject({ kind: "OPERATION", operation: { opRef: "op_1", status: "DECLINED", declineReason: "LIMIT_EXCEEDED" } });
  });

  it("без события за срок — NONE (дальше OPERATION_RESULT_UNCONFIRMED); прерывание — отказ с причиной", async () => {
    const s = setup();
    const w = s.waiting();
    await s.c.advance(DELAY_SEC * 1000 - 1);
    expect(w.outcome()).toBeUndefined();
    await s.c.advance(1);
    expect(w.outcome()).toEqual({ kind: "NONE" });
    const v = s.waiting("ord_2");
    v.ac.abort(new Error("стоп"));
    await tick();
    expect(v.outcome()).toBeInstanceOf(Error);
  });

  it("AG-12 ч. 3б (ревью КТ1 Р49 № 14 (в)): исход ожидания — событие, срок или прерывание — ни таймера срока, ни слушателя abort не остаётся", async () => {
    const cases: [string, (s: ReturnType<typeof setup>, t: ReturnType<typeof trackedSignal>) => Promise<void>][] = [
      ["событие", async (s) => (s.answers.set("op_1", record("AUTHORIZED")), await s.event("operation.authorized", "op_1"))],
      ["срок", async (s) => await s.c.advance(DELAY_SEC * 1000)],
      ["прерывание", async (_s, t) => (t.ac.abort(new Error("стоп")), await tick())],
    ];
    for (const [name, decide] of cases) {
      const s = setup();
      const t = trackedSignal();
      const w = s.ops.expect(ORDER, CART);
      const done = w.outcome(DELAY_SEC * 1000, t.signal).then(
        (o) => o.kind,
        () => "ERROR",
      );
      await tick();
      // пока ждёт — один таймер срока и один слушатель abort
      expect([s.c.live(), t.live()], name).toEqual([1, 1]);
      await decide(s, t);
      expect(await done, name).toBe(name === "событие" ? "OPERATION" : name === "срок" ? "NONE" : "ERROR");
      expect([s.c.live(), t.live()], name).toEqual([0, 0]);
      w.close();
    }
  });

  it("операция другого заказа — operation.unclaimed; не этого агента (400) — operation.foreign; ожидающая не задета", async () => {
    const s = setup();
    const w = s.waiting();
    s.answers.set("op_9", record("AUTHORIZED", { opRef: "op_9", orderRef: "ord_other" }));
    await s.event("operation.authorized", "op_9");
    await s.event("operation.authorized", "op_unknown");
    expect(kinds(s.journal)).toEqual(["operation.status:AUTHORIZED", "operation.unclaimed:", "operation.foreign:"]);
    expect(w.outcome()).toBeUndefined();
  });

  it("Р58 п. 1: REQUEST_INVALID ответа транспорта (404) — не «чужая», а operation.unread с кодом", async () => {
    const s = setup();
    s.answers.set("op_9", new PlatformFailure("REQUEST_INVALID", "after_fix", "REQUEST_INVALID", 404, null));
    await s.event("operation.authorized", "op_9");
    expect(kinds(s.journal)).toEqual(["operation.unread:REQUEST_INVALID"]); // detail — код отказа
  });

  it("order_ref не по маске (адаптер отдал null) — не привязывается", async () => {
    const s = setup();
    const w = s.waiting();
    s.answers.set("op_1", record("AUTHORIZED", { orderRef: null }));
    await s.event("operation.authorized", "op_1");
    expect(kinds(s.journal).at(-1)).toBe("operation.unclaimed:");
    expect(w.outcome()).toBeUndefined();
  });

  it("дубль события (лента и push) — один GET", async () => {
    const s = setup();
    s.waiting();
    s.answers.set("op_1", record("AUTHORIZED"));
    await s.event("operation.authorized", "op_1", "evt_same");
    await s.event("operation.authorized", "op_1", "evt_same");
    expect(s.gets).toEqual(["op_1"]);
  });

  it("Р50 п. 1: окно event_seen_max — дубль в окне без GET, вытесненное событие читается снова", async () => {
    const s = setup(undefined, undefined, 2);
    for (const op of ["op_a", "op_b", "op_c"]) s.answers.set(op, record("AUTHORIZED"));
    await s.event("operation.authorized", "op_a", "evt_a");
    await s.event("operation.authorized", "op_b", "evt_b");
    await s.event("operation.authorized", "op_c", "evt_c");
    await s.event("operation.authorized", "op_c", "evt_c");
    await s.event("operation.authorized", "op_b", "evt_b");
    expect(s.gets).toEqual(["op_a", "op_b", "op_c"]);
    await s.event("operation.authorized", "op_a", "evt_a");
    expect(s.gets).toEqual(["op_a", "op_b", "op_c", "op_a"]);
  });

  it("GET 503 — событие не отмечено обработанным и читается снова; ответ не по схеме — operation.unread, итог по сроку", async () => {
    const s = setup();
    const w = s.waiting();
    s.answers.set("op_1", new PlatformFailure("STATE_UNAVAILABLE", "same_key", "STATE_UNAVAILABLE", 503, null));
    await expect(s.ops.listener({ kind: "event", event: { eventId: "evt_r", type: "operation.authorized", at: "x", mandateId: null, opRef: "op_1", confirmationId: null, declineReason: null } })).rejects.toBeInstanceOf(PlatformFailure);
    s.answers.set("op_1", record("AUTHORIZED"));
    await s.event("operation.authorized", "op_1", "evt_r");
    expect(w.outcome()).toMatchObject({ kind: "OPERATION" });

    const t = setup();
    const v = t.waiting();
    t.answers.set("op_1", new PlatformFailure("BAD_RESPONSE", "never", null, 200, null));
    await t.event("operation.authorized", "op_1");
    // в диагностике оператора — код OPERATION_UNREAD с текстом оператору, отказ — в detail (Р49 дополнение 1, условие 1)
    expect(t.journal).toEqual([expect.objectContaining({ kind: "operation.unread", ref: "op_1", reason: "OPERATION_UNREAD", detail: "BAD_RESPONSE" })]);
    expect(DIAG.OPERATION_UNREAD?.operator.ru).toMatch(/operation\.unread/);
    await t.c.advance(DELAY_SEC * 1000);
    expect(v.outcome()).toEqual({ kind: "NONE" });
  });

  it("ревью КТ1 № 3: GET 503 по событию из ленты — ожидание будит ленту снова после паузы, повторный GET даёт итог до срока", async () => {
    let delivered = false;
    // лента: событие отдаётся, пока слушатель его не обработал (при отказе курсор не сдвигается, Р34 п. 3)
    const feed = async (ops: Operations) => {
      if (delivered) return;
      await ops.listener({ kind: "event", event: { eventId: "evt_w", type: "operation.authorized", at: "x", mandateId: null, opRef: "op_1", confirmationId: null, declineReason: null } });
      delivered = true;
    };
    const s = setup(feed, 10);
    s.answers.set("op_1", new PlatformFailure("STATE_UNAVAILABLE", "same_key", "STATE_UNAVAILABLE", 503, null));
    const w = s.waiting();
    await tick();
    expect(w.outcome()).toBeUndefined();
    s.answers.set("op_1", record("AUTHORIZED"));
    // пауза опроса после отказа ленты — event_poll_interval_ms (реальное время), срок ожидания на тестовых часах не двигается
    for (let i = 0; i < 100 && w.outcome() === undefined; i++) await new Promise((r) => setTimeout(r, 5));
    expect(w.outcome()).toMatchObject({ kind: "OPERATION", operation: { status: "AUTHORIZED" } });
    expect(s.gets).toEqual(["op_1", "op_1"]);
  });

  it("две покупки ждут одну ссылку заказа — привязка неоднозначна: обе AMBIGUOUS (не NONE: поиск по CART её не снимает, ревью КТ1 Р51 № 3)", async () => {
    const s = setup();
    const a = s.waiting();
    const b = s.waiting();
    await tick();
    expect(a.outcome()).toEqual({ kind: "AMBIGUOUS" });
    expect(b.outcome()).toEqual({ kind: "AMBIGUOUS" });
  });

  it("после close() события по заказу — operation.unclaimed", async () => {
    const s = setup();
    const w = s.waiting();
    w.w.close();
    s.answers.set("op_1", record("AUTHORIZED"));
    await s.event("operation.authorized", "op_1");
    expect(kinds(s.journal).at(-1)).toBe("operation.unclaimed:");
  });
});

describe("восстановление op_ref: поиск по CART после итога без события (Р51 п. 5)", () => {
  const lookups = (journal: Record<string, unknown>[]) => journal.filter((e) => e.kind === "operation.lookup").map((e) => [e.ref, e.detail]);

  it("одна операция заказа — итог как из события, в валюте CART; запись operation.lookup BOUND с CART, без тела ответа", async () => {
    const s = setup();
    s.lists.set(CART.id, [record("AUTHORIZED"), record("DECLINED", { opRef: "op_other", orderRef: "ord_other" })]);
    const out = await s.ops.lookup(ORDER, CART);
    expect(out).toMatchObject({ kind: "OPERATION", operation: { opRef: "op_1", status: "AUTHORIZED", amount: { amount: 90_000, currency: "RUB" } } });
    expect(s.gets).toEqual([`list ${CART.id}`]);
    expect(lookups(s.journal)).toEqual([[CART.id, "BOUND"]]);
    const entry = s.journal.find((e) => e.kind === "operation.lookup")!;
    expect(Object.keys(entry).sort()).toEqual(["at", "detail", "kind", "ref"]);
  });

  it("реверсал до ответа эмитента (событий нет вовсе) — REVERSED по поиску, запись operation.reversed", async () => {
    const s = setup();
    s.lists.set(CART.id, [record("REVERSED", { declineReason: "REVERSAL" })]);
    expect(await s.ops.lookup(ORDER, CART)).toMatchObject({ kind: "OPERATION", operation: { status: "REVERSED", declineReason: "REVERSAL" } });
    expect(kinds(s.journal)).toContain("operation.reversed:REVERSAL");
  });

  it("ни одной операции заказа (операция без итога в ответ не входит) — NONE; две — AMBIGUOUS, тоже NONE (не первая)", async () => {
    const s = setup();
    s.lists.set(CART.id, [record("AUTHORIZED", { orderRef: "ord_other" })]);
    expect(await s.ops.lookup(ORDER, CART)).toEqual({ kind: "NONE" });
    s.lists.set(CART.id, [record("AUTHORIZED"), record("AUTHORIZED", { opRef: "op_2" })]);
    expect(await s.ops.lookup(ORDER, CART)).toEqual({ kind: "NONE" });
    expect(lookups(s.journal)).toEqual([[CART.id, "NONE"], [CART.id, "AMBIGUOUS"]]);
  });

  it("операция не сходится с CART — MISMATCH, запись operation.mismatch и operation.lookup MISMATCH", async () => {
    const s = setup();
    s.lists.set(CART.id, [record("AUTHORIZED", { amountMinor: 1 })]);
    expect(await s.ops.lookup(ORDER, CART)).toEqual({ kind: "MISMATCH" });
    expect(kinds(s.journal)).toEqual(["operation.mismatch:AMOUNT", "operation.lookup:MISMATCH"]);
  });

  it("отказ Платформы (404, 400, 403, ответ не по схеме) — NONE, код отказа в operation.lookup; повтора нет; иная ошибка — наружу", async () => {
    for (const [code, status] of [["MANDATE_NOT_FOUND", 404], ["REQUEST_INVALID", 400], ["AGENT_SUSPENDED", 403], ["BAD_RESPONSE", 200]] as const) {
      const s = setup();
      s.lists.set(CART.id, new PlatformFailure(code, "never", code, status, null));
      expect(await s.ops.lookup(ORDER, CART)).toEqual({ kind: "NONE" });
      expect(lookups(s.journal)).toEqual([[CART.id, code]]);
      expect(s.gets).toEqual([`list ${CART.id}`]);
    }
    const boom = new Error("журнал недоступен");
    const s = setup();
    s.lists.set(CART.id, boom);
    await expect(s.ops.lookup(ORDER, CART)).rejects.toBe(boom);
  });
});

describe("наблюдение после итога (Р51 п. 4; таблица К4 в PR #66)", () => {
  const OP: Operation = {
    opRef: "op_1",
    orderRef: ORDER,
    channel: "CARD",
    amount: { amount: 90_000, currency: "RUB" },
    merchantId: "MER-T1",
    indicator: { agentCode: AG, mandateId: CART.id },
    status: "AUTHORIZED",
    declineReason: null,
    fulfilment: null,
  };
  const ful = (scopeCheck: "WITHIN_LIMITS" | "EXCEEDS_AUTHORIZATION" | "NOT_RESERVED", finalMinor = 90_000) => ({ ref: "ful_0123456789abcdef01234567", finalMinor, scopeCheck, spentMinor: finalMinor, at: "2026-10-23T12:05:00.000Z" });
  const observing = (after: WatchAfter, seenMax?: number) => {
    const s = setup(undefined, undefined, seenMax);
    const sent: [string, unknown][] = [];
    s.ops.watch(OP, after, (code, amount) => void sent.push([code, amount]));
    return { ...s, sent };
  };
  const RUB = (amount: number) => ({ amount, currency: "RUB" });

  it("OPERATION_REVERSED × поздний SETTLED — одно уведомление OPERATION_SETTLED_LATE с суммой и валютой (не SCOPE_NOT_RESERVED); затем возврат — OPERATION_REFUNDED", async () => {
    const s = observing("REVERSED");
    s.answers.set("op_1", record("SETTLED", { fulfilment: ful("NOT_RESERVED", 85_000) }));
    await s.event("operation.settled", "op_1");
    expect(s.sent).toEqual([["OPERATION_SETTLED_LATE", RUB(85_000)]]);
    s.answers.set("op_1", record("REFUNDED", { fulfilment: ful("NOT_RESERVED", 85_000) }));
    await s.event("operation.refunded", "op_1");
    expect(s.sent).toEqual([["OPERATION_SETTLED_LATE", RUB(85_000)], ["OPERATION_REFUNDED", RUB(85_000)]]);
  });

  it("граница (UNSETTLED) × поздний SETTLED — OPERATION_SETTLED_LATE; scope_check не WITHIN_LIMITS — ещё SCOPE_* с той же суммой", async () => {
    for (const [scope, extra] of [["WITHIN_LIMITS", []], ["EXCEEDS_AUTHORIZATION", ["SCOPE_EXCEEDS_AUTHORIZATION"]]] as const) {
      const s = observing("UNSETTLED");
      s.answers.set("op_1", record("SETTLED", { fulfilment: ful(scope) }));
      await s.event("operation.settled", "op_1");
      expect(s.sent, scope).toEqual([["OPERATION_SETTLED_LATE", RUB(90_000)], ...extra.map((c) => [c, RUB(90_000)])]);
    }
  });

  it("DONE по SETTLED × возврат — OPERATION_REFUNDED; повторный SETTLED — без уведомления; DONE по REFUNDED — под наблюдение не ставится (дополнение 1 к Р65 п. 1), возврат — без второго", async () => {
    const s = observing("SETTLED");
    s.answers.set("op_1", record("SETTLED", { fulfilment: ful("WITHIN_LIMITS") }));
    await s.event("operation.settled", "op_1");
    expect(s.sent).toEqual([]);
    s.answers.set("op_1", record("REFUNDED", { fulfilment: ful("WITHIN_LIMITS") }));
    await s.event("operation.refunded", "op_1");
    expect(s.sent).toEqual([["OPERATION_REFUNDED", RUB(90_000)]]);
    const r = observing("REFUNDED");
    r.answers.set("op_1", record("REFUNDED", { fulfilment: ful("WITHIN_LIMITS") }));
    await r.event("operation.refunded", "op_1");
    expect(r.sent).toEqual([]);
    expect(kinds(r.journal)).toEqual(["operation.status:REFUNDED", "operation.unclaimed:"]);
  });

  it("условие 2 ревью чата: одно событие дважды (лента и push) — один GET и одно уведомление; второе событие с тем же итогом — без второго уведомления", async () => {
    const s = observing("REVERSED");
    s.answers.set("op_1", record("SETTLED", { fulfilment: ful("NOT_RESERVED") }));
    await s.event("operation.settled", "op_1", "evt_dup");
    await s.event("operation.settled", "op_1", "evt_dup");
    expect(s.gets).toEqual(["op_1"]);
    await s.event("operation.settled", "op_1", "evt_other");
    expect(s.sent.map(([c]) => c)).toEqual(["OPERATION_SETTLED_LATE"]);
  });

  it("условие 2 ревью чата: вытеснение из окна event_seen_max — событие по вытесненной операции — operation.unclaimed без уведомления", async () => {
    const s = observing("REVERSED", 2);
    s.ops.watch({ ...OP, opRef: "op_2", orderRef: "ord_2" }, "REVERSED", () => void s.sent.push(["op_2", null]));
    s.ops.watch({ ...OP, opRef: "op_3", orderRef: "ord_3" }, "REVERSED", () => void s.sent.push(["op_3", null]));
    s.answers.set("op_1", record("SETTLED", { fulfilment: ful("NOT_RESERVED") }));
    await s.event("operation.settled", "op_1");
    expect(s.sent).toEqual([]);
    expect(kinds(s.journal)).toEqual(["operation.status:SETTLED", "operation.unclaimed:"]);
  });

  it("ревью чата К5: settle с уведомлением покупки — под наблюдение ставит сам модуль в момент итога (SETTLED, REFUNDED, REVERSED, граница); событие сразу после выхода — не теряется", async () => {
    for (const [answer, deadline, event, expected] of [
      [record("SETTLED", { fulfilment: ful("WITHIN_LIMITS") }), undefined, record("REFUNDED", { fulfilment: ful("WITHIN_LIMITS") }), "OPERATION_REFUNDED"],
      [record("REVERSED", { declineReason: "REVERSAL" }), undefined, record("SETTLED", { fulfilment: ful("NOT_RESERVED") }), "OPERATION_SETTLED_LATE"],
      [record("AUTHORIZED"), T0, record("SETTLED", { fulfilment: ful("WITHIN_LIMITS") }), "OPERATION_SETTLED_LATE"],
    ] as const) {
      const s = setup();
      const sent: string[] = [];
      s.answers.set("op_1", answer);
      const ac = new AbortController();
      // событие обрабатывается первым продолжением после итога ожидания — раньше, чем вызывающий узнает исход
      const done = s.ops.settle(OP, ac.signal, deadline, (code) => void sent.push(code)).then(async (out) => {
        s.answers.set("op_1", event);
        await s.event(event.status === "REFUNDED" ? "operation.refunded" : "operation.settled", "op_1");
        return out;
      });
      await done;
      expect(sent, answer.status).toEqual([expected]);
    }
  });

  it("ревью чата К5: событие пришло, пока шёл последний GET ожидания (разбудило ожидание), а GET дал итог — наблюдение перечитывает и сообщает", async () => {
    let release: (r: OperationRecord) => void = () => {};
    let calls = 0;
    const sent: string[] = [];
    const c = clock();
    const ops = new Operations({
      port: {
        readOperation: async () => (++calls === 1 ? new Promise<OperationRecord>((res) => (release = res)) : record("REFUNDED", { fulfilment: ful("WITHIN_LIMITS") })),
        readOperations: async () => [],
      },
      journal: { record: () => {} },
      params: { operation_outcome_max_delay_sec: DELAY_SEC, operation_reread_interval_sec: REREAD_SEC, registry_cache_ttl_sec: TTL_SEC, event_seen_max: PARAMS.event_seen_max },
      now: c.now,
      timer: c.timer,
    });
    const settled = ops.settle(OP, new AbortController().signal, undefined, (code) => void sent.push(code));
    await tick();
    // возврат — пока первый GET в пути: ожидание ещё числится за op_ref
    await ops.listener({ kind: "event", event: { eventId: "evt_ref", type: "operation.refunded", at: "x", mandateId: null, opRef: "op_1", confirmationId: null, declineReason: null } });
    release(record("SETTLED", { fulfilment: ful("WITHIN_LIMITS") }));
    await expect(settled).resolves.toMatchObject({ kind: "OPERATION", operation: { status: "SETTLED" } });
    await tick();
    await tick();
    expect(calls).toBe(2);
    expect(sent).toEqual(["OPERATION_REFUNDED"]);
  });

  it("GET дал другой статус — без уведомления; отказ GET с просьбой повторить — наружу (событие прочитается снова); сбой уведомления — исход не меняется", async () => {
    const s = observing("REVERSED");
    s.answers.set("op_1", record("REVERSED", { declineReason: "REVERSAL" }));
    await s.event("operation.settled", "op_1");
    expect(s.sent).toEqual([]);
    s.answers.set("op_1", new PlatformFailure("STATE_UNAVAILABLE", "same_key", "STATE_UNAVAILABLE", 503, null));
    await expect(s.ops.listener({ kind: "event", event: { eventId: "evt_503", type: "operation.settled", at: "x", mandateId: null, opRef: "op_1", confirmationId: null, declineReason: null } })).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    const t = setup();
    t.ops.watch(OP, "REVERSED", () => {
      throw new Error("оболочка упала");
    });
    t.answers.set("op_1", record("SETTLED", { fulfilment: ful("NOT_RESERVED") }));
    await expect(t.event("operation.settled", "op_1")).resolves.toBeUndefined();
  });
});

describe("сверка с заказом и CART (Р49 п. 4; ревью Р38 № 7)", () => {
  const cases: [string, Partial<OperationRecord>, OperationRecord["status"], string][] = [
    ["мандат признака — не CART", { indicator: { agentCode: AG, mandateId: "m_other" } }, "AUTHORIZED", "AOI"],
    ["одобрение без признака", { indicator: null }, "AUTHORIZED", "AOI"],
    ["другой продавец", { merchantId: "MER-9" }, "AUTHORIZED", "MERCHANT"],
    ["сумма не итог CART", { amountMinor: 90_001 }, "AUTHORIZED", "AMOUNT"],
    ["одобрение без суммы", { amountMinor: null }, "AUTHORIZED", "AMOUNT"],
    ["канал не CARD", { channel: "SBP" }, "AUTHORIZED", "CHANNEL"],
    ["отказ с чужим продавцом", { merchantId: "MER-9", declineReason: "LIMIT_EXCEEDED" }, "DECLINED", "MERCHANT"],
  ];
  for (const [name, over, status, field] of cases) {
    it(`${name} — MISMATCH, запись operation.mismatch ${field}`, async () => {
      const s = setup();
      const w = s.waiting();
      s.answers.set("op_1", record(status, over));
      await s.event("operation.authorized", "op_1");
      expect(w.outcome()).toEqual({ kind: "MISMATCH" });
      expect(s.journal.at(-1)).toEqual(expect.objectContaining({ kind: "operation.mismatch", ref: "op_1", detail: field, reason: "OPERATION_REPLY_MISMATCH", mandate: CART.id }));
    });
  }

  it("отказ AOI_MISMATCH без признака и без фактов (#59 п. 4) — итог отказа, а не расхождение", async () => {
    const s = setup();
    const w = s.waiting();
    s.answers.set("op_1", record("DECLINED", { indicator: null, merchantId: null, amountMinor: null, channel: null, declineReason: "AOI_MISMATCH" }));
    await s.event("operation.declined", "op_1");
    expect(w.outcome()).toMatchObject({ kind: "OPERATION", operation: { status: "DECLINED", declineReason: "AOI_MISMATCH", amount: null } });
  });
});

describe("стадия 6: расчёт по operation.settled и GET (Р49 п. 6–7)", () => {
  const authorized: Operation = {
    opRef: "op_1",
    orderRef: ORDER,
    channel: "CARD",
    amount: { amount: 90_000, currency: "RUB" },
    merchantId: "MER-T1",
    indicator: { agentCode: AG, mandateId: CART.id },
    status: "AUTHORIZED",
    declineReason: null,
    fulfilment: null,
  };
  const SETTLED = record("SETTLED", { fulfilment: { ref: "ful_0123456789abcdef01234567", finalMinor: 90_000, scopeCheck: "WITHIN_LIMITS", spentMinor: 90_000, at: "2026-10-23T12:05:00.000Z" } });

  const settling = (s: ReturnType<typeof setup>, deadline?: number) => {
    const ac = new AbortController();
    let out: SettleOutcome | Error | undefined;
    s.ops.settle(authorized, ac.signal, deadline).then((o) => (out = o), (e: Error) => (out = e));
    return { ac, out: () => out };
  };

  it("сразу SETTLED по GET — операция с записью об исполнении в валюте операции; запись operation.settled", async () => {
    const s = setup();
    s.answers.set("op_1", SETTLED);
    const r = settling(s);
    await tick();
    expect(r.out()).toMatchObject({
      kind: "OPERATION",
      operation: { status: "SETTLED", fulfilment: { finalAmount: { amount: 90_000, currency: "RUB" }, spentPosition: { amount: 90_000, currency: "RUB" }, scopeCheck: "WITHIN_LIMITS" } },
    });
    expect(kinds(s.journal)).toEqual(["operation.status:SETTLED", "operation.settled:WITHIN_LIMITS"]);
  });

  it("AUTHORIZED → ждёт события; operation.settled будит — GET без второго GET в слушателе", async () => {
    const s = setup();
    s.answers.set("op_1", record("AUTHORIZED"));
    const r = settling(s);
    await tick();
    expect(r.out()).toBeUndefined();
    s.answers.set("op_1", SETTLED);
    await s.event("operation.settled", "op_1");
    await tick();
    expect(r.out()).toMatchObject({ kind: "OPERATION", operation: { status: "SETTLED" } });
    expect(s.gets).toEqual(["op_1", "op_1"]);
  });

  it("Р51 п. 2 (а): без события — снова GET не чаще operation_reread_interval_sec (не через operation_outcome_max_delay_sec); прерывание вызывающим — PENDING", async () => {
    expect(REREAD_SEC).toBeGreaterThan(DELAY_SEC);
    const s = setup();
    s.answers.set("op_1", record("AUTHORIZED"));
    const r = settling(s);
    await tick();
    // до срока перечитывания — ни одного GET сверх первого, сколько бы ни прошло сроков задержки события
    await s.c.advance(REREAD_SEC * 1000 - 1);
    expect(s.gets).toEqual(["op_1"]);
    await s.c.advance(1);
    expect(s.gets).toEqual(["op_1", "op_1"]);
    await s.c.advance(REREAD_SEC * 1000);
    expect(s.gets).toEqual(["op_1", "op_1", "op_1"]);
    r.ac.abort();
    await tick();
    expect(r.out()).toEqual({ kind: "PENDING" });
  });

  it("Р51 п. 2 (б): граница reservation_ttl_sec — последний GET в срок границы; по-прежнему AUTHORIZED — EXPIRED и запись operation.unsettled", async () => {
    const s = setup();
    s.answers.set("op_1", record("AUTHORIZED"));
    // граница раньше второго планового чтения: пауза — до границы, не на полный срок перечитывания
    const deadline = T0 + REREAD_SEC * 1000 + 500;
    const r = settling(s, deadline);
    await tick();
    await s.c.advance(REREAD_SEC * 1000);
    expect(r.out()).toBeUndefined();
    expect(s.gets).toEqual(["op_1", "op_1"]);
    await s.c.advance(499);
    expect(r.out()).toBeUndefined();
    await s.c.advance(1);
    await tick();
    expect(s.gets).toEqual(["op_1", "op_1", "op_1"]);
    expect(r.out()).toEqual({ kind: "EXPIRED" });
    expect(kinds(s.journal).at(-1)).toBe("operation.unsettled:");
    // итог в последнем чтении — итог, не EXPIRED
    const s2 = setup();
    s2.answers.set("op_1", record("AUTHORIZED"));
    const r2 = settling(s2, T0 + 1000);
    await tick();
    s2.answers.set("op_1", SETTLED);
    await s2.c.advance(1000);
    await tick();
    expect(r2.out()).toMatchObject({ kind: "OPERATION", operation: { status: "SETTLED" } });
  });

  it("Р51 п. 3: REVERSED — итог-операция, запись operation.reversed с причиной закрытым перечнем (иное — OTHER, значение не в журнал)", async () => {
    for (const [reason, detail] of [["REVERSAL", "REVERSAL"], ["AUTH_EXPIRED", "AUTH_EXPIRED"], ["CHARGE_CANCELLED_BY_X", "OTHER"], [null, "OTHER"]] as const) {
      const s = setup();
      s.answers.set("op_1", record("REVERSED", { declineReason: reason }));
      const r = settling(s);
      await tick();
      expect(r.out()).toMatchObject({ kind: "OPERATION", operation: { status: "REVERSED", declineReason: reason } });
      expect(kinds(s.journal).at(-1)).toBe(`operation.reversed:${detail}`);
      if (reason !== null && detail === "OTHER") expect(JSON.stringify(s.journal)).not.toContain(reason);
    }
  });

  it("scope_check вне перечня — в операции как есть, в журнале OTHER; не по форме кода — без значения", async () => {
    for (const [other, kept] of [["PARTIAL_CAPTURE", "PARTIAL_CAPTURE"], [null, null]] as const) {
      const s = setup();
      s.answers.set("op_1", { ...SETTLED, fulfilment: { ...SETTLED.fulfilment!, scopeCheck: { other } } });
      const r = settling(s);
      await tick();
      expect(r.out()).toMatchObject({ kind: "OPERATION", operation: { fulfilment: { scopeCheck: { other: kept } } } });
      expect(kinds(s.journal).at(-1)).toBe("operation.settled:OTHER");
    }
  });

  it("ревью КТ1 Р51 № 1: граница не число (недействительная дата) — EXPIRED без GET и без таймеров; запись operation.unsettled", async () => {
    const s = setup();
    s.answers.set("op_1", record("AUTHORIZED"));
    const r = settling(s, Number.NaN);
    await tick();
    expect(r.out()).toEqual({ kind: "EXPIRED" });
    expect(s.gets).toEqual([]);
    expect(kinds(s.journal)).toEqual(["operation.unsettled:"]);
  });

  it("ревью КТ1 Р51 № 7: граница прошла, пока GET отказывает с просьбой повторить, — EXPIRED и operation.unsettled, не UNREAD", async () => {
    const s = setup();
    s.answers.set("op_1", new PlatformFailure("STATE_UNAVAILABLE", "same_key", "STATE_UNAVAILABLE", 503, null));
    // граница — раньше предела недоступности: по ней исход — граница, а не «Платформа недоступна»
    const r = settling(s, T0 + DELAY_SEC * 1000);
    await tick();
    await s.c.advance(DELAY_SEC * 1000);
    await tick();
    expect(r.out()).toEqual({ kind: "EXPIRED" });
    expect(kinds(s.journal).slice(-2)).toEqual(["operation.unread:STATE_UNAVAILABLE", "operation.unsettled:"]);
  });

  it("ревью КТ1 № 8: GET 503 подряд дольше registry_cache_ttl_sec — UNREAD; каждый отказ — запись operation.unread", async () => {
    const s = setup();
    s.answers.set("op_1", new PlatformFailure("STATE_UNAVAILABLE", "same_key", "STATE_UNAVAILABLE", 503, null));
    const r = settling(s);
    await tick();
    for (let t = 0; t < TTL_SEC && r.out() === undefined; t += DELAY_SEC) await s.c.advance(DELAY_SEC * 1000);
    await tick();
    expect(r.out()).toEqual({ kind: "UNREAD" });
    const unread = s.journal.filter((e) => e.kind === "operation.unread");
    expect(unread.length).toBe(Math.ceil(TTL_SEC / DELAY_SEC) + 1);
    expect(unread.every((e) => e.reason === "OPERATION_UNREAD" && e.detail === "STATE_UNAVAILABLE")).toBe(true);
  });

  it("ревью КТ1 № 10: operation.settled пришло, пока шёл GET, — следующая пауза не ждёт срока", async () => {
    const c = clock();
    let release: (r: OperationRecord) => void = () => {};
    let calls = 0;
    const ops = new Operations({
      port: {
        readOperation: async () => {
          calls++;
          return calls === 1 ? new Promise<OperationRecord>((res) => (release = res)) : SETTLED;
        },
        readOperations: async () => [],
      },
      journal: { record: () => {} },
      params: { operation_outcome_max_delay_sec: DELAY_SEC, operation_reread_interval_sec: REREAD_SEC, registry_cache_ttl_sec: TTL_SEC, event_seen_max: PARAMS.event_seen_max },
      now: c.now,
      timer: c.timer,
    });
    let out: SettleOutcome | undefined;
    void ops.settle(authorized, new AbortController().signal).then((o) => (out = o));
    await tick();
    // событие — пока первый GET не вернулся: пауза ещё не началась, будит флаг
    await ops.listener({ kind: "event", event: { eventId: "evt_s", type: "operation.settled", at: "x", mandateId: null, opRef: "op_1", confirmationId: null, declineReason: null } });
    release(record("AUTHORIZED"));
    await tick();
    await tick();
    expect(out).toMatchObject({ kind: "OPERATION", operation: { status: "SETTLED" } });
    expect(calls).toBe(2);
  });

  it("другая операция по op_ref или другая сумма — MISMATCH; GET не по схеме — UNREAD; 503 — повтор после паузы", async () => {
    const s = setup();
    s.answers.set("op_1", { ...SETTLED, orderRef: "ord_other" });
    const a = settling(s);
    await tick();
    expect(a.out()).toEqual({ kind: "MISMATCH" });
    expect(s.journal.at(-1)).toMatchObject({ kind: "operation.mismatch", detail: "OP_REF" });

    s.answers.set("op_1", { ...SETTLED, amountMinor: 1 });
    const b = settling(s);
    await tick();
    expect(b.out()).toEqual({ kind: "MISMATCH" });

    s.answers.set("op_1", new PlatformFailure("BAD_RESPONSE", "never", null, 200, null));
    const c = settling(s);
    await tick();
    expect(c.out()).toEqual({ kind: "UNREAD" });

    s.answers.set("op_1", new PlatformFailure("STATE_UNAVAILABLE", "same_key", "STATE_UNAVAILABLE", 503, null));
    const d = settling(s);
    await tick();
    expect(d.out()).toBeUndefined();
    s.answers.set("op_1", SETTLED);
    await s.c.advance(DELAY_SEC * 1000);
    await tick();
    expect(d.out()).toMatchObject({ kind: "OPERATION" });
  });
});

describe("фоновое чтение ленты после итога — watch_poll_interval_sec (Р65 п. 5; К2.1)", () => {
  const WATCH_SEC = PARAMS.watch_poll_interval_sec;
  const OP: Operation = {
    opRef: "op_1",
    orderRef: ORDER,
    channel: "CARD",
    amount: { amount: 90_000, currency: "RUB" },
    merchantId: "MER-T1",
    indicator: { agentCode: AG, mandateId: CART.id },
    status: "SETTLED",
    declineReason: null,
    fulfilment: null,
  };

  /** повторяющийся таймер теста: такт — tick(), снят — live false; ms — запомненный срок */
  function background(o: { gate?: () => "RUN" | "SKIP" | "STOP"; sec?: number | undefined; wake?: () => Promise<void>; answer?: () => OperationRecord } = {}) {
    let wakes = 0;
    let now = T0;
    const journal: Record<string, unknown>[] = [];
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const ops = new Operations({
      port: { readOperation: async () => (o.answer ?? (() => record("SETTLED")))(), readOperations: async () => [] },
      journal: { record: (e) => void journal.push(e) },
      params: {
        operation_outcome_max_delay_sec: DELAY_SEC,
        operation_reread_interval_sec: REREAD_SEC,
        registry_cache_ttl_sec: TTL_SEC,
        event_seen_max: PARAMS.event_seen_max,
        reservation_ttl_sec: PARAMS.reservation_ttl_sec,
        ...("sec" in o ? (o.sec !== undefined && { watch_poll_interval_sec: o.sec }) : { watch_poll_interval_sec: WATCH_SEC }),
      },
      now: () => new Date(now),
      wake: o.wake ?? (async () => void wakes++),
      every: (fn, ms) => {
        const t = { fn, ms, live: true };
        timers.push(t);
        return () => void (t.live = false);
      },
      ...(o.gate && { gate: o.gate }),
    });
    const tickAll = async () => {
      for (const t of timers.filter((x) => x.live)) t.fn();
      await tick();
    };
    let seq = 0;
    const event = async (type: PlatformEventType, opRef: string) => {
      await ops.listener({ kind: "event", event: { eventId: `evt_bg_${++seq}`, type, at: new Date(now).toISOString(), mandateId: null, opRef, confirmationId: null, declineReason: null } });
      await tick();
    };
    const advance = (ms: number) => void (now += ms);
    return { ops, timers, tickAll, journal, event, advance, wakes: () => wakes, live: () => timers.filter((t) => t.live).length };
  }

  describe("срок окна и выход по конечному статусу (дополнение 1 к Р65; К2.2)", () => {
    const TTL_MS = PARAMS.reservation_ttl_sec * 1000;
    const kindsOf = (j: Record<string, unknown>[]) => j.map((e) => `${String(e.kind)}:${String(e.ref ?? "")}`);

    it("возврат (operation.refunded → GET REFUNDED) — уведомление, операция уходит из окна, окно пустое — таймер снят", async () => {
      const sent: string[] = [];
      const b = background({ answer: () => record("REFUNDED") });
      b.ops.watch(OP, "SETTLED", (code) => void sent.push(code));
      expect(b.ops.polling).toBe(true);
      await b.event("operation.refunded", "op_1");
      expect(sent).toEqual(["OPERATION_REFUNDED"]);
      expect(b.ops.polling).toBe(false);
      expect(b.live()).toBe(0);
      // следующее событие по ней — как по вытесненной: GET и operation.unclaimed, без второго уведомления
      await b.event("operation.refunded", "op_1");
      expect(sent).toEqual(["OPERATION_REFUNDED"]);
      // GET наблюдения и GET после выхода из окна — по записи operation.status
      expect(kindsOf(b.journal)).toEqual(["operation.status:op_1", "operation.status:op_1", "operation.unclaimed:op_1"]);
    });

    it("постановка после возврата (watch REFUNDED) — под наблюдение не ставится, таймера нет; прежняя запись уходит", () => {
      const b = background();
      b.ops.watch(OP, "REFUNDED", () => undefined);
      expect(b.timers).toEqual([]);
      const c = background();
      c.ops.watch(OP, "SETTLED", () => undefined);
      c.ops.watch(OP, "REFUNDED", () => undefined);
      expect(c.ops.polling).toBe(true); // снимется на ближайшем такте: окно пустое
      return c.tickAll().then(() => expect(c.ops.polling).toBe(false));
    });

    it("срок reservation_ttl_sec от постановки: до границы — в окне; на границе — operation.watch_expired, таймер снят; событие после — operation.unclaimed", async () => {
      const sent: string[] = [];
      const b = background({ answer: () => record("SETTLED") });
      b.ops.watch({ ...OP, status: "REVERSED" }, "REVERSED", (code) => void sent.push(code));
      b.advance(TTL_MS - 1);
      await b.tickAll();
      expect(b.journal).toEqual([]);
      expect(b.wakes()).toBe(1);
      b.advance(1);
      await b.tickAll();
      expect(kindsOf(b.journal)).toEqual(["operation.watch_expired:op_1"]);
      expect(b.journal[0]).toEqual({ at: new Date(T0 + TTL_MS).toISOString(), kind: "operation.watch_expired", ref: "op_1" });
      expect(b.ops.polling).toBe(false);
      expect(b.wakes()).toBe(1); // окно пустое — ленту не будит
      await b.event("operation.settled", "op_1");
      expect(sent).toEqual([]); // поздний клиринг после срока — агент не сообщает (остаточный риск, дополнение 1 п. 6)
      expect(kindsOf(b.journal)).toEqual(["operation.watch_expired:op_1", "operation.status:op_1", "operation.unclaimed:op_1"]);
    });

    it("событие по операции за сроком без такта — тоже выход: watch_expired, затем unclaimed", async () => {
      const sent: string[] = [];
      const b = background({ answer: () => record("SETTLED") });
      b.ops.watch({ ...OP, status: "REVERSED" }, "REVERSED", (code) => void sent.push(code));
      b.advance(TTL_MS);
      await b.event("operation.settled", "op_1");
      expect(sent).toEqual([]);
      expect(kindsOf(b.journal)).toEqual(["operation.watch_expired:op_1", "operation.status:op_1", "operation.unclaimed:op_1"]);
    });

    it("повторная постановка той же операции срок не продлевает", async () => {
      const b = background();
      b.ops.watch(OP, "SETTLED", () => undefined);
      b.advance(TTL_MS - 10);
      b.ops.watch(OP, "SETTLED", () => undefined);
      b.advance(10);
      await b.tickAll();
      expect(kindsOf(b.journal)).toEqual(["operation.watch_expired:op_1"]);
    });
  });

  it("до наблюдения таймера нет; первая операция под наблюдением — один таймер на watch_poll_interval_sec, такт будит ленту", async () => {
    const b = background();
    expect(b.ops.polling).toBe(false);
    expect(b.timers).toEqual([]);
    b.ops.watch(OP, "SETTLED", () => undefined);
    b.ops.watch({ ...OP, opRef: "op_2", orderRef: "ord_2" }, "SETTLED", () => undefined);
    expect(b.ops.polling).toBe(true);
    expect(b.timers.map((t) => t.ms)).toEqual([WATCH_SEC * 1000]);
    await b.tickAll();
    await b.tickAll();
    expect(b.wakes()).toBe(2);
  });

  it("ядро остановлено (gate STOP) — таймер снят на такте, ленту не будит; после остановки новый таймер не ставится", async () => {
    let gate: "RUN" | "SKIP" | "STOP" = "RUN";
    const b = background({ gate: () => gate });
    b.ops.watch(OP, "SETTLED", () => undefined);
    gate = "STOP";
    await b.tickAll();
    expect(b.wakes()).toBe(0);
    expect(b.ops.polling).toBe(false);
    expect(b.live()).toBe(0);
    b.ops.watch({ ...OP, opRef: "op_2", orderRef: "ord_2" }, "SETTLED", () => undefined);
    expect(b.timers).toHaveLength(1);
  });

  it("подпись приостановлена (gate SKIP) — такт пропущен, таймер остаётся; после снятия такт будит ленту", async () => {
    let gate: "RUN" | "SKIP" | "STOP" = "SKIP";
    const b = background({ gate: () => gate });
    b.ops.watch(OP, "SETTLED", () => undefined);
    await b.tickAll();
    expect(b.wakes()).toBe(0);
    expect(b.ops.polling).toBe(true);
    gate = "RUN";
    await b.tickAll();
    expect(b.wakes()).toBe(1);
  });

  it("сбой чтения ленты таймер глотает (недоступность считает сама лента) — таймер остаётся", async () => {
    let calls = 0;
    const b = background({
      wake: async () => {
        calls++;
        throw new Error("лента недоступна");
      },
    });
    b.ops.watch(OP, "SETTLED", () => undefined);
    await b.tickAll();
    await b.tickAll();
    expect(calls).toBe(2);
    expect(b.ops.polling).toBe(true);
  });

  it("таймер по умолчанию не держит процесс (unref): исход покупки уже есть (ревью КТ1 сессии 51 № 12)", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      const ops = new Operations({
        port: { readOperation: async () => record("SETTLED"), readOperations: async () => [] },
        journal: { record: () => undefined },
        params: { operation_outcome_max_delay_sec: DELAY_SEC, operation_reread_interval_sec: REREAD_SEC, registry_cache_ttl_sec: TTL_SEC, event_seen_max: PARAMS.event_seen_max, watch_poll_interval_sec: WATCH_SEC },
        wake: async () => undefined,
      });
      ops.watch(OP, "SETTLED", () => undefined);
      const timer = spy.mock.results.at(-1)?.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
      ops.stopPolling();
    } finally {
      spy.mockRestore();
    }
  });

  it("без watch_poll_interval_sec — фонового чтения нет (ленту читает оболочка или push); stopPolling снимает таймер", async () => {
    const off = background({ sec: undefined });
    off.ops.watch(OP, "SETTLED", () => undefined);
    expect(off.timers).toEqual([]);
    const b = background();
    b.ops.watch(OP, "SETTLED", () => undefined);
    b.ops.stopPolling();
    expect(b.ops.polling).toBe(false);
    expect(b.live()).toBe(0);
  });
});
