// Адаптер витрин продавцов (Р42): порты стадий 2–3 `OfferSource`, `LiveOfferSource`, `ShopPort` по API витрин эмулятора
// (К6, Р26): `GET /v1/shops`, `GET /v1/shops/{id}/catalog`, `POST /v1/shops/{id}/orders`; пакет агентской оплаты —
// `POST /v1/shops/{id}/orders/{order_id}/payment` (Р45 п. 4).
// Каждое обращение подписано портом подписи места сборки (A2 п. 5.1, Т4); подпись остановлена — исключение порта, обращения
// нет (инвариант 4). Ответ витрины — данные: берутся только поля схемы, текст описания — только в `description` для
// сверки с ценой (инвариант 5, Т5а). Отказ витрины — без обходов: ни без подписи, ни другим ключом; повтор — только
// `GET` с повторяемым кодом, один раз, тот же запрос с новой подписью (витрина отклоняет повторный x-nonce).
// Факты модели каталога (К8) — из витрины (Р54 п. 4, kuzin4u/agentic-ps-platform#45): магазин — из записи списка (ИНН,
// MCC, оплата, регионы, возврат), товар — доставка, время обновления, GTIN, бренд, модель, атрибуты; перевод snake_case в
// модель — здесь, проверки значений — ядро (`validateShop` / `validateProduct`). Факты магазина не по схеме — магазин
// исключён целиком. GTIN — данные модели: в журнал не пишется и через сканер номеров карт (`order_ref`) не проходит.
// `checkedAt` живого предложения — по часам агента (Р38 нюанс К6; свежесть по `responded_at` — Р54 п. 6).
// Знак готовности продавца — по ПАО, одной функцией `readiness` (Р53): зона контура — только при ACTIVE; поля витрины
// `zone` и `readiness_mark` — сведения; знак не проверен — витрина недоступна (READINESS_UNAVAILABLE).
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readShop, type CatalogFacts, type CatalogIssueCode, type CatalogProduct, type CatalogShop } from "../../catalog/index.js";
import type { Journal, JournalResult } from "../../journal/index.js";
import type { LiveOffer, LiveOfferRequest, LiveOfferSource } from "../../ports/catalog.js";
import type { HttpRequestSigning, RequestSigning } from "../../ports/request-signing.js";
import { AGENT_STOP_CODES, ruleForFailure } from "../../declines/index.js";
import {
  ShopFailure,
  type OfferSource,
  type ShopOffers,
  type ShopOrder,
  type ShopOrderRequest,
  type ShopPaymentPort,
  type ShopPaymentReply,
  type ShopPaymentRequest,
  type Readiness,
  type ShopPort,
  type ShopUnavailable,
  type ShopUnavailableCause,
} from "../../ports/shop.js";
import { openPackage } from "../../payment-package/package.js";
import type { StandParams } from "../../../shared/config.js";
import { PlatformFailure, type FailureCode } from "../../../shared/domain.js";
import { MERCHANT_ID, SAFE_ID, SHOP_ID } from "../../../shared/ids.js";
import { ORDER_REF } from "../../payment-package/order-ref.js";
import { MERCHANT_RETRYABLE, isMerchantCode } from "./codes.js";

export type ShopsParams = Pick<
  StandParams,
  "shop_request_timeout_ms" | "shop_retry_after_max_sec" | "shop_retry_default_ms" | "shop_search_deadline_ms" | "pao_request_timeout_ms"
>;

