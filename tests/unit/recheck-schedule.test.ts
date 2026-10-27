// Повторная сверка при приостановке (Р60 п. 4–5а, нюанс К1.2): раз в agent_recheck_interval_sec — recheck() через общий
// Pace; push при приостановке — сверка сразу, при расхождении с типом push — ещё одна; отказ сверки — запись
// agent.recheck_failed; после EVENTS_UNAVAILABLE до полного чтения ленты — без обязательств. Таймер — поддельный
// setInterval (развилка 1): сеть и setTimeout настоящие.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignerStopped, SignerSuspended } from "../../src/agent/signer/index.js";
import type { ShopOrderRequest } from "../../src/agent/ports/shop.js";
import { loadParams } from "../../src/shared/config.js";
import { PlatformFailure } from "../../src/shared/domain.js";
import { INTENT } from "../support/consents.js";
import { CREDENTIALS, DRAFT, coreOn } from "../support/core.js";
import { PaoStand } from "../support/pao-stand.js";
import { SHOP } from "../support/purchase.js";
import { feedOffers, liveOffers, payments, shopOrders } from "../support/shop.js";

let stand: PaoStand;
const { agent_recheck_interval_sec: INTERVAL_SEC, registry_cache_ttl_sec: TTL_SEC, pao_max_attempts: ATTEMPTS } = loadParams();
/** лента пуста: чтение после снятия (Р60 п. 2) доходит до пустой страницы */
const HANDLERS = { ...CREDENTIALS, "GET /pao/v1/events": () => ({ status: 200, body: [] }) };
const TICK = INTERVAL_SEC * 1000;
const AGENT_GET = "GET /pao/v1/agent" as const;
const OP = "POST /pao/v1/credentials" as const;
const EVENTS = "GET /pao/v1/events" as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(async () => {
  vi.useRealTimers();
  await stand?.close();
});

type Core = Awaited<ReturnType<typeof coreOn>>["core"];
type Entries = Awaited<ReturnType<typeof coreOn>>["journal"];

const kinds = (journal: Entries, kind: string) => journal.entries.filter((e) => e.kind === kind);

/** Настоящая пауза: лишнее обращение после ожидаемых успело бы дойти до стенда (локальный HTTP). */
const settle = () => new Promise((r) => setTimeout(r, 50));

/** 403 AGENT_SUSPENDED на выдаче реквизита — приостановка подписи (Р60 п. 1); реестр отдаёт SUSPENDED. */
async function suspend(core: Core): Promise<void> {
  stand.status = "SUSPENDED";
  stand.stub.fail(OP, { code: "AGENT_SUSPENDED" }, 1);
  await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "idem-k12" })).rejects.toMatchObject({ code: "AGENT_SUSPENDED" });
}

/** push формы ПАО: тело не подписано (до ПАО 1.5.0), тип — только ожидание */
const push = (core: Core, type: string, n: number) =>
  core.acceptPush(JSON.stringify({ event_id: `evt_push_${n}`, type, at: stand.clock.toISOString(), data: {} }), { "x-event-id": `evt_push_${n}` });

/** Лента недоступна дольше registry_cache_ttl_sec (как П23) — приостановка EVENTS_UNAVAILABLE. */
async function feedDown(
  core: Core,
  failure: { code: "UPSTREAM_UNAVAILABLE" } | { code: "RATE_LIMITED"; retryAfterSec: number } = { code: "UPSTREAM_UNAVAILABLE" },
  times = 1000,
) {
  stand.stub.fail(EVENTS, failure, times);
  await expect(core.events.signal()).rejects.toBeInstanceOf(PlatformFailure);
  stand.clock = new Date(stand.clock.getTime() + TTL_SEC * 1000);
  await expect(core.events.signal()).rejects.toBeInstanceOf(PlatformFailure);
  expect(core.events.failing).toBe(true);
}

