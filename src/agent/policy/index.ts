// Движок политики без модели: проверка каждого действия до вызова платформы, fail-closed.
export type { CartDraftDecision, HumanA5Decision, OfferVerdict, OrderDecision, OrderNext } from "./catalog.js";
export { classifyOffer, mayDraftCart, mayOrder } from "./catalog.js";
