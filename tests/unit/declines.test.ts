import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PAO_CLIENT_CODES, PAO_ERRORS } from "@kuzin4u/agentic-core/pao";
import { FAILURE_RULES, ruleForDeclineReason, ruleForFailure } from "../../src/agent/declines/index.js";
import { EVENTS_CURSOR_INVALID } from "../../src/agent/events/index.js";

const spec = readFileSync("docs/core/SPEC.md", "utf8");
/** коды агента вне ПАО — своя часть §7а (Р33) */
const AGENT_CODES = ["MANDATE_REVOCATION_ORDER_MISSING", "PLATFORM_PROTOCOL_UNSUPPORTED"];
const specRows = [...spec.matchAll(/^\| ([A-Z_]+) \| (\d{3}) \| (\w+) \|/gm)].map((m) => ({ code: m[1]!, http: Number(m[2]), retry: m[3]! }));

describe("таблица отказов", () => {
  it("коды ядра = коды ПАО 1.4.0 + коды агента вне ПАО (Р33) + коды клиента ПАО (Р37 п. 1) + UNKNOWN", () => {
    expect(Object.keys(FAILURE_RULES).sort()).toEqual([...Object.keys(PAO_ERRORS), ...AGENT_CODES, ...PAO_CLIENT_CODES, "UNKNOWN"].sort());
  });

  it("Р33 п. 4: MANDATE_REVOCATION_ORDER_MISSING — стоп без повтора, событие в журнал; строка в SPEC §7а", () => {
    expect(ruleForFailure("MANDATE_REVOCATION_ORDER_MISSING")).toMatchObject({ action: "STOP", retry: "never", maxRetries: 0, defect: false, journal: true });
    for (const c of AGENT_CODES) expect(spec).toMatch(new RegExp(`^\\| ${c} \\| — \\| never \\|`, "m"));
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
    expect(ruleForDeclineReason("SOMETHING_NEW")).toEqual({ code: "DECLINE_REASON_UNKNOWN", action: "STOP_AND_NOTIFY", defect: false, journal: true, unknown: true });
    expect(ruleForDeclineReason(null).unknown).toBe(true);
  });
});