export interface ShopsAdapterOptions {
  baseUrl: string;
  agentCode: string;
  signing: HttpRequestSigning;
  /** знак готовности по ПАО (Р53 п. 1, 5): адрес Платформы и порт подписи модуля signer — остановка подписи и смена ключа
   *  по отказу Платформы (kid — у `current()`); сам запрос подписывает `signing` (тот же ключ и профиль ПАО §2);
   *  `fetch` — по умолчанию `fetch` адаптера (тот же, что у витрин) */
  platform: { baseUrl: string; signing: RequestSigning; fetch?: typeof fetch };
  params: ShopsParams;
  /** попытки обращений (shop.call, Т15) */
  journal: Journal;
  now?: () => Date;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Идентификатор от витрины — в путь и в журнал только по маске (как sku у конвейера, Р38 п. 5). */
const Id = z.string().regex(SHOP_ID);
/** Код продавца — до 128 знаков, как у ПАО (Р54 п. 1). */
const MerchantId = z.string().regex(MERCHANT_ID);
/** Номер заказа продавца — по маске ссылки агента, одно правило с Платформой (128; Р46 п. 1, выбор 1а). */
const OrderId = z.string().regex(ORDER_REF);
/** Знаков после запятой у валюты цены: таблицы в ядре нет (К9); витрина эмулятора — только RUB (ISO 4217). */
const EXPONENT = { RUB: 2 } as const;

/** Список витрин — массив; каждая запись разбирается отдельно (ревью КТ1 п. 1): зона и знак не по схеме — зона рынка,
 *  id или код продавца не по маске — витрина недоступна; отказ стадии — только если списка нет целиком. */
const Shops = z.object({ shops: z.array(z.unknown()) });
const ShopEntry = z.object({ id: Id, merchant_id: MerchantId });
const Zone = z.object({ zone: z.literal("CONTOUR"), readiness_mark: z.literal(true) });
const Currency = z.enum(Object.keys(EXPONENT) as [keyof typeof EXPONENT]);
/** Факты магазина из записи списка (Р54 п. 4): все пять обязательны; значения проверяет ядро (`validateShop`). */
const ShopFacts = z.object({
  inn: z.string(),
  mcc: z.string(),
  payment_methods: z.array(z.string()),
  delivery_regions: z.array(z.string()),
  returns: z.object({ days: z.number().int().nonnegative(), text: z.string() }),
});
const Catalog = z.object({ items: z.array(z.unknown()) });
/** Вариант доставки: `method` — строкой, перечень проверяет ядро (`BAD_METHOD`, как у фида; ревью КТ1 № 1). */
const Delivery = z.object({
  method: z.string(),
  region: z.string().optional(),
  min_days: z.number().int().nonnegative(),
  max_days: z.number().int().nonnegative(),
  cost: z.number().int().nonnegative(),
  currency: Currency,
});
/** Поля живой проверки: цена и наличие (Р32 п. 3). */
const LiveItem = z.object({ sku: Id, price: z.number().int().nonnegative(), currency: Currency, in_stock: z.boolean() });
/** Карточка выдачи (Р54 п. 4): доставка и время обновления обязательны; GTIN, бренд, модель — нет поля — `null`, атрибутов
 *  нет — `{}`. */
const Item = LiveItem.extend({
  title: z.string(),
  description: z.string().optional(),
  category: z.string(),
  delivery_options: z.array(Delivery),
  updated_at: z.string(),
  gtin: z.string().nullable().optional(),
  brand: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  attributes: z.record(z.string(), z.string()).optional(),
});
type ShopItem = z.infer<typeof Item>;
const Order = z.object({ id: OrderId, total: z.number().int().nonnegative(), currency: z.enum(Object.keys(EXPONENT) as [keyof typeof EXPONENT]) });
/** Ответ на оплату — заказ продавца: статус после авторизации у эквайрера (слова продавца, не итог — инвариант 8). */
const Paid = z.object({ id: OrderId, status: z.enum(["PAID", "DECLINED", "REJECTED"]) });

type Method = "GET /v1/shops" | "GET /v1/shops/{id}/catalog" | "POST /v1/shops/{id}/orders" | "POST /v1/shops/{id}/orders/{order_id}/payment";

/** Путь знака готовности (Р53 п. 1): в YAML ПАО 1.4.0 его нет — описан вручную, с ПАО 1.5.0 — из YAML (#37 платформы). */
const READINESS = "GET /pao/v1/merchants/{merchant_id}/readiness";
const ReadinessReply = z.object({ merchant_id: z.string(), status: z.enum(["ACTIVE", "SUSPENDED", "NONE"]), since: z.string().nullable() });

/** Отказы пути знака (ПАО §2 — подпись, допуск, частота и источник ключей; §4 — знак готовности; передача #67): код → HTTP-статус. Пути нет в YAML,
 *  перечень `x-pao-errors` описан здесь вместе с путём (Р53 п. 1); типы ПАО ядра — только у адаптера pao (Р19). */
const READINESS_ERRORS: Readonly<Partial<Record<FailureCode, number>>> = {
  AGENT_UNKNOWN: 401,
  AGENT_KEY_REVOKED: 401,
  SIGNATURE_INVALID: 401,
  AGENT_SUSPENDED: 403,
  REQUEST_INVALID: 400,
  STATE_UNAVAILABLE: 503,
  // слой допуска ПАО на любом пути: сбой источника ключей и ограничение частоты
  UPSTREAM_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
};

/** Код ПАО из тела отказа — только из перечня пути и с его HTTP-статусом; иначе null (как в адаптере pao: пара не по
 *  контракту — не код). */
function paoCode(status: number, body: unknown): FailureCode | null {
  const raw = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
  return typeof raw === "string" && Object.hasOwn(READINESS_ERRORS, raw) && READINESS_ERRORS[raw as FailureCode] === status ? (raw as FailureCode) : null;
}

/** Итог обращения: ответ с телом (JSON или нет) либо нет ответа в срок. */
type Reply = { status: number; body: unknown; retryAfter: string | null } | null;

type Outcome<T> = { ok: true; body: T } | { ok: false; cause: ShopUnavailableCause; retry: number | null };

/** Пауза, которую прерывает `signal` (живая проверка — по тайм-ауту ядра). */
const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });

