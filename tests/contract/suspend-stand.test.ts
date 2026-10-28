// Приостановление и снятие агента на стенде Платформы (Р60 п. 1–5а, AG-14 ч. 1, К1.3а): ядро createAgentCore — с
// расписанием сверки и приёмом push (в тестовом контуре их нет: он повторяет compose без них, STATUS «Открыто»).
// Приостанавливает и снимает оператор стенда (`suspendAgent` / `reinstateAgent`, РП54); push `agent.reinstated` получает
// эмулятор stand.agentReceiver (РП40 п. 8) — тело передаётся в acceptPush ядра вручную. Таймер расписания — поддельный
// setInterval; сеть и setTimeout настоящие. Покупка в работе при приостановлении — К1.3б (контур, витрины эмулятора).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStand, type Stand } from "agentic-ps-platform/stand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentCore, type AgentCore } from "../../src/agent/compose.js";
import { AgentNotReady } from "../../src/agent/declines/index.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { SignerSuspended, generateKey } from "../../src/agent/signer/index.js";
import { loadParams } from "../../src/shared/config.js";
import { INTENT } from "../support/consents.js";
import { AGENT } from "../support/pao-stand.js";
import { feedOffers, liveOffers, payments, shopOrders } from "../support/shop.js";
import { SHOP } from "../support/purchase.js";
import { reinstated } from "../support/stand-purchase.js";

/** Стенд в процессе теста под параллельной нагрузкой прогона бывает медленнее 5 с по умолчанию (нюанс К2.3 Р38). */
const STAND_TIMEOUT_MS = 20_000;
const TICK = loadParams().agent_recheck_interval_sec * 1000;
const AGENT_GET = "GET /pao/v1/agent";
const CONFIG = "GET /.well-known/pao-configuration";

let stand: Stand | undefined;
const cores: AgentCore[] = [];
const dirs: string[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cores.splice(0)) c.close();
  await stand?.close();
  stand = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

/** Ядро на стенде с подпиской: допуск заявлением оператора, журнал обращений агента — метод, путь, статус (без тел).
 *  `start: false` — без start() ядра (приостановление до допуска, Р63 п. 1). */
async function admitted({ start = true } = {}) {
  const s = createStand();
  stand = s;
  const keysDir = tmp("susp-keys-");
  const { descriptor } = generateKey(keysDir);
  const decision = await s.admit(
    { agent_code: AGENT, class: "BUYER", model: "buyer-agent-ref", runtime: "node-20", alg: "ed25519", public_key: descriptor.public_key },
    "buyref-operator",
  );
  if (!decision.admitted) throw new Error("стенд не допустил агента");
  const baseUrl = await s.listen();
  const calls: { route: string; status: number }[] = [];
  const fetchLog: typeof fetch = async (url, init) => {
    const res = await fetch(url, init);
    calls.push({ route: `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`, status: res.status });
    return res;
  };
  const journal = new MemoryJournal();
  const pushUrl = `https://${s.params.event_subscription_allow_hosts[0]}/pao/events`;
  const c = createAgentCore({ keysDir, stateDir: join(tmp("susp-state-"), "state"), journal, pushUrl, pao: { baseUrl, agentCode: AGENT, sleep: async () => {}, fetch: fetchLog } });
  cores.push(c);
  if (start) await c.start();
  const gets = () => calls.filter((x) => x.route === AGENT_GET).length;
  const kinds = (kind: string) => journal.entries.filter((e) => e.kind === kind);
  /** После снятия ядро читает ленту с курсора (Р60 п. 2): стенд пишет в неё agent.suspended и agent.reinstated, по каждому —
   *  своя сверка GET /pao/v1/agent (Р34 п. 5). Дождаться чтения; вернуть типы agent.* из ленты. */
  async function feedAfterResume(): Promise<string[]> {
    await c.events.signal();
    return kinds("event.handled").map((e) => String(e.detail)).filter((t) => t.startsWith("agent."));
  }
  /** оператор приостановил агента; первое подписанное обращение — 403 AGENT_SUSPENDED, подпись приостановлена (п. 1) */
  async function suspended() {
    await s.suspendAgent(AGENT, "OUT_OF_MANDATE");
    await expect(c.platform.requestMandate(INTENT, { idempotencyKey: "idem-susp-m1" })).rejects.toMatchObject({ code: "AGENT_SUSPENDED", httpStatus: 403 });
    expect(kinds("signing.suspended").map((e) => e.reason)).toEqual(["AGENT_SUSPENDED"]);
    expect(vi.getTimerCount()).toBe(1);
  }
  return { s, c, calls, gets, kinds, suspended, feedAfterResume };
}

