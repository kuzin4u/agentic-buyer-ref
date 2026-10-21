// Адаптер витрин (src/agent/adapters/shops, Р42) против эмулятора продавцов на стенде Платформы: подпись — действующим
// ключом агента контура, журнал — журнал контура.
//
// ТЕСТОВЫЙ ПРОФИЛЬ МАГАЗИНА — НЕ ДАННЫЕ ПРОДАВЦА (Р42 п. 2, Р38 нюанс К6). Витрина эмулятора не отдаёт ИНН, MCC, способы
// оплаты, регионы доставки, срок возврата числом, доставку числами и время обновления карточки — их подставляет здесь
// TEST_PROFILE, общий для всех витрин (поведение по категории и MCC, например OUT_OF_CATEGORY, на стенде не отражается).
// Только в tests/support: в src подстановки нет, профиль адаптер получает от места сборки. Решения каталога на стенде по
// этим фактам доказательством не считаются; из витрины по-настоящему — id, код продавца, зона и знак, sku, название,
// описание, категория, цена, валюта, наличие. После kuzin4u/agentic-ps-platform#45 — убрать.
import { ShopsAdapter, type ShopProfile } from "../../src/agent/adapters/shops/index.js";
import type { HttpRequestSigning } from "../../src/agent/ports/index.js";
import type { Contour } from "./contour.js";

/** ТЕСТОВЫЙ ПРОФИЛЬ: факты модели, которых витрина эмулятора не отдаёт (или отдаёт текстом). Не данные продавца. */
export const TEST_PROFILE = {
  inn: "7705123452",
  mcc: "5462",
  paymentMethods: ["card"],
  deliveryRegions: ["77"],
  returns: { days: 0, text: "Продовольственные товары надлежащего качества возврату не подлежат" },
  delivery: { method: "DELIVERY", minDays: 1, maxDays: 2, cost: 0 },
} as const;

/** ТЕСТОВЫЙ ПРОФИЛЬ магазина: время обновления карточки — часы агента (у витрины его нет). */
export function testProfile(clock: () => Date = () => new Date()): ShopProfile {
  const p = TEST_PROFILE;
  return {
    shop: { inn: p.inn, mcc: p.mcc, paymentMethods: [...p.paymentMethods], deliveryRegions: [...p.deliveryRegions], returns: { ...p.returns } },
    item: () => ({
      delivery: [{ method: p.delivery.method, minDays: p.delivery.minDays, maxDays: p.delivery.maxDays, cost: { amount: p.delivery.cost, currency: "RUB" } }],
      updatedAt: clock().toISOString(),
    }),
  };
}

/** Адаптер витрин стенда: как compose.shops, но на подписи и журнале контура. */
/** `signing` — подпись не ключом агента контура (ключ не из реестра — настоящий отказ витрины, П08). */
export function standShops(c: Contour, o: { profile?: (shopId: string) => ShopProfile | null; fetch?: typeof fetch; signing?: HttpRequestSigning } = {}): ShopsAdapter {
  const signing = o.signing ?? c.shopSigning;
  if (!c.merchants || !signing) throw new Error("контур без витрин");
  const profile = testProfile();
  return new ShopsAdapter({
    baseUrl: c.merchants.baseUrl,
    agentCode: c.agentCode,
    signing,
    params: c.params,
    profile: o.profile ?? (() => profile),
    journal: c.journal,
    ...(o.fetch !== undefined && { fetch: o.fetch }),
  });
}
