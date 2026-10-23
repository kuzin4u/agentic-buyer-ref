// Привязка операции к покупке и сверка с заказом и CART (Р49 п. 3–4; Т6, Т8, ревью Р38 № 7). Без сети и журнала: на
// входе — операция по GET и снимки покупки, на выходе — доменная операция в валюте CART или поле расхождения.
import { money } from "@kuzin4u/agentic-core";
import type { CurrencyCode, Fulfilment, Mandate, Operation, OperationRecord } from "../../shared/domain.js";

/** Поле, по которому операция не сходится с покупкой (detail записи operation.mismatch). */
export type MismatchField = "AOI" | "MERCHANT" | "AMOUNT" | "CHANNEL" | "OP_REF";

/** Суммы записи об исполнении — в валюте мандата операции (Р49 п. 7; поле `currency` — с ПАО 1.5.0). */
export function fulfilmentIn(f: OperationRecord["fulfilment"], currency: CurrencyCode): Fulfilment | null {
  if (f === null) return null;
  return { ref: f.ref, finalAmount: money(f.finalMinor, currency), scopeCheck: f.scopeCheck, spentPosition: money(f.spentMinor, currency), at: f.at };
}

/** Итог, который должен совпасть с покупкой целиком: одобрение и расчёт. У отказа и требования подтверждения сверяются
 *  только пришедшие поля — Платформа опускает факты, которых у неё нет (#59 п. 1), а при AOI_MISMATCH нет `aoi` (п. 4). */
const COMPLETE: ReadonlySet<Operation["status"]> = new Set(["AUTHORIZED", "SETTLED"]);

/**
 * Сверка привязанной по `order_ref` операции с CART покупки: мандат признака — CART, продавец и сумма — из CART, канал —
 * CARD (пакет агентской оплаты, Р45). Совпала — операция в валюте CART; нет — поле расхождения.
 */
export function bindOperation(r: OperationRecord, cart: Mandate): Operation | MismatchField {
  const basket = cart.cart;
  // CART без корзины до стадии 5 не доходит (MANDATE_REPLY_MISMATCH); здесь — защита: сверить не с чем
  if (basket === null || basket === undefined) return "AMOUNT";
  const complete = COMPLETE.has(r.status);
  if (r.indicator === null ? complete : r.indicator.mandateId !== cart.id) return "AOI";
  if (r.merchantId === null ? complete : r.merchantId !== basket.merchantId) return "MERCHANT";
  if (r.amountMinor === null ? complete : r.amountMinor !== basket.total.amount) return "AMOUNT";
  if (r.channel === null ? complete : r.channel !== "CARD") return "CHANNEL";
  const currency = basket.total.currency;
  return {
    opRef: r.opRef,
    orderRef: r.orderRef,
    channel: r.channel,
    amount: r.amountMinor === null ? null : money(r.amountMinor, currency),
    merchantId: r.merchantId,
    indicator: r.indicator,
    status: r.status,
    declineReason: r.declineReason,
    fulfilment: fulfilmentIn(r.fulfilment, currency),
  };
}

/** Сверка операции стадии 6 с одобренной на стадии 5 (Р49 п. 6): тот же `op_ref`, `order_ref`, признак, продавец, сумма и
 *  канал; запись об исполнении — в валюте одобренной суммы. */
export function settledOperation(r: OperationRecord, authorized: Operation): Operation | MismatchField {
  if (r.opRef !== authorized.opRef || r.orderRef !== authorized.orderRef) return "OP_REF";
  if (r.indicator === null || r.indicator.mandateId !== authorized.indicator?.mandateId) return "AOI";
  if (r.merchantId !== authorized.merchantId) return "MERCHANT";
  if (authorized.amount === null || r.amountMinor !== authorized.amount.amount) return "AMOUNT";
  if (r.channel !== authorized.channel) return "CHANNEL";
  const currency = authorized.amount.currency;
  return { ...authorized, status: r.status, declineReason: r.declineReason, fulfilment: fulfilmentIn(r.fulfilment, currency) };
}
