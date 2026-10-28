// Порт «подпись обращений»: адаптер платформы берёт подписанта отсюда и сообщает об отказах по ключу и допуску.
// Реализация — связка ключей в src/agent/signer; закрытый ключ через порт не проходит (инвариант 2).
import type { HttpLike, Signer } from "@kuzin4u/agentic-core";
import type { DiagCode } from "../../shared/diag-codes.js";

/** Уточнения остановки агента — значения detail, а не коды причины (Р58 п. 3): CLOCK_SKEW — часы агента и Платформы
 *  расходятся больше signature_skew_sec по Date ответа, повтор подписи не поможет. С кодами реестра не пересекаются. */
export const SIGNER_STOP_DETAILS = ["CLOCK_SKEW"] as const;

export interface RequestSigning {
  /** Подписант действующего ключа; агент остановлен или не допущен — SignerStopped; подпись приостановлена (Р27) —
   *  SignerSuspended. */
  current(): Signer;
  /** Подписант для защитных обращений — отказ от мандата и отзыв своего ключа (Р63 п. 2): и при приостановке подписи
   *  (любая причина); агент остановлен или не допущен — SignerStopped. Только действующий подтверждённый ключ. */
  protective(): Signer;
  /** Платформа подтвердила отзыв kid (AGENT_KEY_REVOKED на его подпись, 200 на отзыв): следующий действующий ключ или
   *  остановка (SignerStopped с `revokedKid`, исходный отказ — в cause). `protective` — на пути защитного обращения:
   *  приостановка не бросает (Р63 п. 3). */
  keyRevoked(kid: string, failure?: unknown, protective?: boolean): Signer;
  /** Отказ в допуске или нет действующего ключа: остановка агента; дальнейшая подпись — SignerStopped.
   *  detail — уточнение для журнала: только значение перечня ПАО (класс при AGENT_CLASS_MISMATCH, Р27) или версия вида
   *  1.x.y, собранная из чисел (PLATFORM_PROTOCOL_UNSUPPORTED, Р33 п. 10), или значение SIGNER_STOP_DETAILS. */
  stop(reason: DiagCode, detail?: string): void;
  /** Ответ реестра не по схеме после допуска (Р27), лента недоступна (Р50 дополнение 1), агент приостановлен оператором
   *  (AGENT_SUSPENDED, Р60 п. 1): подпись приостановлена до успешной повторной сверки; AGENT_SUSPENDED сильнее прочих
   *  причин. До допуска — без действия (допуск и так не состоялся), кроме AGENT_SUSPENDED — приостановка без остановки,
   *  снимает её повторный допуск (Р63 п. 1). */
  suspend(reason: DiagCode): void;
}

/** Агент не может действовать (AGENT_STOP_CODES, SIGNATURE_INVALID, статус реестра не ACTIVE): AGENT_SUSPENDED —
 *  приостановка подписи до сверки с реестром (Р60 п. 1: приостановление обратимо, снимает его оператор), иное — остановка. */
export function haltAgent(signing: Pick<RequestSigning, "stop" | "suspend">, reason: DiagCode, detail?: string): void {
  if (reason === "AGENT_SUSPENDED") signing.suspend(reason);
  else signing.stop(reason, detail);
}

/** Подпись обращения не к ПАО (витрины продавцов, Р42 п. 1): действующим ключом порта `RequestSigning`, тот же профиль
 *  подписи. Собирает место сборки; закрытый ключ через порт не проходит (инвариант 2). Подпись остановлена или
 *  приостановлена — SignerStopped или SignerSuspended, обращения нет. */
export interface HttpRequestSigning {
  sign(req: HttpLike): HttpLike;
}
