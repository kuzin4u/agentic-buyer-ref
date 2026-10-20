// Порты стадий 2–3 конвейера против витрин эмулятора продавцов на стенде Платформы (Р38 п. 8, К6; решение владельца
// 20.10.2026, вариант А). Обращения к витринам — подписанные портом подписи агента (contour.merchants).
//
// ТЕСТОВЫЙ ПРОФИЛЬ МАГАЗИНА — НЕ ДАННЫЕ ПРОДАВЦА. Из витрины эмулятора (`GET /v1/shops`, `GET /v1/shops/{id}/catalog`)
// берутся: id и код продавца, зона, sku, название, категория, цена и валюта, наличие. Всё остальное подставляет здесь
// TEST_PROFILE (помечено у каждого места): ИНН, MCC, способы оплаты, регионы доставки, условия возврата (у витрины —
// свободный текст «возврат 14 дней»: модель ждёт срок числом, текст в факты не переносится), способ, сроки и стоимость
// доставки (у витрины — текст «курьер, 1–2 дня»), время обновления карточки (`updatedAt` — часы агента). Профиль ОБЩИЙ
// для всех витрин: поведение витрин по категории и MCC (например, OUT_OF_CATEGORY) на стенде не отражается. Только в
// tests/support: в src подстановки нет, граница — tests/unit/import-graph.test.ts. Решения каталога на стенде
// (исключение, A5) доказательством не считаются: они проверены на PaoStub и фидах ядра. Передача платформе —
// kuzin4u/agentic-ps-platform#45 (к AG-09); после неё подстановку убрать.
//
// Живая проверка: у витрины нет времени ответа продавца — `checkedAt` ставится по часам агента в момент ответа, проверка
// возраста живого предложения (`LIVE_STALE`, `live_check_max_age_sec`) на стенде фактически не действует (нюанс К6 в Р38).
// Ответ витрины — данные: разбирается по схеме (инвариант 5); ответ не по схеме — отказ порта, карточка не по схеме
// (неполная — поведение INCOMPLETE) — не переведена: `dropped` с кодом REQUIRED; схема — прообраз адаптера витрин AG-09.
import { z } from "zod";
import type { CatalogFacts, CatalogProduct, CatalogShop } from "../../src/agent/catalog/index.js";
import type { LiveOffer, LiveOfferRequest, LiveOfferSource, OfferSource, ShopOffers, ShopOrder, ShopOrderRequest, ShopPort } from "../../src/agent/ports/index.js";
import type { Merchants } from "./contour.js";

const Shop = z.object({ id: z.string().min(1), merchant_id: z.string().min(1), zone: z.enum(["CONTOUR", "OUTSIDE"]) });
const Item = z.object({
  sku: z.string().min(1),
  title: z.string(),
  price: z.number().int().nonnegative(),
  currency: z.literal("RUB"),
  in_stock: z.boolean(),
  category: z.string(),
});
const Shops = z.object({ shops: z.array(Shop) });
const Catalog = z.object({ items: z.array(z.unknown()) });
const Order = z.object({ id: z.string().min(1), total: z.number().int().nonnegative(), currency: z.literal("RUB") });
type EmulatorItem = z.infer<typeof Item>;

/** ТЕСТОВЫЙ ПРОФИЛЬ: факты модели, которых витрина эмулятора не отдаёт (или отдаёт текстом). Не данные продавца. */
export const TEST_PROFILE = {
  inn: "7705123452",
  mcc: "5462",
  paymentMethods: ["card"],
  deliveryRegions: ["77"],
  returns: { days: 0, text: "Продовольственные товары надлежащего качества возврату не подлежат" },
  delivery: { method: "DELIVERY", minDays: 1, maxDays: 2, cost: 0 },
} as const;

async function get<T>(m: Merchants, path: string, schema: z.ZodType<T>): Promise<T> {
  const r = await m.request("GET", path);
  if (r.status !== 200) throw new Error(`витрина ответила ${r.status} на ${path}`);
  return schema.parse(r.body);
}

/** ТЕСТОВЫЙ ПРОФИЛЬ: доставка и `updatedAt` товара; из витрины — sku, название, категория, цена, наличие. */
function product(i: EmulatorItem, updatedAt: string): CatalogProduct {
  const price = { amount: i.price, currency: i.currency };
  const d = TEST_PROFILE.delivery;
  return {
    sku: i.sku,
    gtin: null,
    brand: null,
    model: null,
    attributes: {},
    title: i.title,
    category: i.category,
    price,
    availability: { inStock: i.in_stock },
    delivery: [{ method: d.method, minDays: d.minDays, maxDays: d.maxDays, cost: { amount: d.cost, currency: price.currency } }],
    updatedAt,
  };
}

