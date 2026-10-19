// Журнал решений агента (Р37 п. 3, SPEC §4, Т15): код реестра в reason, закрытый набор полей, код агента и время ставит
// место сборки, штатное закрытие — не код реестра.
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { CATALOG_DIAG_CODES, type CatalogDiagCode } from "@kuzin4u/agentic-core/catalog";
import { DIAG } from "../../src/agent/compose.js";
import { FAILURE_RULES } from "../../src/agent/declines/index.js";
import { JOURNAL_FIELDS, MemoryJournal, type JournalCode, type JournalEntry } from "../../src/agent/journal/index.js";
import { AGENT_DIAG_CODES, type AgentDiagCode } from "../../src/shared/diag-codes.js";
import type { FailureCode } from "../../src/shared/domain.js";
import { Consents, INTENT, feed } from "../support/consents.js";
import { coreOn, startCause } from "../support/core.js";
import { expectJournalClean } from "../support/journal.js";
import { AGENT, PaoStand, type StandOptions } from "../support/pao-stand.js";

let stand: PaoStand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

async function setup(o: Pick<StandOptions, "configuration" | "handlers"> = {}) {
  const consents: Consents = new Consents(() => s.clock);
  const s = new PaoStand({ ...o, handlers: { ...consents.handlers(), ...o.handlers } });
  stand = s;
  const { core, journal } = await coreOn(s);
  return { core, journal, consents, stand: s };
}

describe("код причины — код реестра (Р37 п. 3)", () => {
  it("JournalCode = FailureCode ∪ коды агента ∪ коды каталога ядра; каждый — в полном реестре DIAG", () => {
    expectTypeOf<JournalCode>().toEqualTypeOf<FailureCode | AgentDiagCode | CatalogDiagCode>();
    const codes = [...(Object.keys(FAILURE_RULES) as FailureCode[]), ...AGENT_DIAG_CODES, ...CATALOG_DIAG_CODES];
    expect(codes.filter((c) => !Object.hasOwn(DIAG, c))).toEqual([]);
  });

  it("строка вне реестра в reason не компилируется", () => {
    const j = new MemoryJournal();
    // @ts-expect-error — reason только код реестра (ревью К2.1 № 14)
    j.record({ at: "2026-10-19T00:00:00Z", kind: "agent.stopped", reason: "SOMETHING_ELSE" });
    j.record({ at: "2026-10-19T00:00:00Z", kind: "agent.stopped", reason: "NO_KEY" });
    expect(j.entries).toHaveLength(2);
  });
});

describe("закрытый набор полей (Р37 п. 3, SPEC §4)", () => {
  it("JOURNAL_FIELDS = ключи JournalEntry = перечень SPEC §4; новое поле — через /decision", () => {
    expectTypeOf<(typeof JOURNAL_FIELDS)[number]>().toEqualTypeOf<keyof JournalEntry>();
    expect([...JOURNAL_FIELDS].sort()).toEqual(
      ["at", "agent", "kind", "mandate", "method", "result", "attempt", "reason", "detail", "ref", "kid", "check", "status"].sort(),
    );
  });
});

describe("записи ядра (Р37 п. 3)", () => {
  it("успешный путь: виды записей, код агента и время ядра в каждой, без x-nonce и Idempotency-Key обращений", async () => {
    const { core, journal, consents, stand: s } = await setup({ configuration: { versions: ["1.4.0"] } });
    await core.start();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_journal_1" });
    const active = await core.mandates.awaitSigned(m, feed(consents.sign(m.id)));
    expect(active.status).toBe("ACTIVE");
    await expect(core.mandates.check(active)).resolves.toBeDefined();
    core.close();
    expect(new Set(journal.entries.map((e) => e.kind))).toEqual(
      new Set(["key.loaded", "events.cursor_initial", "request.signed", "agent.selfcheck", "agent.closed"]),
    );
    expectJournalClean(journal.entries, AGENT, s.stub.calls, ["idem_journal_1"]);
    // время — часы ядра, а не писателя (обёртка места сборки, ревью К2.1 № 8)
    for (const e of journal.entries) expect(e.at).toBe(s.clock.toISOString());
  });

  it("отказы: reason и detail — коды реестра и перечни; без значений обращений", async () => {
    // версия не определена (404 конфигурации) — предупреждение; затем допуск: AGENT_SUSPENDED — остановка
    const { core, journal, stand: s } = await setup({ handlers: { "GET /.well-known/pao-configuration": () => ({ status: 404, body: {} }) } });
    s.stub.fail("GET /pao/v1/agent", { code: "AGENT_SUSPENDED" });
    await expect(startCause(core.start())).rejects.toMatchObject({ code: "AGENT_SUSPENDED" });
    const withReason = journal.entries.filter((e) => e.reason !== undefined).map((e) => [e.kind, e.reason, e.detail]);
    expect(withReason).toEqual(
      expect.arrayContaining([
        ["platform.version_unknown", "PLATFORM_VERSION_UNKNOWN", "NO_RESPONSE"],
        ["agent.stopped", "AGENT_SUSPENDED", undefined],
        ["agent.selfcheck", "PLATFORM_VERSION_UNKNOWN", undefined],
        ["agent.selfcheck", "AGENT_SUSPENDED", undefined],
      ]),
    );
    expectJournalClean(journal.entries, AGENT, s.stub.calls);
  });

  it("мандат без порядка отзыва — mandate.revocation_order_missing с кодом реестра", async () => {
    const { core, journal, consents, stand: s } = await setup({ configuration: { versions: ["1.4.0"] } });
    await core.start();
    consents.tamper = (m) => {
      const r = { ...m };
      delete r.revocation_order;
      return r;
    };
    await expect(core.mandates.request(INTENT, { idempotencyKey: "idem_journal_ro" })).rejects.toMatchObject({ reason: "MANDATE_REVOCATION_ORDER_MISSING" });
    expect(journal.entries.filter((e) => e.kind === "mandate.revocation_order_missing").map((e) => e.reason)).toEqual(["MANDATE_REVOCATION_ORDER_MISSING"]);
    expectJournalClean(journal.entries, AGENT, s.stub.calls, ["idem_journal_ro"]);
  });

  it("close — agent.closed без причины, а не agent.stopped с CLOSED (Р36 (в))", async () => {
    const { core, journal } = await setup();
    await core.start();
    core.close();
    expect(journal.entries.filter((e) => e.kind === "agent.closed")).toEqual([{ at: expect.any(String), agent: AGENT, kind: "agent.closed" }]);
    expect(journal.entries.filter((e) => e.kind === "agent.stopped")).toEqual([]);
  });

  it("close после остановки по коду — новой записи нет: агент уже остановлен (нюанс Р37, ревью К2.1 № 9)", async () => {
    const { core, journal, stand: s } = await setup();
    s.stub.fail("GET /pao/v1/agent", { code: "AGENT_UNKNOWN" });
    await expect(startCause(core.start())).rejects.toMatchObject({ code: "AGENT_UNKNOWN" });
    core.close();
    expect(journal.entries.filter((e) => e.kind === "agent.stopped" || e.kind === "agent.closed").map((e) => [e.kind, e.reason])).toEqual([
      ["agent.stopped", "AGENT_UNKNOWN"],
    ]);
  });
});
