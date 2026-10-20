// Правило каталога (Р32 п. 1–6): детерминированно, без модели (инвариант 3). На входе — факты модуля `catalog/`
// (коды), на выходе — решение кодом; тексты для человека даёт оболочка по коду.
import type { ConfirmationMode, Money } from "../../shared/domain.js";
import type { A5SignalCode, CatalogIssueCode, CatalogShop, LiveFact, LiveFactCode, ProductFacts } from "../catalog/index.js";
import type { HumanA5Decision } from "../shell/a5-decision.js";
import { isSpent, issuedByShell } from "./a5-issued.js";

export type { HumanA5Decision };

/** Товар в выдаче. `AVAILABLE` с непустым `a5` — показ с пометкой «сведения продавца противоречивы» (Р32 п. 1); продавец,
 *  `sku` и цена — то, к чему привязано решение человека (Р39 п. 5). */
export type OfferVerdict =
  | { kind: "EXCLUDED"; reason: "MODEL"; codes: CatalogIssueCode[] }
  | { kind: "EXCLUDED"; reason: "REGION" }
  | { kind: "AVAILABLE"; merchantId: string; sku: string; price: Money; a5: A5SignalCode[] };

/** Доставка в регион человека (Р32 п. 5): вариант с этим регионом, вариант без региона при регионе из профиля магазина
 *  или `PICKUP`. Регион человека неизвестен — подтверждается только самовывоз (инвариант 4). */
function reachesRegion(p: ProductFacts, shop: CatalogShop, region: string | undefined): boolean {
  return p.product.delivery.some((d) => {
    if (d.method === "PICKUP") return true;
    if (region === undefined) return false;
    return d.region === undefined ? shop.deliveryRegions.includes(region) : d.region === region;
  });
}

/** Решение по товару выдачи продавца `merchantId`. `shopIssues` непустой — исключён весь магазин (ошибки модели или
 *  разбора фида). */
export function classifyOffer(p: ProductFacts, shop: CatalogShop, shopIssues: CatalogIssueCode[], region: string | undefined, merchantId: string): OfferVerdict {
  const model = [...new Set([...shopIssues, ...p.issues])];
  if (model.length > 0) return { kind: "EXCLUDED", reason: "MODEL", codes: model };
  if (!reachesRegion(p, shop, region)) return { kind: "EXCLUDED", reason: "REGION" };
  return { kind: "AVAILABLE", merchantId, sku: p.product.sku, price: { ...p.product.price }, a5: [...p.signals] };
}

/** Покупка, для которой готовится корзина: корневой INTENT и режим подтверждения из него. */
export interface CartPurchase {
  intentId: string;
  mode: ConfirmationMode;
}

/** Решение выдано оболочкой и покрывает этот показ в этой покупке (Р39 п. 5, Р40 п. 1–2): не потрачено, тот же корневой
 *  INTENT, продавец, `sku`, цена и набор показанных кодов. */
function covers(verdict: OfferVerdict, intentId: string, decision: HumanA5Decision | undefined): decision is HumanA5Decision {
  if (verdict.kind !== "AVAILABLE" || !issuedByShell(decision) || isSpent(decision)) return false;
  return (
    decision.intentId === intentId &&
    decision.merchantId === verdict.merchantId &&
    decision.sku === verdict.sku &&
    decision.price.amount === verdict.price.amount &&
    decision.price.currency === verdict.price.currency &&
    sameSet(decision.shown, verdict.a5)
  );
}

/** Коды, которые человек принял по этому показу в этой покупке; решение не покрывает показ (`covers`) — ни одного. */
export function acceptedA5(verdict: OfferVerdict, purchase: Pick<CartPurchase, "intentId">, decision: HumanA5Decision | undefined): A5SignalCode[] {
  if (verdict.kind !== "AVAILABLE" || !covers(verdict, purchase.intentId, decision)) return [];
  return verdict.a5.filter((c) => decision.accepted.includes(c));
}

const sameSet = <T>(a: readonly T[], b: readonly T[]): boolean => new Set(a).size === new Set(b).size && a.every((x) => b.includes(x));

export type CartDraftDecision = { allow: true } | { allow: false; code: "EXCLUDED" | "A5_AUTONOMOUS" | "A5_NEEDS_HUMAN" | "A5_DECISION_STALE" };

/** Можно ли готовить проект мандата корзины (Р40 п. 3). Сумма и порог `confirm_above_kop` здесь не участвуют: решение
 *  по A5 — отдельно от подтверждения выше порога (Т7), при сумме выше порога нужны оба. Сигналы покрыты, только если
 *  человек принял все по этому же показу в этой покупке (`acceptedA5`); выданное оболочкой решение, которое показ не
 *  покрывает (потрачено, другая покупка, другой показ), — `A5_DECISION_STALE`: человеку — показ заново. */
export function mayDraftCart(verdict: OfferVerdict, purchase: CartPurchase, decision: HumanA5Decision | undefined): CartDraftDecision {
  if (verdict.kind !== "AVAILABLE") return { allow: false, code: "EXCLUDED" };
  if (verdict.a5.length === 0) return { allow: true };
  if (purchase.mode === "AUTONOMOUS") return { allow: false, code: "A5_AUTONOMOUS" };
  if (issuedByShell(decision) && !covers(verdict, purchase.intentId, decision)) return { allow: false, code: "A5_DECISION_STALE" };
  return acceptedA5(verdict, purchase, decision).length === verdict.a5.length ? { allow: true } : { allow: false, code: "A5_NEEDS_HUMAN" };
}

/** Что дальше после отказа живой проверки (Р32 п. 4). Автоматического повтора нет ни в одном случае (инвариант 9). */
export type OrderNext =
  /** предложение не подтверждено — продавцом или из-за сбоя проверки (LIVE_CALL_ERROR); текст человеку — по коду из реестра (Р36 п. 4) */
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