/** Карточка или факты магазина не по схеме (Р42 п. 6, Р54 п. 4) — по полному пути каждой ошибки, на любой глубине
 *  (ревью КТ1 reviewer № 1): поля нет (или `null`) — REQUIRED, иначе последний сегмент `currency` — BAD_CURRENCY, иначе
 *  BAD_TYPE. */
function dropCode(raw: unknown, issues: z.core.$ZodIssue[]): CatalogIssueCode {
  const at = (path: PropertyKey[]): unknown =>
    path.reduce<unknown>((v, k) => (typeof v === "object" && v !== null ? (v as Record<PropertyKey, unknown>)[k] : undefined), raw);
  if (issues.some((i) => at(i.path) == null)) return "REQUIRED";
  return issues.some((i) => i.path.at(-1) === "currency") ? "BAD_CURRENCY" : "BAD_TYPE";
}

/** Общий срок стадии поиска (Р44 п. 6). */
interface Deadline {
  signal: AbortSignal;
  left: () => number;
}

const DEADLINE: ShopUnavailableCause = { reason: "SHOP_SEARCH_DEADLINE" };

export class ShopsAdapter implements OfferSource, LiveOfferSource, ShopPort, ShopPaymentPort {
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** sku → витрина для живой проверки по всем выдачам этого адаптера (не только последней: адаптер может обслуживать
   *  несколько покупок, ревью К1 Б1); null — sku хоть раз был у двух витрин: проверка не идёт (fail-closed) */
  readonly #shopOf = new Map<string, string | null>();

  constructor(private readonly o: ShopsAdapterOptions) {
    this.now = o.now ?? (() => new Date());
    this.fetchImpl = o.fetch ?? fetch;
    this.sleep = o.sleep ?? pause;
  }

