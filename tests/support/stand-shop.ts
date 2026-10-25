// Адаптер витрин (src/agent/adapters/shops, Р42) против эмулятора продавцов на стенде Платформы: подпись — действующим
// ключом агента контура, журнал — журнал контура. Факты модели каталога (ИНН, MCC, оплата, регионы, возврат, доставка,
// время обновления, GTIN) — из витрин эмулятора (kuzin4u/agentic-ps-platform#45, Р54 п. 4); тестового профиля магазина
// больше нет — решения каталога на стенде опираются на факты продавца.
import { ShopsAdapter } from "../../src/agent/adapters/shops/index.js";
import type { HttpRequestSigning } from "../../src/agent/ports/index.js";
import type { Contour } from "./contour.js";

/** Адаптер витрин стенда: как compose.shops, но на подписи и журнале контура. */
/** `signing` — подпись не ключом агента контура (ключ не из реестра — настоящий отказ витрины, П08). */
export function standShops(c: Contour, o: { fetch?: typeof fetch; signing?: HttpRequestSigning } = {}): ShopsAdapter {
  const signing = o.signing ?? c.shopSigning;
  if (!c.merchants || !signing || !c.paoAccess) throw new Error("контур без витрин");
  return new ShopsAdapter({
    baseUrl: c.merchants.baseUrl,
    agentCode: c.agentCode,
    signing,
    platform: c.paoAccess,
    params: c.params,
    journal: c.journal,
    ...(o.fetch !== undefined && { fetch: o.fetch }),
  });
}
