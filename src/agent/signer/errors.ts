// Ошибки модуля signer. Это не коды ПАО: KEY_INVALID — основание отказа в допуске на стороне Платформы (РП23).
// Причины остановки и приостановки — коды реестра (Р36); CLOSED — штатное закрытие, в реестр не входит (Р36, вопрос (в)).
import type { DiagCode } from "../../shared/diag-codes.js";

export type SignerStopReason = DiagCode | "CLOSED";

/** Ключ не принят подписантом: слабый, неканонический, повреждённый, с широкими правами или чужим kid (инвариант 4). */
export class SignerKeyRejected extends Error {
  override readonly name: string = "SignerKeyRejected";
}

/** Настройка канала mTLS не по форме (Р64 п. 6): отпечаток корня — не полный SHA-256 (64 знака hex), корень не PEM
 *  самоподписанного сертификата. Отказ при загрузке параметров — до обращений, частичного сравнения нет. */
export class TlsConfigInvalid extends Error {
  override readonly name = "TlsConfigInvalid";
}

/** Отпечаток корня УЦ из настройки не совпал с корнем (Р64 п. 6): TLS_TRUST_MISMATCH — остановка до первого обращения
 *  (fail-closed). Отпечатков в сообщении нет: оба — в настройке оператора. */
export class TlsTrustMismatch extends SignerKeyRejected {
  override readonly name = "TlsTrustMismatch";
  readonly code = "TLS_TRUST_MISMATCH" as const;
  constructor() {
    super("отпечаток корня УЦ не совпал с настройкой");
  }
}

/** Причина отказа в установке сертификата канала (Р64 п. 4). */
export type TlsCertRejection = "MALFORMED" | "KEY_MISMATCH" | "SAN_MISMATCH" | "NOT_CLIENT_AUTH" | "NOT_ISSUED_BY_ROOT" | "EXPIRED";

/** Сертификат из решения о допуске не установлен (Р64 п. 4): прежний остаётся, агент не останавливается — действие
 *  оператора (новый допуск, другой сертификат). */
export class TlsCertificateRejected extends SignerKeyRejected {
  override readonly name = "TlsCertificateRejected";
  constructor(readonly reason: TlsCertRejection) {
    super(`сертификат канала не установлен: ${reason}`);
  }
}

/** Ротация остановлена: новый ключ не принят подряд сверх предела таблицы отказов (KEY_INVALID, KEY_NOT_ACTIVE; Р31,
 *  Р58 п. 4). Не временный отказ: нужен человек (снятие — перезапуск, команда оператора — AG-14); подпись прежним
 *  подтверждённым ключом продолжается, пока он действителен. */
export class SignerRotationStopped extends Error {
  override readonly name = "SignerRotationStopped";
}

/** Подпись приостановлена до успешной повторной сверки с реестром: ответ реестра не по схеме после допуска (Р27), лента
 *  недоступна (Р50 дополнение 1), агент приостановлен оператором (AGENT_SUSPENDED, Р60 п. 1). */
export class SignerSuspended extends Error {
  override readonly name = "SignerSuspended";
  constructor(readonly reason: DiagCode) {
    super(`подпись приостановлена: ${reason}`);
  }
}

/** Подпись остановлена: нет действующего ключа или агенту отказано в допуске (Т1, SPEC §7а). `revokedKid` — ключ,
 *  отмеченный отозванным перед остановкой NO_ACTIVE_KEY (Р60 п. 7): совпал с ключом, который агент отзывал сам, — отзыв
 *  состоялся и агент остановлен; иной ключ или null — отзыв не состоялся. */
export class SignerStopped extends Error {
  override readonly name = "SignerStopped";
  readonly revokedKid: string | null;
  constructor(
    readonly reason: SignerStopReason,
    options?: ErrorOptions & { revokedKid?: string },
  ) {
    super(`подпись остановлена: ${reason}`, options);
    this.revokedKid = options?.revokedKid ?? null;
  }
}
