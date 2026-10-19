// Порты ядра: платёжная платформа (Р19), живое предложение продавца (Р32), профиль человека (схема 1.0, Р18), советчик Advisor (Р15), тестовые советчики.
export type { PaymentPlatform, PlatformCapabilities, Mutation } from "./payment-platform.js";
export type { MandatePort } from "./mandates.js";
export type { EventsPort, FeedItem } from "./events.js";
export type { RequestSigning } from "./request-signing.js";
export type { LiveAvailability, LiveOffer, LiveOfferRequest, LiveOfferSource } from "./catalog.js";
