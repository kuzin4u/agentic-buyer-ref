// Отчёт самопроверки при старте (Р36 п. 6, дополнение 2): формат К17 п. 8 ядра; «готов» — нет ни одного fail.
// Проверки — в порядке старта: без сети (параметры, ПАО ядра, ключи, курсор), затем Платформа (версия, допуск, подписка —
// при адресе push, дополнение 2 п. 5).
import { buildSelfCheckReport, diagAction, type DiagRegistry, type SelfCheckItem, type SelfCheckReport } from "@kuzin4u/agentic-core/diag";
import type { DiagCode } from "../../shared/diag-codes.js";
import { AGENT_VERSION } from "./registry.js";

export type { SelfCheckItem, SelfCheckReport };

export const SELF_CHECKS = [
  "config.params",
  "core.pao",
  "keys.store",
  "keys.active",
  "events.cursor",
  "platform.protocol",
  "platform.admission",
  // только при адресе push: отказ подписки — предупреждение, код остановки агента — отказ (ревью К2.2 № 4)
  "events.subscription",
] as const;

export type SelfCheckName = (typeof SELF_CHECKS)[number];

/** Агент не стартует: в отчёте есть fail; исходная ошибка — в cause (дополнение 2 п. 3). */
export class AgentNotReady extends Error {
  override readonly name = "AgentNotReady";
  constructor(
    readonly report: SelfCheckReport,
    options?: ErrorOptions,
  ) {
    const failed = report.checks.filter((c) => c.status === "fail").map((c) => `${c.check}: ${c.code}`);
    super(`агент не готов: ${failed.join(", ")}`, options);
  }
}

/** Результат проверки: ok, предупреждение или отказ с кодом из реестра. */
export type CheckResult = { status: "ok" } | { status: "warn" | "fail"; code: DiagCode };

/** Отчёт по выполненным проверкам в порядке SELF_CHECKS; невыполненные (после отказа) в отчёт не входят. */
export function selfCheckReport(results: Partial<Record<SelfCheckName, CheckResult>>, now: Date): SelfCheckReport {
  const checks: SelfCheckItem[] = [];
  for (const check of SELF_CHECKS) {
    const r = results[check];
    if (r === undefined) continue;
    checks.push(r.status === "ok" ? { check, status: "ok" } : { check, status: r.status, code: r.code });
  }
  return buildSelfCheckReport("agent", AGENT_VERSION, checks, now);
}

/** Какую проверку не прошёл старт по коду отказа: ключи и хранилище, курсор, версия Платформы; прочее — допуск. */
export function failedCheck(code: DiagCode): SelfCheckName {
  switch (code) {
    case "KEYSTORE_LOCKED":
    case "KEYSTORE_WRITE_FAILED":
    case "NO_KEY":
    case "KEY_REJECTED":
      return "keys.store";
    case "NO_ACTIVE_KEY":
    case "KEY_AMBIGUOUS":
      return "keys.active";
    case "EVENTS_CURSOR_INVALID":
      return "events.cursor";
    case "PLATFORM_PROTOCOL_UNSUPPORTED":
      return "platform.protocol";
    default:
      return "platform.admission";
  }
}

/** Остановить подписанта или разрешить повтор старта — по действию кода в реестре (дополнение 2 п. 2): stop —
 *  остановка; retry_same_key, after_fix, after_human, new_key — агент не допущен, start() можно повторить. */
export function stopsAgent(registry: DiagRegistry, code: DiagCode): boolean {
  return diagAction(registry, code) === "stop";
}
