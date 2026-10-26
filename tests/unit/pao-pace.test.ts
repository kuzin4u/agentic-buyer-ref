// Ограничитель частоты обращений к ПАО (Р59): ровный интервал не выше rate_limit_per_min (ПАО §2, РП63), запасная частота
// при неизвестном пределе (fail-closed), запись pao.rate_limit до смены (Р-645), один ограничитель на агента (место
// сборки), ожидание ограничителя — в сроке выдачи реквизита (Р45 п. 2.4).
import { afterEach, describe, expect, it } from "vitest";
import { newEd25519Signer } from "@kuzin4u/agentic-core";
import { Pace, PaoPlatform } from "../../src/agent/adapters/pao/index.js";
import { createAgentCore } from "../../src/agent/compose.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import type { RequestSigning } from "../../src/agent/ports/index.js";
import { PAO_RATE_WINDOW_MS, PAO_RETRY_AFTER_MAX_SEC, loadParams } from "../../src/shared/config.js";
import { INTENT, Consents } from "../support/consents.js";
import { AGENT, PaoStand } from "../support/pao-stand.js";

const params = loadParams();
const FALLBACK_MS = 60_000 / params.pao_rate_limit_fallback_per_min;

/** Ограничитель на поддельных часах: время стоит, ожидания записываются. */
function paced(o: { journal?: MemoryJournal } = {}) {
  const sleeps: number[] = [];
  const journal = o.journal ?? new MemoryJournal();
  const pace = new Pace({ fallbackPerMin: params.pao_rate_limit_fallback_per_min, journal, monotonic: () => 0, sleep: async (ms) => void sleeps.push(ms) });
  return { pace, sleeps, journal };
}

describe("ограничитель частоты (Р59 п. 2–3)", () => {
  it("ровный интервал: первое обращение сразу, следующие — через 60 000 / предел мс каждое, в порядке вызова", async () => {
    const { pace, sleeps } = paced();
    await Promise.all([pace.wait(), pace.wait(), pace.wait()]);
    expect(sleeps).toEqual([FALLBACK_MS, 2 * FALLBACK_MS]);
    expect(pace.delay()).toBe(3 * FALLBACK_MS);
  });

  it("предел из GET /pao/v1/agent: запись pao.rate_limit до смены, затем интервал по нему; то же значение — без записи", async () => {
    const { pace, sleeps, journal } = paced();
    await pace.wait();
    pace.learn({ rateLimitPerMin: 3000 });
    pace.learn({ rateLimitPerMin: 3000 });
    expect(journal.entries.map((e) => [e.kind, e.detail])).toEqual([["pao.rate_limit", "AGENT:3000"]]);
    expect(pace.perMin).toBe(3000);
    await pace.wait();
    expect(sleeps).toEqual([20]);
  });

  it("предел неизвестен — запасная частота (fail-closed): нет поля, дробное, отрицательное", () => {
    const { pace, journal } = paced();
    pace.learn({});
    expect(pace.perMin).toBe(params.pao_rate_limit_fallback_per_min);
    for (const bad of [1.5, -5]) {
      pace.learn({ rateLimitPerMin: 600 });
      pace.learn({ rateLimitPerMin: bad });
      expect(pace.perMin).toBe(params.pao_rate_limit_fallback_per_min);
    }
    expect(journal.entries.map((e) => e.detail)).toEqual(["FALLBACK:NO_FIELD", "AGENT:600", "FALLBACK:OUT_OF_RANGE", "AGENT:600", "FALLBACK:OUT_OF_RANGE"]);
  });

  it.each([
    [3, PAO_RATE_WINDOW_MS],
    [5, 15_000],
    [4, 15_000],
  ])("нечётный предел (Р59 дополнение 1 п. 1): L = %i — интервал 30 000 / floor(L/2) = %i мс", async (L, ms) => {
    const { pace, sleeps } = paced();
    pace.learn({ rateLimitPerMin: L });
    await pace.wait();
    await pace.wait();
    expect(sleeps).toEqual([ms]);
  });

  it.each([1, 0])(
    "предел %i — Платформа не пропускает ни одного обращения за окно (дополнение 1 п. 2): pao.contract_violation до pao.rate_limit, одно обращение за окно",
    async (L) => {
      const { pace, sleeps, journal } = paced();
      pace.learn({ rateLimitPerMin: L });
      expect(journal.entries.map((e) => [e.kind, e.reason, e.detail])).toEqual([
        ["pao.contract_violation", "RATE_LIMITED", `RATE_LIMIT_UNUSABLE:${L}`],
        ["pao.rate_limit", undefined, `AGENT:${L}`],
      ]);
      await pace.wait();
      await pace.wait();
      expect(sleeps).toEqual([PAO_RATE_WINDOW_MS]);
    },
  );

  it("часы не дают числа — отказ до сети, без зависания (ревью КТ1 № 1)", async () => {
    const pace = new Pace({ fallbackPerMin: params.pao_rate_limit_fallback_per_min, journal: new MemoryJournal(), monotonic: () => NaN, sleep: async () => {} });
    expect(pace.delay()).toBe(Infinity);
    pace.hold(5);
    await expect(pace.wait()).rejects.toMatchObject({ code: "RATE_LIMITED", retry: "never", httpStatus: 0 });
  });

  it("пауза после 429 (Р59 п. 4): новое обращение — не раньше её конца; ожидающее — новое место после неё", async () => {
    const sleeps: number[] = [];
    // пауза объявляется, пока второе обращение ждёт своего места (время стоит)
    const pace: Pace = new Pace({
      fallbackPerMin: 60,
      journal: new MemoryJournal(),
      monotonic: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 1) pace.hold(5);
      },
    });
    await pace.wait(); // место 0
    await pace.wait(); // место 1 000; во время ожидания — пауза до 5 000: новое место 5 000
    expect(sleeps).toEqual([1000, 4000]);
    expect(pace.delay()).toBe(6000);
    pace.hold(1); // более короткая пауза прежнюю не сокращает
    expect(pace.delay()).toBe(6000);
  });

  it("сбой журнала не отменяет смену предела (Р-645): наружу — ошибка журнала, предел сменён", () => {
    const failing = { record: () => { throw new Error("журнал недоступен"); } };
    const pace = new Pace({ fallbackPerMin: params.pao_rate_limit_fallback_per_min, journal: failing, monotonic: () => 0, sleep: async () => {} });
    expect(() => pace.learn({ rateLimitPerMin: 3000 })).toThrow("журнал недоступен");
    expect(pace.perMin).toBe(3000);
  });
});

