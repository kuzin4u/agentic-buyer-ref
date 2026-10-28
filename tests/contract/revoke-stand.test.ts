// Отзыв своего ключа по ПАО на стенде v0.28.0 (Р57 п. 4; передача #74 — PS-05б ч. 1, РП60; копия ПАО 1.4.0, §3) и
// предел частоты в GET /pao/v1/agent (Р57 п. 5; передача #78 — PS-05б ч. 4, РП63; §2). A2 п. 5.4, SPEC §7а
// (AGENT_KEY_REVOKED), П02 на стенде. Метода отзыва своего ключа у ядра нет (Р57 п. 4): отзыв шлёт тестовая
// поддержка, подписью ключа агента (как tests/support/pao-unkeyed.ts). Отзывается отдельный временный ключ B,
// зарегистрированный по ПАО ключом допуска A; ключ A и другие тесты стенда не задеты (стенд — свой у каждого теста).
// rate_limit_per_min здесь — сверка ответом стенда; чтение ядром и ровная частота — Р59 (pao-pace.test.ts, на стенде — К2).
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signRequest, type Signer } from "@kuzin4u/agentic-core";
import { createStand, type Stand } from "agentic-ps-platform/stand";
import { afterEach, describe, expect, it } from "vitest";
import { PaoPlatform } from "../../src/agent/adapters/pao/index.js";
import { createAgentCore, type AgentCore } from "../../src/agent/compose.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { SignerStopped, SignerSuspended, generateKey } from "../../src/agent/signer/index.js";
import { loadParams } from "../../src/shared/config.js";
import { INTENT } from "../support/consents.js";
import { startCause } from "../support/core.js";
import { AGENT } from "../support/pao-stand.js";

let stand: Stand | undefined;
const cores: AgentCore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) c.close();
  await stand?.close();
  stand = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function setup() {
  const s = createStand();
  stand = s;
  const dirA = tmp("revoke-keys-a-");
  const a = generateKey(dirA);
  const decision = await s.admit(
    { agent_code: AGENT, class: "BUYER", model: "buyer-agent-ref", runtime: "node-20", alg: "ed25519", public_key: a.descriptor.public_key },
    "buyref-operator",
  );
  if (!decision.admitted) throw new Error("стенд не допустил агента");
  const baseUrl = await s.listen();

  /** Подписанное обращение тестовой поддержки к ПАО стенда заданным ключом агента. */
  async function raw(signer: Signer, method: string, path: string, o: { idempotencyKey?: string } = {}) {
    const headers = signRequest(
      {
        method,
        path,
        query: "",
        headers: {
          ...(o.idempotencyKey !== undefined && { "idempotency-key": o.idempotencyKey }),
          "x-agent-code": AGENT,
          "x-timestamp": new Date().toISOString().slice(0, 19) + "Z",
          "x-nonce": randomUUID(),
        },
        body: "",
      },
      signer,
    ).headers;
    const res = await fetch(`${baseUrl}${path}`, { method, headers });
    const text = await res.text();
    return { status: res.status, body: text === "" ? undefined : (JSON.parse(text) as Record<string, unknown>) };
  }

  /** Ядро агента с хранилищем ключей `dir` — допуск по стадии 0, как у места сборки; `fetch` — свой (потеря ответа). */
  function core(dir: string, fetchImpl?: typeof fetch) {
    const journal = new MemoryJournal();
    const c = createAgentCore({ keysDir: dir, stateDir: `${dir}-state`, journal, now: () => new Date(), pao: { baseUrl, agentCode: AGENT, sleep: async () => {}, ...(fetchImpl && { fetch: fetchImpl }) } });
    cores.push(c);
    return { c, journal };
  }
  return { s, a, dirA, baseUrl, raw, core };
}

