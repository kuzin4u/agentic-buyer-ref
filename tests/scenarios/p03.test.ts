// П03 (профиль contour, Р23): агент исключён из реестра или в нём отсутствует. Т1, A2 п. 7, SPEC §7а.
// EXCLUDED эмулирует обёртка стенда (шапка pao-stand.ts): в PaoStub ядра статус есть с v0.5.0, но обработчик обёртки главнее;
// упрощение обёртки — STATUS «Открыто», Р31.
import { afterEach, describe, expect, it } from "vitest";
import { SignerStopped } from "../../src/agent/signer/index.js";
import { PlatformFailure } from "../../src/shared/domain.js";
import { CREDENTIALS, DRAFT, coreOn } from "../support/core.js";
import { PaoStand } from "../support/pao-stand.js";

let stand: PaoStand;
afterEach(() => stand?.close());

const OP = "POST /pao/v1/credentials" as const;

describe("П03 — исключённый или отсутствующий в реестре агент", () => {
  it("исключён до допуска: GET /pao/v1/agent — 200, status EXCLUDED; агент останавливается, запись в журнале", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    stand.exclude([OP]);
    const { core, journal } = await coreOn(stand);

    await expect(core.start()).rejects.toThrow(SignerStopped);
    expect(stand.calls("GET /pao/v1/agent")).toMatchObject([{ status: 200 }]);
    expect(journal.entries.at(-1)).toMatchObject({ kind: "agent.stopped", reason: "AGENT_EXCLUDED" });
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "idem-p03" })).rejects.toThrow(SignerStopped);
    expect(stand.log()).toEqual([{ op: "GET /pao/v1/agent", status: 200 }]);
    expect(stand.stub.violations).toEqual([]);
  });

  it("исключён после допуска: прочий метод — 403 AGENT_SUSPENDED, retry never; без повтора, остановка", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    const { core, journal } = await coreOn(stand);
    await core.start();
    stand.exclude([OP]);

    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "idem-p03" })).rejects.toMatchObject({
      code: "AGENT_SUSPENDED",
      retry: "never",
      httpStatus: 403,
    });
    expect(stand.calls(OP)).toHaveLength(1);
    expect(journal.entries.at(-1)).toMatchObject({ kind: "agent.stopped", reason: "AGENT_SUSPENDED" });
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "idem-p03" })).rejects.toThrow(SignerStopped);
    await expect(core.platform.agentSelf()).rejects.toThrow(SignerStopped);
    expect(stand.log()).toEqual([{ op: "GET /pao/v1/agent", status: 200 }, { op: OP, status: 403 }]);
    expect(stand.stub.violations).toEqual([]);
  });

  it("агента нет в реестре: 401 AGENT_UNKNOWN; без повтора, остановка, запись в журнале", async () => {
    stand = new PaoStand({ unregistered: true });
    const { core, journal } = await coreOn(stand);

    const err = await core.start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformFailure);
    expect(err).toMatchObject({ code: "AGENT_UNKNOWN", retry: "never", httpStatus: 401 });
    expect(stand.calls("GET /pao/v1/agent")).toHaveLength(1);
    expect(journal.entries.at(-1)).toMatchObject({ kind: "agent.stopped", reason: "AGENT_UNKNOWN" });
    await expect(core.platform.agentSelf()).rejects.toThrow(SignerStopped);
    expect(stand.log()).toEqual([{ op: "GET /pao/v1/agent", status: 401 }]);
    expect(stand.stub.violations).toEqual([]);
  });
});
