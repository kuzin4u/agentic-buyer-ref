// Ядро агента и события на стенде v0.11.0 (Р34 п. 2, 4, 8, 10; Р41 п. 2): подписка при старте, push эмулятору получателя стенда →
// его тело и x-event-id — в acceptPush ядра → чтение ленты; курсор в каталоге состояния переживает перезапуск.
// Push на стенде получает эмулятор stand.agentReceiver, а не агент (РП40 п. 8) — тело передаётся вручную.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStand, type Stand } from "agentic-ps-platform/stand";
import { afterEach, describe, expect, it } from "vitest";
import { checkSelfCheckReport } from "@kuzin4u/agentic-core/diag";
import { DIAG, createAgentCore, type AgentCore } from "../../src/agent/compose.js";
import { AgentNotReady } from "../../src/agent/declines/index.js";
import { CURSOR_FILE } from "../../src/agent/events/index.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { SignerStopped, generateKey } from "../../src/agent/signer/index.js";
import { INTENT } from "../support/consents.js";
import { AGENT } from "../support/pao-stand.js";


/** Стенд в процессе теста под параллельной нагрузкой прогона бывает медленнее 5 с по умолчанию (нюанс К2.3). */
const STAND_TIMEOUT_MS = 20_000;
/** Событие agent.* для подмены ленты: стенд agent.* в ленту не пишет (РП39 п. 3). */
const AGENT_EVENT = { event_id: "evt_a1", type: "agent.key_revoked", at: "2026-10-19T09:00:00Z", data: {} };

/** Подмена страниц ленты по очереди; курсор evt_a1 стенд не знает — без пустой страницы в конце был бы 400 и
 *  остановка EVENTS_CURSOR_INVALID, как положено. */
function feedPages(replace: Map<string, () => Response>, pages: unknown[][]): void {
  replace.set("GET /pao/v1/events", () => {
    const page = pages.shift() ?? [];
    if (pages.length === 0) replace.delete("GET /pao/v1/events");
    return Response.json(page);
  });
}