  /** Стадия 2. Список витрин не получен или не по схеме — ShopFailure SHOP_LIST_UNAVAILABLE (Р46 п. 2), остановка сделки.
   *  Витрина отказала в каталоге — магазин недоступен, остальные витрины — дальше. Общий срок стадии — `shop_search_deadline_ms` с начала поиска (Р44
   *  п. 6): по истечении к оставшимся витринам не обращаются, идущее обращение прерывается, ожидание повтора не меньше остатка
   *  не начинается — магазин недоступен с кодом SHOP_SEARCH_DEADLINE. */
  async search(): Promise<(ShopOffers | ShopUnavailable)[]> {
    const deadline = this.#deadline();
    const list = await this.#get("GET /v1/shops", "/v1/shops", Shops, undefined, undefined, deadline);
    if (!list.ok) throw new ShopFailure("SHOP_LIST_UNAVAILABLE");
    const out: (ShopOffers | ShopUnavailable)[] = [];
    for (const entry of list.body.shops) {
      const parsed = ShopEntry.safeParse(entry);
      if (!parsed.success) {
        // идентификатора по маске нет — обратиться к витрине нельзя; в журнал — без id (инвариант 5)
        out.push({ unavailable: { detail: "BAD_RESPONSE" } });
        continue;
      }
      const s = parsed.data;
      if (deadline.left() <= 0) {
        out.push({ shopId: s.id, merchantId: s.merchant_id, unavailable: DEADLINE });
        continue;
      }
      // знак — до каталога (Р53 п. 3–4): не проверен — витрина недоступна, каталог не запрашивается; отказ по агенту
      // (PlatformFailure) — наружу, поиск остановлен
      let mark: Readiness;
      try {
        mark = await this.readiness(s.merchant_id, deadline.signal);
      } catch (e) {
        if (!deadline.signal.aborted || e !== deadline.signal.reason) throw e;
        // запрос ушёл в сеть, ответа нет — в журнал обращений (Т15) с причиной срока
        this.#record("shop.readiness", s.merchant_id, undefined, "unknown", "SHOP_SEARCH_DEADLINE");
        out.push({ shopId: s.id, merchantId: s.merchant_id, unavailable: DEADLINE });
        continue;
      }
      if (mark.unverified !== undefined) {
        out.push({ shopId: s.id, merchantId: s.merchant_id, unavailable: { reason: "READINESS_UNAVAILABLE" } });
        continue;
      }
      // зона контура — только при ACTIVE по ПАО; зона и знак витрины — сведения: расхождение — в журнал, без действия
      const inContour = mark.status === "ACTIVE";
      const says = Zone.safeParse(entry).success;
      if (says !== inContour) this.#record("shop.readiness_mismatch", s.merchant_id, `${mark.status}:${says ? "CONTOUR" : "MARKET"}`);
      const catalog = await this.#get("GET /v1/shops/{id}/catalog", `/v1/shops/${s.id}/catalog`, Catalog, s.id, undefined, deadline);
      if (!catalog.ok) {
        out.push({ shopId: s.id, merchantId: s.merchant_id, unavailable: catalog.cause });
        continue;
      }
      const items: ShopItem[] = [];
      const dropped: CatalogIssueCode[] = [];
      for (const raw of catalog.body.items) {
        const i = Item.safeParse(raw);
        if (i.success) items.push(i.data);
        else dropped.push(dropCode(raw, i.error.issues));
      }
      const facts = this.#facts(s.id, entry, items, dropped);
      // запись не стирается: sku, найденный у другой витрины в любой выдаче, становится неоднозначным навсегда; магазин,
      // исключённый по фактам, sku не регистрирует — иначе он делал бы неоднозначным sku исправной витрины (ревью КТ1 № 3)
      if (facts.shop !== null) for (const i of items) this.#shopOf.set(i.sku, this.#shopOf.has(i.sku) && this.#shopOf.get(i.sku) !== s.id ? null : s.id);
      out.push({
        merchantId: s.merchant_id,
        inContour,
        facts,
        ...(!inContour && { link: `${this.o.baseUrl}/v1/shops/${s.id}/catalog` }),
      });
    }
    return out;
  }

