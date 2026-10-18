// Каталог продавца (Р32): единственный вход `/catalog` ядра в src (граница — tests/support/import-graph.ts).
// Модуль только собирает типизированные факты — коды `CatalogIssue`, `A5Signal`, `LiveCheckCode`; решает `policy/`
// (инвариант 3). Текст фида и ответа продавца — данные (инвариант 5): наружу идут коды, а не тексты и пути из фида.
import {
  checkLiveOffer,
  checkProductA5,
  checkShopA5,
  parseYml,
  validateProduct,
  validateShop,
  type A5SignalCode,
  type CatalogIssueCode,
  type CatalogProduct,
  type CatalogShop,
  type LiveCheckCode,
} from "@kuzin4u/agentic-core/catalog";
import type { StandParams } from "../../shared/config.js";
import type { LiveOffer, LiveOfferRequest, LiveOfferSource } from "../ports/index.js";

export type { A5SignalCode, CatalogIssueCode, CatalogProduct, CatalogShop, LiveCheckCode };

/** Товар после проверок: ошибки модели (`issues`) и сигналы A5 товара и магазина (`signals`) — только коды. */
export interface ProductFacts {
  product: CatalogProduct;
  issues: CatalogIssueCode[];
  signals: A5SignalCode[];
}

/** Магазин и товары фида. `shopIssues` — разбор фида и магазина (`XML_*`, дата фида, варианты доставки магазина)
 *  и `validateShop`: непустой — исключается весь магазин. `dropped` — коды предложений, которые коннектор не перевёл
 *  (в `products` их нет). */
export interface CatalogFacts {
  shop: CatalogShop | null;
  shopIssues: CatalogIssueCode[];
  products: ProductFacts[];
  dropped: CatalogIssueCode[];
}

/** `exponent` — знаков после запятой у валюты цены (таблицы в ядре нет, К9); `offset` — пояс для даты фида без него. */
export interface FeedOptions {
  exponent: number;
  offset?: string;
}

/** Путь ошибки предложения у коннектора; остальные ошибки разбора — уровня фида и магазина. */
const OFFER_PATH = "/yml_catalog/shop/offers/offer[";

const codes = <C extends string>(xs: { code: C }[]): C[] => [...new Set(xs.map((x) => x.code))];

/** Фид YML → факты. `profile` — профиль магазина от потребителя (ИНН, MCC, регионы, возврат: в YML их нет). */
export function readFeed(input: string | Uint8Array, profile: CatalogShop, opts: FeedOptions): CatalogFacts {
  const r = parseYml(input, profile, opts);
  if (r.shop === null) return { shop: null, shopIssues: codes(r.issues), products: [], dropped: [] };
  const shop = r.shop;
  const offerIssues = r.issues.filter((i) => i.path.startsWith(OFFER_PATH));
  const shopIssues = codes([...r.issues.filter((i) => !i.path.startsWith(OFFER_PATH)), ...validateShop(shop)]);
  const shopSignals = shopIssues.length === 0 ? codes(checkShopA5(shop)) : [];
  const products = r.products.map((product): ProductFacts => {
    const issues = codes(validateProduct(product, shop));
    // A5 — только по товару, прошедшему модель: ядро считает данные уже проверенными
    const signals = issues.length === 0 ? [...new Set([...shopSignals, ...codes(checkProductA5(product, opts.exponent))])] : [];
    return { product, issues, signals };
  });
  return { shop, shopIssues, products, dropped: codes(offerIssues) };
}

/** Параметры живой проверки — из конфигурации, все три явно (Р32 п. 7; ревью К1.2а № 3): умолчаний ядра нет. */
export type LiveCheckParams = Pick<StandParams, "live_check_timeout_ms" | "live_check_max_age_sec" | "live_check_clock_skew_sec">;

/** Ошибка вызова проверки (не тот `sku`, неверное количество) — код агента: заказа нет так же, как при `LIVE_*`. */
export type LiveFactCode = LiveCheckCode | "LIVE_CALL_ERROR";

export type LiveFact = { ok: true; offer: LiveOffer } | { ok: false; codes: LiveFactCode[]; offer: LiveOffer | null };

/** Живая проверка непосредственно перед заказом (Р32 п. 3): один вызов источника, без повторов (инвариант 9). */
export async function liveCheck(
  product: CatalogProduct,
  req: LiveOfferRequest,
  source: LiveOfferSource,
  params: LiveCheckParams,
  now?: () => number,
): Promise<LiveFact> {
  try {
    return await checkLiveOffer(product, req, source, {
      timeoutMs: params.live_check_timeout_ms,
      maxAgeMs: params.live_check_max_age_sec * 1000,
      clockSkewMs: params.live_check_clock_skew_sec * 1000,
      ...(now ? { now } : {}),
    });
  } catch {
    return { ok: false, codes: ["LIVE_CALL_ERROR"], offer: null };
  }
}