let stand: Stand | undefined;
const cores: AgentCore[] = [];
const dirs: string[] = [];
afterEach(async () => {
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

async function setup() {
  const s = createStand();
  stand = s;
  const keysDir = tmp("ev-keys-");
  const stateDir = join(tmp("ev-state-"), "state");
  const { descriptor } = generateKey(keysDir);
  const decision = await s.admit(
    { agent_code: AGENT, class: "BUYER", model: "buyer-agent-ref", runtime: "node-20", alg: "ed25519", public_key: descriptor.public_key },
    "buyref-operator",
  );
  if (!decision.admitted) throw new Error("стенд не допустил агента");
  const baseUrl = await s.listen();
  const host = s.params.event_subscription_allow_hosts[0];
  /** журнал обращений агента: метод и путь без query, статус, Idempotency-Key; тела не сохраняются (инвариант 1) */
  const calls: { route: string; status: number; key: string | null }[] = [];
  /** подмена ответа Платформы на маршрут (метод и путь) — для отказов, которых стенд сам не даёт */
  const replace = new Map<string, () => Response>();
  const fetchLog: typeof fetch = async (url, init) => {
    const route0 = `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`;
    const fake = replace.get(route0);
    const res = fake ? fake() : await fetch(url, init);
    const u = new URL(String(url));
    calls.push({ route: `${init?.method ?? "GET"} ${u.pathname}`, status: res.status, key: new Headers(init?.headers).get("idempotency-key") });
    return res;
  };
  const core = (pushUrl?: string) => {
    const journal = new MemoryJournal();
    const c = createAgentCore({ keysDir, stateDir, journal, ...(pushUrl && { pushUrl }), pao: { baseUrl, agentCode: AGENT, sleep: async () => {}, fetch: fetchLog } });
    cores.push(c);
    return { c, journal };
  };
  return { s, core, stateDir, calls, replace, host, pushUrl: `https://${host}/pao/events` };
}

describe("ядро и события на стенде v0.11.0 (Р34)", { timeout: STAND_TIMEOUT_MS }, () => {
  it("подписка при старте, push → лента, курсор в каталоге состояния; перезапуск — без повторной обработки", async () => {
    const { s, core, stateDir, pushUrl, calls } = await setup();
    const a = core(pushUrl);
    await a.c.start();
    expect(await s.registry.subscription(AGENT)).toMatchObject({ url: pushUrl });

    const m = await a.c.platform.requestMandate(INTENT, { idempotencyKey: "idem-m1" });
    await s.issuer.sign(m.id);
    expect(await s.deliverEvents()).toBe(1);
    const [got] = s.agentReceiver.received;
    if (!got) throw new Error("push не доставлен");
    expect(a.c.acceptPush(JSON.stringify(got.event), { "x-event-id": got.header_event_id })).toEqual({ status: 200 });
    await a.c.events.signal();

    expect(a.journal.entries.filter((e) => e.kind.startsWith("event"))).toEqual([
      expect.objectContaining({ kind: "events.cursor_initial" }),
      expect.objectContaining({ kind: "event.handled", ref: got.event_id, detail: "mandate.signed" }),
    ]);
    expect(existsSync(join(stateDir, CURSOR_FILE))).toBe(true);
    expect(a.c.events.cursor()).toBe(got.event_id);

    // перезапуск: тот же каталог состояния — лента с курсора, событие повторно не обрабатывается
    a.c.close();
    const b = core(pushUrl);
    await b.c.start();
    await b.c.events.signal();
    expect(b.c.events.cursor()).toBe(got.event_id);
    expect(b.journal.entries.filter((e) => e.kind.startsWith("event"))).toEqual([]);

    // полный журнал обращений: лишнего PUT или чтения ленты нет; ключ подписки у каждого запуска свой (дополнение Р34 п. 2)
    const CONF = { route: "GET /.well-known/pao-configuration", status: 200, key: null };
    const SELF = { route: "GET /pao/v1/agent", status: 200, key: null };
    const [k1, k2] = calls.filter((c) => c.route === "PUT /pao/v1/subscription").map((c) => c.key);
    expect(k1).toMatch(/^sub-[0-9a-f]{32}$/);
    expect(k2).toMatch(/^sub-[0-9a-f]{32}$/);
    expect(k2).not.toBe(k1);
    expect(calls).toEqual([
      CONF,
      SELF,
      { route: "PUT /pao/v1/subscription", status: 200, key: k1 },
      { route: "POST /pao/v1/mandates", status: 201, key: "idem-m1" },
      // чтение по push: страница с событием и пустая; сигнал во время чтения — ровно одно следующее (уточнение 1)
      { route: "GET /pao/v1/events", status: 200, key: null },
      { route: "GET /pao/v1/events", status: 200, key: null },
      { route: "GET /pao/v1/events", status: 200, key: null },
      CONF,
      SELF,
      { route: "PUT /pao/v1/subscription", status: 200, key: k2 },
      { route: "GET /pao/v1/events", status: 200, key: null },
    ]);
  });

  it("адрес подписки отвергнут (400) — запись в журнал, старт состоялся, лента работает (Р34 п. 8)", async () => {
    const { s, core } = await setup();
    expect(s.params.event_subscription_allow_hosts).not.toContain("agent.example.invalid");
    const a = core("https://agent.example.invalid/pao/events");
    await expect(a.c.start()).resolves.toMatchObject({ status: "ACTIVE" });
    expect(a.journal.entries).toContainEqual(expect.objectContaining({ kind: "events.subscription_rejected", reason: "REQUEST_INVALID" }));
    // дополнение 2 к Р36 п. 5: отказ адреса — предупреждение в отчёте, готовность не снята
    expect(checkSelfCheckReport(a.c.selfCheck()!, DIAG)).toEqual([]);
    expect(a.c.selfCheck()).toMatchObject({ ready: true });
    expect(a.c.selfCheck()!.checks.at(-1)).toEqual({ check: "events.subscription", status: "warn", code: "REQUEST_INVALID" });
    await a.c.events.signal();
    expect(a.c.events.cursor()).toBeNull();
  });

  it("П04 на ленте: подпись после первого чтения → mandate.signed (по push или опросу) → GET ACTIVE (Р34 п. 5, Р29 п. 5)", async () => {
    const { s, core, pushUrl, calls } = await setup();
    const a = core(pushUrl);
    await a.c.start();
    const m = await a.c.mandates.request(INTENT, { idempotencyKey: "idem-p04" });
    const abort = new AbortController();
    const waiting = a.c.mandates.awaitSigned(m, a.c.events.items(abort.signal), abort.signal);
    // подпись — после того как ожидание уже прочитало ленту (статус был PENDING_SIGNATURE)
    for (let i = 0; i < 200 && !calls.some((c) => c.route === "GET /pao/v1/events"); i++) await new Promise((r) => setTimeout(r, 5));
    expect((await s.issuer.sign(m.id)).statusCode).toBe(200);
    await s.deliverEvents();
    const [got] = s.agentReceiver.received;
    if (!got) throw new Error("push не доставлен");
    a.c.acceptPush(JSON.stringify(got.event), { "x-event-id": got.header_event_id });

    await expect(waiting).resolves.toMatchObject({ id: m.id, status: "ACTIVE" });
    abort.abort();
    expect(a.journal.entries).toContainEqual(expect.objectContaining({ kind: "event.handled", ref: got.event_id, detail: "mandate.signed" }));
    // статус — по GET после события: до ожидания и после mandate.signed
    expect(calls.filter((c) => c.route === `GET /pao/v1/mandates/${m.id}`)).toHaveLength(2);
    // полный журнал: кроме чтений ленты (их число зависит от опроса) — ровно эти обращения, по порядку
    expect(calls.filter((c) => c.route !== "GET /pao/v1/events").map((c) => c.route)).toEqual([
      "GET /.well-known/pao-configuration",
      "GET /pao/v1/agent",
      "PUT /pao/v1/subscription",
      "POST /pao/v1/mandates",
      `GET /pao/v1/mandates/${m.id}`,
      `GET /pao/v1/mandates/${m.id}`,
    ]);
    // ошибок нет: конфигурацию стенд отдаёт с v0.26.0 (РП60, передача #74; до неё — 404, Р33 п. 10; Р57 п. 1)
    expect(calls.filter((c) => c.status >= 400).map((c) => c.route)).toEqual([]);
  });

  it("agent.* в ленте — сверка GET /pao/v1/agent, курсор двигается (Р34 п. 5)", async () => {
    const { core, calls, replace } = await setup();
    const a = core();
    await a.c.start();
    feedPages(replace, [[AGENT_EVENT], []]);
    const from = calls.length;
    await a.c.events.signal();
    expect(calls.slice(from).map((c) => [c.route, c.status])).toEqual([
      ["GET /pao/v1/events", 200],
      ["GET /pao/v1/agent", 200],
      ["GET /pao/v1/events", 200],
    ]);
    expect(a.c.events.cursor()).toBe("evt_a1");
    expect(a.journal.entries).toContainEqual(expect.objectContaining({ kind: "event.handled", ref: "evt_a1", detail: "agent.key_revoked" }));
  });

  it("agent.*: сверка не прошла (503) — курсор на месте, записи нет; после восстановления — одна обработка (Р34 п. 3)", async () => {
    const { core, calls, replace } = await setup();
    const a = core();
    await a.c.start();
    feedPages(replace, [[AGENT_EVENT], [AGENT_EVENT], []]);
    replace.set("GET /pao/v1/agent", () => {
      replace.delete("GET /pao/v1/agent");
      return Response.json({ code: "STATE_UNAVAILABLE", message: "x", norm: "x", retry: "same_key" }, { status: 503 });
    });
    await expect(a.c.events.signal()).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    expect(a.c.events.cursor()).toBeNull();
    expect(a.journal.entries.filter((e) => e.kind === "event.handled")).toEqual([]);
    await a.c.events.signal();
    expect(a.c.events.cursor()).toBe("evt_a1");
    expect(a.journal.entries.filter((e) => e.kind === "event.handled")).toHaveLength(1);
    expect(calls.filter((c) => c.route === "GET /pao/v1/agent").map((c) => c.status)).toEqual([200, 503, 200]);
  });

  it("agent.* во время внешней сверки — дождаться её и сверить заново, без «сверка уже идёт» (ревью К2.4 № 3–4)", async () => {
    const { core, calls, replace } = await setup();
    const a = core();
    await a.c.start();
    feedPages(replace, [[AGENT_EVENT], []]);
    const external = a.c.recheck();
    await Promise.all([external, a.c.events.signal()]);
    expect(calls.filter((c) => c.route === "GET /pao/v1/agent").map((c) => c.status)).toEqual([200, 200, 200]);
    expect(a.c.events.cursor()).toBe("evt_a1");
  });

  it("A → B → A тремя запусками: действует последний адрес, ключи разные (дополнение Р34 п. 2)", async () => {
    const { s, core, host, calls } = await setup();
    const urls = [`https://${host}/a`, `https://${host}/b`, `https://${host}/a`];
    for (const url of urls) {
      const r = core(url);
      await r.c.start();
      expect((await s.registry.subscription(AGENT))?.url).toBe(url);
      r.c.close();
    }
    const keys = calls.filter((c) => c.route === "PUT /pao/v1/subscription").map((c) => c.key);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
  });

  it.each([
    ["503 STATE_UNAVAILABLE без Retry-After", () => Response.json({ code: "STATE_UNAVAILABLE", message: "x", norm: "x", retry: "same_key" }, { status: 503 }), "STATE_UNAVAILABLE"],
    ["ответ — не та подписка (BAD_RESPONSE)", () => Response.json({ url: "https://evil.example/x", events: [] }, { status: 200 }), "BAD_RESPONSE"],
  ] as const)("подписка: %s — старт успешен, events.subscription_failed без адреса, лента работает (дополнение Р34 п. 1)", async (_, reply, code) => {
    const { core, replace, pushUrl } = await setup();
    replace.set("PUT /pao/v1/subscription", reply);
    const a = core(pushUrl);
    await expect(a.c.start()).resolves.toMatchObject({ status: "ACTIVE" });
    const failed = a.journal.entries.filter((e) => e.kind === "events.subscription_failed");
    expect(failed).toEqual([{ at: expect.any(String), agent: AGENT, kind: "events.subscription_failed", reason: code }]);
    // отчёт самопроверки: подписка — предупреждение, готовность не снята (дополнение 2 к Р36 п. 5)
    expect(checkSelfCheckReport(a.c.selfCheck()!, DIAG)).toEqual([]);
    expect(a.c.selfCheck()).toMatchObject({ ready: true });
    expect(a.c.selfCheck()!.checks.at(-1)).toEqual({ check: "events.subscription", status: "warn", code });
    expect(JSON.stringify(a.journal.entries)).not.toContain(pushUrl);
    await a.c.events.signal();
    expect(a.c.events.cursor()).toBeNull();
  });

  // Дополнение 2 к Р36 п. 5 (ревью К2.2 № 4): код остановки агента на подписке после допуска — AgentNotReady с отчётом,
  // selfCheck() не показывает ready: true; подписант остановлен.
  it("подписка: 403 AGENT_SUSPENDED после допуска — AgentNotReady, events.subscription: fail, ready: false, подпись остановлена", async () => {
    const { core, replace, pushUrl } = await setup();
    replace.set("PUT /pao/v1/subscription", () =>
      Response.json({ code: "AGENT_SUSPENDED", message: "x", norm: "x", retry: "never" }, { status: 403 }),
    );
    const a = core(pushUrl);
    const err = await a.c.start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentNotReady);
    const report = (err as AgentNotReady).report;
    expect(checkSelfCheckReport(report, DIAG)).toEqual([]);
    expect(report.ready).toBe(false);
    expect(report.checks.slice(-2)).toEqual([
      { check: "platform.admission", status: "ok" },
      { check: "events.subscription", status: "fail", code: "AGENT_SUSPENDED" },
    ]);
    expect((err as AgentNotReady).cause).toMatchObject({ code: "AGENT_SUSPENDED" });
    expect(a.c.selfCheck()).toBe(report);
    await expect(a.c.platform.agentSelf()).rejects.toThrow(SignerStopped);
    // Р60 п. 0, ревью К1.1 № 4: адаптер сначала приостанавливает подпись, затем старт останавливает её — в журнале обе
    // записи по порядку. На подписке так и остаётся (нюанс К1.1 Р63); без остановки — только на допуске (Р63 п. 1)
    expect(a.journal.entries.filter((e) => e.kind === "signing.suspended" || e.kind === "agent.stopped").map((e) => [e.kind, e.reason])).toEqual([
      ["signing.suspended", "AGENT_SUSPENDED"],
      ["agent.stopped", "AGENT_SUSPENDED"],
    ]);
    expect(JSON.stringify(a.journal.entries)).not.toContain(pushUrl);
  });

  it("подписка: остановленная подпись (AGENT_KEY_REVOKED, запасного ключа нет — NO_ACTIVE_KEY) — events.subscription: fail, AgentNotReady", async () => {
    const { core, replace, pushUrl } = await setup();
    replace.set("PUT /pao/v1/subscription", () =>
      Response.json({ code: "AGENT_KEY_REVOKED", message: "x", norm: "x", retry: "new_key" }, { status: 401 }),
    );
    const a = core(pushUrl);
    const err = await a.c.start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentNotReady);
    const report = (err as AgentNotReady).report;
    expect(checkSelfCheckReport(report, DIAG)).toEqual([]);
    expect(report.ready).toBe(false);
    expect(report.checks.at(-1)).toEqual({ check: "events.subscription", status: "fail", code: "NO_ACTIVE_KEY" });
    expect((err as AgentNotReady).cause).toBeInstanceOf(SignerStopped);
    expect(a.c.selfCheck()).toBe(report);
  });

  it("подписка прошла — events.subscription: ok, ready: true", async () => {
    const { core, pushUrl } = await setup();
    const a = core(pushUrl);
    await a.c.start();
    expect(checkSelfCheckReport(a.c.selfCheck()!, DIAG)).toEqual([]);
    expect(a.c.selfCheck()).toMatchObject({ ready: true });
    expect(a.c.selfCheck()!.checks.at(-1)).toEqual({ check: "events.subscription", status: "ok" });
  });

  // Р37 п. 4, Р34 ответ (б): держимый мандат — перечитывание по событию ленты, а не по слову события.
  it("держимый мандат отозван в банке — mandate.revoked по ленте → GET REVOKED → mandate.revoked, не держится (Т15)", async () => {
    const { s, core, calls } = await setup();
    const a = core();
    await a.c.start();
    const m = await a.c.mandates.request(INTENT, { idempotencyKey: "idem-held-1" });
    const abort = new AbortController();
    const waiting = a.c.mandates.awaitSigned(m, a.c.events.items(abort.signal), abort.signal);
    for (let i = 0; i < 200 && !calls.some((c) => c.route === "GET /pao/v1/events"); i++) await new Promise((r) => setTimeout(r, 5));
    expect((await s.issuer.sign(m.id)).statusCode).toBe(200);
    await a.c.events.signal();
    await expect(waiting).resolves.toMatchObject({ id: m.id, status: "ACTIVE" });
    abort.abort();
    expect(a.c.mandates.held().map((x) => x.id)).toEqual([m.id]);

    const getsBefore = calls.filter((c) => c.route === `GET /pao/v1/mandates/${m.id}`).length;
    expect((await s.issuer.revoke(m.id)).statusCode).toBe(200);
    await a.c.events.signal();
    expect(a.c.mandates.held()).toEqual([]);
    // статус — по GET после события отзыва: ровно одно новое чтение мандата (ревью К2.3 № 10)
    expect(calls.filter((c) => c.route === `GET /pao/v1/mandates/${m.id}`)).toHaveLength(getsBefore + 1);
    expect(a.journal.entries.filter((e) => e.kind === "mandate.revoked")).toEqual([
      expect.objectContaining({ agent: AGENT, kind: "mandate.revoked", mandate: m.id }),
    ]);
    expect(a.journal.entries).toContainEqual(expect.objectContaining({ kind: "event.handled", detail: "mandate.revoked" }));
  });

  it("сбой GET держимого мандата на mandate.revoked — курсор на месте; после восстановления — одна обработка и одна запись (Р34 п. 3, ревью К2.3 № 7)", async () => {
    const { s, core, replace } = await setup();
    const a = core();
    await a.c.start();
    const m = await a.c.mandates.request(INTENT, { idempotencyKey: "idem-held-3" });
    expect((await s.issuer.sign(m.id)).statusCode).toBe(200);
    const abort = new AbortController();
    await expect(a.c.mandates.awaitSigned(m, a.c.events.items(abort.signal), abort.signal)).resolves.toMatchObject({ status: "ACTIVE" });
    abort.abort();
    await a.c.events.signal();
    const cursor = a.c.events.cursor();
    expect((await s.issuer.revoke(m.id)).statusCode).toBe(200);
    replace.set(`GET /pao/v1/mandates/${m.id}`, () => Response.json({ code: "STATE_UNAVAILABLE", message: "m", retry: "same_key" }, { status: 503 }));
    await expect(a.c.events.signal()).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    expect(a.c.events.cursor()).toBe(cursor);
    expect(a.journal.entries.filter((e) => e.kind === "event.handled" && e.detail === "mandate.revoked")).toEqual([]);
    expect(a.c.mandates.held().map((x) => x.id)).toEqual([m.id]);
    replace.delete(`GET /pao/v1/mandates/${m.id}`);
    await a.c.events.signal();
    expect(a.journal.entries.filter((e) => e.kind === "event.handled" && e.detail === "mandate.revoked")).toHaveLength(1);
    expect(a.journal.entries.filter((e) => e.kind === "mandate.revoked")).toHaveLength(1);
    expect(a.c.mandates.held()).toEqual([]);
  });

  it("пропуск INVALID_DATA мандатного типа вне ожидания подписи — GET всех держимых, ACTIVE держится (Р34 ответ (б))", async () => {
    const { s, core, calls, replace } = await setup();
    const a = core();
    await a.c.start();
    const m = await a.c.mandates.request(INTENT, { idempotencyKey: "idem-held-2" });
    expect((await s.issuer.sign(m.id)).statusCode).toBe(200);
    const abort = new AbortController();
    await expect(a.c.mandates.awaitSigned(m, a.c.events.items(abort.signal), abort.signal)).resolves.toMatchObject({ status: "ACTIVE" });
    abort.abort();
    await a.c.events.signal(); // mandate.signed из ленты — курсор на нём
    const before = calls.filter((c) => c.route === `GET /pao/v1/mandates/${m.id}`).length;
    feedPages(replace, [[{ event_id: "evt_bad_m", type: "mandate.revoked", at: "2026-10-19T09:00:00Z", data: {} }], []]);
    await a.c.events.signal();
    expect(a.journal.entries).toContainEqual(expect.objectContaining({ kind: "event.ignored", ref: "evt_bad_m", detail: "INVALID_DATA" }));
    expect(calls.filter((c) => c.route === `GET /pao/v1/mandates/${m.id}`)).toHaveLength(before + 1);
    expect(a.c.mandates.held().map((x) => x.id)).toEqual([m.id]);
  });

  it("404 у держимого мандата на mandate.revoked — mandate.vanished, курсор сдвинут, лента работает дальше (решение владельца по К2.3, вариант (а))", async () => {
    const { s, core, replace } = await setup();
    const a = core();
    await a.c.start();
    const m = await a.c.mandates.request(INTENT, { idempotencyKey: "idem-held-4" });
    expect((await s.issuer.sign(m.id)).statusCode).toBe(200);
    const abort = new AbortController();
    await expect(a.c.mandates.awaitSigned(m, a.c.events.items(abort.signal), abort.signal)).resolves.toMatchObject({ status: "ACTIVE" });
    abort.abort();
    await a.c.events.signal();
    const cursor = a.c.events.cursor();
    expect((await s.issuer.revoke(m.id)).statusCode).toBe(200);
    replace.set(`GET /pao/v1/mandates/${m.id}`, () => Response.json({ code: "MANDATE_NOT_FOUND", message: "m", retry: "after_human" }, { status: 404 }));
    await a.c.events.signal();
    expect(a.c.events.cursor()).not.toBe(cursor);
    expect(a.journal.entries.filter((e) => e.kind === "mandate.vanished")).toEqual([
      expect.objectContaining({ kind: "mandate.vanished", mandate: m.id, reason: "MANDATE_NOT_FOUND" }),
    ]);
    expect(a.c.mandates.held()).toEqual([]);
    // лента идёт дальше: новый мандат подписывается и ожидание по ленте завершается
    replace.delete(`GET /pao/v1/mandates/${m.id}`);
    const m2 = await a.c.mandates.request({ ...INTENT, subject: "второй" }, { idempotencyKey: "idem-held-5" });
    expect((await s.issuer.sign(m2.id)).statusCode).toBe(200);
    const abort2 = new AbortController();
    const waiting = a.c.mandates.awaitSigned(m2, a.c.events.items(abort2.signal), abort2.signal);
    await a.c.events.signal();
    await expect(waiting).resolves.toMatchObject({ id: m2.id, status: "ACTIVE" });
    abort2.abort();
  });

  it("каталог состояния совпадает с каталогом ключей или вложен (в обе стороны) — отказ сборки", async () => {
    const d = tmp("ev-same-");
    const pao = { baseUrl: "http://127.0.0.1:1", agentCode: AGENT };
    for (const [keysDir, stateDir] of [[d, d], [d, join(d, "state")], [join(d, "keys"), d], [d, `${d}/./`]]) {
      expect(() => createAgentCore({ keysDir: keysDir!, stateDir: stateDir!, pao }), `${keysDir} / ${stateDir}`).toThrow(/каталог состояния/);
    }
    // соседние каталоги с общим началом имени — не вложенность
    const c = createAgentCore({ keysDir: `${d}/keys`, stateDir: `${d}/keys-state`, pao });
    c.close();
  });
});
