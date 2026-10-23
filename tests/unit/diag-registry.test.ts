// Р36: реестр кодов агента в формате К17 ядра — полнота, без повтора записей ядра, согласие с таблицей отказов,
// «кто ошибся» у LIVE_CALL_ERROR, тексты без подстановок и идентификаторов; каждый код из src — в реестре.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG_DIAG, CATALOG_DIAG_CODES } from "@kuzin4u/agentic-core/catalog";
import { checkDiagRegistry, diagAction } from "@kuzin4u/agentic-core/diag";
import { PAO_CLIENT_CODES, PAO_CLIENT_DIAG, PAO_DIAG, PAO_ERRORS, PAO_RETRY_ACTION } from "@kuzin4u/agentic-core/pao";
import { DIAG } from "../../src/agent/compose.js";
import { AGENT_DIAG, DECLINE_REASONS, FAILURE_RULES, PAYMENT_NOTICE_CODES, PAYMENT_OUTCOME_CODES, UNFINISHED, UNFINISHED_TEXT, afterPayment, mergeDiag, ruleForDeclineReason, stopNext, type DiagAction, type ReasonAction } from "../../src/agent/declines/index.js";
import { REVOCATION_ORDER_MISSING_TEXT } from "../../src/agent/mandates/index.js";
import { STOP_CAUSES } from "../../src/agent/pipeline/index.js";
import { AGENT_DIAG_CODES } from "../../src/shared/diag-codes.js";

const PAO_CODES = Object.keys(PAO_ERRORS);
const ALL_CODES = [...PAO_CODES, ...PAO_CLIENT_CODES, ...CATALOG_DIAG_CODES, ...AGENT_DIAG_CODES];

function srcFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? srcFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

