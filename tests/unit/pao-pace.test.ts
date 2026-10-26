// Ограничитель частоты обращений к ПАО (Р59): ровный интервал не выше rate_limit_per_min (ПАО §2, РП63), запасная частота
// при неизвестном пределе (fail-closed), запись pao.rate_limit до смены (Р-645), один ограничитель на агента (место
// сборки), ожидание ограничителя — в сроке выдачи реквизита (Р45 п. 2.4).
import { afterEach, describe, expect, it } from "vitest";
import { newEd25519Signer } from "@kuzin4u/agentic-core";
import { Pace, PaoPlatform } from "../../src/agent/adapters/pao/index.js";
import { createAgentCore } from "../../src/agent/compose.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import type { RequestSigning } from "../../src/agent/ports/index.js";
import { loadParams } from "../../src/shared/config.js";
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

  it("предел неизвестен — запасная частота (fail-closed): нет поля, 0, дробное, отрицательное", () => {
    const { pace, journal } = paced();
    pace.learn({});
    expect(pace.perMin).toBe(params.pao_rate_limit_fallback_per_min);
    pace.learn({ rateLimitPerMin: 600 });
    for (const bad of [0, 1.5, -5]) {
      pace.learn({ rateLimitPerMin: 600 });
      pace.learn({ rateLimitPerMin: bad });
      expect(pace.perMin).toBe(params.pao_rate_limit_fallback_per_min);
    }
    expect(journal.entries.map((e) => e.detail)).toEqual([
      "FALLBACK:NO_FIELD",
      "AGENT:600",
      "FALLBACK:OUT_OF_RANGE",
      "AGENT:600",
      "FALLBACK:OUT_OF_RANGE",
      "AGENT:600",
      "FALLBACK:OUT_OF_RANGE",
    ]);
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
    expect(30_000 + params.pao_credentials_timeout_ms).toBeGreaterThan(params.registry_cache_ttl_sec * 1000);
    const draft = { mandate: { id: "m_cart", currency: "RUB" }, orderRef: "ORD-1", merchantId: "shop_1", amountMax: { amount: 250000, currency: "RUB" }, channel: "CARD" as const };
    await expect(platform.issueCredential(draft, { idempotencyKey: "idem-c" })).rejects.toMatchObject({ code: "RATE_LIMITED", retry: "same_key", httpStatus: 0 });
    expect(calls).toEqual([]);
    expect(pace.delay()).toBe(30_000);
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
