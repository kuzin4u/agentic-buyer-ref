// Фоновое чтение ленты после итога через место сборки (Р65 п. 5, дополнение 1; КТ1 сессии 51 — важное № 3): модуль
// операций наружу из AgentCore не выходит, поэтому проводка состояния ядра (gate: остановка — STOP, приостановка подписи
// — SKIP) проверяется по обращениям к ленте PaoStub и журналу ядра. Расчёт — шаги оплаты ядра (core.payment().settle) с
// уведомлением покупки: операция встаёт под наблюдение внутри ядра. Таймер — поддельный setInterval (как
// recheck-schedule.test.ts); сеть и setTimeout настоящие. watch_poll_interval_sec — 1 с из своего файла параметров:
// такт фонового чтения раньше такта сверки при приостановке (agent_recheck_interval_sec).
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PurchaseNotice } from "../../src/agent/ports/shop.js";
import { loadParams } from "../../src/shared/config.js";
import type { Money, Operation } from "../../src/shared/domain.js";
import { DRAFT, coreOn } from "../support/core.js";
import { AGENT, PaoStand } from "../support/pao-stand.js";

const PARAMS = loadParams();
const WATCH_SEC = 1;
const EVENTS = "GET /pao/v1/events" as const;
const OPERATION = "GET /pao/v1/operations/{op_ref}" as const;
const CREDENTIALS = "POST /pao/v1/credentials" as const;
const TOTAL: Money = { amount: 250000, currency: "RUB" };
const FUL = { fulfilment_ref: "ful_0123456789abcdef01234567", final_amount: 250000, scope_check: "WITHIN_LIMITS", spent_position: 250000, at: "2026-10-23T12:05:00Z" };
const AUTHORIZED: Operation = {
  opRef: "op_w1",
  orderRef: "ORD-W1",
  channel: "CARD",
  amount: TOTAL,
  merchantId: "shop_1",
  indicator: { agentCode: AGENT, mandateId: "m_cart" },
  status: "AUTHORIZED",
  declineReason: null,
  fulfilment: null,
};

let stand: PaoStand | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(async () => {
  vi.useRealTimers();
  expect(stand?.stub.violations ?? []).toEqual([]);
  await stand?.close();
  stand = undefined;
});

/** Ждать по-настоящему, пока условие не выполнится (пауза ленты — event_poll_interval_ms настоящими часами). */
async function until(cond: () => boolean, ms = PARAMS.event_poll_interval_ms * 3): Promise<void> {
  for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
}
/** Настоящая пауза дольше паузы ленты: лишнее обращение после ожидаемых успело бы дойти до PaoStub. */
const quiet = () => new Promise((r) => setTimeout(r, PARAMS.event_poll_interval_ms + 200));

/** Ядро после расчёта: операция op_w1 SETTLED под наблюдением; лента отдаёт события из очереди теста. */
async function settled() {
  const queue: unknown[] = [];
  let status: "SETTLED" | "REFUNDED" = "SETTLED";
  const s = new PaoStand({
    handlers: {
      [EVENTS]: () => ({ status: 200, body: queue.splice(0) as never }),
      [OPERATION]: () => ({
        status: 200,
        body: { op_ref: "op_w1", order_ref: "ORD-W1", channel: "CARD", amount: 250000, merchant_id: "shop_1", aoi: { indicator: true, agent_code: AGENT, mandate_id: "m_cart" }, status, reason: null, fulfilment: FUL, deal_ref: null },
      }),
    },
  });
  stand = s;
  const paramsPath = `${s.dir}-params.json`;
  writeFileSync(paramsPath, JSON.stringify({ ...PARAMS, watch_poll_interval_sec: WATCH_SEC }));
  const { core, journal } = await coreOn(s, { paramsPath });
  await core.start();
  const notices: [PurchaseNotice, Money | undefined][] = [];
  const steps = core.payment({ pay: async () => ({ status: "PAID" }) });
  await expect(steps.settle(AUTHORIZED, new AbortController().signal, undefined, (code, amount) => void notices.push([code, amount]))).resolves.toMatchObject({ status: "SETTLED" });
  await quiet();
  const reads = () => s.stub.calls.filter((c) => c.op === EVENTS).length;
  const refund = () => {
    status = "REFUNDED";
    queue.push({ event_id: "evt_w_ref", type: "operation.refunded", at: "2026-10-23T12:10:00Z", data: { op_ref: "op_w1" } });
  };
  return { s, core, journal, notices, reads, refund };
}

describe("фоновое чтение ленты через AgentCore — проводка gate (Р65 п. 5; КТ1 № 3)", () => {
  it("RUN: после расчёта такт watch_poll_interval_sec читает ленту; возврат → GET → OPERATION_REFUNDED; окно пустое — таймер снят", async () => {
    const t = await settled();
    const before = t.reads();
    const timers = vi.getTimerCount();
    t.refund();
    vi.advanceTimersByTime(WATCH_SEC * 1000);
    await until(() => t.notices.length > 0);
    expect(t.notices).toEqual([["OPERATION_REFUNDED", TOTAL]]);
    expect(t.reads()).toBeGreaterThan(before);
    // один GET операции по возврату (расчёт — ещё один, раньше)
    expect(t.s.stub.calls.filter((c) => c.op === OPERATION)).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(timers - 1);
  });

  it("SKIP: подпись приостановлена — такт ленту не читает (403 и серии EVENTS_UNAVAILABLE нет); таймер остаётся", async () => {
    const t = await settled();
    t.s.status = "SUSPENDED";
    t.s.stub.fail(CREDENTIALS, { code: "AGENT_SUSPENDED" }, 1);
    await expect(t.core.platform.issueCredential(DRAFT, { idempotencyKey: "idem-watch-susp" })).rejects.toMatchObject({ code: "AGENT_SUSPENDED" });
    await quiet();
    const before = t.reads();
    const timers = vi.getTimerCount();
    vi.advanceTimersByTime(WATCH_SEC * 1000);
    await quiet();
    expect(t.reads()).toBe(before);
    expect(t.journal.entries.filter((e) => e.kind === "events.unavailable")).toEqual([]);
    expect(vi.getTimerCount()).toBe(timers);
  });

  it("STOP: ядро закрыто — таймер снят на ближайшем такте, ленту не читает и не ставится снова", async () => {
    const t = await settled();
    const timers = vi.getTimerCount();
    t.core.close();
    const before = t.reads();
    const entries = t.journal.entries.length;
    vi.advanceTimersByTime(WATCH_SEC * 1000);
    await quiet();
    expect(vi.getTimerCount()).toBe(timers - 1);
    expect(t.reads()).toBe(before);
    vi.advanceTimersByTime(WATCH_SEC * 1000);
    await quiet();
    expect(t.reads()).toBe(before);
    expect(t.journal.entries.slice(entries).filter((e) => e.kind !== "agent.closed")).toEqual([]);
  });
});
