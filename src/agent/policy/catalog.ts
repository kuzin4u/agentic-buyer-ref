// Правило каталога (Р32 п. 1–6): детерминированно, без модели (инвариант 3). На входе — факты модуля `catalog/`
// (коды), на выходе — решение кодом; тексты для человека даёт оболочка по коду.
import type { ConfirmationMode } from "../../shared/domain.js";
import type { A5SignalCode, CatalogIssueCode, CatalogShop, LiveFact, LiveFactCode, ProductFacts } from "../catalog/index.js";

/** Товар в выдаче. `AVAILABLE` с непустым `a5` — показ с пометкой «сведения продавца противоречивы» (Р32 п. 1). */
export type OfferVerdict =
  | { kind: "EXCLUDED"; reason: "MODEL"; codes: CatalogIssueCode[] }
  | { kind: "EXCLUDED"; reason: "REGION" }
  | { kind: "AVAILABLE"; a5: A5SignalCode[] };

/** Доставка в регион человека (Р32 п. 5): вариант с этим регионом, вариант без региона при регионе из профиля магазина
 *  или `PICKUP`. Регион человека неизвестен — подтверждается только самовывоз (инвариант 4). */
function reachesRegion(p: ProductFacts, shop: CatalogShop, region: string | undefined): boolean {
  return p.product.delivery.some((d) => {
    if (d.method === "PICKUP") return true;
    if (region === undefined) return false;
    return d.region === undefined ? shop.deliveryRegions.includes(region) : d.region === region;
  });
}

/** Решение по товару выдачи. `shopIssues` непустой — исключён весь магазин (ошибки модели или разбора фида). */
export function classifyOffer(p: ProductFacts, shop: CatalogShop, shopIssues: CatalogIssueCode[], region: string | undefined): OfferVerdict {
  const model = [...new Set([...shopIssues, ...p.issues])];
  if (model.length > 0) return { kind: "EXCLUDED", reason: "MODEL", codes: model };
  if (!reachesRegion(p, shop, region)) return { kind: "EXCLUDED", reason: "REGION" };
  return { kind: "AVAILABLE", a5: [...p.signals] };
}

/** Явное решение человека в оболочке в ответ на показ сигнала A5 (Р32 п. 2): по товару и по показанным кодам.
 *  Создаёт его только оболочка по действию человека; агент его не создаёт и пометку не снимает (инвариант 7). */
export interface HumanA5Decision {
  sku: string;
  accepted: A5SignalCode[];
}

export type CartDraftDecision = { allow: true } | { allow: false; code: "EXCLUDED" | "A5_AUTONOMOUS" | "A5_NEEDS_HUMAN" };

/** Можно ли готовить проект мандата корзины. Сумма и порог `confirm_above_kop` здесь не участвуют: решение по A5 —
 *  отдельно от подтверждения выше порога (Т7), при сумме выше порога нужны оба. */
export function mayDraftCart(
  sku: string,
  verdict: OfferVerdict,
  mode: ConfirmationMode,
  decision: HumanA5Decision | undefined,
): CartDraftDecision {
  if (verdict.kind !== "AVAILABLE") return { allow: false, code: "EXCLUDED" };
  if (verdict.a5.length === 0) return { allow: true };
  if (mode === "AUTONOMOUS") return { allow: false, code: "A5_AUTONOMOUS" };
  const covered = decision !== undefined && decision.sku === sku && verdict.a5.every((c) => decision.accepted.includes(c));
  return covered ? { allow: true } : { allow: false, code: "A5_NEEDS_HUMAN" };
}

/** Что дальше после отказа живой проверки (Р32 п. 4). Автоматического повтора нет ни в одном случае (инвариант 9). */
export type OrderNext =
  /** продавец не подтвердил предложение — сообщить человеку */
  | "TELL_UNCONFIRMED"
  /** нет в наличии или не хватает количества — сообщить человеку */
  | "TELL_STOCK"
  /** цена изменилась — позиция по `offer`, человеку предлагается новый мандат корзины (Т6, Р5) */
  | "NEW_CART_MANDATE";

export type OrderDecision =
  | { allow: true; offer: NonNullable<LiveFact["offer"]> }
  | { allow: false; next: OrderNext; codes: LiveFactCode[]; offer: LiveFact["offer"] };

/** Код → шаг по Р32 п. 4. Полнота — проверка типов: новый код ядра без строки здесь не скомпилируется. */
const NEXT = {
  LIVE_UNAVAILABLE: "TELL_UNCONFIRMED",
  LIVE_INVALID: "TELL_UNCONFIRMED",
  LIVE_STALE: "TELL_UNCONFIRMED",
  LIVE_CURRENCY: "TELL_UNCONFIRMED",
  LIVE_CALL_ERROR: "TELL_UNCONFIRMED",
  LIVE_OUT_OF_STOCK: "TELL_STOCK",
  LIVE_QUANTITY: "TELL_STOCK",
  LIVE_PRICE_UP: "NEW_CART_MANDATE",
  LIVE_PRICE_DOWN: "NEW_CART_MANDATE",
} as const satisfies Record<LiveFactCode, OrderNext>;

/** Заказ — только при `ok: true` непосредственно перед ним (Р32 п. 3). Несколько кодов: неподтверждённое важнее
 *  наличия, наличие — важнее цены (новый мандат по отсутствующему товару бессмыслен). Новый мандат — только если
 *  все коды ценовые; неизвестный код (ответ вне таблицы) или пустой список — «не подтверждено» (инвариант 4). */
export function mayOrder(live: LiveFact): OrderDecision {
  if (live.ok) return { allow: true, offer: live.offer };
  const steps = live.codes.map((c): OrderNext => (Object.hasOwn(NEXT, c) ? NEXT[c] : "TELL_UNCONFIRMED"));
  const next: OrderNext =
    steps.length === 0 || steps.includes("TELL_UNCONFIRMED") ? "TELL_UNCONFIRMED" : steps.includes("TELL_STOCK") ? "TELL_STOCK" : "NEW_CART_MANDATE";
  return { allow: false, next, codes: [...live.codes], offer: live.offer };
}
