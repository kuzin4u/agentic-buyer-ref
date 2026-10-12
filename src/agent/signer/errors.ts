// Ошибки модуля signer. Это не коды ПАО: KEY_INVALID — основание отказа в допуске на стороне Платформы (РП23).

/** Ключ не принят подписантом: слабый, неканонический, повреждённый, с широкими правами или чужим kid (инвариант 4). */
export class SignerKeyRejected extends Error {
  override readonly name: string = "SignerKeyRejected";
}

/** Подпись остановлена: нет действующего ключа или агенту отказано в допуске (Т1, SPEC §7а). */
export class SignerStopped extends Error {
  override readonly name = "SignerStopped";
  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`подпись остановлена: ${reason}`, options);
  }
}