describe("приостановление и снятие агента на стенде (Р60, К1.3а)", { timeout: STAND_TIMEOUT_MS }, () => {
  it("suspendAgent → приостановка; стадия 0 — отказ без обращения; сверка по расписанию: SUSPENDED — остаётся, после reinstateAgent — снятие", async () => {
    const r = await admitted();
    await r.suspended();

    // стадия 0: покупка отказана кодом приостановки, к Платформе обращений нет
    const before = r.calls.length;
    const purchase = r.c.purchase({ offers: feedOffers(SHOP), live: liveOffers(SHOP, () => new Date()), shop: shopOrders(SHOP), payment: payments() });
    await expect(purchase.intent(INTENT, { idempotencyKey: "idem-susp-p1" })).rejects.toMatchObject({ code: "AGENT_SUSPENDED" });
    expect(purchase.state).toBe("STOPPED");
    expect(r.calls.length).toBe(before);

    // тик при SUSPENDED у стенда — GET прочитал SUSPENDED, приостановка остаётся, отказа сверки нет
    const g = r.gets();
    await vi.advanceTimersByTimeAsync(TICK);
    await vi.waitFor(() => expect(r.gets()).toBe(g + 1));
    expect(r.calls.at(-1)).toEqual({ route: AGENT_GET, status: 200 });
    await expect(r.c.platform.requestMandate(INTENT, { idempotencyKey: "idem-susp-m2" })).rejects.toBeInstanceOf(SignerSuspended);
    expect(r.kinds("agent.recheck_failed")).toEqual([]);

    // оператор снял приостановление — снимает следующий тик, push не нужен
    await reinstated(r.s, AGENT);
    await vi.advanceTimersByTimeAsync(TICK);
    await vi.waitFor(() => expect(r.kinds("signing.resumed")).toHaveLength(1));
    // два тика и по сверке на каждое agent.* из ленты, прочитанной после снятия
    expect(await r.feedAfterResume()).toEqual(["agent.suspended", "agent.reinstated"]);
    expect(r.gets()).toBe(g + 2 + 2);
    expect(vi.getTimerCount()).toBe(0);
    await expect(r.c.platform.requestMandate(INTENT, { idempotencyKey: "idem-susp-m3" })).resolves.toMatchObject({ status: "PENDING_SIGNATURE" });
  });

  it("второй прогон: настоящий push agent.reinstated со стенда → acceptPush → сверка сразу, снятие без тика", async () => {
    const r = await admitted();
    await r.suspended();
    await reinstated(r.s, AGENT);
    await r.s.deliverEvents();
    const got = r.s.agentReceiver.received.find((x) => (x.event as { type?: string }).type === "agent.reinstated");
    if (!got) throw new Error("push agent.reinstated не доставлен");
    const g = r.gets();

    expect(r.c.acceptPush(JSON.stringify(got.event), { "x-event-id": got.header_event_id })).toEqual({ status: 200 });
    await vi.waitFor(() => expect(r.kinds("signing.resumed")).toHaveLength(1));
    // таймер не сдвигался: сняла сверка по push, ожидание совпало с прочитанным ACTIVE — один GET (п. 5а); дальше — по
    // сверке на каждое agent.* из ленты, прочитанной после снятия
    expect(r.calls.filter((x) => x.route === AGENT_GET).slice(g)[0]).toEqual({ route: AGENT_GET, status: 200 });
    expect(await r.feedAfterResume()).toEqual(["agent.suspended", "agent.reinstated"]);
    expect(r.gets()).toBe(g + 1 + 2);
    expect(vi.getTimerCount()).toBe(0);
    await expect(r.c.platform.requestMandate(INTENT, { idempotencyKey: "idem-susp-m4" })).resolves.toMatchObject({ status: "PENDING_SIGNATURE" });
  });

  it("Р63 п. 1: приостановлен до start() — AgentNotReady AGENT_SUSPENDED без остановки; при допуске — только конфигурация и GET /pao/v1/agent; повтор — то же; после reinstateAgent start() проходит", async () => {
    const r = await admitted({ start: false });
    await r.s.suspendAgent(AGENT, "OUT_OF_MANDATE");
    // из подписанных — только GET /pao/v1/agent; неподписанная конфигурация — проверка версии ПАО (нюанс К1.1 Р63)
    const admission = [
      { route: CONFIG, status: 200 },
      { route: AGENT_GET, status: 200 },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = r.calls.length;
      const err = await r.c.start().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentNotReady);
      expect((err as AgentNotReady).report.checks.at(-1)).toEqual({ check: "platform.admission", status: "fail", code: "AGENT_SUSPENDED" });
      expect(r.calls.slice(before)).toEqual(admission);
    }
    expect(r.kinds("agent.stopped")).toEqual([]);
    expect(r.kinds("signing.suspended").map((e) => e.reason)).toEqual(["AGENT_SUSPENDED"]);
    expect(vi.getTimerCount()).toBe(0); // до допуска расписания сверки нет
    await expect(r.c.platform.requestMandate(INTENT, { idempotencyKey: "idem-susp-m6" })).rejects.toMatchObject({ reason: "NOT_ADMITTED" });

    await reinstated(r.s, AGENT);
    await r.c.start();
    expect(r.kinds("signing.resumed")).toHaveLength(1);
    await expect(r.c.platform.requestMandate(INTENT, { idempotencyKey: "idem-susp-m7" })).resolves.toMatchObject({ status: "PENDING_SIGNATURE" });
  });

  it("поддельный push agent.reinstated при SUSPENDED у стенда — ничего не открывает: две сверки, обе SUSPENDED", async () => {
    const r = await admitted();
    await r.suspended();
    const g = r.gets();
    const forged = { event_id: "evt_forged_1", type: "agent.reinstated", at: new Date().toISOString(), data: { agent_code: AGENT } };

    expect(r.c.acceptPush(JSON.stringify(forged), { "x-event-id": forged.event_id })).toEqual({ status: 200 });
    await vi.waitFor(() => expect(r.gets()).toBe(g + 2));
    await new Promise((res) => setTimeout(res, 50));
    expect(r.gets()).toBe(g + 2);
    expect(r.kinds("signing.resumed")).toEqual([]);
    const before = r.calls.length;
    await expect(r.c.platform.requestMandate(INTENT, { idempotencyKey: "idem-susp-m5" })).rejects.toBeInstanceOf(SignerSuspended);
    expect(r.calls.length).toBe(before);
    expect(vi.getTimerCount()).toBe(1);
  });
});
