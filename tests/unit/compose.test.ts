import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { createAgentCore } from "../../src/agent/compose.js";
import { ConfigError } from "../../src/shared/config.js";
import { SignerStopped } from "../../src/agent/signer/index.js";
import { AgentNotReady } from "../../src/agent/declines/index.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { startCause } from "../support/core.js";

const pao = { baseUrl: "http://127.0.0.1:1", agentCode: "nspk:agent:buyref-01:v1" };
/** каталог состояния создаётся только при первой записи курсора — здесь не создаётся */
const stateDir = join(tmpdir(), "buyref-state-compose-unused");
let keysDir: string;
beforeEach(() => {
  keysDir = mkdtempSync(join(tmpdir(), "buyref-keys-"));
});
afterEach(() => rmSync(keysDir, { recursive: true, force: true }));

describe("место сборки ядра", () => {
  it("собирает ядро с адаптером pao, связкой ключей и стендовыми параметрами", () => {
    const core = createAgentCore({ pao, keysDir, stateDir });
    expect(core.capabilities.platform).toBe("pao");
    expect(core.params.registry_cache_ttl_sec).toBeGreaterThan(0);
  });

  it("без параметров не собирается (fail-closed): AgentNotReady, config.params — PARAMS_INVALID, исходная ошибка в cause (Р36 п. 6)", () => {
    const journal = new MemoryJournal();
    let err: unknown;
    try {
      createAgentCore({ pao, keysDir, stateDir, journal, paramsPath: "config/missing.json" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgentNotReady);
    expect((err as AgentNotReady).cause).toBeInstanceOf(ConfigError);
    expect((err as AgentNotReady).report).toMatchObject({ ready: false, checks: [{ check: "config.params", status: "fail", code: "PARAMS_INVALID" }] });
    expect(journal.entries).toEqual([expect.objectContaining({ kind: "agent.selfcheck", check: "config.params", status: "fail", reason: "PARAMS_INVALID" })]);
  });

  it("без ключей в хранилище допуск не начинается: остановка до обращения к платформе", async () => {
    const journal = new MemoryJournal();
    const core = createAgentCore({ pao, keysDir, stateDir, journal });
    await expect(startCause(core.start())).rejects.toThrow(SignerStopped);
    expect(journal).toMatchObject({
      entries: [
        expect.objectContaining({ kind: "agent.stopped", reason: "NO_KEY" }),
        expect.objectContaining({ kind: "agent.selfcheck", check: "config.params", status: "ok" }),
        expect.objectContaining({ kind: "agent.selfcheck", check: "core.pao", status: "ok" }),
        expect.objectContaining({ kind: "agent.selfcheck", check: "keys.store", status: "fail", reason: "NO_KEY" }),
      ],
    });
  });
});
