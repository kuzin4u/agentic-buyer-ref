// Отказ канала mTLS по исключению fetch (Р64 п. 7; решение владельца 29.10): закрытый перечень, общий для адаптера ПАО
// (`adapters/pao/errors.ts`) и знака готовности витрин (`adapters/shops`, КТ1 № 1 сессии 49); здесь, а не в адаптере
// ПАО — его подключает только место сборки (Р19). Алерт TLS о сертификате клиента — как 401 AGENT_UNKNOWN; сервер не
// прошёл проверку — TLS_SERVER_UNTRUSTED; срок сертификата канала истёк до обращения (код ошибки канала signer) —
// TLS_CERT_EXPIRED. Прочее, в т. ч. обрыв, сброс при рукопожатии, тайм-аут — не отказ канала.
import type { FailureCode } from "../../shared/domain.js";

const CLIENT_CERT_ALERT_CODES: ReadonlySet<string> = new Set([
  "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE",
  "ERR_SSL_SSLV3_ALERT_CERTIFICATE_REVOKED",
  "ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED",
  "ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN",
  "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
  "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED",
]);
/** Номера алертов о сертификате клиента (RFC 8446 §6): bad_certificate, certificate_revoked, certificate_expired,
 *  certificate_unknown, unknown_ca, certificate_required. */
const CLIENT_CERT_ALERTS: ReadonlySet<number> = new Set([42, 44, 45, 46, 48, 116]);
/** protocol_version: сервер не поддерживает TLS 1.3. */
const PROTOCOL_VERSION_ALERT = 70;
/** Сервер не прошёл проверку (КТ1 № 2 сессии 49): все коды проверки X.509 Node (`X509_ERROR_CODE_MAPPING`, 28 кодов)
 *  без `OUT_OF_MEM`; `UNSPECIFIED` — код вне таблицы Node, неизвестный отказ проверки сервера (инвариант 4); имя сервера и
 *  версия протокола. `OUT_OF_MEM` — ресурс машины агента, а не признак чужого сервера: NO_RESPONSE с повтором (решение
 *  владельца, сессия 50). */
const SERVER_UNTRUSTED_CODES: ReadonlySet<string> = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "CERT_SIGNATURE_FAILURE",
  "CRL_SIGNATURE_FAILURE",
  "CERT_NOT_YET_VALID",
  "CERT_HAS_EXPIRED",
  "CRL_NOT_YET_VALID",
  "CRL_HAS_EXPIRED",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_CHAIN_TOO_LONG",
  "CERT_REVOKED",
  "INVALID_CA",
  "PATH_LENGTH_EXCEEDED",
  "INVALID_PURPOSE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "HOSTNAME_MISMATCH",
  "UNSPECIFIED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_CERT_ALTNAME_FORMAT",
  "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
  "ERR_SSL_UNSUPPORTED_PROTOCOL",
]);
/** Номер алерта Node отдаёт только в тексте OpenSSL (EPROTO); распознаётся ровно этот шаблон. */
const ALERT_NUMBER = /SSL alert number (\d{1,3})\n?$/;

/** Отказ канала по причине исключения fetch; null — не отказ канала (дальше — NO_RESPONSE или «не проверено»). */
export function channelFailure(cause: unknown): FailureCode | null {
  if (typeof cause !== "object" || cause === null) return null;
  const code = (cause as { code?: unknown }).code;
  if (code === "TLS_CERT_EXPIRED") return "TLS_CERT_EXPIRED";
  if (typeof code === "string" && CLIENT_CERT_ALERT_CODES.has(code)) return "AGENT_UNKNOWN";
  if (typeof code === "string" && SERVER_UNTRUSTED_CODES.has(code)) return "TLS_SERVER_UNTRUSTED";
  const message = (cause as { message?: unknown }).message;
  const alert = typeof message === "string" ? ALERT_NUMBER.exec(message) : null;
  if (alert === null) return null;
  const n = Number(alert[1]);
  if (CLIENT_CERT_ALERTS.has(n)) return "AGENT_UNKNOWN";
  return n === PROTOCOL_VERSION_ALERT ? "TLS_SERVER_UNTRUSTED" : null;
}
