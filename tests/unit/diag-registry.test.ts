// Р36: реестр кодов агента в формате К17 ядра — полнота, без повтора записей ядра, согласие с таблицей отказов,
// «кто ошибся» у LIVE_CALL_ERROR, тексты без подстановок и идентификаторов; каждый код из src — в реестре.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG_DIAG, CATALOG_DIAG_CODES } from "@kuzin4u/agentic-core/catalog";
import { checkDiagRegistry, diagAction } from "@kuzin4u/agentic-core/diag";
import { PAO_DIAG, PAO_ERRORS, PAO_RETRY_ACTION } from "@kuzin4u/agentic-core/pao";
import { DIAG } from "../../src/agent/compose.js";
import { AGENT_DIAG, DECLINE_REASONS, FAILURE_RULES, mergeDiag, ruleForDeclineReason, type DiagAction, type ReasonAction } from "../../src/agent/declines/index.js";
import { REVOCATION_ORDER_MISSING_TEXT } from "../../src/agent/mandates/index.js";
import { AGENT_DIAG_CODES } from "../../src/shared/diag-codes.js";

const PAO_CODES = Object.keys(PAO_ERRORS);
const ALL_CODES = [...PAO_CODES, ...CATALOG_DIAG_CODES, ...AGENT_DIAG_CODES];

function srcFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? srcFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

describe("реестр кодов агента (Р36)", () => {
  it("полнота: запись на каждый код агента, поля по К17, тексты ru", () => {
    expect(checkDiagRegistry(AGENT_DIAG_CODES, AGENT_DIAG, { langs: ["ru"] })).toEqual([]);
    expect(new Set(AGENT_DIAG_CODES).size).toBe(AGENT_DIAG_CODES.length);
  });

  it("записи ядра не повторяются; полный реестр — ПАО, каталог и агент, полон", () => {
    const own = Object.keys(AGENT_DIAG);
    expect(own.filter((c) => Object.hasOwn(PAO_DIAG, c) || Object.hasOwn(CATALOG_DIAG, c))).toEqual([]);
    expect(checkDiagRegistry(ALL_CODES, DIAG, { langs: ["ru"] })).toEqual([]);
    expect(Object.keys(DIAG)).toHaveLength(ALL_CODES.length);
    // текст ПАО — из ядра, а не своя копия
    expect(DIAG.MANDATE_NOT_FOUND).toBe(PAO_DIAG.MANDATE_NOT_FOUND);
  });

  it("код в двух реестрах — ошибка сборки", () => {
    expect(() => mergeDiag(PAO_DIAG, { AGENT_UNKNOWN: PAO_DIAG.AGENT_UNKNOWN })).toThrow(/AGENT_UNKNOWN/);
  });

  it("таблица отказов и реестр согласны: retry правила → действие записи (PAO_RETRY_ACTION ядра)", () => {
    for (const [code, rule] of Object.entries(FAILURE_RULES)) {
      expect(DIAG[code]?.action, code).toBe(PAO_RETRY_ACTION[rule.retry]);
    }
  });

  it("причины operation.declined (SPEC §7б) и реестр согласны: код = ключ, запись есть, действие по таблице", () => {
    const ACTION: Record<ReasonAction, DiagAction> = { STOP: "stop", STOP_AND_NOTIFY: "stop", NOTIFY_HUMAN: "after_human", FIX_AGENT: "after_fix" };
    const rules = [...Object.entries(DECLINE_REASONS), ["(неизвестная)", ruleForDeclineReason("SOMETHING_NEW")] as const];
    for (const [key, rule] of rules) {
      if (key !== "(неизвестная)") expect(rule.code, key).toBe(key);
      expect(DIAG[rule.code]?.action, key).toBe(ACTION[rule.action]);
    }
    expect(ruleForDeclineReason(null).code).toBe("DECLINE_REASON_UNKNOWN");
  });

  it("тексты ядра не повторяются; текст отказа мандата без порядка отзыва — один (Р36 п. 1, п. 3)", () => {
    const core = new Set([...Object.values(PAO_DIAG), ...Object.values(CATALOG_DIAG)].map((e) => e.human.ru));
    expect(Object.values(AGENT_DIAG).filter((e) => core.has(e.human.ru)).map((e) => e.code)).toEqual([]);
    expect(AGENT_DIAG.MANDATE_REVOCATION_ORDER_MISSING.human.ru).toBe(REVOCATION_ORDER_MISSING_TEXT);
  });

  it("since — версия агента из package.json (Р36 п. 3)", () => {
    const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    for (const e of Object.values(AGENT_DIAG)) if (e.component === "agent") expect(e.since, e.code).toBe(version);
  });

  it("код не из реестра — stop (fail-closed, инвариант 4)", () => {
    expect(diagAction(DIAG, "SOMETHING_NEW")).toBe("stop");
  });

  it("кто ошибся: LIVE_CALL_ERROR — агент и среда, человеку не «продавец не подтвердил» (ревью К1.2б № 7)", () => {
    const e = AGENT_DIAG.LIVE_CALL_ERROR;
    expect(e.source).toEqual(["agent", "environment"]);
    expect(e.human.ru).not.toMatch(/продав|магазин/i);
    expect(e.human.ru).toMatch(/помощник/);
  });

  it("решения владельца: (а) отказы мандатов — с префиксом MANDATE_, (б) PLATFORM_VERSION_UNKNOWN — after_fix, (в) CLOSED вне реестра", () => {
    expect(AGENT_DIAG_CODES.filter((c) => /^(DRAFT_INVALID|REPLY_MISMATCH|NOT_ACTIVE|SIGNATURE_PENDING|NO_MANDATE|OUT_OF_SCOPE|REVOCATION_ORDER_MISSING)$/.test(c))).toEqual([]);
    expect(AGENT_DIAG.PLATFORM_VERSION_UNKNOWN.action).toBe("after_fix");
    expect(Object.hasOwn(DIAG, "CLOSED")).toBe(false);
  });

  it("тексты — постоянные строки: без подстановок, идентификаторов и реквизитов (К17 п. 6, инвариант 1)", () => {
    for (const e of Object.values(AGENT_DIAG)) {
      for (const t of [e.human.ru, e.operator.ru]) {
        expect(t, e.code).not.toMatch(/[{}<>$`]|tok_|\bm_|\bord_|nspk:agent|\d{12,}/);
      }
    }
  });

  it("каждый код-литерал причины в src — в полном реестре (остановка, приостановка, журнал, отказ мандата, коды фактов)", () => {
    const call = /(?:\.stop|\.suspend|#halt|#stop|#suspend|#mark|#record|new MandateRefused|new SignerStopped|new SignerSuspended)\(([^)]*)\)/g;
    const literal = /"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)"/g;
    const codes = /codes: \[([^\]]*)\]/g;
    const reason = /reason: "([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)"(?!\s*\|)/g; // не объединение типов (domain.ts)
    const found = new Set<string>();
    for (const f of srcFiles("src")) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(call)) for (const l of m[1]!.matchAll(literal)) found.add(l[1]!);
      for (const m of text.matchAll(reason)) found.add(m[1]!);
      for (const m of text.matchAll(codes)) for (const l of m[1]!.matchAll(literal)) found.add(l[1]!);
    }
    expect(found.size).toBeGreaterThan(20);
    expect([...found].filter((c) => !Object.hasOwn(DIAG, c)).sort()).toEqual([]);
  });
});
