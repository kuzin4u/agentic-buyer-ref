// Порт «подпись обращений»: адаптер платформы берёт подписанта отсюда и сообщает об отказах по ключу и допуску.
// Реализация — связка ключей в src/agent/signer; закрытый ключ через порт не проходит (инвариант 2).
import type { Signer } from "@kuzin4u/agentic-core";

export interface RequestSigning {
  /** Подписант действующего ключа; агент остановлен или не допущен — SignerStopped; подпись приостановлена (Р27) —
   *  SignerSuspended. */
  current(): Signer;
  /** Платформа ответила AGENT_KEY_REVOKED на подпись kid: следующий действующий ключ или остановка
   *  (SignerStopped, исходный отказ — в cause). */
  keyRevoked(kid: string, failure?: unknown): Signer;
  /** Отказ в допуске или нет действующего ключа: остановка агента; дальнейшая подпись — SignerStopped.
   *  detail — уточнение для журнала: только значение перечня ПАО (класс при AGENT_CLASS_MISMATCH, Р27) или версия вида
   *  1.x.y, собранная из чисел (PLATFORM_PROTOCOL_UNSUPPORTED, Р33 п. 10). */
  stop(reason: string, detail?: string): void;
  /** Ответ реестра не по схеме после допуска (Р27): подпись приостановлена до успешной повторной сверки; до допуска —
   *  без действия (допуск и так не состоялся). */
  suspend(reason: string): void;
}
