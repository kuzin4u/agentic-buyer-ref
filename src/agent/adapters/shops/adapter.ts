// Адаптер витрин продавцов (Р42): порты стадий 2–3 `OfferSource`, `LiveOfferSource`, `ShopPort` по API витрин эмулятора
// (К6, Р26): `GET /v1/shops`, `GET /v1/shops/{id}/catalog`, `POST /v1/shops/{id}/orders`; пакет агентской оплаты —
// `POST /v1/shops/{id}/orders/{order_id}/payment` (Р45 п. 4).
// Каждое обращение подписано портом подписи места сборки (A2 п. 5.1, Т4); подпись остановлена — исключение порта, обращения
// нет (инвариант 4). Ответ витрины — данные: берутся только поля схемы, текст описания — только в `description` для
// сверки с ценой (инвариант 5, Т5а). Отказ витрины — без обходов: ни без подписи, ни другим ключом; повтор — только
// `GET` с повторяемым кодом, один раз, тот же запрос с новой подписью (витрина отклоняет повторный x-nonce).
// Факты, которых витрина не отдаёт (ИНН, MCC, оплата, регионы, возврат, доставка, время обновления), — профиль магазина
// от места сборки (Р42 п. 2; до kuzin4u/agentic-ps-platform#45). Время ответа продавца у витрины нет — `checkedAt`
// живого предложения по часам агента (Р38 нюанс К6).
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readShop, type CatalogFacts, type CatalogIssueCode, type CatalogProduct, type CatalogShop } from "../../catalog/index.js";
import type { Journal, JournalResult } from "../../journal/index.js";
import type { LiveOffer, LiveOfferRequest, LiveOfferSource } from "../../ports/catalog.js";
import type { HttpRequestSigning } from "../../ports/request-signing.js";
import {
  ShopFailure,
  type OfferSource,
  type ShopOffers,
  type ShopOrder,
  type ShopOrderRequest,
  type ShopPaymentPort,
  type ShopPaymentReply,
  type ShopPaymentRequest,
  type ShopPort,
  type ShopUnavailable,
  type ShopUnavailableCause,
} from "../../ports/shop.js";
import { openPackage } from "../../payment-package/package.js";
import type { StandParams } from "../../../shared/config.js";
import { SAFE_ID, SHOP_ID } from "../../../shared/ids.js";
import { ORDER_REF } from "../../payment-package/order-ref.js";
import { MERCHANT_RETRYABLE, isMerchantCode } from "./codes.js";

/** Профиль магазина (Р42 п. 2): сведения, которых витрина не отдаёт. `item` — доставка и время обновления карточки;
 *  null — сведений нет (карточка не пройдёт модель). */
export interface ShopProfile {
  shop: Omit<CatalogShop, "id">;
  item(sku: string): Pick<CatalogProduct, "delivery" | "updatedAt"> | null;
}

export type ShopsParams = Pick<StandParams, "shop_request_timeout_ms" | "shop_retry_after_max_sec" | "shop_retry_default_ms" | "shop_search_deadline_ms">;

