// Решение человека по сигналам A5 (Р32 п. 2, Р39 п. 5): создаёт только оболочка по действию человека в ответ на показ.
// Код ядра решение не создаёт (правило графа импортов: из shell/ ядро берёт только типы, отметку реестра политики
// ставит только эта фабрика) и не подделывает: политика принимает только выданное фабрикой (инвариант 7).
import type { Money } from "../../shared/domain.js";
import type { A5SignalCode } from "../catalog/index.js";
import { markIssued } from "../policy/a5-issued.js";

declare const ISSUED: unique symbol;

/** Что человек видел в выдаче: продавец, товар, коды A5 и цена (у товара выдачи конвейера — `Offer`). */
export interface ShownOffer {
  merchantId: string;
  sku: string;
  a5: readonly A5SignalCode[];
  product: { price: Money };
}

/** Решение привязано к показу: продавец и `sku` (один `sku` бывает у двух магазинов), показанные коды и цена. После
 *  смены цены или набора кодов оно товар не покрывает — решает политика (`mayDraftCart`). */
export interface HumanA5Decision {
  readonly [ISSUED]: true;
  readonly merchantId: string;
  readonly sku: string;
  readonly price: Readonly<Money>;
  /** коды A5, показанные человеку */
  readonly shown: readonly A5SignalCode[];
  /** коды, которые человек принял; только из показанных */
  readonly accepted: readonly A5SignalCode[];
}

/** Решение человека по показанному товару. Принять можно только показанное; решение заморожено — вызывающий его не
 *  изменит после выдачи. */
export function humanA5Decision(shown: ShownOffer, accepted: readonly A5SignalCode[]): HumanA5Decision {
  const codes = [...new Set(accepted)];
  if (!codes.every((c) => shown.a5.includes(c))) throw new RangeError("решение A5: принят код, которого не было в показе");
  const d = Object.freeze({
    merchantId: shown.merchantId,
    sku: shown.sku,
    price: Object.freeze({ amount: shown.product.price.amount, currency: shown.product.price.currency }),
    shown: Object.freeze([...new Set(shown.a5)]),
    accepted: Object.freeze(codes),
  });
  markIssued(d);
  return d as unknown as HumanA5Decision;
}
