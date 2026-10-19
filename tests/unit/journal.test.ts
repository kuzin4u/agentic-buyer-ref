// Журнал решений агента (Р37 п. 3, SPEC §4, Т15): код реестра в reason, закрытый набор полей, код агента и время ставит
// место сборки, штатное закрытие — не код реестра.
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { PaoCallError, PaoClient } from "@kuzin4u/agentic-core/pao";
import { CATALOG_DIAG_CODES, type CatalogDiagCode } from "@kuzin4u/agentic-core/catalog";
import { DIAG } from "../../src/agent/compose.js";
import { FAILURE_RULES } from "../../src/agent/declines/index.js";
import { JOURNAL_FIELDS, MemoryJournal, type JournalCode, type JournalEntry } from "../../src/agent/journal/index.js";
import { AGENT_DIAG_CODES, type AgentDiagCode } from "../../src/shared/diag-codes.js";
import type { FailureCode } from "../../src/shared/domain.js";
import { Consents, INTENT, event, feed } from "../support/consents.js";
import { CREDENTIALS, DRAFT, coreOn, startCause } from "../support/core.js";
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
      new Set(["key.loaded", "events.cursor_initial", "pao.call", "request.signed", "agent.selfcheck", "agent.closed"]),
    );
    // журнал обращений (Р37 п. 3): попытка на обращение, ключ операции — шаблон, mandate — из ответа, пути или тела
    expect(journal.entries.filter((e) => e.kind === "pao.call").map((e) => [e.method, e.attempt, e.result, e.mandate, e.detail])).toEqual([
      ["GET /.well-known/pao-configuration", 1, "ok", undefined, "200"],
      ["GET /pao/v1/agent", 1, "ok", undefined, "200"],
      ["POST /pao/v1/mandates", 1, "ok", m.id, "201"],
      ["GET /pao/v1/mandates/{id}", 1, "ok", m.id, "200"],
      ["GET /pao/v1/mandates/{id}/verify", 1, "ok", m.id, "200"],
    ]);
    expect(s.stub.calls).toHaveLength(5);
    expectJournalClean(journal.entries, AGENT, s.stub.calls, ["idem_journal_1"]);
    // время — часы ядра, а не писателя (обёртка места сборки, ревью К2.1 № 8)
    for (const e of journal.entries) expect(e.at).toBe(s.clock.toISOString());
  });

  it("повтор тем же ключом (503) — две попытки: refused с кодом и статусом, затем ok (Т15 «попытка повтора»)", async () => {
    const { core, journal, stand: s } = await setup({ configuration: { versions: ["1.4.0"] } });
    s.stub.fail("GET /pao/v1/agent", { code: "STATE_UNAVAILABLE" }, 1);
    await core.start();
    expect(journal.entries.filter((e) => e.kind === "pao.call").map((e) => [e.method, e.attempt, e.result, e.reason, e.detail])).toEqual([
      ["GET /.well-known/pao-configuration", 1, "ok", undefined, "200"],
      ["GET /pao/v1/agent", 1, "refused", "STATE_UNAVAILABLE", "503"],
      ["GET /pao/v1/agent", 2, "ok", undefined, "200"],
    ]);
    expect(s.stub.calls).toHaveLength(3);
    expectJournalClean(journal.entries, AGENT, s.stub.calls);
  });

  it("нет ответа (тайм-аут транспорта) — result unknown, UNKNOWN, без HTTP-статуса", async () => {
    const consents: Consents = new Consents(() => s.clock);
    const s: PaoStand = (stand = new PaoStand({ handlers: consents.handlers(), configuration: { versions: ["1.4.0"] } }));
    let down = false;
    const fetchImpl: typeof fetch = (url, init) => (down ? Promise.reject(new TypeError("fetch failed")) : fetch(url, init));
    const { core, journal } = await coreOn(s, { fetch: fetchImpl });
    await core.start();
    down = true;
    await expect(core.mandates.request(INTENT, { idempotencyKey: "idem_journal_down" })).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(journal.entries.filter((e) => e.kind === "pao.call").at(-1)).toEqual({
      at: s.clock.toISOString(),
      agent: AGENT,
      kind: "pao.call",
      method: "POST /pao/v1/mandates",
      attempt: 1,
      result: "unknown",
      reason: "UNKNOWN",
    });
    expect(s.stub.calls).toHaveLength(2);
    expectJournalClean(journal.entries, AGENT, s.stub.calls, ["idem_journal_down"]);
  });

  it("mandate — из тела (mandate_id) и в ветке отказа; идентификатор вне маски — без поля mandate (ревью К2.2 № 8)", async () => {
    const { core, journal, stand: s } = await setup({ configuration: { versions: ["1.4.0"] }, handlers: CREDENTIALS });
    await core.start();
    await core.platform.issueCredential(DRAFT, { idempotencyKey: "idem_journal_cr1" });
    s.stub.fail("POST /pao/v1/credentials", { code: "MANDATE_SCOPE" });
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "idem_journal_cr2" })).rejects.toMatchObject({ code: "MANDATE_SCOPE" });
    await expect(core.platform.getMandate("m 1/../x")).rejects.toBeDefined();
    expect(journal.entries.filter((e) => e.kind === "pao.call").slice(2).map((e) => [e.method, e.result, e.mandate, e.reason])).toEqual([
      ["POST /pao/v1/credentials", "ok", DRAFT.mandate.id, undefined],
      ["POST /pao/v1/credentials", "refused", DRAFT.mandate.id, "MANDATE_SCOPE"],
      ["GET /pao/v1/mandates/{id}", "refused", undefined, expect.any(String)],
    ]);
    expectJournalClean(journal.entries, AGENT, s.stub.calls, ["idem_journal_cr1", "idem_journal_cr2"]);
  });

  it("конфигурация 404 — unknown с HTTP-статусом; PAO_CLIENT_SIGNER_MISSING — не попытка, pao.call нет (ревью К2.2 № 1, № 8)", async () => {
    const { core, journal } = await setup({ handlers: { "GET /.well-known/pao-configuration": () => ({ status: 404, body: {} }) } });
    await core.start();
    expect(journal.entries.find((e) => e.kind === "pao.call")).toMatchObject({ method: "GET /.well-known/pao-configuration", attempt: 1, result: "unknown", reason: "UNKNOWN", detail: "404" });
    const spy = vi.spyOn(PaoClient.prototype, "call").mockRejectedValueOnce(new PaoCallError(0, undefined, 0, undefined, { clientCode: "PAO_CLIENT_SIGNER_MISSING" }));
    try {
      const before = journal.entries.filter((e) => e.kind === "pao.call").length;
      await expect(core.platform.agentSelf()).rejects.toMatchObject({ code: "PAO_CLIENT_SIGNER_MISSING" });
      expect(journal.entries.filter((e) => e.kind === "pao.call")).toHaveLength(before);
    } finally {
      spy.mockRestore();
    }
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

  it("отказ агента действовать (Т15, Р37 п. 5): каждый путь — ровно одна agent.refused с кодом и mandate; текст — не в журнале", async () => {
    const { core, journal, consents, stand: s } = await setup({ configuration: { versions: ["1.4.0"] } });
    await core.start();
    const refused = () => journal.entries.filter((e) => e.kind === "agent.refused").map((e) => [e.reason, e.mandate]);
    const messages: string[] = [];
    const fail = async (p: Promise<unknown>, reason: string) => {
      const e = (await p.catch((x: unknown) => x)) as Error & { reason?: string };
      expect(e.reason).toBe(reason);
      messages.push(e.message);
    };
    // отказ до обращения: ни запроса к ПАО, ни pao.call
    const calls0 = s.stub.calls.length;
    const pao0 = journal.entries.filter((e) => e.kind === "pao.call").length;
    await fail(core.mandates.requireActive(null), "MANDATE_NONE");
    await fail(core.mandates.request({ ...INTENT, keyTermsShown: false }, { idempotencyKey: "idem_journal_r1" }), "MANDATE_DRAFT_INVALID");
    expect(s.stub.calls).toHaveLength(calls0);
    expect(journal.entries.filter((e) => e.kind === "pao.call")).toHaveLength(pao0);
    // ответ POST: другой статус, другие пределы
    consents.tamper = (m) => ({ ...m, status: "REJECTED" });
    await fail(core.mandates.request(INTENT, { idempotencyKey: "idem_journal_r2" }), "MANDATE_NOT_ACTIVE");
    consents.tamper = (m) => ({ ...m, subject: "другое" });
    await fail(core.mandates.request(INTENT, { idempotencyKey: "idem_journal_r3" }), "MANDATE_REPLY_MISMATCH");
    consents.tamper = undefined;
    // ожидание подписи: лента кончилась без подписи; отзыв во время ожидания
    const p1 = await core.mandates.request(INTENT, { idempotencyKey: "idem_journal_r4" });
    await fail(core.mandates.awaitSigned(p1, feed()), "MANDATE_SIGNATURE_PENDING");
    consents.mandates.get(p1.id)!.status = "REVOKED";
    await fail(core.mandates.awaitSigned(p1, feed(event("mandate.revoked", p1.id))), "MANDATE_NOT_ACTIVE");
    // requireActive: не ACTIVE; verify не подтвердил
    const p2 = await core.mandates.request(INTENT, { idempotencyKey: "idem_journal_r5" });
    await fail(core.mandates.requireActive(p2), "MANDATE_NONE");
    const active = await core.mandates.awaitSigned(p2, feed(consents.sign(p2.id)));
    consents.outcome = "OUT_OF_SCOPE";
    await fail(core.mandates.requireActive(active), "MANDATE_OUT_OF_SCOPE");
    // id не по маске (вызывающий снаружи) — запись без mandate
    await fail(core.mandates.requireActive({ ...active, id: "m 1/../x", status: "REJECTED" }), "MANDATE_NONE");
    expect(refused()).toEqual([
      ["MANDATE_NONE", undefined],
      ["MANDATE_DRAFT_INVALID", undefined],
      ["MANDATE_NOT_ACTIVE", "m_1"],
      ["MANDATE_REPLY_MISMATCH", "m_2"],
      ["MANDATE_SIGNATURE_PENDING", p1.id],
      ["MANDATE_NOT_ACTIVE", p1.id],
      ["MANDATE_NONE", p2.id],
      ["MANDATE_OUT_OF_SCOPE", p2.id],
      ["MANDATE_NONE", undefined],
    ]);
    const text = JSON.stringify(journal.entries);
    for (const m of messages) expect(text).not.toContain(m);
    expectJournalClean(journal.entries, AGENT, s.stub.calls);
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
