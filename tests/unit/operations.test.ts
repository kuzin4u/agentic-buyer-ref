// Модуль операций (Р49 п. 3–7): событие operation.* — сигнал, итог — по GET; привязка к покупке по order_ref, сверка с
// CART (признак, продавец, сумма, канал); дубли по event_id; GET, который Платформа просит повторить, — событие читается
// снова; стадия 6 — GET по op_ref, без события — снова GET через operation_outcome_max_delay_sec, прерывание — PENDING.
import { describe, expect, it } from "vitest";
import { Operations, type OperationOutcome, type SettleOutcome } from "../../src/agent/operations/index.js";
import type { FeedItem } from "../../src/agent/ports/events.js";
import { DIAG } from "../../src/agent/compose.js";
import { loadParams } from "../../src/shared/config.js";
import { PlatformFailure, type Mandate, type Operation, type OperationRecord, type PlatformEventType } from "../../src/shared/domain.js";

const T0 = Date.parse("2026-10-23T12:00:00.000Z");
const PARAMS = loadParams();
const DELAY_SEC = PARAMS.operation_outcome_max_delay_sec;
const TTL_SEC = PARAMS.registry_cache_ttl_sec;
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

function setup(wake?: (ops: Operations) => Promise<void>, pollMs?: number) {
  const c = clock();
  const answers = new Map<string, OperationRecord | Error>();
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
    },
    journal: { record: (e) => void journal.push(e) },
    params: { operation_outcome_max_delay_sec: DELAY_SEC, registry_cache_ttl_sec: TTL_SEC, ...(pollMs !== undefined && { event_poll_interval_ms: pollMs }) },
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
  return { c, answers, gets, journal, ops, event, waiting };
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

  it("операция другого заказа — operation.unclaimed; не этого агента (400) — operation.foreign; ожидающая не задета", async () => {
    const s = setup();
    const w = s.waiting();
    s.answers.set("op_9", record("AUTHORIZED", { opRef: "op_9", orderRef: "ord_other" }));
    await s.event("operation.authorized", "op_9");
    await s.event("operation.authorized", "op_unknown");
    expect(kinds(s.journal)).toEqual(["operation.status:AUTHORIZED", "operation.unclaimed:", "operation.foreign:"]);
    expect(w.outcome()).toBeUndefined();
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

  it("две покупки ждут одну ссылку заказа — привязка неоднозначна: обе NONE", async () => {
    const s = setup();
    const a = s.waiting();
    const b = s.waiting();
    await tick();
    expect(a.outcome()).toEqual({ kind: "NONE" });
    expect(b.outcome()).toEqual({ kind: "NONE" });
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

  const settling = (s: ReturnType<typeof setup>) => {
    const ac = new AbortController();
    let out: SettleOutcome | Error | undefined;
    s.ops.settle(authorized, ac.signal).then((o) => (out = o), (e: Error) => (out = e));
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

  it("без события дольше operation_outcome_max_delay_sec — снова GET (#59 п. 3); прерывание вызывающим — PENDING", async () => {
    const s = setup();
    s.answers.set("op_1", record("AUTHORIZED"));
    const r = settling(s);
    await tick();
    await s.c.advance(DELAY_SEC * 1000);
    await s.c.advance(DELAY_SEC * 1000);
    expect(s.gets).toEqual(["op_1", "op_1", "op_1"]);
    r.ac.abort();
    await tick();
    expect(r.out()).toEqual({ kind: "PENDING" });
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
      },
      journal: { record: () => {} },
      params: { operation_outcome_max_delay_sec: DELAY_SEC, registry_cache_ttl_sec: TTL_SEC },
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
