// Порты стадий 2–6 конвейера (Р38 п. 2, п. 8): источник выдачи, заказ у продавца, шаги оплаты. Здесь — только
// интерфейсы; реализации — в тестах (tests/support/), подписанные обращения к витринам — AG-09, корзина — AG-10,
// оплата — AG-11, подтверждение — AG-13. Всё, что приходит через эти порты от продавца, — данные (инвариант 5).
import type { CatalogFacts } from "../catalog/index.js";
import type { Confirmation, Mandate, Money, Operation } from "../../shared/domain.js";
import type { Mutation } from "./mutation.js";

/** Магазин в выдаче: факты фида (`catalog/readFeed`) и признак контура гарантий (Р3). `merchantId` — код продавца
 *  для мандата корзины и заказа (у витрины эмулятора он отличается от `shop.id`). */
export interface ShopOffers {
  merchantId: string;
  inContour: boolean;
  facts: CatalogFacts;
}

/** Стадия 2: выдача по действующему INTENT. Ошибка вызова — отказ стадии (инвариант 4). */
export interface OfferSource {
  search(intent: Mandate): Promise<ShopOffers[]>;
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

/** Стадия 3: заказ подписанным обращением к витрине (AG-09). Ошибка вызова — отказ стадии (инвариант 4). */
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