  /** Знак готовности продавца по ПАО (Р53) — единственное место, где агент его берёт: подписанный
   *  `GET /pao/v1/merchants/{merchant_id}/readiness` (ПАО §2, пустое тело), без кэша у агента (ответ Платформы — `no-store`)
   *  и без повтора, тайм-аут `pao_request_timeout_ms`. Подпись остановлена — исключение, обращения нет. Отказ по агенту —
   *  общим правилом обращений к ПАО (Р53 п. 5): код из `AGENT_STOP_CODES` — остановка подписи, `AGENT_KEY_REVOKED` — смена
   *  ключа; затем PlatformFailure наружу (сделка STOPPED тем же кодом); 401 без кода по перечню — BAD_RESPONSE. Другого
   *  действующего ключа нет — `keyRevoked` сам бросает SignerStopped (`NO_ACTIVE_KEY`), он и уходит наружу. Нет ответа, прочий
   *  отказ (400, 414, 503 …), ответ не по схеме, чужой merchant_id, merchant_id не по маске (без обращения) — «знак не
   *  проверен» (Р53 п. 4). */
  async readiness(merchantId: string, signal?: AbortSignal): Promise<Readiness> {
    if (!MERCHANT_ID.test(merchantId)) {
      this.#record("shop.readiness", undefined, "PATTERN", "refused");
      return { unverified: "PATTERN" };
    }
    const path = `/pao/v1/merchants/${merchantId}/readiness`;
    // подпись — тем же портом, что у витрин (действующий ключ, профиль ПАО §2; Р53 п. 1): остановлена — исключение,
    // обращения нет; kid — для смены ключа по AGENT_KEY_REVOKED (Р53 п. 5)
    const { kid } = this.o.platform.signing.current();
    const signed = this.o.signing.sign({ method: "GET", path, query: "", headers: this.#headers(), body: "" });
    const reply = await this.#request(this.o.platform.fetch ?? this.fetchImpl, `${this.o.platform.baseUrl}${path}`, "GET", signed.headers, undefined, this.o.params.pao_request_timeout_ms, signal);
    if (reply === null) {
      this.#record("shop.readiness", merchantId, "NO_RESPONSE", "unknown");
      return { unverified: "NO_RESPONSE" };
    }
    if (reply.status === 200) {
      const b = ReadinessReply.safeParse(reply.body);
      if (!b.success || b.data.merchant_id !== merchantId) {
        this.#record("shop.readiness", merchantId, "BAD_RESPONSE", "refused");
        return { unverified: "BAD_RESPONSE" };
      }
      this.#record("shop.readiness", merchantId, b.data.status, "ok");
      return { status: b.data.status };
    }
    const code = paoCode(reply.status, reply.body);
    if (reply.status === 401 || (code !== null && AGENT_STOP_CODES.has(code))) {
      const failure = new PlatformFailure(code ?? "BAD_RESPONSE", ruleForFailure(code ?? "BAD_RESPONSE").retry, code, reply.status, null, "знак готовности: отказ по агенту");
      this.#record("shop.readiness", merchantId, code ?? "BAD_RESPONSE", "refused");
      if (code !== null && AGENT_STOP_CODES.has(code)) this.o.platform.signing.stop(code);
      else if (code !== null && ruleForFailure(code).action === "ROTATE_KEY") this.o.platform.signing.keyRevoked(kid, failure);
      throw failure;
    }
    const detail = code ?? `HTTP_${reply.status}`;
    this.#record("shop.readiness", merchantId, detail, "refused");
    return { unverified: detail };
  }

  /** Живое предложение перед заказом: цена и наличие — из каталога витрины, `checkedAt` — часы агента (#45). Отказ —
   *  исключение: у конвейера это LIVE_CALL_ERROR или LIVE_UNAVAILABLE, заказа нет. */
  async fetch(req: LiveOfferRequest, signal: AbortSignal): Promise<LiveOffer> {
    const shop = this.#shopOf.get(req.sku);
    if (shop === undefined || shop === null) throw new Error("sku нет в выдаче или он у двух витрин");
    const catalog = await this.#get("GET /v1/shops/{id}/catalog", `/v1/shops/${shop}/catalog`, Catalog, shop, signal);
    if (!catalog.ok) throw new Error("витрина не ответила на живую проверку или ответ не по схеме");
    const i = catalog.body.items.flatMap((x) => {
      const p = LiveItem.safeParse(x);
      return p.success && p.data.sku === req.sku ? [p.data] : [];
    })[0];
    if (i === undefined) throw new Error("sku нет у витрины");
    return { sku: i.sku, price: { amount: i.price, currency: i.currency }, availability: { inStock: i.in_stock }, checkedAt: this.now().toISOString() };
  }

  /** Стадия 3: заказ по мандату корзины; не повторяется никогда (у витрины нет ключа идемпотентности заказа, инвариант 9).
   *  Отказ витрины — SHOP_ORDER_REFUSED; нет ответа в срок или ответ не по схеме — SHOP_ORDER_STATE_UNKNOWN. */
  async order(req: ShopOrderRequest): Promise<ShopOrder> {
    const method: Method = "POST /v1/shops/{id}/orders";
    if (!SHOP_ID.test(req.shopId)) throw new Error("id витрины не по маске");
    const reply = await this.#send("POST", `/v1/shops/${req.shopId}/orders`, JSON.stringify({ items: req.items, cart_mandate_id: req.cartMandateId }));
    if (reply === null) {
      this.#log(method, 1, "unknown", req.shopId, { detail: "NO_RESPONSE" }, req.cartMandateId);
      throw new ShopFailure("SHOP_ORDER_STATE_UNKNOWN");
    }
    if (reply.status >= 400) {
      this.#log(method, 1, "refused", req.shopId, this.#cause(reply.body), req.cartMandateId);
      throw new ShopFailure("SHOP_ORDER_REFUSED");
    }
    const b = reply.status === 201 ? Order.safeParse(reply.body) : null;
    if (!b?.success) {
      this.#log(method, 1, "unknown", req.shopId, { detail: "BAD_RESPONSE" }, req.cartMandateId);
      throw new ShopFailure("SHOP_ORDER_STATE_UNKNOWN");
    }
    this.#log(method, 1, "ok", req.shopId, undefined, req.cartMandateId);
    return { orderId: b.data.id, total: { amount: b.data.total, currency: b.data.currency } };
  }

  /** Стадия 5: пакет агентской оплаты продавцу (Р45 п. 4) — подписанным обращением, `content-digest` покрывает тело
   *  (подпись пакета, ПАО §4); не повторяется (как заказ). Тело — только в запросе: в журнал, исключения и сообщения оно не
   *  попадает. Отказ витрины — SHOP_ORDER_REFUSED; нет ответа в срок или ответ не по схеме — SHOP_ORDER_STATE_UNKNOWN. Статус
   *  заказа из ответа — detail записи shop.call: это слова продавца, а не итог операции (инвариант 8). */
  async pay(req: ShopPaymentRequest): Promise<ShopPaymentReply> {
    const method: Method = "POST /v1/shops/{id}/orders/{order_id}/payment";
    if (!SHOP_ID.test(req.shopId) || !ORDER_REF.test(req.orderId)) throw new Error("id витрины или заказа не по маске");
    const reply = await this.#send("POST", `/v1/shops/${req.shopId}/orders/${req.orderId}/payment`, openPackage(req.package));
    if (reply === null) {
      this.#log(method, 1, "unknown", req.shopId, { detail: "NO_RESPONSE" }, req.cartMandateId);
      throw new ShopFailure("SHOP_ORDER_STATE_UNKNOWN");
    }
    if (reply.status >= 400) {
      this.#log(method, 1, "refused", req.shopId, this.#cause(reply.body), req.cartMandateId);
      throw new ShopFailure("SHOP_ORDER_REFUSED");
    }
    const b = reply.status === 200 ? Paid.safeParse(reply.body) : null;
    if (!b?.success || b.data.id !== req.orderId) {
      this.#log(method, 1, "unknown", req.shopId, { detail: "BAD_RESPONSE" }, req.cartMandateId);
      throw new ShopFailure("SHOP_ORDER_STATE_UNKNOWN");
    }
    this.#log(method, 1, "ok", req.shopId, { detail: b.data.status }, req.cartMandateId);
    return { status: b.data.status };
  }

  /** Факты витрины → модель К8 (Р54 п. 4): магазин — из записи списка `entry`, товары — из карточек каталога. Факты
   *  магазина не по схеме — магазин исключён целиком: один код на магазин, по карточкам записей нет (витрина INCOMPLETE эмулятора, Р54 п. 5). */
  #facts(shopId: string, entry: unknown, items: ShopItem[], dropped: CatalogIssueCode[]): CatalogFacts {
    const f = ShopFacts.safeParse(entry);
    if (!f.success) return { shop: null, shopIssues: [dropCode(entry, f.error.issues)], products: [], dropped: [] };
    const shop: CatalogShop = {
      id: shopId,
      inn: f.data.inn,
      mcc: f.data.mcc,
      paymentMethods: f.data.payment_methods,
      deliveryRegions: f.data.delivery_regions,
      returns: f.data.returns,
    };
    const products = items.map(
      (i): CatalogProduct => ({
        sku: i.sku,
        gtin: i.gtin ?? null,
        brand: i.brand ?? null,
        model: i.model ?? null,
        attributes: i.attributes ?? {},
        title: i.title,
        category: i.category,
        price: { amount: i.price, currency: i.currency },
        availability: { inStock: i.in_stock },
        delivery: i.delivery_options.map((d) => ({
          // перечень способов — у ядра: значение вне перечня даёт BAD_METHOD в validateProduct (как у фида)
          method: d.method as CatalogProduct["delivery"][number]["method"],
          ...(d.region !== undefined && { region: d.region }),
          minDays: d.min_days,
          maxDays: d.max_days,
          cost: { amount: d.cost, currency: d.currency },
        })),
        updatedAt: i.updated_at,
        // текст витрины — только для сверки с ценой (A5), решений по нему нет (инвариант 5)
        ...(i.description !== undefined && { description: i.description }),
      }),
    );
    return readShop(shop, products, dropped, EXPONENT.RUB);
  }

  /** GET с одним повтором по повторяемому коду (Р42 п. 4); 200 не по схеме — BAD_RESPONSE без повтора; `shopId` — для
   *  журнала. `deadline` — общий срок поиска (Р44 п. 6): обращение прервано им или ожидание повтора не меньше остатка —
   *  SHOP_SEARCH_DEADLINE без повтора. */
  async #get<T>(method: Method, path: string, schema: z.ZodType<T>, shopId?: string, signal?: AbortSignal, deadline?: Deadline): Promise<Outcome<T>> {
    let attempt = 1;
    for (;;) {
      let reply: Reply;
      try {
        reply = await this.#send("GET", path, undefined, deadline ? (signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal) : signal);
      } catch (e) {
        // только прерывание сроком поиска: иное исключение (остановленная подпись, отмена вызывающего) — наружу (инвариант 4)
        if (deadline === undefined || signal?.aborted || !deadline.signal.aborted || e !== deadline.signal.reason) throw e;
        this.#log(method, attempt, "unknown", shopId, DEADLINE);
        return { ok: false, cause: DEADLINE, retry: null };
      }
      const r = this.#outcome(reply, schema);
      this.#log(method, attempt, r.ok ? "ok" : r.cause.detail === "NO_RESPONSE" ? "unknown" : "refused", shopId, r.ok ? undefined : r.cause);
      if (r.ok || r.retry === null || attempt > 1) return r;
      if (deadline !== undefined && r.retry >= deadline.left()) return { ok: false, cause: DEADLINE, retry: null };
      await this.sleep(r.retry, signal);
      attempt++;
    }
  }

