// Порты стадий 2–6 конвейера (Р38 п. 2, п. 8): источник выдачи, заказ у продавца, шаги оплаты. Здесь — только
// интерфейсы; реализации — в тестах (tests/support/), подписанные обращения к витринам — AG-09, корзина — AG-10,
// оплата — AG-11, подтверждение — AG-13. Всё, что приходит через эти порты от продавца, — данные (инвариант 5).
import type { CatalogFacts } from "../catalog/index.js";
import type { Confirmation, Mandate, Money, Operation } from "../../shared/domain.js";
import type { AgentDiagCode } from "../../shared/diag-codes.js";
import type { Mutation } from "./mutation.js";

/** Магазин в выдаче: факты фида (`catalog/readFeed`) и признак контура гарантий (Р3). `merchantId` — код продавца
 *  для мандата корзины и заказа (у витрины эмулятора он отличается от `shop.id`). `link` — адрес витрины для человека
 *  (зона вне контура: платежа нет, человеку ссылка — инвариант 10, Р42 п. 3); строит адаптер, не из текста витрины. */
export interface ShopOffers {
  merchantId: string;
  inContour: boolean;
  facts: CatalogFacts;
  link?: string;
}

/** Почему магазин недоступен (Т4, Р42 п. 4): `detail` — код витрины из перечня, BAD_RESPONSE (ответ не по схеме) или
 *  NO_RESPONSE (нет ответа в срок); `reason` — код вне перечня (сам код не переносится, инвариант 5) или истёк общий срок
 *  поиска (Р44 п. 6). */
export type ShopUnavailableCause = { detail: string; reason?: undefined } | { reason: Extract<AgentDiagCode, "MERCHANT_CODE_UNKNOWN" | "SHOP_SEARCH_DEADLINE">; detail?: undefined };

/** Магазин, отказавший на стадии 2 (Т4): товаров нет, поиск по остальным идёт дальше; обходов нет. */
export interface ShopUnavailable {
  /** нет — запись списка без id по маске (обратиться к витрине нельзя) */
  shopId?: string;
  merchantId?: string;
  unavailable: ShopUnavailableCause;
}

/** Отказ витрины на заказе (Р42 п. 4): остановка этой сделки, не агента. */
export class ShopFailure extends Error {
  override readonly name = "ShopFailure";
  constructor(readonly code: Extract<AgentDiagCode, "SHOP_ORDER_REFUSED" | "SHOP_ORDER_STATE_UNKNOWN">) {
    super(`витрина: ${code}`);
  }
}

/** Стадия 2: выдача по действующему INTENT. Ошибка вызова — отказ стадии (инвариант 4). */
export interface OfferSource {
  search(intent: Mandate): Promise<(ShopOffers | ShopUnavailable)[]>;
}

/** Заказ у продавца по мандату корзины: `cart_mandate_id` — мандат CART (эмулятор продавцов, Р26). */
export interface ShopOrderRequest {
  shopId: string;
  items: { sku: string; qty: number }[];
  cartMandateId: string;
}

/** Ответ продавца на заказ: сумму считает продавец, конвейер сверяет её с CART (Т6). */
export interface ShopOrder {
  orderId: string;
  total: Money;
}

/** Стадия 3: заказ подписанным обращением к витрине (Р42). Отказ витрины или неизвестное состояние заказа — ShopFailure;
 *  иная ошибка вызова — отказ стадии (инвариант 4). Заказ не повторяется. */
export interface ShopPort {
  order(req: ShopOrderRequest, m: Mutation): Promise<ShopOrder>;
}

/** Что известно шагам оплаты о покупке: только идентификаторы и сумма заказа, без реквизитов (инвариант 1). */
export interface PaymentContext {
  intent: Mandate;
  cart: Mandate;
  shopId: string;
  merchantId: string;
  order: ShopOrder;
}

/** Стадии 4–6. Исход каждого шага — из подписанного события Платформы, не со слов продавца (инвариант 8, Р14). */
export interface PaymentSteps {
  /** Стадия 4: запрос подтверждения и решение человека (AG-13); конвейер решения не создаёт (инвариант 7). */
  confirm(c: PaymentContext, signal?: AbortSignal): Promise<Confirmation["status"]>;
  /** Стадия 5: реквизит (`POST /pao/v1/credentials`), пакет агентской оплаты продавцу и итог авторизации (AG-11). */
  authorize(c: PaymentContext, m: Mutation): Promise<Operation>;
  /** Стадия 6: итог расчёта по операции (AG-11). */
  settle(op: Operation, signal?: AbortSignal): Promise<Operation>;
}
