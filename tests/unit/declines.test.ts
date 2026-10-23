import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PAO_CLIENT_CODES, PAO_ERRORS } from "@kuzin4u/agentic-core/pao";
import { AGENT_STOP_CODES, FAILURE_RULES, ruleForDeclineReason, ruleForFailure } from "../../src/agent/declines/index.js";
import { EVENTS_CURSOR_INVALID } from "../../src/agent/events/index.js";

const spec = readFileSync("docs/core/SPEC.md", "utf8");
/** коды агента вне ПАО — своя часть §7а (Р33) */
const AGENT_CODES = ["MANDATE_REVOCATION_ORDER_MISSING", "PLATFORM_PROTOCOL_UNSUPPORTED"];
/** разделение UNKNOWN (Р48 п. 3) */
const SPLIT_CODES = ["NO_RESPONSE", "BAD_RESPONSE", "AGENT_REQUEST_DEFECT"];
const specRows = [...spec.matchAll(/^\| ([A-Z_]+) \| (\d{3}) \| (\w+) \|/gm)].map((m) => ({ code: m[1]!, http: Number(m[2]), retry: m[3]! }));

describe("таблица отказов", () => {
  it("коды ядра = коды ПАО 1.4.0 + коды агента вне ПАО (Р33, Р48 п. 3) + коды клиента ПАО (Р37 п. 1) + UNKNOWN", () => {
    expect(Object.keys(FAILURE_RULES).sort()).toEqual([...Object.keys(PAO_ERRORS), ...AGENT_CODES, ...SPLIT_CODES, ...PAO_CLIENT_CODES, "UNKNOWN"].sort());
  });

  it("Р33 п. 4: MANDATE_REVOCATION_ORDER_MISSING — стоп без повтора, событие в журнал; строка в SPEC §7а", () => {
    expect(ruleForFailure("MANDATE_REVOCATION_ORDER_MISSING")).toMatchObject({ action: "STOP", retry: "never", maxRetries: 0, defect: false, journal: true });
    for (const c of AGENT_CODES) expect(spec).toMatch(new RegExp(`^\\| ${c} \\| — \\| never \\|`, "m"));
  });

  it("Р48 п. 3: NO_RESPONSE — повтор тем же ключом (адаптер ограничивает методами), BAD_RESPONSE и AGENT_REQUEST_DEFECT — без повтора; строки в SPEC §7а", () => {
    expect(ruleForFailure("NO_RESPONSE")).toMatchObject({ action: "RETRY_SAME_KEY", retry: "same_key", maxRetries: null, defect: false, journal: true });
    expect(ruleForFailure("BAD_RESPONSE")).toMatchObject({ action: "STOP", retry: "never", maxRetries: 0, defect: false, journal: true });
    expect(ruleForFailure("AGENT_REQUEST_DEFECT")).toMatchObject({ action: "STOP", retry: "never", maxRetries: 0, defect: true, journal: true });
    expect(spec).toMatch(/^\| NO_RESPONSE \| — \| same_key \|/m);
    expect(spec).toMatch(/^\| BAD_RESPONSE \| любой \| never \|/m);
    expect(spec).toMatch(/^\| AGENT_REQUEST_DEFECT \| — \| never \|/m);
  });

  it("Р37 п. 1: коды клиента ПАО — без повтора, агент не останавливается; строки в SPEC §7а", () => {
    expect(ruleForFailure("PAO_CLIENT_REDIRECT")).toMatchObject({ action: "STOP", retry: "after_fix", maxRetries: 0, defect: false, journal: true });
    expect(ruleForFailure("PAO_CLIENT_SIGNER_MISSING")).toMatchObject({ action: "STOP", retry: "after_fix", maxRetries: 0, defect: true, journal: true });
    expect(AGENT_STOP_CODES.has("PAO_CLIENT_REDIRECT")).toBe(false);
    expect(spec).toMatch(/^\| PAO_CLIENT_REDIRECT \| 3xx \| after_fix \|/m);
    expect(spec).toMatch(/^\| PAO_CLIENT_SIGNER_MISSING \| — \| after_fix \|/m);
  });

  it.each(Object.entries(PAO_ERRORS))("%s: retry совпадает с ПАО", (code, row) => {
    expect(ruleForFailure(code as keyof typeof FAILURE_RULES).retry).toBe(row.retry);
  });

  it("SPEC §7а совпадает с ПАО по коду, HTTP и retry", () => {
    expect(specRows.length).toBe(Object.keys(PAO_ERRORS).length);
    for (const r of specRows) expect(PAO_ERRORS[r.code as keyof typeof PAO_ERRORS], r.code).toMatchObject({ http: r.http, retry: r.retry });
  });

  it("Р31: REQUEST_INVALID — остановка, дефект; KEY_INVALID — новый ключ, предел 3 отказа подряд, дефект", () => {
    expect(ruleForFailure("REQUEST_INVALID")).toMatchObject({ action: "STOP", maxRetries: 0, defect: true, journal: true });
    expect(ruleForFailure("KEY_INVALID")).toMatchObject({ action: "NEW_KEY", maxRetries: 2, defect: true, journal: true });
    // SPEC §7а: «после 3 отказов подряд» = первый отказ + maxRetries
    expect(spec).toMatch(/\| KEY_INVALID \| 422 \| after_fix \|[^\n]*после 3 отказов подряд/);
  });

  it("Р34 п. 4: EVENTS_CURSOR_INVALID — причина остановки агента (не отказ Платформы), строка в SPEC §7а", () => {
    expect(Object.keys(FAILURE_RULES)).not.toContain(EVENTS_CURSOR_INVALID);
    expect(spec).toMatch(new RegExp(`^\\| ${EVENTS_CURSOR_INVALID} \\| — \\| never \\|[^\\n]*UNREADABLE[^\\n]*REJECTED`, "m"));
  });

  it("UNKNOWN — остановка без повтора", () => {
    expect(ruleForFailure("UNKNOWN")).toMatchObject({ action: "STOP", retry: "never", maxRetries: 0, defect: false, journal: true });
  });

  it("причины отклонения: по SPEC §7б, неизвестная — остановка по операции и человеку", () => {
    expect(ruleForDeclineReason("AOI_MISMATCH").action).toBe("STOP");
    expect(ruleForDeclineReason("INSUFFICIENT_FUNDS").action).toBe("NOTIFY_HUMAN");
    expect(ruleForDeclineReason("AOI_MISSING").action).toBe("FIX_AGENT");
    // Р48 п. 1: перечень #57 — без повтора операции; совпадающие с §7а — с кодом DECLINED_
    expect(ruleForDeclineReason("AGENT_SUSPENDED")).toMatchObject({ code: "DECLINED_AGENT_SUSPENDED", action: "STOP_AGENT" });
    expect(ruleForDeclineReason("MANDATE_REVOKED")).toMatchObject({ code: "DECLINED_MANDATE_REVOKED", action: "STOP_ALL" });
    for (const r of ["MANDATE_NOT_FOUND", "MANDATE_EXPIRED", "MANDATE_SCOPE"]) expect(ruleForDeclineReason(r).action, r).toBe("NEW_MANDATE");
    for (const r of ["LIMIT_EXCEEDED", "ISSUER_DECLINED"]) expect(ruleForDeclineReason(r).action, r).toBe("NOTIFY_HUMAN");
    for (const r of ["CREDENTIAL_INVALID", "STATE_UNAVAILABLE"]) expect(ruleForDeclineReason(r).action, r).toBe("STOP");
    expect(ruleForDeclineReason("ISSUER_DECLINED").code).toBe("ISSUER_DECLINED");
    expect(ruleForDeclineReason("SOMETHING_NEW")).toEqual({ code: "DECLINE_REASON_UNKNOWN", action: "STOP_AND_NOTIFY", defect: false, journal: true, unknown: true });
    expect(ruleForDeclineReason(null).unknown).toBe(true);
  });
});
