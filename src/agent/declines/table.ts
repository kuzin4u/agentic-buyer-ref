// Таблица «код отказа → поведение» (SPEC §7, Р20). Ключи — словарь ядра; адаптер переводит коды платформы в него.
import type { FailureCode, RetryClass } from "../../shared/domain.js";
import type { AgentDiagCode } from "../../shared/diag-codes.js";

export type DeclineAction =
  /** остановка; без повтора */
  | "STOP"
  /** остановить всё начатое по мандату и сообщить, что не завершено */
  | "STOP_ALL"
  /** подписать действующим новым ключом; нет ключа — остановка */
  | "ROTATE_KEY"
  /** регистрируемый ключ не принят: не использовать и не повторять им; следующая ротация — новый ключ, подряд не больше
   *  maxRetries раз после первого отказа, затем ротация остановлена; подпись — прежним подтверждённым ключом (Р31) */
  | "NEW_KEY"
  /** исправить причину и повторить не больше maxRetries раз, иначе остановка */
  | "FIX_AND_RETRY"
  /** запросить у человека новый мандат */
  | "NEW_MANDATE"
  /** ждать mandate.signed; без подписи не продолжать */
  | "WAIT_PRINCIPAL"
  /** передать решение человеку */
  | "ASK_HUMAN"
  /** повторяет адаптер: тем же ключом идемпотентности, в пределах pao_max_attempts и потолка Retry-After;
   *  отказ, дошедший до ядра, — бюджет исчерпан: остановка */
  | "RETRY_SAME_KEY"
  /** реквизит не использовать; новый — только при действующем мандате CART */
  | "NEW_CREDENTIAL";

export interface DeclineRule {
  action: DeclineAction;
  /** класс повтора по SPEC §7а (совпадает с retry ПАО 1.4.0) */
  retry: RetryClass;
  /** null — повторы ограничены временем (registry_cache_ttl_sec), а не числом */
  maxRetries: number | null;
  /** дефект или нарушение агента: прогон отмечается */
  defect: boolean;
  /** отдельное событие в журнал (дефект, нарушение или неопознанный ответ платформы) */
  journal: boolean;
}

const rule = (
  action: DeclineAction,
  retry: RetryClass,
  maxRetries: number | null = 0,
  defect = false,
  journal = defect,
): DeclineRule => ({ action, retry, maxRetries, defect, journal });

/** SPEC §7а. Новый код ядра без строки здесь не соберётся. */
export const FAILURE_RULES: Readonly<Record<FailureCode, DeclineRule>> = {
  AGENT_UNKNOWN: rule("STOP", "never"),
  AGENT_SUSPENDED: rule("STOP", "never"),
  AGENT_KEY_REVOKED: rule("ROTATE_KEY", "new_key", 1),
  SIGNATURE_INVALID: rule("FIX_AND_RETRY", "after_fix", 1),
  MANDATE_NOT_FOUND: rule("NEW_MANDATE", "after_human"),
  MANDATE_EXPIRED: rule("NEW_MANDATE", "after_human"),
  MANDATE_REVOKED: rule("STOP_ALL", "never"),
  MANDATE_SCOPE: rule("NEW_MANDATE", "after_human"),
  PRINCIPAL_SIGNATURE_PENDING: rule("WAIT_PRINCIPAL", "after_human"),
  LIMIT_EXCEEDED: rule("ASK_HUMAN", "after_human"),
  STATE_UNAVAILABLE: rule("RETRY_SAME_KEY", "same_key", null),
  CONFIRMATION_REQUIRED: rule("ASK_HUMAN", "after_human"),
  CREDENTIAL_INVALID: rule("NEW_CREDENTIAL", "after_fix"),
  CREDENTIALS_FORBIDDEN: rule("STOP", "never", 0, true),
  IDEMPOTENCY_REQUIRED: rule("FIX_AND_RETRY", "same_key", 1, true),
  IDEMPOTENCY_CONFLICT: rule("STOP", "after_fix", 0, true),
  RATE_LIMITED: rule("RETRY_SAME_KEY", "same_key", null),
  UPSTREAM_UNAVAILABLE: rule("RETRY_SAME_KEY", "same_key", null),
  // Р31: тело не по схеме метода — дефект агента, без повтора.
  REQUEST_INVALID: rule("STOP", "after_fix", 0, true),
  // Р31: ключ не принят при регистрации — ключ отклонён, тем же ключом не повторяется; новые ключи — не больше maxRetries
  // раз подряд после первого отказа, затем ротация остановлена до решения человека (подпись — прежним ключом).
  KEY_INVALID: rule("NEW_KEY", "after_fix", 2, true),
  // Р33 п. 4: код агента вне ПАО — мандат без порядка отзыва не подтверждён (A7 п. 2.2); не дефект агента.
  MANDATE_REVOCATION_ORDER_MISSING: rule("STOP", "never", 0, false, true),
  // Р33 п. 10: Платформа ниже ПАО 1.4.0 — останавливается агент целиком (AGENT_STOP_CODES); не дефект агента.
  PLATFORM_PROTOCOL_UNSUPPORTED: rule("STOP", "never", 0, false, true),
  // Р37 п. 1: отказы клиента ПАО ядра (after_fix ядра) — без повтора; агент не останавливается (не AGENT_STOP_CODES).
  PAO_CLIENT_REDIRECT: rule("STOP", "after_fix", 0, false, true),
  PAO_CLIENT_SIGNER_MISSING: rule("STOP", "after_fix", 0, true),
  // Неопознанный ответ платформы — не дефект агента, но остановка и событие в журнал (SPEC §7а).
  UNKNOWN: rule("STOP", "never", 0, false, true),
};

