// Коды отказа витрин эмулятора продавцов (Р26 п. 5, Р42 п. 4, 7): тело отказа витрины — `{code}`. Перечень, реестр К17 и
// признак «повторяемый» — `declines/merchant.ts` (формат /diag — только в declines, Р36 п. 1); здесь — только таблица
// «код → HTTP-статус» эмулятора для сверки ответа.
import type { MerchantCode } from "../../declines/index.js";

export { MERCHANT_RETRYABLE, isMerchantCode, type MerchantCode } from "../../declines/index.js";

/** Код витрины → HTTP-статус эмулятора (`MERCHANT_ERROR_HTTP`, PS-12). */
export const MERCHANT_HTTP: Readonly<Record<MerchantCode, number>> = {
  AGENT_UNIDENTIFIED: 403,
  KEY_UNKNOWN: 401,
  AGENT_MISMATCH: 401,
  KEY_EXPIRED: 401,
  SIGNATURE_INVALID: 401,
  SHOP_NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  ORDERS_NOT_ACCEPTED: 409,
  ITEM_INVALID: 422,
  ITEM_INCOMPLETE: 422,
  PACKAGE_INVALID: 422,
  PACKAGE_MISMATCH: 409,
  ORDER_NOT_PAYABLE: 409,
  UPSTREAM_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
};
