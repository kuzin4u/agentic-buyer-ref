import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PAO_SPEC_SHA256, PAO_VERSION } from "@kuzin4u/agentic-core/pao";

// Р20: копия ПАО у агента совпадает с той, из которой собран подключённый agentic-core.
const COPY = `docs/core/protocol/agent-protocol.v${PAO_VERSION}.yaml`;

describe("копия ПАО", () => {
  it("есть для версии agentic-core", () => {
    expect(PAO_VERSION).toBe("1.2.0");
    expect(() => readFileSync(COPY)).not.toThrow();
  });

  it("совпадает по sha-256 с PAO_SPEC_SHA256", () => {
    const sha = createHash("sha256").update(readFileSync(COPY)).digest("hex");
    expect(sha).toBe(PAO_SPEC_SHA256);
  });

  it("записана в SOURCE.md с тем же хэшем", () => {
    const source = readFileSync("docs/core/protocol/SOURCE.md", "utf8");
    expect(source).toContain(`agent-protocol.v${PAO_VERSION}.yaml`);
    expect(source).toContain(PAO_SPEC_SHA256);
  });
});