describe("К1.2 — сверка по расписанию при приостановке (Р60 п. 4)", () => {
  it("AGENT_SUSPENDED: GET раз в agent_recheck_interval_sec, SUSPENDED — приостановка остаётся, ACTIVE — снятие и таймер снят", async () => {
    stand = new PaoStand({ handlers: HANDLERS });
    const { core, journal } = await coreOn(stand);
    await core.start();
    expect(vi.getTimerCount()).toBe(0);
    await suspend(core);
    expect(vi.getTimerCount()).toBe(1);
    const gets = stand.calls(AGENT_GET).length;

    await vi.advanceTimersByTimeAsync(TICK - 1);
    expect(stand.calls(AGENT_GET)).toHaveLength(gets);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(stand.calls(AGENT_GET)).toHaveLength(gets + 1));
    // прочитан SUSPENDED — не отказ сверки: записи agent.recheck_failed нет, приостановка остаётся
    expect(core.selfCheck()?.ready).toBe(true);
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "idem-k12" })).rejects.toThrow(SignerSuspended);
    expect(kinds(journal, "agent.recheck_failed")).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);

    stand.status = "ACTIVE";
    await vi.advanceTimersByTimeAsync(TICK);
    await vi.waitFor(() => expect(kinds(journal, "signing.resumed")).toHaveLength(1));
    expect(stand.calls(AGENT_GET)).toHaveLength(gets + 2);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3 * TICK);
    expect(stand.calls(AGENT_GET)).toHaveLength(gets + 2);
    expect(stand.stub.violations).toEqual([]);
  });

  it("EVENTS_UNAVAILABLE тоже ставит расписание (причина любая)", async () => {
    stand = new PaoStand({ handlers: HANDLERS });
    const { core, journal } = await coreOn(stand);
    await core.start();
    await feedDown(core);
    expect(kinds(journal, "signing.suspended").map((e) => e.reason)).toEqual(["EVENTS_UNAVAILABLE"]);
    expect(vi.getTimerCount()).toBe(1);
    core.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("сверка прочитала EXCLUDED — остановка, таймер снят, тиков больше нет", async () => {
    stand = new PaoStand({ handlers: HANDLERS });
    const { core, journal } = await coreOn(stand);
    await core.start();
    await suspend(core);
    stand.status = "EXCLUDED";
    const gets = stand.calls(AGENT_GET).length;

    await vi.advanceTimersByTimeAsync(TICK);
    await vi.waitFor(() => expect(kinds(journal, "agent.stopped").map((e) => e.reason)).toEqual(["AGENT_EXCLUDED"]));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3 * TICK);
    expect(stand.calls(AGENT_GET)).toHaveLength(gets + 1);
    expect(kinds(journal, "agent.recheck_failed")).toEqual([]);
  });

  it("close() при приостановке — таймер снят", async () => {
    stand = new PaoStand({ handlers: HANDLERS });
    const { core } = await coreOn(stand);
    await core.start();
    await suspend(core);
    expect(vi.getTimerCount()).toBe(1);
    core.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("тик во время идущей сверки — та же сверка, один GET", async () => {
    stand = new PaoStand({ handlers: HANDLERS });
    const { core } = await coreOn(stand);
    await core.start();
    await suspend(core);
    stand.status = "ACTIVE";
    const gets = stand.calls(AGENT_GET).length;

    const external = core.recheck();
    await vi.advanceTimersByTimeAsync(TICK);
    await external;
    expect(stand.calls(AGENT_GET)).toHaveLength(gets + 1);
  });

  it("сверка не прошла (503) — agent.recheck_failed первой в серии, повтор того же кода без записи; ACTIVE — серия закрыта", async () => {
    stand = new PaoStand({ handlers: HANDLERS });
    const { core, journal } = await coreOn(stand);
    await core.start();
    await suspend(core);
    stand.status = "ACTIVE";
    // 503 с Retry-After заглушки — повторы адаптера до pao_max_attempts на тик; два тика подряд не проходят
    stand.stub.fail(AGENT_GET, { code: "UPSTREAM_UNAVAILABLE" }, 2 * ATTEMPTS);
    const gets = stand.calls(AGENT_GET).length;

    await vi.advanceTimersByTimeAsync(TICK);
    await vi.waitFor(() => expect(kinds(journal, "agent.recheck_failed")).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(TICK);
    await vi.waitFor(() => expect(stand.calls(AGENT_GET)).toHaveLength(gets + 2 * ATTEMPTS));
    await settle();
    // тот же код вторым тиком — без записи; подпись приостановлена, расписание стоит
    expect(kinds(journal, "agent.recheck_failed").map((e) => e.reason)).toEqual(["UPSTREAM_UNAVAILABLE"]);
    expect(kinds(journal, "signing.resumed")).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(TICK);
    await vi.waitFor(() => expect(kinds(journal, "signing.resumed")).toHaveLength(1));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("пауза после 429 держит и сверку по расписанию: GET тика — после ожидания общего Pace (Р60 п. 4 (а))", async () => {
    stand = new PaoStand({ handlers: HANDLERS });
    let mono = 0;
    const sleeps: number[] = [];
    const { core, journal } = await coreOn(stand, {
      monotonic: () => mono,
      sleep: async (ms) => {
        sleeps.push(ms);
        mono += ms;
      },
    });
    await core.start();
    // 429 с Retry-After: 2 на чтении ленты сверх попыток: последняя пауза Pace — 2 с от последнего ответа, после неё
    // обращений нет
    await feedDown(core, { code: "RATE_LIMITED", retryAfterSec: 2 });
    expect(kinds(journal, "signing.suspended").map((e) => e.reason)).toEqual(["EVENTS_UNAVAILABLE"]);
    const gets = stand.calls(AGENT_GET).length;
    const slept = sleeps.length;

    await vi.advanceTimersByTimeAsync(TICK);
    await vi.waitFor(() => expect(stand.calls(AGENT_GET)).toHaveLength(gets + 1));
    expect(sleeps.slice(slept, slept + 1)).toEqual([2000]);
  });

  it("таймер не держит процесс (unref)", async () => {
    vi.useRealTimers();
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      stand = new PaoStand({ handlers: HANDLERS });
      const { core } = await coreOn(stand);
      await core.start();
      await suspend(core);
      const timer = spy.mock.results.at(-1)?.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
      core.close();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("К1.2 — push при приостановке (Р60 п. 5–5а)", () => {
  it("push при приостановке — сверка сразу, лента не читается", async () => {
    stand = new PaoStand({ handlers: HANDLERS });
    const { core, journal } = await coreOn(stand);
    await core.start();
    await suspend(core);
    stand.status = "ACTIVE";
    const gets = stand.calls(AGENT_GET).length;
    const reads = stand.calls(EVENTS).length;

    expect(push(core, "agent.reinstated", 1)).toEqual({ status: 200 });
    await vi.waitFor(() => expect(kinds(journal, "signing.resumed")).toHaveLength(1));
    expect(stand.calls(AGENT_GET)).toHaveLength(gets + 1);
    // до сверки лента не читалась; после снятия — с сохранённого курсора (Р60 п. 2)
    const order = stand.log().slice(-2).map((c) => c.op);
    expect(order[0]).toBe(AGENT_GET);
    expect(stand.calls(EVENTS).length).toBeLessThanOrEqual(reads + 1);
  });

  it.each([
    ["agent.reinstated", "SUSPENDED"],
    ["agent.suspended", "ACTIVE"],
  ] as const)("push %s, сверка прочитала %s — ещё одна сверка (п. 5а): два GET", async (type, first) => {
    stand = new PaoStand({ handlers: HANDLERS });
    const { core } = await coreOn(stand);
    await core.start();
    await suspend(core);
    stand.status = first;
    const gets = stand.calls(AGENT_GET).length;

    push(core, type, 1);
    await vi.waitFor(() => expect(stand.calls(AGENT_GET)).toHaveLength(gets + 2));
    await settle();
    expect(stand.calls(AGENT_GET)).toHaveLength(gets + 2);
  });

  it("push совпал с прочитанным статусом — одна сверка; поддельный agent.reinstated при SUSPENDED ничего не открывает", async () => {
    stand = new PaoStand({ handlers: HANDLERS });
    const { core, journal } = await coreOn(stand);
    await core.start();
    await suspend(core);
    const gets = stand.calls(AGENT_GET).length;

    push(core, "agent.suspended", 1);
    await vi.waitFor(() => expect(stand.calls(AGENT_GET)).toHaveLength(gets + 1));
    await settle();
    expect(stand.calls(AGENT_GET)).toHaveLength(gets + 1);

    // подделка: тип говорит «снят», реестр — SUSPENDED; не больше двух GET, подпись приостановлена
    push(core, "agent.reinstated", 2);
    await vi.waitFor(() => expect(stand.calls(AGENT_GET)).toHaveLength(gets + 3));
    await settle();
    expect(stand.calls(AGENT_GET)).toHaveLength(gets + 3);
    expect(kinds(journal, "signing.resumed")).toEqual([]);
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "idem-k12" })).rejects.toThrow(SignerSuspended);
  });

  it("push не agent.* при приостановке — одна сверка без сравнения", async () => {
    stand = new PaoStand({ handlers: HANDLERS });
    const { core } = await coreOn(stand);
    await core.start();
    await suspend(core);
    const gets = stand.calls(AGENT_GET).length;

    push(core, "operation.authorized", 1);
    await vi.waitFor(() => expect(stand.calls(AGENT_GET)).toHaveLength(gets + 1));
    await settle();
    expect(stand.calls(AGENT_GET)).toHaveLength(gets + 1);
  });
});

describe("К1.2 — EVENTS_UNAVAILABLE: до полного чтения ленты обязательств нет (Р60 п. 4, нюанс К1.2)", () => {
  it("снята сверкой, лента не прочитана: мандат, реквизит, заказ у витрины — без обращения; отказ от мандата, чтение и регистрация ключа — идут", async () => {
    stand = new PaoStand({ handlers: HANDLERS });
    const { core, journal } = await coreOn(stand);
    await core.start();
    await feedDown(core);
    await core.recheck();
    // окно: подпись снята, чтение ленты после снятия ждёт event_poll_interval_ms (настоящий setTimeout ленты)
    expect(kinds(journal, "signing.resumed")).toHaveLength(1);
    expect(core.events.failing).toBe(true);

    // защитные и чтение — идут к Платформе (ответ стенда любой: мандата m_1 нет)
    await core.platform.relinquishMandate("m_1", { idempotencyKey: "idem-k12-r" }).catch(() => undefined);
    await core.platform.getMandate("m_1").catch(() => undefined);
    expect(stand.calls("POST /pao/v1/mandates/{id}/relinquish")).toHaveLength(1);
    expect(stand.calls("GET /pao/v1/mandates/{id}")).toHaveLength(1);
    // ротация — не обязательство: без неё при истёкшем ключе агент не подпишет и сверку (решение владельца, сессия 42)
    await core.platform.registerKey({ alg: "Ed25519", publicKey: "AAAA" }, { idempotencyKey: "idem-k12-k" }).catch(() => undefined);
    expect(stand.calls("POST /pao/v1/agent/keys")).toHaveLength(1);

    // обязательства — отказ до подписи, обращения нет
    const held = { name: "SignerSuspended", reason: "EVENTS_UNAVAILABLE" };
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "idem-k12-c" })).rejects.toMatchObject(held);
    await expect(core.platform.requestMandate(INTENT, { idempotencyKey: "idem-k12-m" })).rejects.toMatchObject(held);
    const shopFetch = vi.fn<typeof fetch>();
    const shop = core.shops({ baseUrl: "http://127.0.0.1:9", fetch: shopFetch });
    await expect(shop.order({ shopId: "shop_1", items: [], cartMandateId: "m_1" } as unknown as ShopOrderRequest)).rejects.toMatchObject(held);
    expect(shopFetch).not.toHaveBeenCalled();
    expect(stand.calls(OP)).toHaveLength(0);
    expect(stand.calls("POST /pao/v1/mandates")).toHaveLength(0);
  });

  it("стадия 0 — EVENTS_UNAVAILABLE до полного чтения ленты; снятие будит ленту, чтение до пустой страницы снимает признак", async () => {
    stand = new PaoStand({ handlers: HANDLERS });
    const { core } = await coreOn(stand);
    await core.start();
    // два неудачных чтения feedDown (в каждом — повторы адаптера), затем лента доступна
    await feedDown(core, { code: "UPSTREAM_UNAVAILABLE" }, 2 * ATTEMPTS);
    const reads = stand.calls(EVENTS).length;
    await core.recheck();
    expect(core.events.failing).toBe(true);

    const before = stand.stub.calls.length;
    const purchase = core.purchase({ offers: feedOffers(SHOP), live: liveOffers(SHOP, () => stand.clock), shop: shopOrders(SHOP), payment: payments() });
    await expect(purchase.intent(INTENT, { idempotencyKey: "idem-k12-p" })).rejects.toMatchObject({ code: "EVENTS_UNAVAILABLE" });
    expect(stand.stub.calls.length).toBe(before);

    // чтение после снятия начато самим ядром (Р60 п. 2): ещё до signal() теста
    expect(stand.calls(EVENTS).length).toBe(reads);
    await vi.waitFor(() => expect(stand.calls(EVENTS).length).toBeGreaterThan(reads), { timeout: 3000 });
    await core.events.signal();
    expect(core.events.failing).toBe(false);
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "idem-k12-c2" })).resolves.toMatchObject({ credentialRef: "cr_1" });
  });

  it("короткий сбой ленты (меньше registry_cache_ttl_sec) признак не ставит", async () => {
    stand = new PaoStand({ handlers: HANDLERS });
    const { core } = await coreOn(stand);
    await core.start();
    stand.stub.fail(EVENTS, { code: "UPSTREAM_UNAVAILABLE" }, ATTEMPTS);
    await expect(core.events.signal()).rejects.toBeInstanceOf(PlatformFailure);
    expect(core.events.failing).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("остановленный агент — сверки нет (SignerStopped у recheck)", async () => {
    stand = new PaoStand({ handlers: HANDLERS });
    const { core } = await coreOn(stand);
    await core.start();
    core.close();
    await expect(core.recheck()).rejects.toThrow(SignerStopped);
  });
});
