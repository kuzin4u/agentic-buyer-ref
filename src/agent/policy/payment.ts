// Проверки до стадий 4–5 (Р39 п. 1): детерминированно, без модели и сети (инвариант 3). Порядок — подмножество порядка
// ADP Платформы, применимое к агенту: пакет, на который ADP заведомо откажет, продавцу не уходит. Остаток и статус — из
// verify (инвариант 6): политика их сравнивает, но не вычисляет.
import type { Mandate, MandateCheck, Money } from "../../shared/domain.js";

/** Факты покупки перед оплатой: снимки мандатов, продавец заказа и итог CART. */
export interface PaymentFacts {
  intent: Mandate;
  cart: Mandate;
  merchantId: string;
  total: Money;
}

/** Порог подтверждения (Р39 п. 1.5): рыночный — из конфигурации; клиентский порог эмитента — когда появится канал в ПАО
 *  (STATUS «Открыто»), до того не задан. */
export interface Thresholds {
  marketKop: number;
  clientKop?: number;
}

export type PaymentRefusal = "MANDATE_OUT_OF_SCOPE" | "MANDATE_AMOUNT_LEFT_INSUFFICIENT" | "CURRENCY_NOT_SUPPORTED" | "SPLIT_WINDOW";

/** Отказ — с мандатом, по которому он вышел (для записи журнала); у отказа по покупке целиком мандата нет. */
export type PaymentDecision = { allow: true } | { allow: false; code: PaymentRefusal; mandate?: Mandate };

/** Меньшее из рыночного и клиентского порога (#37 п. 4). */
export function confirmThreshold(t: Thresholds): number {
  return t.clientKop === undefined ? t.marketKop : Math.min(t.marketKop, t.clientKop);
}

/** Р39 п. 1.4: итог не в RUB — оплаты нет (у ADP — STATE_UNAVAILABLE). */
export function currencySupported(total: Money): boolean {
  return total.currency === "RUB";
}

/** Т7: итог строго выше порога — стадия 4. Иная валюта сюда не доходит (`currencySupported`). */
export function needsConfirmation(total: Money, t: Thresholds): boolean {
  return total.amount > confirmThreshold(t);
}

/** Р39 п. 1.1–1.2 по одному мандату — сразу после его verify: CONFIRMED, `amount_left` > 0 и в валюте итога (иначе вне
 *  пределов: Р35, ПАО §3; суммы в разных валютах не сравниваются; инвариант 4); остаток не меньше итога (К4а; у CART
 *  после PS-10 — меньшее из CART и родителя, #36). Только отказ или «дальше»: разрешения по одному мандату нет — его
 *  даёт `mayAuthorize`. */
export function mandateRefusal(m: Mandate, c: MandateCheck, total: Money): Extract<PaymentDecision, { allow: false }> | null {
  if (c.outcome !== "CONFIRMED" || c.amountLeft.amount <= 0 || c.amountLeft.currency !== total.currency) return { allow: false, code: "MANDATE_OUT_OF_SCOPE", mandate: m };
  if (c.amountLeft.amount < total.amount) return { allow: false, code: "MANDATE_AMOUNT_LEFT_INSUFFICIENT", mandate: m };
  return null;
}

/** Р39 п. 1.1–1.3, по порядку и по полному набору фактов: проверки 1–2 по каждому мандату (INTENT раньше CART), затем
 *  продавец и валюта итога — в пределах обоих (как MANDATE_SCOPE у ADP). Первый отказ — ответ. */
export function mayAuthorize(f: PaymentFacts, checks: { intent: MandateCheck; cart: MandateCheck }): PaymentDecision {
  for (const [m, c] of [[f.intent, checks.intent], [f.cart, checks.cart]] as const) {
    const refused = mandateRefusal(m, c, f.total);
    if (refused !== null) return refused;
  }
  for (const m of [f.intent, f.cart]) {
    if (!m.merchantScope.includes(f.merchantId) || m.amountLimit.currency !== f.total.currency) return { allow: false, code: "MANDATE_OUT_OF_SCOPE", mandate: m };
  }
  return { allow: true };
}
