// Отказ ПАО → отказ ядра (SPEC §7а, Р20). Класс повтора — из таблицы ядра по коду, не из тела ответа.
// Р48 п. 3: тайм-аут и сбой сети до заголовков — NO_RESPONSE (same_key); отказ без тела ПАО и пара «код, HTTP» не по
// x-pao-errors — BAD_RESPONSE; код вне ПАО 1.4.0 и неразобранное — UNKNOWN (never, инвариант 4).
import { PAO_ERRORS, PaoCallError, type ErrorCode } from "@kuzin4u/agentic-core/pao";
import { PlatformFailure, type FailureCode } from "../../../shared/domain.js";
import { FAILURE_RULES } from "../../declines/index.js";

/** Полный перевод кодов ПАО 1.4.0; новый код в agentic-core без строки здесь не соберётся. */
const CODES: Record<ErrorCode, FailureCode> = {
  AGENT_UNKNOWN: "AGENT_UNKNOWN",
  AGENT_SUSPENDED: "AGENT_SUSPENDED",
  AGENT_KEY_REVOKED: "AGENT_KEY_REVOKED",
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
  MANDATE_NOT_FOUND: "MANDATE_NOT_FOUND",
  MANDATE_EXPIRED: "MANDATE_EXPIRED",
  MANDATE_REVOKED: "MANDATE_REVOKED",
  MANDATE_SCOPE: "MANDATE_SCOPE",
  PRINCIPAL_SIGNATURE_PENDING: "PRINCIPAL_SIGNATURE_PENDING",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  STATE_UNAVAILABLE: "STATE_UNAVAILABLE",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  CREDENTIAL_INVALID: "CREDENTIAL_INVALID",
  CREDENTIALS_FORBIDDEN: "CREDENTIALS_FORBIDDEN",
  IDEMPOTENCY_REQUIRED: "IDEMPOTENCY_REQUIRED",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  UPSTREAM_UNAVAILABLE: "UPSTREAM_UNAVAILABLE",
  REQUEST_INVALID: "REQUEST_INVALID",
  KEY_INVALID: "KEY_INVALID",
};

/** Код платформы для журнала — только если похож на код; иначе не переносим ничего из тела. */
const safeCode = (v: unknown): string | null => (typeof v === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(v) ? v : null);

export function toFailure(e: unknown, idempotencyKey: string | null = null): PlatformFailure {
  if (e instanceof PlatformFailure) return e;
  if (e instanceof PaoCallError) {
    // Отказ самого клиента (К18, Р37 п. 1): код — из clientCode, не из тела; запрос на другой адрес или в сеть не уходил.
    if (e.clientCode !== undefined) {
      const key = e.idempotencyKey ?? idempotencyKey;
      // код клиента вне словаря (dist ядра новее типов) — UNKNOWN, а не TypeError (инвариант 4; ревью К0 № 6)
      if (!Object.hasOwn(FAILURE_RULES, e.clientCode)) return new PlatformFailure("UNKNOWN", "never", null, e.status, key, "код клиента ПАО вне словаря");
      return new PlatformFailure(e.clientCode, FAILURE_RULES[e.clientCode].retry, null, e.status, key);
    }
    const raw = safeCode(e.body?.code);
    const code = raw !== null && Object.hasOwn(CODES, raw) ? CODES[raw as ErrorCode] : undefined;
    const key = e.idempotencyKey ?? idempotencyKey;
    if (code === undefined) {
      if (e.status === 0) return new PlatformFailure("NO_RESPONSE", FAILURE_RULES.NO_RESPONSE.retry, null, 0, key, "нет ответа");
      if (!e.body) return new PlatformFailure("BAD_RESPONSE", "never", null, e.status, key, "ответ без тела ПАО");
      return new PlatformFailure("UNKNOWN", "never", raw, e.status, key, "код не из ПАО 1.4.0");
    }
    // Пара «код, HTTP» должна совпасть с x-pao-errors; иначе ответ не подтверждён контрактом (инвариант 4).
    if (PAO_ERRORS[raw as ErrorCode].http !== e.status) {
      return new PlatformFailure("BAD_RESPONSE", "never", raw, e.status, key, "HTTP-статус не совпадает с кодом ПАО");
    }
    return new PlatformFailure(code, FAILURE_RULES[code].retry, raw, e.status, key);
  }
  // Сообщение исключения не переносится: у JSON.parse в нём бывает фрагмент тела ответа.
  return new PlatformFailure("UNKNOWN", "never", null, 0, idempotencyKey, "ответ не разобран");
}
