// Тестовые порты стадий конвейера (Р38 п. 8): выдача из фида YML (tests/fixtures) — до AG-09 (подписанные обращения
// к витринам). Не поведение продавца, а подготовленные факты `catalog/readFeed`.
import { readFileSync } from "node:fs";
import { readFeed, type CatalogShop } from "../../src/agent/catalog/index.js";
import type { OfferSource, ShopOffers } from "../../src/agent/ports/index.js";

export const BAKERY_FEED = readFileSync(new URL("../fixtures/massa-madre.yml", import.meta.url), "utf8");

export const bakery = (over: Partial<CatalogShop> = {}): CatalogShop => ({
  id: "massa-madre",
  inn: "7705123452",
  mcc: "5462",
  paymentMethods: ["sbp", "card"],
  deliveryRegions: ["77"],
  returns: { days: 0, text: "Продовольственные товары надлежащего качества возврату не подлежат" },
  ...over,
});

export interface FeedShop {
  feed: string;
  profile: CatalogShop;
  merchantId: string;
  inContour?: boolean;
}

/** Выдача из фидов; `calls` — сколько раз спросили (обращений до ворот быть не должно). */
export function feedOffers(...shops: FeedShop[]): OfferSource & { calls: number } {
  const src = {
    calls: 0,
    search: async (): Promise<ShopOffers[]> => {
      src.calls++;
      return shops.map((s) => ({
        merchantId: s.merchantId,
        inContour: s.inContour ?? true,
        facts: readFeed(s.feed, s.profile, { exponent: 2, offset: "+03:00" }),
      }));
    },
  };
  return src;
}
