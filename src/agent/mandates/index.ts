// Клиент журнала мандатов: INTENT и CART, verify, ожидание подписи, отказ без действующего мандата (AG-05).
// Реакция на отзыв — AG-14, выписка для спора — AG-15.
export { MandateClient, missingTerms, refOf, type MandateClientOptions, type MandateJournal } from "./client.js";
export { MandateRefused, REVOCATION_ORDER_MISSING_TEXT, type MandateRefusal } from "./errors.js";
