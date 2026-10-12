// Порт «подпись обращений»: адаптер платформы берёт подписанта отсюда и сообщает об отказах по ключу и допуску.
// Реализация — связка ключей в src/agent/signer; закрытый ключ через порт не проходит (инвариант 2).
import type { Signer } from "@kuzin4u/agentic-core";

export interface RequestSigning {
  /** Подписант действующего ключа; агент остановлен или не допущен — SignerStopped. */
  current(): Signer;
  /** Платформа ответила AGENT_KEY_REVOKED на подпись kid: следующий действующий ключ или остановка
   *  (SignerStopped, исходный отказ — в cause). */
  keyRevoked(kid: string, failure?: unknown): Signer;
  /** Отказ в допуске или нет действующего ключа: остановка агента; дальнейшая подпись — SignerStopped. */
  stop(reason: string): void;
}
