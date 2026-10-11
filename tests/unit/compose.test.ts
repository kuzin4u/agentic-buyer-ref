import { describe, it, expect } from "vitest";
import { newEd25519Signer } from "@kuzin4u/agentic-core";
import { createAgentCore } from "../../src/agent/compose.js";
import { ConfigError } from "../../src/shared/config.js";

const { signer } = newEd25519Signer("kid_test");
const pao = { baseUrl: "http://127.0.0.1:1", agentCode: "nspk:agent:buyref-01:v1", signer };

describe("место сборки ядра", () => {
  it("собирает ядро с адаптером pao и стендовыми параметрами", () => {
    const core = createAgentCore({ pao });
    expect(core.capabilities.platform).toBe("pao");
    expect(core.params.registry_cache_ttl_sec).toBeGreaterThan(0);
  });

  it("без параметров не запускается (fail-closed)", () => {
    expect(() => createAgentCore({ pao, paramsPath: "config/missing.json" })).toThrow(ConfigError);
  });
});