/** Выдача по витринам эмулятора: магазин и товары — из витрины, недостающие факты модели — TEST_PROFILE. `shopOf` — sku →
 *  витрина для живой проверки; одинаковый sku у двух витрин — отказ порта (живая проверка ушла бы не туда). */
export function standOffers(m: Merchants, clock: () => Date = () => new Date()): OfferSource & { shopOf: Map<string, string> } {
  const shopOf = new Map<string, string>();
  return {
    shopOf,
    async search(): Promise<ShopOffers[]> {
      const { shops } = await get(m, "/v1/shops", Shops);
      const out: ShopOffers[] = [];
      for (const s of shops) {
        const raw = (await get(m, `/v1/shops/${s.id}/catalog`, Catalog)).items.map((x) => Item.safeParse(x));
        // карточка не по схеме (неполная — нет цены, валюты) — не переведена, как у коннектора фида: код без sku
        const items = raw.flatMap((r) => (r.success ? [r.data] : []));
        const dropped = raw.filter((r) => !r.success).map(() => "REQUIRED" as const);
        for (const i of items) {
          const other = shopOf.get(i.sku);
          if (other !== undefined && other !== s.id) throw new Error("одинаковый sku у двух витрин");
          shopOf.set(i.sku, s.id);
        }
        // ТЕСТОВЫЙ ПРОФИЛЬ: реквизиты, оплата, регионы и возврат магазина — не из витрины; id и зона — из витрины
        const p = TEST_PROFILE;
        const shop: CatalogShop = { id: s.id, inn: p.inn, mcc: p.mcc, paymentMethods: [...p.paymentMethods], deliveryRegions: [...p.deliveryRegions], returns: { ...p.returns } };
        // ТЕСТОВЫЙ ПРОФИЛЬ: время обновления карточки — часы агента (у витрины его нет)
        const updatedAt = clock().toISOString();
        const facts: CatalogFacts = { shop, shopIssues: [], products: items.map((i) => ({ product: product(i, updatedAt), issues: [], signals: [] })), dropped };
        out.push({ merchantId: s.merchant_id, inContour: s.zone === "CONTOUR", facts });
      }
      return out;
    },
  };
}

/** Живое предложение по витрине эмулятора: цена и наличие — из витрины, `checkedAt` — часы агента (у витрины его нет). */
export function standLive(m: Merchants, shopOf: Map<string, string>, clock: () => Date = () => new Date()): LiveOfferSource & { calls: LiveOfferRequest[] } {
  const src = {
    calls: [] as LiveOfferRequest[],
    async fetch(req: LiveOfferRequest): Promise<LiveOffer> {
      src.calls.push(req);
      const shop = shopOf.get(req.sku);
      if (shop === undefined) throw new Error("sku нет в выдаче");
      const items = (await get(m, `/v1/shops/${shop}/catalog`, Catalog)).items.flatMap((x) => {
        const r = Item.safeParse(x);
        return r.success ? [r.data] : [];
      });
      const i = items.find((x) => x.sku === req.sku);
      if (i === undefined) throw new Error("sku нет у витрины");
      // ТЕСТОВЫЙ ПРОФИЛЬ: время ответа продавца — часы агента
      return { sku: i.sku, price: { amount: i.price, currency: i.currency }, availability: { inStock: i.in_stock }, checkedAt: clock().toISOString() };
    },
  };
  return src;
}

/** Заказ у витрины эмулятора подписанным обращением по мандату корзины (`cart_mandate_id`); сумму считает продавец. */
export function standShop(m: Merchants): ShopPort & { calls: ShopOrderRequest[] } {
  const port = {
    calls: [] as ShopOrderRequest[],
    async order(req: ShopOrderRequest): Promise<ShopOrder> {
      port.calls.push(req);
      const r = await m.request("POST", `/v1/shops/${req.shopId}/orders`, { body: { items: req.items, cart_mandate_id: req.cartMandateId } });
      if (r.status !== 201) throw new Error(`витрина отказала в заказе: ${r.status}`);
      const b = Order.parse(r.body);
      return { orderId: b.id, total: { amount: b.total, currency: b.currency } };
    },
  };
  return port;
}
