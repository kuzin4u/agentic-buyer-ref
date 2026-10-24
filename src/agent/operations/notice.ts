// Уведомления оболочки по операции (Р49 п. 7, Р51 п. 3–4): общие для расчёта покупки и наблюдения после итога. Без сети и
// журнала: на входе — операция покупки, на выходе — код уведомления и сумма к нему.
import type { NoticeAmount, PurchaseNotice } from "../ports/shop.js";
import type { Operation } from "../../shared/domain.js";

/** Уведомление по записи об исполнении (Р49 п. 7): всё, кроме WITHIN_LIMITS; записи нет у SETTLED — не распознано. */
export function scopeNotice(op: Operation): PurchaseNotice | null {
  const s = op.fulfilment?.scopeCheck;
  if (s === "WITHIN_LIMITS") return null;
  if (s === "EXCEEDS_AUTHORIZATION") return "SCOPE_EXCEEDS_AUTHORIZATION";
  if (s === "NOT_RESERVED") return "SCOPE_NOT_RESERVED";
  return "SCOPE_CHECK_UNRECOGNIZED";
}

/** Сумма к уведомлению (Р51 п. 3–4): сумма списания из записи об исполнении; записи нет — сумма операции. */
export const chargedAmount = (op: Operation): NoticeAmount | undefined => op.fulfilment?.finalAmount ?? op.amount ?? undefined;
