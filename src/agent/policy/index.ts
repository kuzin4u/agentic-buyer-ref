// Движок политики без модели: проверка каждого действия до вызова платформы, fail-closed.
export type { CartDraftDecision, CartPurchase, HumanA5Decision, OfferVerdict, OrderDecision, OrderNext } from "./catalog.js";
export { acceptedA5, classifyOffer, mayDraftCart, mayOrder } from "./catalog.js";
export { issuedByShell } from "./a5-issued.js";
export type { PaymentDecision, PaymentFacts, PaymentRefusal, Thresholds } from "./payment.js";
export { confirmThreshold, currencySupported, mandateRefusal, mayAuthorize, needsConfirmation } from "./payment.js";
export type { SplitOutcome, SplitSlot } from "./split.js";
export { SplitWindow } from "./split.js";
