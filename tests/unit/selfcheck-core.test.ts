// Р36 п. 6, дополнение 2 п. 1: версия ПАО ядра ≠ копии — сборка отклоняется AgentNotReady (core.pao: CORE_PAO_MISMATCH),
// сеть не трогается. Расхождение версий подставляется подменой проверки адаптера: настоящее ядро совпадает с копией.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/agent/adapters/pao/index.js", async (orig) => ({
  ...(await orig<typeof import("../../src/agent/adapters/pao/index.js")>()),
  assertPaoVersion: () => {
    throw new Error("ПАО в agentic-core 9.9.9, копия у агента 1.4.0");
  },
}));

const { createAgentCore } = await import("../../src/agent/compose.js");
const { AgentNotReady } = await import("../../src/agent/declines/index.js");
const { MemoryJournal } = await import("../../src/agent/journal/index.js");

describe("самопроверка при сборке — ПАО ядра", () => {
  it("версия ПАО ядра не совпадает с копией — AgentNotReady, config.params ok, core.pao fail, запись в журнал", () => {
    const journal = new MemoryJournal();
    let err: unknown;
    try {
      createAgentCore({ keysDir: "/nonexistent-keys", stateDir: "/nonexistent-state", journal, pao: { baseUrl: "http://127.0.0.1:9", agentCode: "nspk:agent:x:v1" } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgentNotReady);
    expect((err as InstanceType<typeof AgentNotReady>).report).toMatchObject({
      ready: false,
      checks: [
        { check: "config.params", status: "ok" },
        { check: "core.pao", status: "fail", code: "CORE_PAO_MISMATCH" },
      ],
    });
    expect(journal.entries.map((e) => [e.kind, e.check, e.status])).toEqual([
      ["agent.selfcheck", "config.params", "ok"],
      ["agent.selfcheck", "core.pao", "fail"],
    ]);
  });
});
