import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { createAgentCore } from "../../src/agent/compose.js";
import { ConfigError } from "../../src/shared/config.js";
import { SignerStopped } from "../../src/agent/signer/index.js";

const pao = { baseUrl: "http://127.0.0.1:1", agentCode: "nspk:agent:buyref-01:v1" };
let keysDir: string;
beforeEach(() => {
  keysDir = mkdtempSync(join(tmpdir(), "buyref-keys-"));
});
afterEach(() => rmSync(keysDir, { recursive: true, force: true }));

describe("место сборки ядра", () => {
  it("собирает ядро с адаптером pao, связкой ключей и стендовыми параметрами", () => {
    const core = createAgentCore({ pao, keysDir });
    expect(core.capabilities.platform).toBe("pao");
    expect(core.params.registry_cache_ttl_sec).toBeGreaterThan(0);
  });

  it("без параметров не запускается (fail-closed)", () => {
    expect(() => createAgentCore({ pao, keysDir, paramsPath: "config/missing.json" })).toThrow(ConfigError);
  });

  it("без ключей в хранилище допуск не начинается: остановка до обращения к платформе", async () => {
    const core = createAgentCore({ pao, keysDir });
    await expect(core.start()).rejects.toThrow(SignerStopped);
    expect(core.journal).toMatchObject({ entries: [expect.objectContaining({ kind: "agent.stopped", reason: "NO_KEY" })] });
  });
});