  /** Общий срок стадии поиска с этого момента: сигнал прерывания и остаток в мс (часы — монотонные). Таймер срока
   *  срабатывает раньше, чем часы отсчитают полный срок: сработал — остаток ноль, иначе после прерванного сроком обращения
   *  была бы ещё попытка (Р46, К2а; уточняет Р44 п. 6). */
  #deadline(): Deadline {
    const ms = this.o.params.shop_search_deadline_ms;
    const start = performance.now();
    const signal = AbortSignal.timeout(ms);
    return { signal, left: () => (signal.aborted ? 0 : ms - (performance.now() - start)) };
  }

  #outcome<T>(reply: Reply, schema: z.ZodType<T>): Outcome<T> {
    if (reply === null) return { ok: false, cause: { detail: "NO_RESPONSE" }, retry: null };
    if (reply.status === 200) {
      const b = schema.safeParse(reply.body);
      return b.success ? { ok: true, body: b.data } : { ok: false, cause: { detail: "BAD_RESPONSE" }, retry: null };
    }
    const cause = reply.status >= 400 ? this.#cause(reply.body) : { detail: "BAD_RESPONSE" };
    const code = (reply.body as { code?: unknown } | undefined)?.code;
    const retryable = (reply.status === 429 || reply.status === 503) && isMerchantCode(code) && MERCHANT_RETRYABLE.has(code);
    return { ok: false, cause, retry: retryable ? this.#wait(reply.retryAfter) : null };
  }

  /** Ожидание перед повтором: Retry-After в секундах не больше предела; без него — shop_retry_default_ms; больше предела
   *  или не число секунд — повтора нет (null). */
  #wait(retryAfter: string | null): number | null {
    if (retryAfter === null) return this.o.params.shop_retry_default_ms;
    if (!/^\d{1,10}$/.test(retryAfter.trim())) return null;
    const sec = Number(retryAfter.trim());
    return sec <= this.o.params.shop_retry_after_max_sec ? sec * 1000 : null;
  }

  /** Код отказа витрины: из перечня — detail; иначе — MERCHANT_CODE_UNKNOWN, сам код не переносится (инвариант 5). */
  #cause(body: unknown): ShopUnavailableCause {
    const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
    return isMerchantCode(code) ? { detail: code } : { reason: "MERCHANT_CODE_UNKNOWN" };
  }

  /** Подписанное обращение; нет ответа в shop_request_timeout_ms или сбой сети — null. Перенаправлению не следует. */
  async #send(method: "GET" | "POST", path: string, body?: string, signal?: AbortSignal): Promise<Reply> {
    const headers = { ...(body !== undefined && { "content-type": "application/json" }), ...this.#headers() };
    // подпись — до сети: остановленная подпись — исключение наружу, обращения нет; пустое тело подписывается как ""
    const signed = this.o.signing.sign({ method, path, query: "", headers, body: body ?? "" });
    return this.#request(this.fetchImpl, `${this.o.baseUrl}${path}`, method, signed.headers, body, this.o.params.shop_request_timeout_ms, signal);
  }

  /** Заголовки подписи агента (ПАО §2): код агента, время, одноразовый x-nonce. */
  #headers(): Record<string, string> {
    return { "x-agent-code": this.o.agentCode, "x-timestamp": this.now().toISOString().slice(0, 19) + "Z", "x-nonce": randomUUID() };
  }

  /** Обращение по сети; нет ответа в `timeoutMs` или сбой сети — null; прерывание вызывающим — его причина наружу.
   *  Перенаправлению не следует. */
  async #request(fetchImpl: typeof fetch, url: string, method: "GET" | "POST", headers: Record<string, string>, body: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<Reply> {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method,
        headers,
        redirect: "manual",
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        ...(body !== undefined && { body }),
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text === "" ? undefined : (JSON.parse(text) as unknown);
      } catch {
        parsed = undefined;
      }
      return { status: res.status, body: parsed, retryAfter: res.headers.get("retry-after") };
    } catch {
      if (signal?.aborted) throw signal.reason;
      return null;
    }
  }

  /** shop.readiness и shop.readiness_mismatch (Р53): merchant — код продавца по маске `MERCHANT_ID` (Р54 п. 1), detail — значение перечня; тела
   *  ответа нет. */
  #record(kind: "shop.readiness" | "shop.readiness_mismatch", merchant: string | undefined, detail: string | undefined, result?: JournalResult, reason?: "SHOP_SEARCH_DEADLINE"): void {
    this.o.journal.record({
      at: this.now().toISOString(),
      kind,
      ...(kind === "shop.readiness" && { method: READINESS, attempt: 1 }),
      ...(result !== undefined && { result }),
      ...(merchant !== undefined && MERCHANT_ID.test(merchant) && { merchant }),
      ...(detail !== undefined && { detail }),
      ...(reason !== undefined && { reason }),
    });
  }

  /** shop.call (Т15): тела, заголовков и x-nonce нет; ref — id витрины по маске (код продавца — поле merchant — у записей
   *  конвейера: у заказа адаптер его не знает); mandate — мандат корзины заказа по маске (ревью К1 № 4–5). */
  #log(method: Method, attempt: number, result: JournalResult, shopId?: string, cause?: ShopUnavailableCause, mandate?: string): void {
    this.o.journal.record({
      at: this.now().toISOString(),
      kind: "shop.call",
      method,
      attempt,
      result,
      ...(shopId !== undefined && SHOP_ID.test(shopId) && { ref: shopId }),
      ...(mandate !== undefined && SAFE_ID.test(mandate) && { mandate }),
      ...(cause?.detail !== undefined && { detail: cause.detail }),
      ...(cause?.reason !== undefined && { reason: cause.reason }),
    });
  }
}