describe("отзыв своего ключа по ПАО и предел частоты на стенде v0.28.0 (§2, §3; РП60, РП63; Р57 п. 4–5)", () => {
  it("ключ B, которым подписан отзыв, — 200 REVOKED; повтор тем же ключом — 401 AGENT_KEY_REVOKED; допуск только ключом B — остановка NO_ACTIVE_KEY, ключ A действует (П02 на стенде)", async () => {
    const { a, dirA, baseUrl, raw, core } = await setup();
    // временный ключ B — регистрация по ПАО ключом допуска A (адаптер агента, POST /pao/v1/agent/keys)
    const dirB = tmp("revoke-keys-b-");
    const b = generateKey(dirB);
    const fixedA = { current: () => a.signer, protective: () => a.signer, keyRevoked: () => a.signer, stop: () => {}, suspend: () => {} };
    const platform = new PaoPlatform({ baseUrl, agentCode: AGENT, signing: fixedA, params: loadParams(), journal: new MemoryJournal() });
    expect(await platform.registerKey({ alg: "ed25519", publicKey: b.descriptor.public_key }, { idempotencyKey: "idem-key-b" })).toMatchObject({
      kid: b.descriptor.kid,
      status: "ACTIVE",
    });

    // отзыв ключа B, подписанный самим B: пустое тело, Idempotency-Key обязателен
    const revoke = `/pao/v1/agent/keys/${b.descriptor.kid}/revoke`;
    expect(await raw(b.signer, "POST", revoke, { idempotencyKey: "idem-revoke-b" })).toMatchObject({
      status: 200,
      body: { kid: b.descriptor.kid, status: "REVOKED" },
    });
    // потерянный ответ: повтор тем же ключом — не сохранённый 200, а 401 AGENT_KEY_REVOKED (§3, РП60)
    expect(await raw(b.signer, "POST", revoke, { idempotencyKey: "idem-revoke-b" })).toMatchObject({
      status: 401,
      body: { code: "AGENT_KEY_REVOKED" },
    });
    // проверка исхода — GET /pao/v1/agent другим действующим ключом
    const self = await raw(a.signer, "GET", "/pao/v1/agent");
    expect(self.status).toBe(200);
    expect(self.body!.keys).toEqual(expect.arrayContaining([expect.objectContaining({ kid: a.descriptor.kid, status: "ACTIVE" })]));
    expect(self.body!.keys).not.toEqual(expect.arrayContaining([expect.objectContaining({ kid: b.descriptor.kid, status: "ACTIVE" })]));

    // допуск ядра только с ключом B: 401 AGENT_KEY_REVOKED → ключ отозван, другого действующего нет → остановка
    // NO_ACTIVE_KEY — как П02 на PaoStub («нет действующего ключа — агент останавливается»)
    const onB = core(dirB);
    const err = (await startCause(onB.c.start()).catch((e: unknown) => e)) as SignerStopped;
    expect(err).toBeInstanceOf(SignerStopped);
    expect(err.reason).toBe("NO_ACTIVE_KEY");
    expect(onB.journal.entries).toContainEqual(expect.objectContaining({ kind: "key.revoked", kid: b.descriptor.kid, reason: "AGENT_KEY_REVOKED" }));
    // за остановкой при start() — отчёт самопроверки (agent.selfcheck), поэтому не последняя запись
    expect(onB.journal.entries).toContainEqual(expect.objectContaining({ kind: "agent.stopped", reason: "NO_ACTIVE_KEY" }));
    // ключ A не задет: допуск ядра с ключом A — ACTIVE
    await expect(core(dirA).c.start()).resolves.toMatchObject({ agentCode: AGENT, status: "ACTIVE" });
  });

  /** Связка ядра с единственным ключом A: после отзыва — остановка NO_ACTIVE_KEY с признаком отозванного ключа, запись
   *  key.revoked — раньше agent.stopped (Р-645). */
  function stoppedAfterRevoke(err: unknown, journal: MemoryJournal, kid: string) {
    expect(err).toBeInstanceOf(SignerStopped);
    expect(err).toMatchObject({ reason: "NO_ACTIVE_KEY", revokedKid: kid });
    const kinds = journal.entries.map((e) => e.kind);
    expect(kinds.indexOf("key.revoked")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("key.revoked")).toBeLessThan(kinds.indexOf("agent.stopped"));
    expect(journal.entries).toContainEqual(expect.objectContaining({ kind: "key.revoked", kid }));
  }

  it("revokeKey ядра (Р60 п. 7): единственный ключ — 200 REVOKED, связка — NO_ACTIVE_KEY с revokedKid (отзыв состоялся)", async () => {
    const { s, a, dirA, core } = await setup();
    const { c, journal } = core(dirA);
    await c.start();
    const err = await c.platform.revokeKey(a.descriptor.kid, { idempotencyKey: "idem-revoke-a" }).catch((e: unknown) => e);
    stoppedAfterRevoke(err, journal, a.descriptor.kid);
    expect((await s.keys.list(AGENT)).find((k) => k.kid === a.descriptor.kid)).toMatchObject({ status: "REVOKED" });
  });

  it("(а) ответ на отзыв потерян, повтор тем же ключом — 401 AGENT_KEY_REVOKED: отзыв состоялся, другого ключа нет — NO_ACTIVE_KEY с revokedKid, без чтения", async () => {
    const { s, a, dirA, core } = await setup();
    const calls: string[] = [];
    let lost = false;
    const lossy: typeof fetch = async (url, init) => {
      const route = `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`;
      calls.push(route);
      const res = await fetch(url, init);
      if (route.endsWith("/revoke") && !lost) {
        lost = true;
        throw new TypeError("fetch failed"); // запрос дошёл и исполнен, ответ потерян
      }
      return res;
    };
    const { c, journal } = core(dirA, lossy);
    await c.start();
    const from = calls.length;
    const err = await c.platform.revokeKey(a.descriptor.kid, { idempotencyKey: "idem-revoke-a" }).catch((e: unknown) => e);
    stoppedAfterRevoke(err, journal, a.descriptor.kid);
    const revoke = `POST /pao/v1/agent/keys/${a.descriptor.kid}/revoke`;
    expect(calls.slice(from)).toEqual([revoke, revoke]);
    expect(journal.entries.filter((e) => e.kind === "pao.call" && e.method === "POST /pao/v1/agent/keys/{kid}/revoke").map((e) => [e.result, e.reason])).toEqual([
      ["unknown", "NO_RESPONSE"],
      ["refused", "AGENT_KEY_REVOKED"],
    ]);
    expect((await s.keys.list(AGENT)).find((k) => k.kid === a.descriptor.kid)).toMatchObject({ status: "REVOKED" });
  });

  it("(б) неизвестный kid — 422 KEY_INVALID never, ключ не отмечен, ротация не задета, агент работает", async () => {
    const { dirA, core } = await setup();
    const { c, journal } = core(dirA);
    await c.start();
    const unknown = generateKey(tmp("revoke-keys-x-")).descriptor.kid; // по форме — kid, у агента такого нет
    await expect(c.platform.revokeKey(unknown, { idempotencyKey: "idem-revoke-x" })).rejects.toMatchObject({ name: "PlatformFailure", code: "KEY_INVALID", retry: "never", httpStatus: 422 });
    expect(journal.entries.filter((e) => e.kind === "key.revoked" || e.kind === "key.rotation_stopped")).toEqual([]);
    await expect(c.platform.agentSelf()).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("отзыв не состоялся: ключ подписи A отозван оператором — 401, связка NO_ACTIVE_KEY с revokedKid = A, а не запрошенный ключ", async () => {
    const { s, a, dirA, core } = await setup();
    const { c, journal } = core(dirA);
    await c.start();
    await s.keys.revoke(AGENT, a.descriptor.kid);
    const other = generateKey(tmp("revoke-keys-y-")).descriptor.kid;
    const err = await c.platform.revokeKey(other, { idempotencyKey: "idem-revoke-y" }).catch((e: unknown) => e);
    stoppedAfterRevoke(err, journal, a.descriptor.kid);
    expect((err as SignerStopped).revokedKid).not.toBe(other);
  });

  /** Брошенный временный ключ B прошлого запуска в хранилище A: регистрация по ПАО прошла (ключом A), ответ «потерян» —
   *  файл остался временным. Ядро на каталоге A с журналом обращений (маршрут, Idempotency-Key). */
  async function abandonedOnStand() {
    const env = await setup();
    const b = generateKey(env.dirA, "pending").descriptor;
    const fixedA = { current: () => env.a.signer, protective: () => env.a.signer, keyRevoked: () => env.a.signer, stop: () => {}, suspend: () => {} };
    const platform = new PaoPlatform({ baseUrl: env.baseUrl, agentCode: AGENT, signing: fixedA, params: loadParams(), journal: new MemoryJournal() });
    await platform.registerKey({ alg: "ed25519", publicKey: b.public_key }, { idempotencyKey: "idem-key-b-abandoned" });
    const calls: { route: string; idem: string | null }[] = [];
    const log: typeof fetch = async (url, init) => {
      calls.push({ route: `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`, idem: new Headers(init?.headers).get("idempotency-key") });
      return fetch(url, init);
    };
    const { c, journal } = env.core(env.dirA, log);
    await c.start();
    expect(journal.entries).toContainEqual(expect.objectContaining({ kind: "key.abandoned_registered", kid: b.kid }));
    const revoke = `POST /pao/v1/agent/keys/${b.kid}/revoke`;
    return { ...env, b, c, journal, calls, revokes: () => calls.filter((x) => x.route === revoke), revoke };
  }

  it("Р63 п. 6: брошенный ключ, зарегистрированный у Платформы, — maintainKeys отзывает его (ключ идемпотентности от kid, key.revoked ABANDONED); повторно не отзывает", async () => {
    const r = await abandonedOnStand();
    await r.c.maintainKeys();
    expect(r.revokes()).toEqual([{ route: r.revoke, idem: `agent-key-revoke-${r.b.kid}` }]);
    expect(r.journal.entries).toContainEqual(expect.objectContaining({ kind: "key.revoked", kid: r.b.kid, reason: "ABANDONED" }));
    expect((await r.s.keys.list(AGENT)).find((k) => k.kid === r.b.kid)).toMatchObject({ status: "REVOKED" });
    await r.c.maintainKeys();
    expect(r.revokes()).toHaveLength(1);
    await expect(r.c.platform.agentSelf()).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("Р63 п. 6: при приостановке у стенда maintainKeys отзывает брошенный ключ защитным входом, ротации нет — SignerSuspended", async () => {
    const r = await abandonedOnStand();
    await r.s.suspendAgent(AGENT, "KEY_COMPROMISE");
    await expect(r.c.platform.requestMandate(INTENT, { idempotencyKey: "idem-rev-susp-m" })).rejects.toMatchObject({ code: "AGENT_SUSPENDED", httpStatus: 403 });
    await expect(r.c.maintainKeys()).rejects.toBeInstanceOf(SignerSuspended);
    expect(r.revokes()).toEqual([{ route: r.revoke, idem: `agent-key-revoke-${r.b.kid}` }]);
    expect((await r.s.keys.list(AGENT)).find((k) => k.kid === r.b.kid)).toMatchObject({ status: "REVOKED" });
    expect(r.calls.filter((x) => x.route === "POST /pao/v1/agent/keys")).toEqual([]);
  });

  it("GET /pao/v1/agent отдаёт rate_limit_per_min — предел второго слоя уровня 1 из параметров стенда (РП63 п. 1; AG-08)", async () => {
    const { s, a, raw } = await setup();
    const self = await raw(a.signer, "GET", "/pao/v1/agent");
    expect(self.status).toBe(200);
    expect(self.body).toMatchObject({ level: 1, rate_limit_per_min: s.params.pao_agent_rate_limit_per_min_l1 });
    expect(s.params.pao_agent_rate_limit_per_min_l1).toBe(3000); // стендовое значение L1 (РП63, CHANGELOG v0.28.0)
  });
});