export interface ShopsAdapterOptions {
  baseUrl: string;
  agentCode: string;
  signing: HttpRequestSigning;
  params: ShopsParams;
  /** профиль магазина по id витрины; null — профиля нет, магазин исключён целиком (REQUIRED) */
  profile: (shopId: string) => ShopProfile | null;
  /** попытки обращений (shop.call, Т15) */
  journal: Journal;
  now?: () => Date;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Идентификатор от витрины — в путь и в журнал только по маске (как sku у конвейера, Р38 п. 5). */
const Id = z.string().regex(SHOP_ID);
/** Номер заказа продавца — по маске ссылки агента, одно правило с Платформой (128; Р46 п. 1, выбор 1а). */
const OrderId = z.string().regex(ORDER_REF);
/** Знаков после запятой у валюты цены: таблицы в ядре нет (К9); витрина эмулятора — только RUB (ISO 4217). */
const EXPONENT = { RUB: 2 } as const;

/** Список витрин — массив; каждая запись разбирается отдельно (ревью КТ1 п. 1): зона и знак не по схеме — зона рынка,
 *  id или код продавца не по маске — витрина недоступна; отказ стадии — только если списка нет целиком. */
const Shops = z.object({ shops: z.array(z.unknown()) });
const ShopEntry = z.object({ id: Id, merchant_id: Id });
const Zone = z.object({ zone: z.literal("CONTOUR"), readiness_mark: z.literal(true) });
const Catalog = z.object({ items: z.array(z.unknown()) });
const Item = z.object({
  sku: Id,
  title: z.string(),
  description: z.string().optional(),
  price: z.number().int().nonnegative(),
  currency: z.enum(Object.keys(EXPONENT) as [keyof typeof EXPONENT]),
  in_stock: z.boolean(),
  category: z.string(),
});
type ShopItem = z.infer<typeof Item>;
const Order = z.object({ id: OrderId, total: z.number().int().nonnegative(), currency: z.enum(Object.keys(EXPONENT) as [keyof typeof EXPONENT]) });
/** Ответ на оплату — заказ продавца: статус после авторизации у эквайрера (слова продавца, не итог — инвариант 8). */
const Paid = z.object({ id: OrderId, status: z.enum(["PAID", "DECLINED", "REJECTED"]) });

type Method = "GET /v1/shops" | "GET /v1/shops/{id}/catalog" | "POST /v1/shops/{id}/orders" | "POST /v1/shops/{id}/orders/{order_id}/payment";

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

/** Карточка не по схеме (Р42 п. 6): поля нет — REQUIRED, валюта не из таблицы — BAD_CURRENCY, иначе BAD_TYPE. */
function dropCode(raw: unknown, issues: z.core.$ZodIssue[]): CatalogIssueCode {
  const rec = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const fields = issues.map((i) => i.path[0]);
  if (fields.some((f) => typeof f !== "string" || rec[f] === undefined)) return "REQUIRED";
  return fields.includes("currency") ? "BAD_CURRENCY" : "BAD_TYPE";
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
      // запись не стирается: sku, найденный у другой витрины в любой выдаче, становится неоднозначным навсегда
      for (const i of items) this.#shopOf.set(i.sku, this.#shopOf.has(i.sku) && this.#shopOf.get(i.sku) !== s.id ? null : s.id);
      // зона контура — только при зоне CONTOUR и знаке готовности true (РП22 п. 7 платформы); нет полей, иное значение или
      // тип — рынок (Р42 п. 3)
      const inContour = Zone.safeParse(entry).success;
      out.push({
        merchantId: s.merchant_id,
        inContour,
        facts: this.#facts(s.id, items, dropped),
        ...(!inContour && { link: `${this.o.baseUrl}/v1/shops/${s.id}/catalog` }),
      });
    }
    return out;
  }

  /** Живое предложение перед заказом: цена и наличие — из каталога витрины, `checkedAt` — часы агента (#45). Отказ —
   *  исключение: у конвейера это LIVE_CALL_ERROR или LIVE_UNAVAILABLE, заказа нет. */
  async fetch(req: LiveOfferRequest, signal: AbortSignal): Promise<LiveOffer> {
    const shop = this.#shopOf.get(req.sku);
    if (shop === undefined || shop === null) throw new Error("sku нет в выдаче или он у двух витрин");
    const catalog = await this.#get("GET /v1/shops/{id}/catalog", `/v1/shops/${shop}/catalog`, Catalog, shop, signal);
    if (!catalog.ok) throw new Error("витрина не ответила на живую проверку или ответ не по схеме");
    const i = catalog.body.items.flatMap((x) => {
      const p = Item.safeParse(x);
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

  /** Факты витрины: магазин и товары — из витрины и профиля; профиля нет — магазин исключён (REQUIRED). */
  #facts(shopId: string, items: ShopItem[], dropped: CatalogIssueCode[]): CatalogFacts {
    const profile = this.o.profile(shopId);
    if (profile === null) return { shop: null, shopIssues: ["REQUIRED"], products: [], dropped: [] };
    const shop: CatalogShop = { ...structuredClone(profile.shop), id: shopId };
    const products = items.map((i): CatalogProduct => {
      const extra = profile.item(i.sku);
      return {
        sku: i.sku,
        gtin: null,
        brand: null,
        model: null,
        attributes: {},
        title: i.title,
        category: i.category,
        price: { amount: i.price, currency: i.currency },
        availability: { inStock: i.in_stock },
        delivery: extra === null ? [] : structuredClone(extra.delivery),
        updatedAt: extra?.updatedAt ?? "",
        // текст витрины — только для сверки с ценой (A5), решений по нему нет (инвариант 5)
        ...(i.description !== undefined && { description: i.description }),
      };
    });
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

  /** Общий срок стадии поиска с этого момента: сигнал прерывания и остаток в мс (часы — монотонные). */
  #deadline(): Deadline {
    const ms = this.o.params.shop_search_deadline_ms;
    const start = performance.now();
    return { signal: AbortSignal.timeout(ms), left: () => ms - (performance.now() - start) };
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
    const headers: Record<string, string> = {
      ...(body !== undefined && { "content-type": "application/json" }),
      "x-agent-code": this.o.agentCode,
      "x-timestamp": this.now().toISOString().slice(0, 19) + "Z",
      "x-nonce": randomUUID(),
    };
    // подпись — до сети: остановленная подпись — исключение наружу, обращения нет; пустое тело подписывается как ""
    const signed = this.o.signing.sign({ method, path, query: "", headers, body: body ?? "" });
    const timeout = AbortSignal.timeout(this.o.params.shop_request_timeout_ms);
    try {
      const res = await this.fetchImpl(`${this.o.baseUrl}${path}`, {
        method,
        headers: signed.headers,
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
