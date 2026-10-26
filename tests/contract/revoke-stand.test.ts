// Отзыв своего ключа по ПАО на стенде v0.28.0 (Р57 п. 4; передача #74 — PS-05б ч. 1, РП60; копия ПАО 1.4.0, §3) и
// предел частоты в GET /pao/v1/agent (Р57 п. 5; передача #78 — PS-05б ч. 4, РП63; §2). A2 п. 5.4, SPEC §7а
// (AGENT_KEY_REVOKED), П02 на стенде. Метода отзыва своего ключа у ядра нет (Р57 п. 4): отзыв шлёт тестовая
// поддержка, подписью ключа агента (как tests/support/pao-unkeyed.ts). Отзывается отдельный временный ключ B,
// зарегистрированный по ПАО ключом допуска A; ключ A и другие тесты стенда не задеты (стенд — свой у каждого теста).
// rate_limit_per_min ядро не читает (`AgentSelf` без поля) — сверка ответом стенда; чтение и ровная частота — AG-08.
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
import { SignerStopped, generateKey } from "../../src/agent/signer/index.js";
import { loadParams } from "../../src/shared/config.js";
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
  const decision = s.admit(
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

  /** Ядро агента с хранилищем ключей `dir` — допуск по стадии 0, как у места сборки. */
  function core(dir: string) {
    const journal = new MemoryJournal();
    const c = createAgentCore({ keysDir: dir, stateDir: `${dir}-state`, journal, now: () => new Date(), pao: { baseUrl, agentCode: AGENT, sleep: async () => {} } });
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
    const fixedA = { current: () => a.signer, keyRevoked: () => a.signer, stop: () => {}, suspend: () => {} };
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

  it("GET /pao/v1/agent отдаёт rate_limit_per_min — предел второго слоя уровня 1 из параметров стенда (РП63 п. 1; AG-08)", async () => {
    const { s, a, raw } = await setup();
    const self = await raw(a.signer, "GET", "/pao/v1/agent");
    expect(self.status).toBe(200);
    expect(self.body).toMatchObject({ level: 1, rate_limit_per_min: s.params.pao_agent_rate_limit_per_min_l1 });
    expect(s.params.pao_agent_rate_limit_per_min_l1).toBe(3000); // стендовое значение L1 (РП63, CHANGELOG v0.28.0)
  });
});
