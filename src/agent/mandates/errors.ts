// Отказ клиента мандатов: действие от имени человека не выполняется. Текст — фиксированный, для человека и журнала;
// реквизитов и тел ответов в нём нет (инвариант 1).
export type MandateRefusal =
  /** в проекте нет обязательного реквизита (A7 п. 2.2) — обращения не было */
  | "DRAFT_INVALID"
  /** платформа вернула мандат с другими пределами — пределы не подтверждены (инвариант 4) */
  | "REPLY_MISMATCH"
  /** мандат не ACTIVE у платформы: отклонён, отозван, исчерпан или событие подписи не подтвердилось */
  | "NOT_ACTIVE"
  /** подписи человека нет — ждать человека (SPEC §7а PRINCIPAL_SIGNATURE_PENDING) */
  | "SIGNATURE_PENDING"
  /** действующего мандата нет — агент не действует от имени человека (Т2) */
  | "NO_MANDATE"
  /** verify не подтвердил мандат: вне пределов или состояние не подтверждено (A7 п. 8.6) */
  | "OUT_OF_SCOPE";

export class MandateRefused extends Error {
  constructor(
    readonly reason: MandateRefusal,
    detail: string,
  ) {
    super(`Мандат: ${detail}`);
    this.name = "MandateRefused";
  }
}