describe("реестр кодов агента (Р36)", () => {
  it("полнота: запись на каждый код агента, поля по К17, тексты ru", () => {
    expect(checkDiagRegistry(AGENT_DIAG_CODES, AGENT_DIAG, { langs: ["ru"] })).toEqual([]);
    expect(new Set(AGENT_DIAG_CODES).size).toBe(AGENT_DIAG_CODES.length);
  });

  it("записи ядра не повторяются; полный реестр — ПАО, клиент ПАО (Р37 п. 1), каталог и агент, полон", () => {
    const own = Object.keys(AGENT_DIAG);
    expect(own.filter((c) => Object.hasOwn(PAO_DIAG, c) || Object.hasOwn(PAO_CLIENT_DIAG, c) || Object.hasOwn(CATALOG_DIAG, c))).toEqual([]);
    expect(checkDiagRegistry(ALL_CODES, DIAG, { langs: ["ru"] })).toEqual([]);
    expect(Object.keys(DIAG)).toHaveLength(ALL_CODES.length);
    // текст ПАО — из ядра, а не своя копия
    expect(DIAG.MANDATE_NOT_FOUND).toBe(PAO_DIAG.MANDATE_NOT_FOUND);
    expect(DIAG.PAO_CLIENT_REDIRECT).toBe(PAO_CLIENT_DIAG.PAO_CLIENT_REDIRECT);
    // передача #34 п. 3: оба реестра ядра полны по своим перечням
    expect(checkDiagRegistry([...PAO_CODES, ...PAO_CLIENT_CODES], { ...PAO_DIAG, ...PAO_CLIENT_DIAG })).toEqual([]);
  });

  it("код в двух реестрах — ошибка сборки", () => {
    expect(() => mergeDiag(PAO_DIAG, { AGENT_UNKNOWN: PAO_DIAG.AGENT_UNKNOWN })).toThrow(/AGENT_UNKNOWN/);
  });

  it("таблица отказов и реестр согласны: retry правила → действие записи (PAO_RETRY_ACTION ядра)", () => {
    for (const [code, rule] of Object.entries(FAILURE_RULES)) {
      expect(DIAG[code]?.action, code).toBe(PAO_RETRY_ACTION[rule.retry]);
    }
  });

  it("причины operation.declined (SPEC §7б) и реестр согласны: код — ключ или DECLINED_<ключ> у кода §7а, запись есть, действие по таблице", () => {
    const ACTION: Record<ReasonAction, DiagAction> = {
      STOP: "stop", STOP_AND_NOTIFY: "stop", NOTIFY_HUMAN: "after_human", FIX_AGENT: "after_fix",
      NEW_MANDATE: "after_human", STOP_AGENT: "stop", STOP_ALL: "stop",
    };
    const rules = [...Object.entries(DECLINE_REASONS), ["(неизвестная)", ruleForDeclineReason("SOMETHING_NEW")] as const];
    for (const [key, rule] of rules) {
      // Р48 п. 1: причина, совпадающая с кодом §7а (он в PAO_DIAG ядра), — с приставкой DECLINED_
      if (key !== "(неизвестная)") {
        expect(rule.code, key).toBe(Object.hasOwn(PAO_ERRORS, key) ? `DECLINED_${key}` : key);
        expect(AGENT_DIAG[rule.code]?.component, key).toBe("pao");
      }
      expect(DIAG[rule.code]?.action, key).toBe(ACTION[rule.action]);
    }
    expect(ruleForDeclineReason(null).code).toBe("DECLINE_REASON_UNKNOWN");
  });

  it("Р48 п. 2: тексты человеку причин §7б — без совета повторить, с «итог проверьте в приложении банка»", () => {
    const codes = [...Object.values(DECLINE_REASONS).map((r) => r.code), ruleForDeclineReason(null).code];
    for (const code of codes) {
      const human = AGENT_DIAG[code].human.ru;
      expect(human, code).not.toMatch(/повтор|ещё раз|снова|попробуйте|пополните|другой способ|позже/i);
      expect(human, code).toContain("итог проверьте в приложении банка");
    }
  });

  it("Р50 п. 4 (условие владельца 2): тексты «что не завершено» — у каждого значения; PAYMENT, PAYMENT_OUTCOME, SETTLEMENT — по Р-298", () => {
    expect(Object.keys(UNFINISHED_TEXT).sort()).toEqual([...UNFINISHED].sort());
    for (const u of ["PAYMENT", "PAYMENT_OUTCOME", "SETTLEMENT"] as const) {
      expect(UNFINISHED_TEXT[u], u).toContain("итог проверьте в приложении банка");
    }
    for (const u of UNFINISHED) expect(UNFINISHED_TEXT[u], u).not.toMatch(/повтор|ещё раз|снова|попроб|позже|пополните|другой способ/i);
    // PAYMENT — и до пакета, и после известного отказа §7б: «оплата не прошла», заказ не оплачен (ревью КТ1 № 1)
    expect(UNFINISHED_TEXT.PAYMENT).toContain("оплата не прошла");
    expect(UNFINISHED_TEXT.PAYMENT).toContain("не оплачен");
  });

  it("Р50 п. 4: next — из действия таблиц §7а и §7б, а не из текста", () => {
    expect(stopNext("MANDATE_REVOKED")).toBe("STOP_ALL");
    expect(stopNext("DECLINED_MANDATE_REVOKED")).toBe("STOP_ALL");
    expect(stopNext("MANDATE_EXPIRED")).toBe("NEW_MANDATE");
    expect(stopNext("DECLINED_MANDATE_SCOPE")).toBe("NEW_MANDATE");
    expect(stopNext("LIMIT_EXCEEDED")).toBe("ASK_HUMAN");
    expect(stopNext("CONFIRMATION_REQUIRED")).toBe("ASK_HUMAN");
    expect(stopNext("DECLINED_LIMIT_EXCEEDED")).toBe("NOTIFY_HUMAN");
    expect(stopNext("DECLINE_REASON_UNKNOWN")).toBe("NOTIFY_HUMAN");
    expect(stopNext("OPERATION_RESULT_UNCONFIRMED")).toBe("NOTIFY_HUMAN");
    expect(stopNext("DECLINED_AGENT_SUSPENDED")).toBeNull();
    expect(stopNext("UNKNOWN")).toBeNull();
    expect(stopNext("MANDATE_NOT_ACTIVE")).toBeNull();
    // каждое действие таблиц сводится: §7а — STOP_ALL, NEW_MANDATE, ASK_HUMAN; прочее — null
    for (const [code, r] of Object.entries(FAILURE_RULES)) {
      const want = r.action === "STOP_ALL" || r.action === "NEW_MANDATE" || r.action === "ASK_HUMAN" ? r.action : null;
      expect(stopNext(code as keyof typeof FAILURE_RULES), code).toBe(want);
    }
  });

  it("Р49 п. 2 (блокер Р-298): у итоговых кодов после отправки пакета — «итог проверьте в приложении банка», без совета повторить; иной код — OPERATION_RESULT_UNCONFIRMED", () => {
    expect(PAYMENT_OUTCOME_CODES.has("OPERATION_RESULT_UNCONFIRMED")).toBe(true);
    expect(PAYMENT_OUTCOME_CODES.has("OPERATION_REPLY_MISMATCH")).toBe(true);
    // уведомления и ожидание после оплаты — тексты по тому же правилу (условие владельца к Р49 п. 6–7)
    for (const code of PAYMENT_NOTICE_CODES) {
      const human = DIAG[code]!.human.ru;
      expect(human, code).not.toMatch(/повтор|ещё раз|снова|попроб|позже|пополните|другой способ/i);
      expect(human, code).toContain("итог проверьте в приложении банка");
    }
    for (const code of PAYMENT_OUTCOME_CODES) {
      const human = DIAG[code]!.human.ru;
      expect(human, code).not.toMatch(/повтор|ещё раз|снова|попроб|позже|пополните|другой способ/i);
      expect(human, code).toContain("итог проверьте в приложении банка");
      expect(afterPayment(code), code).toBe(code);
    }
    for (const code of ["UNKNOWN", "MANDATE_NOT_ACTIVE", "STATE_UNAVAILABLE", "NO_RESPONSE", "PIPELINE_TRANSITION_FORBIDDEN"] as const) {
      expect(afterPayment(code), code).toBe("OPERATION_RESULT_UNCONFIRMED");
    }
  });

  it("Р48 п. 1: перечень §7б — закрытый перечень Платформы v0.19.0 (передача #57) плюс AOI_MISSING и INSUFFICIENT_FUNDS", () => {
    // Перечень стенда не экспортируется (exports пакета — stand и fixtures): читается текст объявления из dist; до ПАО 1.5.0
    // enum в YAML нет (#37). Сломается при переносе файла на стороне платформы — тогда сверка по CHANGELOG и #57.
    const dts = readFileSync("node_modules/agentic-ps-platform/dist/fulfilment/outcomes.d.ts", "utf8");
    const list = /DECLINE_EVENT_REASONS: readonly \[([^\]]*)\]/.exec(dts)?.[1] ?? "";
    const platform = [...list.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]!);
    expect(platform).toHaveLength(10);
    expect(Object.keys(DECLINE_REASONS).sort()).toEqual([...platform, "AOI_MISSING", "INSUFFICIENT_FUNDS"].sort());
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
    const call = /(?:\.stop|\.suspend|#halt|#stop|#suspend|#mark|#record|new MandateRefused|#refuse|new SignerStopped|new SignerSuspended)\(([^)]*)\)/g;
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
    // уточнение остановки (Р40 п. 6) — значение detail, а не код причины: в вызове остановки вторым аргументом
    const causes: readonly string[] = STOP_CAUSES;
    expect([...found].filter((c) => !Object.hasOwn(DIAG, c) && !causes.includes(c)).sort()).toEqual([]);
  });

  it("уточнения остановки покупки (Р40 п. 6) с кодами реестра не пересекаются — читатель журнала их не спутает", () => {
    expect(STOP_CAUSES.filter((c) => Object.hasOwn(DIAG, c))).toEqual([]);
  });
});
