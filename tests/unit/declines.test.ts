import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PAO_ERRORS } from "@kuzin4u/agentic-core/pao";
import { FAILURE_RULES, ruleForDeclineReason, ruleForFailure } from "../../src/agent/declines/index.js";

const spec = readFileSync("docs/core/SPEC.md", "utf8");
const specRows = [...spec.matchAll(/^\| ([A-Z_]+) \| (\d{3}) \| (\w+) \|/gm)].map((m) => ({ code: m[1]!, http: Number(m[2]), retry: m[3]! }));

describe("таблица отказов", () => {
  it("коды ядра = коды ПАО 1.3.0 + UNKNOWN", () => {
    expect(Object.keys(FAILURE_RULES).sort()).toEqual([...Object.keys(PAO_ERRORS), "UNKNOWN"].sort());
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

  it("UNKNOWN — остановка без повтора", () => {
    expect(ruleForFailure("UNKNOWN")).toMatchObject({ action: "STOP", retry: "never", maxRetries: 0, defect: false, journal: true });
  });

  it("причины отклонения: по SPEC §7б, неизвестная — остановка по операции и человеку", () => {
    expect(ruleForDeclineReason("AOI_MISMATCH").action).toBe("STOP");
    expect(ruleForDeclineReason("INSUFFICIENT_FUNDS").action).toBe("NOTIFY_HUMAN");
    expect(ruleForDeclineReason("AOI_MISSING").action).toBe("FIX_AGENT");
    expect(ruleForDeclineReason("SOMETHING_NEW")).toEqual({ action: "STOP_AND_NOTIFY", defect: false, journal: true, unknown: true });
    expect(ruleForDeclineReason(null).unknown).toBe(true);
  });
});
