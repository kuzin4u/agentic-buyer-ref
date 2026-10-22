// Пакет агентской оплаты для продавца (ПАО §4, РП22 п. 5; Р45 п. 3). Реквизит (`payload`: `token_ref`, криптограмма) —
// только внутри запечатанного пакета: тело закрыто (`#private`), сериализация, `inspect` и строка его не показывают,
// `structuredClone` его не переносит. Запечатывает адаптер `pao` по ответу `POST /pao/v1/credentials`, открывает только
// адаптер витрин при отправке (тест границы). Конвейер, политика, журнал, оболочка и советчик пакета не открывают
// (инвариант 1).

/** Состав пакета — ровно ПАО §4; суммы нет (сумма операции — из заказа продавца и сообщения процессинга). */
export interface PaymentPackageBody {
  credential_ref: string;
  kind: "CARD" | "SBP";
  /** как в ответе Платформы, без изменений */
  payload: Readonly<Record<string, unknown>>;
  /** признак агентной операции, как в ответе Платформы */
  aoi: Readonly<Record<string, unknown>>;
  cart_mandate_id: string;
  order_ref: string;
}

/** Что видно снаружи вместо содержимого. */
export const SEALED = "[пакет агентской оплаты]";

export class SealedPackage {
  /** тело пакета JSON-строкой; вне класса не читается */
  readonly #body: string;

  constructor(body: PaymentPackageBody) {
    this.#body = JSON.stringify(body);
  }

  toJSON(): string {
    return SEALED;
  }

  toString(): string {
    return SEALED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return SEALED;
  }

  /** Тело для отправки продавцу; копия без закрытого поля (`structuredClone`, подмена прототипа) — исключение. */
  static open(p: SealedPackage): string {
    if (!(#body in p)) throw new TypeError("не запечатанный пакет агентской оплаты");
    return p.#body;
  }
}

/** Запечатать пакет — адаптер `pao` по ответу Платформы. */
export function sealPackage(body: PaymentPackageBody): SealedPackage {
  return new SealedPackage(body);
}

/** Тело пакета JSON-строкой — только адаптер витрин, непосредственно перед отправкой (подписанным обращением). */
export function openPackage(p: SealedPackage): string {
  return SealedPackage.open(p);
}
