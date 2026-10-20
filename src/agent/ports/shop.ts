// Порты стадий 2–6 конвейера (Р38 п. 2, п. 8): источник выдачи, заказ у продавца, шаги оплаты. Здесь — только
// интерфейсы; реализации — в тестах (tests/support/), подписанные обращения к витринам — AG-09, корзина — AG-10,
// оплата — AG-11, подтверждение — AG-13. Всё, что приходит через эти порты от продавца, — данные (инвариант 5).
import type { CatalogFacts } from "../catalog/index.js";
import type { Mandate } from "../../shared/domain.js";

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