/** Отказ в допуске (SPEC §7а: AGENT_UNKNOWN, AGENT_SUSPENDED) и несовместимая Платформа (PLATFORM_PROTOCOL_UNSUPPORTED,
 *  Р33 п. 10): останавливается агент целиком, а не одно обращение (П03). */
export const AGENT_STOP_CODES: ReadonlySet<FailureCode> = new Set<FailureCode>([
  "AGENT_UNKNOWN",
  "AGENT_SUSPENDED",
  "PLATFORM_PROTOCOL_UNSUPPORTED",
]);

export function ruleForFailure(code: FailureCode): DeclineRule {
  return FAILURE_RULES[code] ?? FAILURE_RULES.UNKNOWN;
}

/** FIX_AGENT — исправить дефект агента, не повторять операцию; STOP_AND_NOTIFY — остановка по операции и уведомление человека. */
export type ReasonAction = "FIX_AGENT" | "STOP" | "NOTIFY_HUMAN" | "STOP_AND_NOTIFY";

export interface ReasonRule {
  /** код реестра (Р36): причина из перечня §7б или DECLINE_REASON_UNKNOWN */
  code: Extract<AgentDiagCode, "AOI_MISSING" | "AOI_MISMATCH" | "INSUFFICIENT_FUNDS" | "DECLINE_REASON_UNKNOWN">;
  action: ReasonAction;
  defect: boolean;
  /** отдельное событие в журнал (SPEC §7б) */
  journal: boolean;
  /** причина не из перечня SPEC §7б */
  unknown: boolean;
}

/** SPEC §7б: причины отклонения операции (operation.declined). Повтора операции нет ни у одной. */
export const DECLINE_REASONS: Readonly<Record<string, ReasonRule>> = {
  AOI_MISSING: { code: "AOI_MISSING", action: "FIX_AGENT", defect: true, journal: true, unknown: false },
  AOI_MISMATCH: { code: "AOI_MISMATCH", action: "STOP", defect: true, journal: true, unknown: false },
  INSUFFICIENT_FUNDS: { code: "INSUFFICIENT_FUNDS", action: "NOTIFY_HUMAN", defect: false, journal: false, unknown: false },
};

export function ruleForDeclineReason(reason: string | null): ReasonRule {
  if (reason !== null && Object.hasOwn(DECLINE_REASONS, reason)) return DECLINE_REASONS[reason]!;
  // Р20 (уточнение 11.10.2026): неизвестная причина — остановка по операции, уведомить человека, без повтора.
  return { code: "DECLINE_REASON_UNKNOWN", action: "STOP_AND_NOTIFY", defect: false, journal: true, unknown: true };
}