describe("ограничитель в адаптере ПАО (Р59 п. 1–2)", () => {
  const { signer } = newEd25519Signer("kid_test");
  const signing: RequestSigning = {
    current: () => signer,
    keyRevoked: () => {
      throw new Error("в этих тестах ключ не отзывается");
    },
    stop: () => {},
    suspend: () => {},
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const draft = { mandate: { id: "m_cart", currency: "RUB" }, orderRef: "ORD-1", merchantId: "shop_1", amountMax: { amount: 250000, currency: "RUB" }, channel: "CARD" as const };
  const self = (rate?: number) =>
    json(200, { agent_code: AGENT, status: "ACTIVE", class: "BUYER", keys: [], ...(rate !== undefined && { rate_limit_per_min: rate }) });

  it("общий ограничитель: предел, прочитанный одним адаптером, держит обращения другого", async () => {
    const { pace, sleeps } = paced();
    const calls: string[] = [];
    const fetch = async (url: string | URL | Request) => {
      calls.push(String(url));
      return self(6);
    };
    const a = new PaoPlatform({ journal: new MemoryJournal(), baseUrl: "http://pao.test", agentCode: AGENT, signing, params, sleep: async () => {}, fetch, pace });
    const b = new PaoPlatform({ journal: new MemoryJournal(), baseUrl: "http://pao.test", agentCode: AGENT, signing, params, sleep: async () => {}, fetch, pace });
    await a.agentSelf(); // слот 0, предел 6 / мин — интервал 10 с
    await b.agentSelf();
    expect(sleeps).toEqual([10_000]);
    expect(calls).toHaveLength(2);
  });

  it("сбой журнала на pao.rate_limit не отменяет остановку агента не ACTIVE (Р-645, ревью КТ1 № 1 сессии 38)", async () => {
    const stops: string[] = [];
    const journal = {
      record: (e: { kind: string }) => {
        if (e.kind === "pao.rate_limit") throw new Error("журнал недоступен");
      },
    };
    const platform = new PaoPlatform({
      journal,
      baseUrl: "http://pao.test",
      agentCode: AGENT,
      signing: { ...signing, stop: (reason) => void stops.push(reason) },
      params,
      sleep: async () => {},
      fetch: async () => json(200, { agent_code: AGENT, status: "SUSPENDED", class: "BUYER", keys: [], rate_limit_per_min: 3000 }),
    });
    await expect(platform.agentSelf()).rejects.toThrow("журнал недоступен");
    expect(stops).toEqual(["AGENT_SUSPENDED"]);
  });

  it.each([
    ["5", 5000],
    ["999", PAO_RETRY_AFTER_MAX_SEC * 1000],
  ])("429 с Retry-After %s: запись pao.call, затем пауза всех обращений (не дольше потолка 30 с); сбой журнала её не отменяет", async (after, holdMs) => {
    const { pace } = paced();
    const journal = {
      record: (e: { kind: string }) => {
        if (e.kind === "pao.call") throw new Error("журнал недоступен");
      },
    };
    const platform = new PaoPlatform({
      journal,
      baseUrl: "http://pao.test",
      agentCode: AGENT,
      signing,
      params,
      sleep: async () => {},
      fetch: async () => new Response(JSON.stringify({ code: "RATE_LIMITED", message: "m", retry: "same_key" }), { status: 429, headers: { "content-type": "application/json", "retry-after": after } }),
      pace,
    });
    await expect(platform.verifyMandate({ id: "m_1", currency: "RUB" })).rejects.toThrow("журнал недоступен");
    expect(pace.delay()).toBe(holdMs);
  });

  it.each([
    ["30", []],
    ["31", [["pao.call", "RATE_LIMITED", "429"], ["pao.contract_violation", "RATE_LIMITED", "RETRY_AFTER_OVER_MAX:31"]]],
  ])("429 с Retry-After %s: больше 30 с — запись pao.contract_violation после pao.call (ПАО §2, решение владельца 26.10)", async (after, expected) => {
    const { pace } = paced();
    const journal = new MemoryJournal();
    const platform = new PaoPlatform({
      journal,
      baseUrl: "http://pao.test",
      agentCode: AGENT,
      signing,
      params,
      sleep: async () => {},
      fetch: async () => new Response(JSON.stringify({ code: "RATE_LIMITED", message: "m", retry: "same_key" }), { status: 429, headers: { "content-type": "application/json", "retry-after": after } }),
      pace,
    });
    await expect(platform.verifyMandate({ id: "m_1", currency: "RUB" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const marks = journal.entries.filter((e) => e.kind === "pao.contract_violation" || (expected.length > 0 && e.kind === "pao.call")).map((e) => [e.kind, e.reason, e.detail]);
    expect(marks).toEqual(expected);
    // пауза — не меньше 30 с (при 30 повтор занимает ещё место в очереди); точное значение — тест выше
    expect(pace.delay()).toBeGreaterThanOrEqual(PAO_RETRY_AFTER_MAX_SEC * 1000);
  });

  it("429 без Retry-After — без повтора и без паузы (Р59 п. 4)", async () => {
    const { pace } = paced();
    pace.learn({ rateLimitPerMin: 60_000 }); // интервал 1 мс
    let calls = 0;
    const platform = new PaoPlatform({
      journal: new MemoryJournal(),
      baseUrl: "http://pao.test",
      agentCode: AGENT,
      signing,
      params,
      sleep: async () => {},
      fetch: async () => {
        calls++;
        return json(429, { code: "RATE_LIMITED", message: "m", retry: "same_key" });
      },
      pace,
    });
    await expect(platform.verifyMandate({ id: "m_1", currency: "RUB" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(calls).toBe(1);
    expect(pace.delay()).toBe(1);
  });

  it("выдача реквизита: ожидание ограничителя не помещается в срок — RATE_LIMITED до сети, место в очереди не занято", async () => {
    const { pace } = paced();
    pace.learn({ rateLimitPerMin: 2 }); // интервал 30 с: 30 + pao_credentials_timeout_ms 35 с > registry_cache_ttl_sec 60 с
    await pace.wait();
    const calls: string[] = [];
    const platform = new PaoPlatform({
      journal: new MemoryJournal(),
      baseUrl: "http://pao.test",
      agentCode: AGENT,
      signing,
      params,
      sleep: async () => {},
      monotonic: () => 0,
      fetch: async (url) => {
        calls.push(String(url));
        return json(500, {});
      },
      pace,
    });
    expect(PAO_RATE_WINDOW_MS + params.pao_credentials_timeout_ms).toBeGreaterThan(params.registry_cache_ttl_sec * 1000);
    await expect(platform.issueCredential(draft, { idempotencyKey: "idem-c" })).rejects.toMatchObject({ code: "RATE_LIMITED", retry: "same_key", httpStatus: 0 });
    expect(calls).toEqual([]);
    expect(pace.delay()).toBe(PAO_RATE_WINDOW_MS);
  });

  it("выдача реквизита: пауза после 429, объявленная во время ожидания, — срок перепроверяется, RATE_LIMITED до сети (ревью КТ1 № 3)", async () => {
    // часы идут вместе со сном; первая пауза сна — объявление паузы 30 с другим обращением агента
    let t = 0;
    let n = 0;
    const sleep = async (ms: number) => {
      t += ms;
      if (n++ === 0) pace.hold(PAO_RETRY_AFTER_MAX_SEC);
    };
    const pace: Pace = new Pace({ fallbackPerMin: params.pao_rate_limit_fallback_per_min, journal: new MemoryJournal(), monotonic: () => t, sleep });
    pace.learn({ rateLimitPerMin: 4 }); // интервал 15 с: 15 + 35 ≤ 60 — до ожидания помещается
    await pace.wait();
    expect(pace.delay() + params.pao_credentials_timeout_ms).toBeLessThanOrEqual(params.registry_cache_ttl_sec * 1000);
    const calls: string[] = [];
    const platform = new PaoPlatform({
      journal: new MemoryJournal(),
      baseUrl: "http://pao.test",
      agentCode: AGENT,
      signing,
      params,
      sleep,
      monotonic: () => t,
      fetch: async (url) => {
        calls.push(String(url));
        return json(500, {});
      },
      pace,
    });
    await expect(platform.issueCredential(draft, { idempotencyKey: "idem-c2" })).rejects.toMatchObject({ code: "RATE_LIMITED", retry: "same_key", httpStatus: 0 });
    expect(calls).toEqual([]);
    // ожидание 15 с, пауза до 45 с — попытка с тайм-аутом 35 с в срок 60 с уже не помещается
    expect(t).toBe(15_000 + PAO_RETRY_AFTER_MAX_SEC * 1000);
  });

  it("429 первого слоя на конфигурации — та же пауза всех обращений (ревью КТ1 № 5)", async () => {
    const { pace } = paced();
    const platform = new PaoPlatform({
      journal: new MemoryJournal(),
      baseUrl: "http://pao.test",
      agentCode: AGENT,
      signing,
      params,
      sleep: async () => {},
      fetch: async () =>
        new Response(JSON.stringify({ code: "RATE_LIMITED", message: "m", retry: "same_key" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "7" } }),
      pace,
    });
    await expect(platform.checkProtocol()).resolves.toMatchObject({ status: "unknown" });
    expect(pace.delay()).toBe(7000);
  });
});

describe("один ограничитель на агента в месте сборки (Р59 п. 1)", () => {
  let stand: PaoStand | undefined;
  afterEach(async () => {
    await stand?.close();
    stand = undefined;
  });

  it("предел, прочитанный адаптером допуска, держит обращения рабочего адаптера", async () => {
    const consents: Consents = new Consents(() => s.clock);
    const s = new PaoStand({ configuration: { versions: ["1.4.0"] }, handlers: consents.handlers() });
    stand = s;
    s.rateLimitPerMin = 6; // интервал 10 с
    const baseUrl = await s.stub.start();
    const sleeps: number[] = [];
    const journal = new MemoryJournal();
    const core = createAgentCore({
      keysDir: s.dir,
      stateDir: `${s.dir}-state`,
      journal,
      now: () => s.clock,
      // время стоит: ожидание ограничителя видно целиком
      pao: { baseUrl, agentCode: AGENT, sleep: async (ms) => void sleeps.push(ms), monotonic: () => 0 },
    });
    await core.start();
    await core.mandates.request(INTENT, { idempotencyKey: "idem_pace_1" });
    core.close();
    // конфигурация — слот 0 (рабочий адаптер); GET /pao/v1/agent — запасной интервал (адаптер допуска, тот же
    // ограничитель), предел 6 / мин; мандат — через 10 с после него (рабочий адаптер)
    expect(sleeps).toEqual([FALLBACK_MS, FALLBACK_MS + 10_000]);
    expect(journal.entries.filter((e) => e.kind === "pao.rate_limit").map((e) => e.detail)).toEqual(["AGENT:6"]);
  });
});
