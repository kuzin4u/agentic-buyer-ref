// Р36 п. 6, дополнение 2: отчёт самопроверки при старте — проверки в порядке старта, ready: false — агент не стартует
// (AgentNotReady, исходная ошибка в cause); stop по реестру — подписант остановлен, иначе start() можно повторить.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkSelfCheckReport } from "@kuzin4u/agentic-core/diag";
import { DIAG } from "../../src/agent/compose.js";
import { AGENT_VERSION, AgentNotReady, type SelfCheckReport } from "../../src/agent/declines/index.js";
import { CURSOR_FILE } from "../../src/agent/events/cursor.js";
import { SignerStopped } from "../../src/agent/signer/index.js";
import { PlatformFailure } from "../../src/shared/domain.js";
import { CREDENTIALS, DRAFT, coreOn } from "../support/core.js";
import { PaoStand } from "../support/pao-stand.js";

const ADMISSION = "GET /pao/v1/agent";
const ALL = ["config.params", "core.pao", "keys.store", "keys.active", "events.cursor", "platform.protocol", "platform.admission"];

let stand: PaoStand | undefined;
afterEach(async () => {
  if (stand) rmSync(`${stand.dir}-state`, { recursive: true, force: true });
  await stand?.close();
  stand = undefined;
});

/** Отказ старта: AgentNotReady с отчётом, проверенным форматом ядра по полному реестру. */
async function notReady(p: Promise<unknown>): Promise<AgentNotReady> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(AgentNotReady);
  const err = e as AgentNotReady;
  expect(checkSelfCheckReport(err.report, DIAG)).toEqual([]);
  expect(err.report.ready).toBe(false);
  return err;
}

const items = (r: SelfCheckReport | null) => r?.checks.map((c) => [c.check, c.status, c.code ?? null]);

describe("самопроверка при старте (Р36 п. 6)", () => {
  it("всё в порядке — ready: true, семь проверок в порядке старта, отчёт по формату К17; версия не определена — warn", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    const { core, journal } = await coreOn(stand);
    await core.start();
    const r = core.selfCheck()!;
    expect(checkSelfCheckReport(r, DIAG)).toEqual([]);
    expect(r).toMatchObject({ component: "agent", version: AGENT_VERSION, ready: true, checked_at: stand.clock.toISOString() });
    expect(r.checks.map((c) => c.check)).toEqual(ALL);
    // PaoStub по умолчанию отдаёт versions ["v1"] — версия ПАО не определена: предупреждение, готовность не снята
    expect(r.checks.find((c) => c.check === "platform.protocol")).toEqual({ check: "platform.protocol", status: "warn", code: "PLATFORM_VERSION_UNKNOWN" });
    expect(journal.entries.filter((e) => e.kind === "agent.selfcheck").map((e) => [e.check, e.status, e.reason ?? null])).toEqual(items(r));
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "i1" })).resolves.toBeDefined();
  });

  it("версия ПАО 1.4.0 подтверждена — все проверки ok", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS, configuration: { versions: ["1.4.0"] } });
    const { core } = await coreOn(stand);
    await core.start();
    expect(core.selfCheck()!.checks.every((c) => c.status === "ok")).toBe(true);
  });

  it("курсор ленты не читается — events.cursor: fail, ни одного обращения к Платформе, агент остановлен", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    mkdirSync(`${stand.dir}-state`, { recursive: true });
    writeFileSync(join(`${stand.dir}-state`, CURSOR_FILE), "не JSON");
    const { core, journal } = await coreOn(stand);
    const err = await notReady(core.start());
    expect(items(err.report)).toEqual([
      ["config.params", "ok", null],
      ["core.pao", "ok", null],
      ["keys.store", "ok", null],
      ["keys.active", "ok", null],
      ["events.cursor", "fail", "EVENTS_CURSOR_INVALID"],
    ]);
    expect(stand.stub.calls).toHaveLength(0);
    expect(journal.entries).toContainEqual(expect.objectContaining({ kind: "agent.stopped", reason: "EVENTS_CURSOR_INVALID", detail: "UNREADABLE" }));
    await expect(core.platform.agentSelf()).rejects.toThrow(SignerStopped);
  });

  it("Платформа ниже ПАО 1.4.0 — platform.protocol: fail, допуска нет", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS, configuration: { versions: ["1.3.0"] } });
    const { core } = await coreOn(stand);
    const err = await notReady(core.start());
    expect(err.report.checks.at(-1)).toEqual({ check: "platform.protocol", status: "fail", code: "PLATFORM_PROTOCOL_UNSUPPORTED" });
    expect(err.cause).toMatchObject({ code: "PLATFORM_PROTOCOL_UNSUPPORTED" });
    expect(stand.calls(ADMISSION)).toHaveLength(0);
  });

  it("503 на допуске (retry_same_key) — агент не допущен, подписант не остановлен: повторный start проходит", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    const { core } = await coreOn(stand);
    stand.stub.fail(ADMISSION, { code: "UPSTREAM_UNAVAILABLE" }, core.params.pao_max_attempts);
    const err = await notReady(core.start());
    expect(err.report.checks.at(-1)).toEqual({ check: "platform.admission", status: "fail", code: "UPSTREAM_UNAVAILABLE" });
    expect(err.cause).toBeInstanceOf(PlatformFailure);
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "i1" })).rejects.toThrow(SignerStopped);
    await core.start();
    expect(core.selfCheck()!.ready).toBe(true);
  });

  it("AGENT_UNKNOWN (stop по реестру) — platform.admission: fail, подписант остановлен, повтор не обращается к Платформе", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    const { core } = await coreOn(stand);
    stand.stub.fail(ADMISSION, { code: "AGENT_UNKNOWN" });
    const err = await notReady(core.start());
    expect(err.report.checks.at(-1)).toEqual({ check: "platform.admission", status: "fail", code: "AGENT_UNKNOWN" });
    const calls = stand.stub.calls.length;
    await notReady(core.start());
    expect(stand.stub.calls).toHaveLength(calls);
  });

  it("класс не BUYER — platform.admission: fail AGENT_CLASS_MISMATCH", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    stand.agentClass = "SELLER";
    const { core } = await coreOn(stand);
    const err = await notReady(core.start());
    expect(err.report.checks.at(-1)).toEqual({ check: "platform.admission", status: "fail", code: "AGENT_CLASS_MISMATCH" });
  });

  it("несколько ключей без метаданных — keys.active: fail KEY_AMBIGUOUS, keys.store: ok, без сети (ревью К2.2 № 1)", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS, keys: 2 });
    rmSync(join(stand.dir, "keys.meta.json"));
    const { core } = await coreOn(stand);
    const err = await notReady(core.start());
    expect(items(err.report)).toEqual([
      ["config.params", "ok", null],
      ["core.pao", "ok", null],
      ["keys.store", "ok", null],
      ["keys.active", "fail", "KEY_AMBIGUOUS"],
    ]);
    expect(stand.stub.calls).toHaveLength(0);
  });

  it("второе ядро на том же каталоге ключей — keys.store: fail KEYSTORE_LOCKED, без сети", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    const first = await coreOn(stand);
    await first.core.start();
    const before = stand.stub.calls.length;
    const second = await coreOn(stand);
    const err = await notReady(second.core.start());
    expect(items(err.report)).toEqual([
      ["config.params", "ok", null],
      ["core.pao", "ok", null],
      ["keys.store", "fail", "KEYSTORE_LOCKED"],
    ]);
    expect(stand.stub.calls).toHaveLength(before);
    first.core.close();
  });
});
