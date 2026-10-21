// Коды отказа витрин эмулятора продавцов (Р26 п. 5, Р42 п. 4, 7): тело отказа витрины — `{code}`. Перечень закрыт: код вне
// него — MERCHANT_CODE_UNKNOWN, магазин недоступен. Это не коды ПАО и не коды агента: отдельный перечень, в журнал —
// только как detail записи shop.call. Реестр в формате К17 (тексты, источник, действие) — К2.

/** Код витрины → HTTP-статус эмулятора (`MERCHANT_ERROR_HTTP`, PS-12). */
export const MERCHANT_HTTP = {
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
} as const;

export type MerchantCode = keyof typeof MERCHANT_HTTP;

/** Повторяемые коды (Р42 п. 4): только временный отказ витрины — один повтор `GET` после Retry-After. */
export const MERCHANT_RETRYABLE: ReadonlySet<MerchantCode> = new Set<MerchantCode>(["RATE_LIMITED", "UPSTREAM_UNAVAILABLE"]);

export const isMerchantCode = (c: unknown): c is MerchantCode => typeof c === "string" && Object.hasOwn(MERCHANT_HTTP, c);
