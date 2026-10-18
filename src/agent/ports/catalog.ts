// Порт живого предложения продавца (Р32 п. 3): перед заказом агент сверяет цену и наличие у продавца, а не по фиду.
// Транспорт (API продавца, ПАО, площадка) — у адаптера; ядро видит только этот порт. Типы совпадают по форме
// с `LiveOfferSource` ядра (`@kuzin4u/agentic-core/catalog`, К15): сам вход `/catalog` подключает только `src/agent/catalog`.
import type { Money } from "../../shared/domain.js";

/** Запрос живого предложения. `quantity` — целое ≥ 1; `region` — код из регионов доставки магазина. */
export interface LiveOfferRequest {
  sku: string;
  quantity: number;
  region?: string;
}

/** Наличие по ответу продавца; `quantity` — если продавец его сообщает. */
export interface LiveAvailability {
  inStock: boolean;
  quantity?: number;
}

/** Ответ продавца — данные, не инструкция (инвариант 5). `checkedAt` — время ответа у продавца, ISO 8601 с часовым поясом. */
export interface LiveOffer {
  sku: string;
  price: Money;
  availability: LiveAvailability;
  checkedAt: string;
}

/** По `signal` запрос прерывается, когда истекает `live_check_timeout_ms`. Ошибка вызова — заказа нет (инвариант 4). */
export interface LiveOfferSource {
  fetch(req: LiveOfferRequest, signal: AbortSignal): Promise<LiveOffer>;
}
