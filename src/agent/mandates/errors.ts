// Отказ клиента мандатов: действие от имени человека не выполняется. Текст — фиксированный, для человека и журнала;
// реквизитов и тел ответов в нём нет (инвариант 1). Коды — из реестра агента (Р36 п. 2, вопрос (а)).
import type { AgentDiagCode } from "../../shared/diag-codes.js";

export type MandateRefusal = Extract<
  AgentDiagCode,
  /** в проекте нет обязательного реквизита (A7 п. 2.2) — обращения не было */
  | "MANDATE_DRAFT_INVALID"
  /** платформа вернула мандат с другими пределами — пределы не подтверждены (инвариант 4) */
  | "MANDATE_REPLY_MISMATCH"
  /** мандат не ACTIVE у платформы: отклонён, отозван, исчерпан или событие подписи не подтвердилось */
  | "MANDATE_NOT_ACTIVE"
  /** подписи человека нет — ждать человека (SPEC §7а PRINCIPAL_SIGNATURE_PENDING) */
  | "MANDATE_SIGNATURE_PENDING"
  /** действующего мандата нет — агент не действует от имени человека (Т2) */
  | "MANDATE_NONE"
  /** verify не подтвердил мандат: вне пределов или состояние не подтверждено (A7 п. 8.6) */
  | "MANDATE_OUT_OF_SCOPE"
  /** Платформа не указала порядок отзыва — мандат не подтверждён (A7 п. 2.2, Р33 п. 4) */
  | "MANDATE_REVOCATION_ORDER_MISSING"
>;

/** Текст при MANDATE_REVOCATION_ORDER_MISSING (Р33 п. 4) — побайтно как human.ru записи реестра (Р36; тест diag-registry):
 *  mandates не видит declines (граница модулей). */
export const REVOCATION_ORDER_MISSING_TEXT =
  "Банк не указал порядок отзыва поручения, поэтому покупка по нему невозможна. Обратитесь в банк или создайте поручение заново.";

export class MandateRefused extends Error {
  constructor(
    readonly reason: MandateRefusal,
    detail: string,
  ) {
    super(`Мандат: ${detail}`);
    this.name = "MandateRefused";
  }
}
