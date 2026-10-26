// Ошибки модуля signer. Это не коды ПАО: KEY_INVALID — основание отказа в допуске на стороне Платформы (РП23).
// Причины остановки и приостановки — коды реестра (Р36); CLOSED — штатное закрытие, в реестр не входит (Р36, вопрос (в)).
import type { DiagCode } from "../../shared/diag-codes.js";

export type SignerStopReason = DiagCode | "CLOSED";

/** Ключ не принят подписантом: слабый, неканонический, повреждённый, с широкими правами или чужим kid (инвариант 4). */
export class SignerKeyRejected extends Error {
  override readonly name: string = "SignerKeyRejected";
}

/** Ротация остановлена: новый ключ не принят подряд сверх предела таблицы отказов (KEY_INVALID, KEY_NOT_ACTIVE; Р31,
 *  Р58 п. 4). Не временный отказ: нужен человек (снятие — перезапуск, команда оператора — AG-14); подпись прежним
 *  подтверждённым ключом продолжается, пока он действителен. */
export class SignerRotationStopped extends Error {
  override readonly name = "SignerRotationStopped";
}

/** Подпись приостановлена до успешной повторной сверки с реестром (Р27: ответ реестра не по схеме после допуска). */
export class SignerSuspended extends Error {
  override readonly name = "SignerSuspended";
  constructor(readonly reason: DiagCode) {
    super(`подпись приостановлена: ${reason}`);
  }
}

/** Подпись остановлена: нет действующего ключа или агенту отказано в допуске (Т1, SPEC §7а). */
export class SignerStopped extends Error {
  override readonly name = "SignerStopped";
  constructor(
    readonly reason: SignerStopReason,
    options?: ErrorOptions,
  ) {
    super(`подпись остановлена: ${reason}`, options);
  }
}
