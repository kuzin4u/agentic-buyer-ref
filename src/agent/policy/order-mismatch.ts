// Пометка Д02 (Р48 п. 5; Т5а, A5 п. 1.2–1.3): продавец посчитал заказ не по той цене, что показал агенту
// (ORDER_REPLY_MISMATCH), — пара «продавец, sku» помечается в следующих выдачах этого процесса сигналом A5_PRICE_MISMATCH:
// зона прежняя, покупка — только по явному решению человека (Р32). Цену агент не пересчитывает. Реестр — в памяти
// процесса до перезапуска (остаточный риск — нюанс Р48, пересмотр при AG-16); один на ядро, как окно дробления.

export class OrderPriceMismatches {
  readonly #seen = new Set<string>();

  /** Отметить позицию заказа, у которого Order.total продавца разошёлся с итогом CART. */
  mark(merchantId: string, sku: string): void {
    this.#seen.add(key(merchantId, sku));
  }

  /** Позиция продавца уже расходилась с заказом в этом процессе. */
  has(merchantId: string, sku: string): boolean {
    return this.#seen.has(key(merchantId, sku));
  }
}

// \u0000 не встречается в идентификаторах по маске: пары не склеиваются
const key = (merchantId: string, sku: string): string => `${merchantId}\u0000${sku}`;
