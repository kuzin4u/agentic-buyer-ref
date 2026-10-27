// П03 (профиль contour, Р23): агент исключён из реестра или в нём отсутствует. Т1, A2 п. 7, SPEC §7а.
// EXCLUDED эмулирует обёртка стенда (шапка pao-stand.ts): в PaoStub ядра статус есть с v0.5.0, но обработчик обёртки главнее;
// упрощение обёртки — STATUS «Открыто», Р31.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignerStopped, SignerSuspended } from "../../src/agent/signer/index.js";
import { loadParams } from "../../src/shared/config.js";
import { PlatformFailure } from "../../src/shared/domain.js";
import { CREDENTIALS, DRAFT, coreOn, startCause, lastEntry } from "../support/core.js";
import { PaoStand, CONFIGURATION } from "../support/pao-stand.js";

let stand: PaoStand;
afterEach(() => {
  vi.useRealTimers();
  return stand?.close();
});

const { agent_recheck_interval_sec: INTERVAL_SEC } = loadParams();

const OP = "POST /pao/v1/credentials" as const;

describe("П03 — исключённый или отсутствующий в реестре агент", () => {
  it("исключён до допуска: GET /pao/v1/agent — 200, status EXCLUDED; агент останавливается, запись в журнале", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    stand.exclude([OP]);
    const { core, journal } = await coreOn(stand);

    await expect(startCause(core.start())).rejects.toThrow(SignerStopped);
    expect(stand.calls("GET /pao/v1/agent")).toMatchObject([{ status: 200 }]);
    expect(lastEntry(journal)).toMatchObject({ kind: "agent.stopped", reason: "AGENT_EXCLUDED" });
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "idem-p03" })).rejects.toThrow(SignerStopped);
    expect(stand.log()).toEqual([CONFIGURATION, { op: "GET /pao/v1/agent", status: 200 }]);
    expect(stand.stub.violations).toEqual([]);
  });

  // Р60 п. 1: 403 AGENT_SUSPENDED не отличает приостановленного от исключённого (оба получают его на прочих методах) —
  // сначала приостановка подписи (агент не действует, не повторяет), остановка — по сверке: GET /pao/v1/agent — EXCLUDED.
  // Сверку запускает расписание ядра (Р60 п. 4), тест её не вызывает: поддельный setInterval, сеть настоящая.
  it("исключён после допуска: прочий метод — 403 AGENT_SUSPENDED, retry never; без повтора; приостановка, по сверке по расписанию EXCLUDED — остановка", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
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
    expect(lastEntry(journal)).toMatchObject({ kind: "signing.suspended", reason: "AGENT_SUSPENDED" });
    // не повторяет: рабочая подпись приостановлена, обращения нет
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "idem-p03" })).rejects.toThrow(SignerSuspended);
    // до срока расписания — сверки нет; через agent_recheck_interval_sec — GET /pao/v1/agent, EXCLUDED — остановка
    await vi.advanceTimersByTimeAsync(INTERVAL_SEC * 1000 - 1);
    expect(stand.calls("GET /pao/v1/agent")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(lastEntry(journal)).toMatchObject({ kind: "agent.stopped", reason: "AGENT_EXCLUDED" }));
    expect(vi.getTimerCount()).toBe(0);
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "idem-p03" })).rejects.toThrow(SignerStopped);
    await expect(core.platform.agentSelf()).rejects.toThrow(SignerStopped);
    expect(stand.log()).toEqual([
      CONFIGURATION,
      { op: "GET /pao/v1/agent", status: 200 },
      { op: OP, status: 403 },
      { op: "GET /pao/v1/agent", status: 200 },
    ]);
    expect(stand.stub.violations).toEqual([]);
  });

  it("агента нет в реестре: 401 AGENT_UNKNOWN; без повтора, остановка, запись в журнале", async () => {
    stand = new PaoStand({ unregistered: true });
    const { core, journal } = await coreOn(stand);

    const err = await startCause(core.start()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformFailure);
    expect(err).toMatchObject({ code: "AGENT_UNKNOWN", retry: "never", httpStatus: 401 });
    expect(stand.calls("GET /pao/v1/agent")).toHaveLength(1);
    expect(lastEntry(journal)).toMatchObject({ kind: "agent.stopped", reason: "AGENT_UNKNOWN" });
    await expect(core.platform.agentSelf()).rejects.toThrow(SignerStopped);
    expect(stand.log()).toEqual([CONFIGURATION, { op: "GET /pao/v1/agent", status: 401 }]);
    expect(stand.stub.violations).toEqual([]);
  });
});
