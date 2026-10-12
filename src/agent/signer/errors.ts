// Ошибки модуля signer. Это не коды ПАО: KEY_INVALID — основание отказа в допуске на стороне Платформы (РП23).

/** Ключ не принят подписантом: слабый, неканонический, повреждённый, с широкими правами или чужим kid (инвариант 4). */
export class SignerKeyRejected extends Error {
  override readonly name = "SignerKeyRejected";
}
