// Витрины продавцов (Р42): адаптер портов стадий 2–3 и перечень кодов отказа витрин.
export { ShopsAdapter, type Readiness, type ShopProfile, type ShopsAdapterOptions, type ShopsParams } from "./adapter.js";
export { MERCHANT_HTTP, MERCHANT_RETRYABLE, isMerchantCode, type MerchantCode } from "./codes.js";
