// Покупка по стадиям 0–6 (Р38 п. 2–4) поверх готовых частей: клиент мандатов (Р37 п. 4), лента (Р34), политика каталога
// (Р32), порты стадий. Переход — только через машину (machine.ts): таблица — «можно ли вообще», ворота стадий здесь —
// «выполнены ли условия сейчас». Ход покупки задаёт вызывающий: каждое действие человека — типизированный вход метода
// (инвариант 3). Состояние — только в памяти (Р38 п. 6).
import type { StandParams } from "../../shared/config.js";
import { PlatformFailure, type CartLine, type Mandate, type MandateDraft, type Money, type Operation } from "../../shared/domain.js";
import type { DiagCode } from "../../shared/diag-codes.js";
import { SAFE_ID, SHOP_ID } from "../../shared/ids.js";
import { liveCheck, type A5SignalCode, type CatalogIssueCode, type CatalogProduct, type LiveCheckParams, type LiveFactCode } from "../catalog/index.js";
import { ruleForDeclineReason, stopNext, type StopNext, type Unfinished } from "../declines/index.js";
import { MandateRefused, type MandateClient } from "../mandates/index.js";
import { chargedAmount, scopeNotice } from "../operations/notice.js";
import { issuedByShell, spend } from "../policy/a5-issued.js";
import { acceptedA5, cartTotal, classifyOffer, mayDraftCart, mayOrder, type CartPurchase, type HumanA5Decision, type OfferVerdict, type OrderDecision, type OrderNext } from "../policy/catalog.js";
import { confirmThreshold, currencySupported, mandateRefusal, mayAuthorize, mayCartMerchant, needsConfirmation, type PaymentDecision, type Thresholds } from "../policy/payment.js";
import type { OrderPriceMismatches } from "../policy/order-mismatch.js";
import type { SplitWindow } from "../policy/split.js";
import type { LiveOfferSource } from "../ports/catalog.js";
import type { FeedItem } from "../ports/events.js";
import type { Mutation } from "../ports/mutation.js";
import { orderRefIssue, type OrderRefIssue } from "../payment-package/order-ref.js";
import { PaymentFailure, ShopFailure, type ConfirmationOutcome, type OfferSource, type PaymentContext, type NoticeAmount, type PaymentSteps, type PurchaseNotice, type ShopOffers, type ShopOrder, type ShopPort, type ShopUnavailable, type ShopUnavailableCause } from "../ports/shop.js";
import { PurchaseMachine, PurchaseTransitionForbidden, allowed, type PurchaseJournal, type PurchaseState, type StopCause } from "./machine.js";

/** Почему оставлен CART (Р46 п. 3): новый поиск из CART_ACTIVE или отказ живой проверки перед заказом. */
export type CartAbandoned = "NEW_SEARCH" | "REFUSED_BEFORE_ORDER";

/** Итог отказа от CART после остановки покупки или оставления CART (Р63, дополнение 1 п. 1, 6) — для оболочки:
 *  `cartRelease`, `cartReleased()`. NONE — отказа нет и не начат; PENDING — идёт; RELINQUISHED — подтверждён; FAILED — не
 *  подтверждён; NOT_NEEDED — CART уже не действует; SKIPPED — нельзя (подпись остановлена, CART не известен); KEPT —
 *  пакет оплаты ушёл, CART оставлен намеренно. */
export type CartRelease = "NONE" | "PENDING" | "RELINQUISHED" | "FAILED" | "NOT_NEEDED" | "SKIPPED" | "KEPT";

/** Почему отказа от CART не было (Р63, дополнение 1 п. 5): detail записи cart.relinquish_skipped. */
export type CartReleaseSkip = "STOPPED" | "UNKNOWN_CART" | "NOT_NEEDED" | "KEPT";

/** Остановка, при которой CART уже не действует — отказ не нужен (Р63 п. 7). */
const CART_NOT_NEEDED: ReadonlySet<DiagCode> = new Set<DiagCode>(["MANDATE_REVOKED", "MANDATE_NOT_ACTIVE", "MANDATE_EXPIRED"]);
/** Исход создания CART не подтверждён — CART агенту не известен (Р63, дополнение 1 п. 1). */
const CART_UNCONFIRMED: ReadonlySet<DiagCode> = new Set<DiagCode>(["NO_RESPONSE", "BAD_RESPONSE", "UNKNOWN"]);

/** Записи конвейера сверх записей машины (Р38 п. 5, Р37 п. 5). */
export interface PipelineJournal extends PurchaseJournal {
  record(
    entry:
      | Parameters<PurchaseJournal["record"]>[0]
      /** ошибка модели каталога — reason; нет доставки в регион — detail REGION без reason; ref — sku, merchant — код
       *  продавца, оба по маске (у решений каталога ниже — так же) */
      | { at: string; kind: "offer.excluded"; reason: CatalogIssueCode; ref?: string; mandate?: string; merchant?: string }
      | { at: string; kind: "offer.excluded"; detail: "REGION"; ref?: string; mandate?: string; merchant?: string }
      /** сигнал A5 — показ с пометкой; detail ORDER_REPLY_MISMATCH — пометка Д02 по прежнему заказу (Р48 п. 5) */
      | { at: string; kind: "offer.flagged"; reason: A5SignalCode; detail?: "ORDER_REPLY_MISMATCH"; ref?: string; mandate?: string; merchant?: string }
      /** проект CART не готовится (Р32 п. 2, Р40 п. 4): reason — код сигнала A5, detail — решение политики */
      | { at: string; kind: "cart.refused"; reason: A5SignalCode; detail: CartRefusal; ref?: string; mandate?: string; merchant?: string }
      /** заказа нет — живая проверка не ok (Р32 п. 3–4): reason — код проверки, detail — следующий шаг */
      | { at: string; kind: "order.live_refused"; reason: LiveFactCode; detail: OrderNext; ref?: string; mandate?: string; merchant?: string }
      /** запроса CART нет — живая проверка перед ним не ok (Р43 п. 1): как order.live_refused */
      | { at: string; kind: "cart.live_refused"; reason: LiveFactCode; detail: OrderNext; ref?: string; mandate?: string; merchant?: string }
      /** магазин отказал в каталоге (Т4, Р42 п. 4): detail — код витрины, BAD_RESPONSE или NO_RESPONSE; reason — код вне
       *  перечня; merchant — код продавца по маске */
      | ({ at: string; kind: "shop.unavailable"; mandate?: string; merchant?: string } & ShopUnavailableCause)
      /** прежний CART больше не используется (Т15, Р46 п. 3): mandate — id CART по маске, detail — причина закрытым
       *  перечнем; сумм, позиций и продавца нет. У Платформы CART остаётся ACTIVE (риск 4а) */
      | { at: string; kind: "cart.abandoned"; detail: CartAbandoned; mandate?: string }
      /** отказ от CART подтверждён Платформой (Р63, дополнение 1 п. 5) */
      | { at: string; kind: "cart.relinquished"; mandate?: string }
      /** отказ от CART не подтверждён: reason — код отказа или UNKNOWN */
      | { at: string; kind: "cart.relinquish_failed"; reason: DiagCode; mandate?: string }
      /** отказа от CART не было: detail — почему, закрытым перечнем */
      | { at: string; kind: "cart.relinquish_skipped"; detail: CartReleaseSkip; mandate?: string }
      /** ворота: держимый мандат вышел (отзыв, иной статус) — отказ действовать (Р38 п. 3) */
      | { at: string; kind: "agent.refused"; reason: "MANDATE_NOT_ACTIVE"; mandate?: string }
      /** ворота: остатка Платформы по мандату не хватает на итог CART (Р38 п. 3, К4а) */
      | { at: string; kind: "agent.refused"; reason: "MANDATE_AMOUNT_LEFT_INSUFFICIENT"; mandate?: string }
      /** политика в воротах: verify CONFIRMED, но остаток 0 или в чужой валюте, продавец или валюта итога вне пределов
       *  мандата (Р39 п. 1.1, 1.3; К2а); в cart() — продавец выбора вне области INTENT, до обращений (Р56 п. 2) */
      | { at: string; kind: "agent.refused"; reason: "MANDATE_OUT_OF_SCOPE"; mandate?: string }
      /** политика до стадий 4–5: итог не в RUB; доля в окне дробления (Р39 п. 1.4, п. 4) */
      | { at: string; kind: "agent.refused"; reason: "CURRENCY_NOT_SUPPORTED" | "SPLIT_WINDOW"; mandate?: string }
      /** выбор человека не из контура гарантий выдачи (Р38 п. 2, поправка К3) — отказ действовать; ref — sku по маске */
      | { at: string; kind: "agent.refused"; reason: "OFFER_NOT_IN_CONTOUR"; ref?: string; mandate?: string }
      /** количество не целое ≥ 1 или итог не безопасное целое (Р43 п. 3) — отказ действовать; ref — sku по маске */
      | { at: string; kind: "agent.refused"; reason: "CART_QTY_INVALID"; ref?: string; mandate?: string }
      /** решение человека по A5 не выдано оболочкой (Р40 п. 4) — отказ действовать; ref — sku, merchant — код продавца, по
       *  маске; mandate — корневой INTENT из машины */
      | { at: string; kind: "agent.refused"; reason: "A5_DECISION_FORGED"; ref?: string; mandate?: string; merchant?: string }
      /** номер заказа продавца не передаётся дальше (Р45, 9а): detail — только причина, значения нет */
      | { at: string; kind: "agent.refused"; reason: "SHOP_ORDER_REF_INVALID"; detail: OrderRefIssue; mandate?: string }
      /** уведомление оболочки упало (Р47 п. 5, В3): исход покупки не меняется */
      | { at: string; kind: "notify.failed"; reason: PurchaseNotice; mandate?: string }
      /** STOP_ALL (Р50 п. 4, Т13): что не завершено — detail из перечня UNFINISHED, reason — код остановки; после
       *  purchase.stage STOPPED */
      | { at: string; kind: "purchase.unfinished"; reason: DiagCode; detail: Unfinished; mandate?: string },
  ): void;
}

/** Товар выдачи. `a5` непустой — показ с пометкой «сведения продавца противоречивы» (Р32 п. 1). `link` — у зоны вне
 *  контура: адрес витрины для человека, платежа нет (инвариант 10, Р42 п. 3). */
export interface Offer {
  shopId: string;
  merchantId: string;
  sku: string;
  product: CatalogProduct;
  a5: A5SignalCode[];
  link?: string;
}

/** Код пояснения различия в защите по зоне (Т5, A6 п. 3.1, Р42 п. 3); тексты для человека — в оболочке (`shell/zones`). */
export type ZoneCode = "ZONE_CONTOUR" | "ZONE_MARKET";

/** Магазин, недоступный в этой выдаче (Т4, Р42 п. 4): человеку — «продавец недоступен». */
export interface UnavailableShop {
  /** нет — запись списка витрин без id по маске */
  shopId?: string;
  merchantId?: string;
  cause: ShopUnavailableCause;
}

/** Две зоны (Р3, Т5): по зоне вне контура гарантий покупки нет — человеку ссылка (инвариант 10). У каждой зоны — код
 *  пояснения (`disclosure`); `unavailable` — магазины, отказавшие в каталоге (Т4). */
export interface OfferZones {
  contour: Offer[];
  market: Offer[];
  disclosure: { contour: "ZONE_CONTOUR"; market: "ZONE_MARKET" };
  unavailable: UnavailableShop[];
}

/** Позиция выбора: товар выдачи этой покупки у продавца выбора (`sku`), количество; `decision` — явное решение человека
 *  по сигналам A5 этой позиции из оболочки (Р32 п. 2, Р44 п. 1). */
export interface CartChoiceLine {
  sku: string;
  qty: number;
  decision?: HumanA5Decision;
}

/** Выбор человека на стадии 3: одна или несколько позиций одного продавца (Р44 п. 1) — продавец один на корзину по
 *  построению; `keyTermsShown` — карточка CART показана (Т3а). */
export interface CartChoice {
  merchantId: string;
  lines: CartChoiceLine[];
  keyTermsShown: boolean;
}

/** Исход политики по сигналам A5, при котором корзина не готовится: решения нет или не все сигналы приняты, автономный
 *  режим, решение устарело — потрачено, из другой покупки или по другому показу (Р40 п. 3). */
export type CartRefusal = "A5_NEEDS_HUMAN" | "A5_AUTONOMOUS" | "A5_DECISION_STALE";

/** Проект корзины не готовится (Р32 п. 2): покупка остаётся в OFFERS, обращений не было (Р38 п. 4, поправка К3). */
export class CartRefused extends Error {
  constructor(readonly code: "EXCLUDED" | CartRefusal) {
    super(`Корзина не готовится: ${code}`);
    this.name = "CartRefused";
  }
}

/** Живая проверка перед запросом CART не ok (Р43 п. 1, Р32 п. 4): мандата корзины нет, покупка остаётся в OFFERS; что
 *  дальше — `next` (ценовые коды — выбор человека по новой цене). */
export class CartLiveRefused extends Error {
  constructor(
    readonly next: OrderNext,
    readonly codes: LiveFactCode[],
  ) {
    super(`Корзина не готовится: ${codes.join(", ")}`);
    this.name = "CartLiveRefused";
  }
}

/** Живая проверка не ok (Р32 п. 3–4): заказа нет, покупка вернулась в OFFERS; что дальше — `next`. */
export class OrderRefused extends Error {
  constructor(
    readonly next: OrderNext,
    readonly codes: LiveFactCode[],
  ) {
    super(`Заказа нет: ${codes.join(", ")}`);
    this.name = "OrderRefused";
  }
}

/** Покупка остановлена воротами конвейера; код — в журнале (purchase.stage) и здесь. */
export class PurchaseStopped extends Error {
  /** что делать оболочке — из таблицы ядра по коду (Р50 п. 4); null — просто остановка */
  readonly next: StopNext | null;
  /** `cause` — исходная ошибка шага, если код заменён после отправки пакета (Р49 п. 2): для оператора, не для человека;
   *  `unfinished` — что не завершено при STOP_ALL (Р50 п. 4) */
  constructor(
    readonly code: DiagCode,
    options?: { cause: unknown },
    readonly unfinished: Unfinished | null = null,
  ) {
    super(`Покупка остановлена: ${code}`, options);
    this.name = "PurchaseStopped";
    this.next = stopNext(code);
  }
}

export interface PurchaseOptions {
  mandates: MandateClient;
  /** лента для ожидания подписи (`EventFeed.items`) */
  events: (signal?: AbortSignal) => AsyncIterable<FeedItem>;
  offers: OfferSource;
  /** живое предложение продавца перед заказом (Р32 п. 3) */
  live: LiveOfferSource;
  shop: ShopPort;
  payment: PaymentSteps;
  /** стендовые параметры: живая проверка и порог подтверждения (Т7) — из конфигурации, не литералом */
  params: LiveCheckParams & Pick<StandParams, "confirm_above_kop">;
  /** окно дробления (Р39 п. 4) — одно на ядро: общее для всех покупок, иначе доли разных покупок друг друга не видят */
  split: SplitWindow;
  /** пометка Д02 (Р48 п. 5) — одна на ядро: заказ одной покупки помечает предложение в выдачах следующих */
  orderMismatches: OrderPriceMismatches;
  journal: PipelineJournal;
  /** стадия 0 (Р38 п. 2): null — последний start() дал допуск (Р36 п. 6) и подпись не остановлена; иначе код остановки */
  admission: () => DiagCode | null;
  /** код остановки по ошибке вне ядра (остановленная подпись — у места сборки); null — не знает */
  failureCode?: (e: unknown) => DiagCode | null;
  /** подпись остановлена, а не приостановлена (у места сборки): отказ от CART не пытается — SKIPPED STOPPED (Р63,
   *  дополнение 1 п. 1); не передана — попытка, отказ порта — FAILED */
  signingStopped?: () => boolean;
  /** регион человека из профиля; нет — доступен только самовывоз (Р32 п. 5) */
  region?: string;
  /** уведомление оболочки (Р47 п. 5, В3; Р49 п. 7): CONFIRMATION_PENDING — один раз на запрос подтверждения, без link;
   *  SCOPE_* — запись об исполнении не WITHIN_LIMITS; OPERATION_REFUNDED — возврат (Р51 п. 3); `amount` — сумма списания
   *  по операции у SCOPE_* и OPERATION_REFUNDED; конвейер его не ждёт, сбой — запись notify.failed, исход не меняется */
  notify?: (code: PurchaseNotice, amount?: NoticeAmount) => void | Promise<void>;
  now?: () => Date;
}

/** sku из фида — в журнале только по маске идентификатора (Р38 п. 5, инвариант 5). */
const skuRef = (sku: string): { ref?: string } => (SHOP_ID.test(sku) ? { ref: sku } : {});

/** Исход стадии 4 → код остановки (Р47 п. 4, 6): одобрение до канала к продавцу — CONFIRMATION_NOT_DELIVERED; запроса нет за
 *  confirmation_wait_ms — OPERATION_RESULT_UNCONFIRMED (как без ожидания, Р45 п. 5); прочее — UNKNOWN (fail-closed). */
const CONFIRMATION_STOP: Readonly<Record<ConfirmationOutcome, DiagCode>> = {
  APPROVED: "CONFIRMATION_NOT_DELIVERED",
  REJECTED: "CONFIRMATION_REJECTED",
  EXPIRED: "CONFIRMATION_EXPIRED",
  UNBOUND: "CONFIRMATION_UNBOUND",
  NONE: "OPERATION_RESULT_UNCONFIRMED",
  UNKNOWN: "UNKNOWN",
};

/** Отказ подписи — ждать человека, а не останавливать покупку (SPEC §7а PRINCIPAL_SIGNATURE_PENDING); только у ожидания
 *  подписи мандата: тот же код из порта витрины или оплаты — остановка (ревью К3 повторное Н1, инвариант 4). */
const WAITS_HUMAN: ReadonlySet<DiagCode> = new Set(["MANDATE_SIGNATURE_PENDING"]);
/** Расчёта ещё нет, ожидание прервал вызывающий (Р49 п. 6) — покупка ждёт в SETTLING, только у стадии 6. */
const WAITS_SETTLEMENT: ReadonlySet<DiagCode> = new Set(["SETTLEMENT_PENDING"]);
const NONE: ReadonlySet<DiagCode> = new Set();


export class Purchase {
  // машина — только у конвейера: вызывающему — чтение состояния и кода (ревью К3 повторное Н2: переход в обход стадии)
  readonly #machine: PurchaseMachine;
  private readonly now: () => Date;
  // Всё, по чему конвейер решает, — свои замороженные снимки; наружу — только копии: вызывающий (оболочка, позже
  // советчик) не может подменить выдачу, мандат корзины или заказ после проверки (ревью К3 № 1–3, инвариант 3).
  #intent: Mandate | null = null;
  #zones: OfferZones | null = null;
  /** товары выдачи по позициям подписанного CART, в его порядке */
  #lines: readonly Offer[] | null = null;
  #cart: Mandate | null = null;
  #order: ShopOrder | null = null;
  #operation: Operation | null = null;
  /** когда стадия 5 дала AUTHORIZED (мс, часы конвейера): от него граница ожидания клиринга (Р51 п. 2 (б)) */
  #authorizedAt: number | null = null;
  /** стадия идёт: повторный вход до её окончания — запрещённый переход (ревью К3 № 4) */
  #busy = false;
  /** итог отказа от последнего оставленного CART (Р63, дополнение 1) */
  #cartRelease: CartRelease = "NONE";
  /** идущий или завершённый фоновый отказ от CART; null — не начат */
  #cartReleasing: Promise<CartRelease> | null = null;
  /** запрос CART ушёл, ответа ещё нет: остановка с неподтверждённым исходом — CART не известен (UNKNOWN_CART) */
  #cartRequested = false;

  constructor(private readonly o: PurchaseOptions) {
    this.now = o.now ?? (() => new Date());
    this.#machine = new PurchaseMachine({ journal: o.journal, now: this.now });
    // любая остановка (шаг, ворота, сбой журнала, запрещённый переход) — решение об отказе от CART после записи STOPPED;
    // отчёт человеку его не ждёт (Р63 п. 7, дополнение 1 п. 2)
    this.#machine.stopped.addEventListener("abort", () => queueMicrotask(() => this.#releaseOnStop()), { once: true });
  }

  get state(): PurchaseState {
    return this.#machine.state;
  }

  /** Код остановки; до STOPPED — null. */
  get reason(): DiagCode | null {
    return this.#machine.reason;
  }

  /** Что делать оболочке после остановки (Р50 п. 4) — и когда наружу ушла исходная ошибка шага, а не PurchaseStopped;
   *  до STOPPED — null. */
  get next(): StopNext | null {
    const reason = this.#machine.reason;
    return reason === null ? null : stopNext(reason);
  }

  /** Что не завершено при STOP_ALL (Р50 п. 4); иначе null. */
  get unfinished(): Unfinished | null {
    return this.next === "STOP_ALL" ? this.#machine.unfinished : null;
  }

  get intentMandate(): Mandate | null {
    return copy(this.#intent);
  }

  get offers(): OfferZones | null {
    return copy(this.#zones);
  }

  get cartMandate(): Mandate | null {
    return copy(this.#cart);
  }

  /** Итог отказа от CART после остановки или оставления CART (Р63, дополнение 1 п. 1). */
  get cartRelease(): CartRelease {
    return this.#cartRelease;
  }

  /** Итог отказа (не PENDING); не отклоняется. Отказа нет — текущее значение сразу (до остановки — NONE: итога не ждёт). */
  cartReleased(): Promise<CartRelease> {
    return this.#cartRelease === "PENDING" && this.#cartReleasing !== null ? this.#cartReleasing : Promise.resolve(this.#cartRelease);
  }

  get order(): ShopOrder | null {
    return copy(this.#order);
  }

  get operation(): Operation | null {
    return copy(this.#operation);
  }

  /** Стадии 0–1: допуск и запрос INTENT. Подписи ещё нет — INTENT_PENDING, дальше `awaitIntent`; запрос сразу вернул
   *  ACTIVE (РП35) — INTENT_ACTIVE, `awaitIntent` не вызывается (повтор перехода запрещён), дальше `search`. Отказ
   *  допуска — только purchase.stage: причину уже записали подписант или старт (agent.stopped, admission.failed). */
  intent(draft: MandateDraft, m: Mutation): Promise<Mandate> {
    return this.#stage("INTENT_PENDING", async () => {
      const refused = this.o.admission();
      if (refused !== null) this.#halt(refused);
      const intent = snapshot(await this.#guard(() => this.o.mandates.request(draft, m)));
      this.#machine.bind(intent.id);
      this.#intent = intent;
      this.#machine.to(intent.status === "ACTIVE" ? "INTENT_ACTIVE" : "INTENT_PENDING");
      return copy(intent);
    });
  }

  /** Стадия 1: подпись INTENT человеком по ленте. Лента кончилась без подписи — покупка ждёт (MANDATE_SIGNATURE_PENDING
   *  наружу, состояние прежнее); иной отказ — STOPPED. */
  awaitIntent(signal?: AbortSignal): Promise<Mandate> {
    return this.#stage("INTENT_ACTIVE", async () => {
      const intent = this.#need(this.#intent);
      const signed = snapshot(await this.#guard(() => this.o.mandates.awaitSigned(intent, this.o.events(signal), signal), WAITS_HUMAN));
      this.#intent = signed;
      this.#machine.to("INTENT_ACTIVE");
      return copy(signed);
    });
  }

  /** Стадия 2: выдача в двух зонах. Перед поиском — INTENT держится и подтверждён verify (Т2); решения каталога —
   *  в журнал (Р37 п. 5): `policy/` журнала не получает (инвариант 3). Новая выдача стирает снимок прежнего CART (К2а),
   *  запись cart.abandoned — Р46 п. 3. */
  search(): Promise<OfferZones> {
    return this.#stage("OFFERS", async () => {
      const intent = this.#need(this.#intent);
      this.#held(intent);
      await this.#guard(() => this.o.mandates.requireActive(intent));
      const shops = await this.#guard(() => this.o.offers.search(copy(intent)));
      // разбор выдачи — тоже шаг стадии: сбой формы или журнала — STOPPED, а не покупка в прежнем состоянии (инвариант 4)
      const zones = snapshot(await this.#guard(async () => this.#classify(shops)));
      // отзыв мог прийти по ленте, пока шёл поиск (ревью К2.2 № 15)
      this.#held(intent);
      // оставленный CART — в журнал до смены выдачи и снимка: сбой записи — STOPPED с прежними выдачей и CART (Р46 п. 3,
      // инвариант 4; ревью reviewer К3 № 1)
      this.#abandon("NEW_SEARCH");
      if (this.#cart !== null) this.#relinquishCart(this.#cart.id); // Р63, дополнение 1 п. 6
      this.#zones = zones;
      // выдача сменилась — прежний CART наружу как текущий не отдаётся и не исполняется: новый CART — по новому выбору
      // (общее правило с отказом перед заказом; решение владельца 21.10, К2а)
      this.#cart = null;
      this.#lines = null;
      this.#machine.to("OFFERS");
      return copy(zones);
    });
  }

  /** Стадия 3: выбор человека → живая проверка → проект CART (Р32 п. 2) → мандат корзины с родителем INTENT. Каждая
   *  позиция ищется по ключу в своей выдаче (зона, A5 — из неё, не от вызывающего), все — у одной витрины; количество и
   *  итог — до обращений (Р43 п. 3, Р44 п. 1). Отказ политики по любой позиции — CartRefused, покупка остаётся в OFFERS,
   *  обращений нет. Цены позиций — из живой проверки каждой непосредственно перед CART (Р43 п. 1, Р44 п. 2), до первой
   *  не ok — CartLiveRefused, покупка в OFFERS; ценовой отказ сбрасывает выдачу (Р44 п. 4). Выдачи нет (сброшена или не
   *  было поиска) — запрещённый переход. Перед CART — INTENT держится и подтверждён verify (Р38 п. 3). CART сразу ACTIVE
   *  (РП35) — CART_PENDING и CART_ACTIVE подряд, `awaitCart` не вызывается. */
  cart(input: CartChoice, m: Mutation): Promise<Mandate> {
    return this.#stage("CART_PENDING", async () => {
      // выбор — снимком, каждое поле прочитано один раз до первого ожидания: геттер или правка вызывающего во время живой
      // проверки и verify не меняют ни проверенное количество, ни решение A5 (ревью reviewer К1, повторный проход, блокер 1;
      // Р-205); бросающий геттер — отказ промиса, покупка в OFFERS, обращений нет
      const choice = pick(input);
      const intent = this.#need(this.#intent);
      const zones = this.#need(this.#zones);
      // пустой выбор или повтор sku — неверное предложение вызывающего (Р44 п. 1, как количество)
      if (choice.lines.length === 0 || new Set(choice.lines.map((l) => l.sku)).size !== choice.lines.length) this.#invalidQty();
      // товар — только из контура гарантий этой выдачи и одной витрины: по зоне вне контура покупки нет (инвариант 10); выбор
      // вне контура — дефект или подмена вызывающего, а не решение политики — остановка (Р38 п. 2, поправка К3, решение
      // владельца 20.10)
      let shopId: string | undefined;
      const offers = choice.lines.map((l) => {
        const offer = zones.contour.find((x) => x.merchantId === choice.merchantId && x.sku === l.sku);
        shopId ??= offer?.shopId;
        if (offer === undefined || offer.shopId !== shopId) {
          this.#record({ kind: "agent.refused", reason: "OFFER_NOT_IN_CONTOUR", ...skuRef(String(l.sku)) });
          this.#halt("OFFER_NOT_IN_CONTOUR");
        }
        return offer;
      });
      // количество и итог — до обращений: неверное предложение вызывающего, не решение политики (Р43 п. 3)
      if (cartTotal(offers.map((o, i) => ({ price: o.product.price, qty: choice.lines[i]!.qty }))) === null) this.#invalidQty(offers, choice);
      // продавец выбора — в области INTENT, до обращений: действие вне мандата останавливает политика, а не контур (Р56 п. 2,
      // Т16, инвариант 3)
      this.#refuse(mayCartMerchant(intent, choice.merchantId));
      // показ — из своей выдачи: продавец, sku, цена и коды A5, к которым привязано решение человека (Р39 п. 5), и
      // покупка — корневой INTENT (Р40 п. 1)
      const verdicts = offers.map((o): Extract<OfferVerdict, { kind: "AVAILABLE" }> => ({ kind: "AVAILABLE", merchantId: o.merchantId, sku: o.sku, price: { ...o.product.price }, a5: [...o.a5] }));
      const purchase: CartPurchase = { intentId: intent.id, mode: intent.confirmationMode };
      verdicts.forEach((v, i) => this.#draftable(v, purchase, choice.lines[i]!.decision));
      // отказ от прежнего CART ещё идёт — стадия ждёт его итога в начале, до ворот, verify, живой проверки и траты решений
      // A5: цены — непосредственно перед CART, держимые — после ожидания (Р43 п. 1, Р38 п. 3); остановка во время ожидания —
      // без траты (Р63, дополнение 1 п. 6; предел — п. 3; КТ1 сессии 46 № 1). FAILED — новый CART всё равно запрашивается:
      // решение за Платформой, итог прежнего — в журнале
      if (this.#cartRelease === "PENDING") {
        await this.cartReleased();
        this.#alive();
      }
      this.#held(intent);
      // verify INTENT — до обращения к витрине: без действующего INTENT ни одного обращения к витринам (П05, как в search();
      // решение владельца по ревью К1 № 5)
      await this.#guard(() => this.o.mandates.requireActive(intent));
      // цены позиций — из живой проверки непосредственно перед CART (Р43 п. 1, Р44 п. 2); проверка перед заказом остаётся
      const lines: CartLine[] = [];
      for (const [i, offer] of offers.entries()) {
        const { qty } = choice.lines[i]!;
        lines.push({ sku: offer.sku, qty, price: await this.#liveBeforeCart(offer, qty) });
      }
      const total = cartTotal(lines);
      // защита: при ok живая цена равна цене выдачи, а её итог проверен выше — недостижимо, но с записью, как и выше
      if (total === null) this.#invalidQty();
      // держимые — повторно после живой проверки: лента могла вывести INTENT во время ожидания (Р38 п. 3)
      this.#held(intent);
      // вторая защита: решения — повторно непосредственно перед тратой, без ожидания между ними (при `#busy` и привязке к
      // INTENT потратить их на другую корзину во время verify нельзя — недостижимо, нюанс К2 Р40). Тратятся только решения,
      // которые покрыли сигналы своей позиции, при любом исходе запроса CART (Р40 п. 2, fail-closed)
      verdicts.forEach((v, i) => this.#draftable(v, purchase, choice.lines[i]!.decision));
      for (const [i, v] of verdicts.entries()) {
        const { decision } = choice.lines[i]!;
        if (v.a5.length > 0 && issuedByShell(decision)) spend(decision);
      }
      // запрос нового CART уходит — итог прежнего отказа только в журнале: решение об отказе после остановки — по новому
      // CART (Р63, дополнение 1 п. 1; КТ1 сессии 46 № 2 (а))
      this.#cartRelease = "NONE";
      this.#cartReleasing = null;
      this.#cartRequested = true;
      const cart = snapshot(
        await this.#guard(async () => {
          const got = await this.o.mandates.request(cartDraft(intent, choice, keyLines(lines), total), m, intent);
          if (this.#machine.state === "STOPPED") this.#releaseLate(got);
          return got;
        }),
      );
      this.#cartRequested = false;
      this.#lines = Object.freeze(offers);
      this.#cart = cart;
      this.#machine.to("CART_PENDING");
      if (cart.status === "ACTIVE") this.#machine.to("CART_ACTIVE");
      return copy(cart);
    });
  }

  /** Количество, итог или состав выбора не годятся (Р43 п. 3, Р44 п. 1) — agent.refused и STOPPED до обращений; ref — sku
   *  первой позиции с неверным количеством, иначе без ref. */
  #invalidQty(offers?: readonly Offer[], choice?: CartChoice): never {
    const bad = offers?.find((o, i) => cartTotal([{ price: o.product.price, qty: choice!.lines[i]!.qty }]) === null);
    this.#record({ kind: "agent.refused", reason: "CART_QTY_INVALID", ...(bad !== undefined && skuRef(bad.sku)) });
    this.#halt("CART_QTY_INVALID");
  }

  /** Живая проверка позиции перед запросом CART (Р43 п. 1): ok — цена продавца; иначе коды в журнал (cart.live_refused),
   *  ценовой отказ сбрасывает выдачу (Р44 п. 4) и CartLiveRefused, покупка остаётся в OFFERS (Р32 п. 4: автоматического
   *  повтора нет). */
  async #liveBeforeCart(offer: Offer, qty: number): Promise<Money> {
    const req = { sku: offer.sku, quantity: qty, ...(this.o.region !== undefined && { region: this.o.region }) };
    const live = await liveCheck(offer.product, req, this.o.live, this.o.params, () => this.now().getTime());
    this.#alive();
    const d = mayOrder(live);
    if (!d.allow) {
      for (const reason of d.codes) this.#record({ kind: "cart.live_refused", reason, detail: d.next, ...skuRef(offer.sku), ...merchantRef(offer.merchantId) });
      if (d.next === "NEW_CART_MANDATE") this.#zones = null;
      throw new CartLiveRefused(d.next, d.codes);
    }
    return { ...d.offer.price };
  }

  /** Стадия 3: подпись CART человеком по ленте — как `awaitIntent`; держимые — до ожидания и после (Р38 п. 3). */
  awaitCart(signal?: AbortSignal): Promise<Mandate> {
    return this.#stage("CART_ACTIVE", async () => {
      const intent = this.#need(this.#intent);
      const cart = this.#need(this.#cart);
      this.#held(intent);
      const signed = snapshot(await this.#guard(() => this.o.mandates.awaitSigned(cart, this.o.events(signal), signal), WAITS_HUMAN));
      this.#held(intent, signed);
      this.#cart = signed;
      this.#machine.to("CART_ACTIVE");
      return copy(signed);
    });
  }

  /** Стадия 3: живая проверка каждой позиции непосредственно перед заказом (Р32 п. 3, Р44 п. 2) → проверка по мандату
   *  (Р44 п. 5) → заказ у продавца → сверка суммы (Т6). Позиции заказа и проверки — из подписанного CART, товары и магазин —
   *  из своей выдачи. Проверка не ok — OrderRefused, CART_ACTIVE → OFFERS (Р38 п. 1), снимок CART стёрт; ценовой отказ
   *  сбрасывает и выдачу: новый CART — только после нового поиска (Т6, Р44 п. 4). Отказ по мандату — STOPPED до заказа.
   *  Сумма или валюта заказа ≠ CART — STOPPED ORDER_REPLY_MISMATCH. */
  placeOrder(m: Mutation): Promise<ShopOrder> {
    return this.#stage("ORDERED", async () => {
      const intent = this.#need(this.#intent);
      const cart = this.#need(this.#cart);
      const offers = this.#need(this.#lines);
      const basket = cart.cart;
      // CART без корзины или не с позициями выбора — ответ не той формы (инвариант 4); состав сверил клиент мандатов (sameTerms)
      if (basket === null || basket === undefined || basket.lines.length !== offers.length || basket.lines.some((l, i) => l.sku !== offers[i]!.sku)) {
        this.#halt("MANDATE_REPLY_MISMATCH");
      }
      this.#held(intent, cart);
      let checked = await this.#liveBeforeOrder(basket.lines, offers);
      // проверка по мандату непосредственно перед заказом (Р44 п. 5, Р-149): остаток не меньше итога CART, продавец и
      // валюта в пределах — иначе STOPPED до заказа, у продавца не остаётся неоплаченного заказа; ворота стадии 5 остаются
      await this.#scope(intent, cart);
      // два verify могли состарить живые проверки (до registry_cache_ttl_sec каждый): хоть одна старше
      // live_check_max_age_sec — все повторяются ровно один раз, без нового verify (Р46 п. 4, выбор 4а); итог повторной —
      // как первой (б). Возраст повторной — прямо перед заказом: старше — отказ LIVE_STALE путём Р44, второго круга нет (а1)
      if (checked.some((at) => this.#stale(at))) {
        checked = await this.#liveBeforeOrder(basket.lines, offers);
        this.#held(intent, cart);
        const i = checked.findIndex((at) => this.#stale(at));
        // решение — политикой (инвариант 3); `!d.allow` всегда истинно при ok: false — сужение типа
        const d = i >= 0 ? mayOrder({ ok: false, codes: ["LIVE_STALE"], offer: null }) : null;
        if (d !== null && !d.allow) this.#refuseOrder(basket.lines[i]!.sku, offers[i]!, d);
      }
      const shopId = offers[0]!.shopId;
      const order = await this.#guard(async () => {
        const reply = snapshot(await this.o.shop.order({ shopId, items: basket.lines.map((l) => ({ sku: l.sku, qty: l.qty })), cartMandateId: cart.id }, m));
        // номер заказа продавца — до снимка (Р45, решение 9а): не по маске или похож на номер карты — ни в снимок, ни в
        // журнал; у продавца остаётся неоплаченный заказ; стадия 5 проверяет ещё раз (второй рубеж)
        const issue = orderRefIssue(reply.orderId);
        if (issue !== null) {
          this.#record({ kind: "agent.refused", reason: "SHOP_ORDER_REF_INVALID", detail: issue, ...maskedMandate(cart.id) });
          this.#halt("SHOP_ORDER_REF_INVALID");
        }
        if (reply.total.amount !== basket.total.amount || reply.total.currency !== basket.total.currency) {
          // Д02 (Р48 п. 5): какая позиция расходится, по итогу не видно — помечаются все позиции заказа
          for (const l of basket.lines) this.o.orderMismatches.mark(offers[0]!.merchantId, l.sku);
          this.#halt("ORDER_REPLY_MISMATCH");
        }
        return reply;
      });
      this.#held(intent, cart);
      this.#order = order;
      this.#machine.to("ORDERED");
      return copy(order);
    });
  }

  /** Итог CART строго выше порога — меньшего из рыночного и клиентского (Р39 п. 1.5); итога нет или он не в RUB — да
   *  (fail-closed). Сведения для оболочки, а не ворота: после Р47 п. 2 подтверждения требует ADP, агент идёт в
   *  авторизацию и при итоге выше порога (Р-142). */
  get needsConfirmation(): boolean {
    const total = this.#cart?.cart?.total;
    if (total === undefined || !currencySupported(total)) return true;
    return needsConfirmation(total, this.#thresholds);
  }

  /** Порог для окна дробления (Р39 п. 4, Р-136): канала клиентского порога в ПАО нет (STATUS «Открыто», Р39) — только
   *  рыночный. Воротами стадии 5 порог не служит: подтверждения требует ADP (Р47 п. 2, Р-142). */
  get #thresholds(): Thresholds {
    return { marketKop: this.o.params.confirm_above_kop };
  }

  /** Стадия 5: авторизация через порт (AG-11): реквизит и пакет продавцу; итог — из события Платформы и GET операции
   *  (инвариант 8, Р49 п. 5). Итога нет в срок — порт отвечает PaymentFailure OPERATION_RESULT_UNCONFIRMED — STOPPED, место
   *  в окне дробления занято, повторной оплаты нет: из STOPPED переходов нет. Итог выше порога предварительного
   *  подтверждения не требует — его требует ADP (Р47 п. 2). DECLINED — STOPPED с кодом причины (SPEC §7б). Платформа
   *  требует подтверждения (PaymentFailure CONFIRMATION_REQUIRED порта или ответ CONFIRMATION_REQUIRED) — стадия 4. */
  authorize(m: Mutation): Promise<Operation> {
    return this.#stage("AUTHORIZING", async () => {
      const c = this.#context();
      this.#prepay(c.intent, c.cart);
      await this.#gate(c.intent, c.cart);
      // окно дробления — повторно после ворот (доля могла появиться, пока шёл verify) и сразу место в нём, без ожидания
      // между ними (Р39 п. 4): параллельная покупка под тем же INTENT увидит эту операцию. Место — после перехода:
      // отказ перехода не оставит в окне операцию, которой не было (ревью К2 М4)
      this.#prepay(c.intent, c.cart);
      this.#machine.to("AUTHORIZING");
      const slot = this.o.split.open(c.intent.id, this.#total(c.cart));
      const op = await this.#guard(async (): Promise<Operation | null> => {
        let reply: Operation;
        try {
          reply = snapshot(await this.o.payment.authorize(this.#forPayment(c), m));
        } catch (e) {
          // сбой или неизвестный исход (в том числе пакет передан, итог не подтверждён — Р45 п. 5) — место занято; так же
          // при ожидании подтверждения после DECLINED продавца (Р47 п. 6)
          slot.settle("UNKNOWN");
          // шаг прерван остановкой покупки (Р45, Б2в (а)) — наружу та же ошибка, что у остановленной стадии
          if (e === this.#machine.stopped.reason) throw this.#stopped(this.#machine.reason ?? "UNKNOWN");
          if (e instanceof PaymentFailure && e.code === "CONFIRMATION_REQUIRED") return null;
          throw e;
        }
        // отказ окно не занимает; сбой, неизвестный исход и CONFIRMATION_REQUIRED (дальше стадия 4, исход не известен —
        // Р47 п. 6, решение владельца по ревью К3 № 4) — занимают (fail-closed)
        // SETTLED на стадии 5 — событие одобрения прочитано поздно или потеряно, итог уже после клиринга: одобрение
        // подтверждено, расчёт заберёт settle (ревью КТ1 № 6, дополнение 1 к Р49)
        // REFUNDED — так же: одобрение, клиринг и возврат уже были, итог заберёт settle (Р51 п. 3). REVERSED — итог известен
        // (оплата отменена), но место в окне занято: клиринг после реверсала возможен (РП55, fail-closed)
        const approved = reply.status === "AUTHORIZED" || reply.status === "SETTLED" || reply.status === "REFUNDED";
        if (reply.status === "DECLINED") slot.settle("REFUSED");
        else if (approved) slot.settle("APPROVED");
        else slot.settle("UNKNOWN");
        if (reply.status === "DECLINED") this.#halt(ruleForDeclineReason(reply.declineReason).code);
        if (reply.status === "REVERSED") this.#reversed(reply);
        if (reply.status === "CONFIRMATION_REQUIRED") return null;
        if (!approved) this.#halt("UNKNOWN");
        return reply;
      });
      if (op === null) return this.#confirm(c);
      this.#operation = op;
      this.#authorizedAt = this.now().getTime();
      this.#held(c.intent, c.cart);
      this.#machine.to("SETTLING");
      return copy(op);
    });
  }

  /** Стадия 4 (Т7, Р47 п. 2–6): запрос создала ADP на отказе авторизации — решение человека в приложении банка, агент
   *  сам не подтверждает (инвариант 7). Ожидание — через порт: привязка, уведомление и статус по GET (модуль
   *  confirmations). Канала ссылки к продавцу до AG-13 ч. 2 нет — каждый исход в ч. 1 — STOPPED; переход
   *  CONFIRMING → AUTHORIZING в ч. 1 не проходит ни один путь. */
  async #confirm(c: Omit<PaymentContext, "signal" | "sending">): Promise<never> {
    this.#machine.to("CONFIRMING");
    const outcome = await this.#guard(async () => {
      try {
        return await this.o.payment.confirm(this.#forPayment(c), () => this.#notify("CONFIRMATION_PENDING"), this.#machine.stopped);
      } catch (e) {
        if (e === this.#machine.stopped.reason) throw this.#stopped(this.#machine.reason ?? "UNKNOWN");
        throw e;
      }
    });
    // мандаты вышли, пока человек решал (отзыв по ленте), — отказ действовать, как в воротах (Р38 п. 3)
    this.#held(c.intent, c.cart);
    // исход вне перечня (реализация порта вне ядра) — UNKNOWN, fail-closed
    this.#halt(Object.hasOwn(CONFIRMATION_STOP, outcome) ? CONFIRMATION_STOP[outcome] : "UNKNOWN");
  }

  /** Уведомление покупки после её итога (Р51 п. 4) — для наблюдения модуля операций: то же уведомление оболочки. */
  readonly #late = (code: PurchaseNotice, amount?: NoticeAmount): void => this.#notify(code, amount);

  /** Уведомление оболочки (В3): не ждётся; исключение и отказ обещания — запись notify.failed, исход не меняется. */
  #notify(code: PurchaseNotice, amount?: NoticeAmount): void {
    const failed = () => {
      try {
        this.#record({ kind: "notify.failed", reason: code });
      } catch {
        // журнал недоступен — покупка уже остановлена (#record); уведомление исход не меняет
      }
    };
    try {
      // сумма — копией: оболочка не меняет снимок операции покупки
      const r = amount === undefined ? this.o.notify?.(code) : this.o.notify?.(code, { ...amount });
      if (r !== undefined) Promise.resolve(r).catch(failed);
    } catch {
      failed();
    }
  }

  /** Стадия 6 (Р49 п. 6–7, Р51 п. 2–3): итог расчёта через порт — из события Платформы и GET; граница ожидания — от
   *  получения AUTHORIZED (`#authorizedAt`). Расчёта ещё нет, ожидание прервал вызывающий — SETTLEMENT_PENDING наружу,
   *  покупка остаётся SETTLING (settle() можно вызвать снова). SETTLED — DONE; REFUNDED (расчёт и возврат уже были) — DONE и
   *  уведомление OPERATION_REFUNDED; REVERSED — STOPPED с OPERATION_REVERSED; иное — STOPPED (после отправки пакета —
   *  OPERATION_RESULT_UNCONFIRMED, Р49 п. 2). scope_check не WITHIN_LIMITS — уведомление оболочки с суммой списания. */
  settle(signal?: AbortSignal): Promise<Operation> {
    // расчёт ждут днями: повторный вызов, пока первый ждёт, — то же ожидание, не запрещённый переход (ревью КТ1 № 7б)
    if (this.#busy && this.#machine.state === "SETTLING") return Promise.reject(new PaymentFailure("SETTLEMENT_PENDING"));
    return this.#stage("DONE", async () => {
      const authorized = this.#need(this.#operation);
      // остановка покупки прерывает ожидание расчёта так же, как сигнал вызывающего (ревью КТ1 № 7а)
      const until = signal === undefined ? this.#machine.stopped : AbortSignal.any([signal, this.#machine.stopped]);
      const authorizedAt = this.#authorizedAt === null ? undefined : new Date(this.#authorizedAt);
      const op = await this.#guard(async () => {
        const reply = snapshot(await this.o.payment.settle(copy(authorized), until, authorizedAt, this.#late));
        if (reply.status === "REVERSED") this.#reversed(reply);
        if (reply.status !== "SETTLED" && reply.status !== "REFUNDED") this.#halt("UNKNOWN");
        return reply;
      }, WAITS_SETTLEMENT);
      this.#operation = op;
      this.#machine.to("DONE");
      const notice = scopeNotice(op);
      if (notice !== null) this.#notify(notice, chargedAmount(op));
      if (op.status === "REFUNDED") this.#notify("OPERATION_REFUNDED", chargedAmount(op));
      return copy(op);
    });
  }

  /** Ворота перед стадией 5 (Р38 п. 3): проверка по мандату (`#scope`) непосредственно перед запросом реквизита, затем
   *  знак готовности продавца корзины по ПАО (Р53 п. 6): `ACTIVE` — дальше; `SUSPENDED` или `NONE` — STOPPED
   *  MERCHANT_NOT_READY; знак не проверен — STOPPED READINESS_UNAVAILABLE; отказ по агенту — код ПАО (или остановка
   *  подписи); после знака — держимые ещё раз (отзыв по ленте во время запроса знака); затем пропуск машины в AUTHORIZING. */
  async #gate(intent: Mandate, cart: Mandate): Promise<void> {
    await this.#scope(intent, cart);
    // продавец — из подписанного CART, как в #scope; знак перечитывается: между поиском и оплатой его могли приостановить
    const mark = await this.#guard(async () => {
      try {
        return await this.o.shop.readiness(cart.cart!.merchantId, this.#machine.stopped);
      } catch (e) {
        // запрос прерван остановкой покупки (параллельный вызов) — наружу та же ошибка, что у остановленной стадии
        if (e === this.#machine.stopped.reason) throw this.#stopped(this.#machine.reason ?? "UNKNOWN");
        throw e;
      }
    });
    if (mark.unverified !== undefined) this.#halt("READINESS_UNAVAILABLE");
    if (mark.status !== "ACTIVE") this.#halt("MERCHANT_NOT_READY");
    // знак — сетевое ожидание: мандат могли отозвать по ленте, пока он шёл (ревью КТ1 № 1) — без этого реквизит запрошен
    // по отозванному CART
    this.#held(intent, cart);
    // без пропуска машина не пустит в AUTHORIZING: запрещённый переход по К2.1, даже если таблица его разрешает
    this.#machine.passGate5();
  }

  /** Проверка по мандату (Р38 п. 3, Р40 п. 5, Р44 п. 5) — перед заказом, до стадии 4 и в воротах стадии 5: INTENT и CART оба среди держимых
   *  (сигнал, без сети), затем verify каждого и решение политики по нему (Р39 п. 1.1–1.3: остаток > 0, в валюте итога и
   *  не меньше итога, продавец и валюта в пределах; инвариант 6); после verify — держимые ещё раз (отзыв по ленте во время
   *  проверки). Отзыв — agent.refused MANDATE_NOT_ACTIVE; verify не CONFIRMED — MANDATE_OUT_OF_SCOPE (запись клиента
   *  мандатов); отказ политики — agent.refused с её кодом; всё — STOPPED до запроса подтверждения или реквизита. */
  async #scope(intent: Mandate, cart: Mandate): Promise<void> {
    const total = this.#total(cart);
    // продавец — из подписанного CART, как его видит Платформа (ревью К2 М3); с выдачей сверен клиентом мандатов
    const merchantId = cart.cart!.merchantId;
    this.#held(intent, cart);
    // verify по одному: не CONFIRMED — отказ клиента мандатов (MANDATE_OUT_OF_SCOPE, его запись); остальное решает
    // политика (Р39 п. 1.1–1.3) — после каждого verify, чтобы по INTENT вне пределов CART уже не проверялся
    const intentCheck = await this.#guard(() => this.o.mandates.requireActive(intent));
    this.#refuse(mandateRefusal(intent, intentCheck, total));
    const cartCheck = await this.#guard(() => this.o.mandates.requireActive(cart));
    this.#refuse(mayAuthorize({ intent, cart, merchantId, total }, { intent: intentCheck, cart: cartCheck }));
    this.#held(intent, cart);
  }

  /** Политика по сигналам A5 перед проектом CART (Р32 п. 2, Р40 п. 3–4): отказ — cart.refused по каждому сигналу, который
   *  человек не принял, и CartRefused; покупка остаётся в OFFERS. Подделка решения — agent.refused и STOPPED. */
  #draftable(verdict: OfferVerdict, purchase: CartPurchase, decision: HumanA5Decision | undefined): void {
    // EXCLUDED здесь не возникает (в contour только доступные товары): появился — дефект, а не тихий отказ (ревью К5 № 3);
    // в записи остановки — уточнение CART_POLICY_EXCLUDED, без agent.refused и cart.refused (Р40 п. 6, Р-109). Показ не
    // AVAILABLE — то же до решения политики (второй слой)
    if (verdict.kind !== "AVAILABLE") this.#halt("UNKNOWN", "CART_POLICY_EXCLUDED");
    const d = mayDraftCart(verdict, purchase, decision);
    if (d.allow) return;
    if (d.code === "EXCLUDED") this.#halt("UNKNOWN", "CART_POLICY_EXCLUDED");
    // решение не из оболочки — дефект или подмена вызывающего, а не «решения нет» (Р40 п. 4, как OFFER_NOT_IN_CONTOUR)
    if (d.code === "A5_DECISION_FORGED") {
      this.#record({ kind: "agent.refused", reason: "A5_DECISION_FORGED", ...skuRef(verdict.sku), ...merchantRef(verdict.merchantId) });
      this.#halt("A5_DECISION_FORGED");
    }
    // решение политики — в журнал конвейером (Р37 п. 5, Р38 п. 5): по каждому сигналу, который человек не принял
    const accepted = acceptedA5(verdict, purchase, decision);
    const open = d.code === "A5_NEEDS_HUMAN" ? verdict.a5.filter((c) => !accepted.includes(c)) : verdict.a5;
    for (const reason of open) this.#record({ kind: "cart.refused", reason, detail: d.code, ...skuRef(verdict.sku), ...merchantRef(verdict.merchantId) });
    throw new CartRefused(d.code);
  }

  /** Решения каталога — в журнал по каждому товару (Р37 п. 5): исключение — код модели или REGION, A5 — пометка. */
  #classify(shops: (ShopOffers | ShopUnavailable)[]): OfferZones {
    const zones: OfferZones = { contour: [], market: [], disclosure: { contour: "ZONE_CONTOUR", market: "ZONE_MARKET" }, unavailable: [] };
    for (const s of shops) {
      // магазин отказал в каталоге — недоступен, без обходов; поиск по остальным идёт дальше (Т4, Р42 п. 4)
      if ("unavailable" in s) {
        const cause: ShopUnavailableCause = s.unavailable.reason !== undefined ? { reason: s.unavailable.reason } : { detail: s.unavailable.detail };
        this.#record({ kind: "shop.unavailable", ...cause, ...(s.merchantId !== undefined ? merchantRef(s.merchantId) : {}) });
        zones.unavailable.push({ ...(s.shopId !== undefined && { shopId: s.shopId }), ...(s.merchantId !== undefined && { merchantId: s.merchantId }), cause });
        continue;
      }
      const { shop, shopIssues, products, dropped } = s.facts;
      const m = merchantRef(s.merchantId);
      // фид не разобран — товаров нет, исключён весь магазин: запись на код без sku
      if (shop === null) {
        for (const reason of shopIssues) this.#record({ kind: "offer.excluded", reason, ...m });
        continue;
      }
      // предложения, которые коннектор не перевёл (sku у них нет): запись на код без ref
      for (const reason of dropped) this.#record({ kind: "offer.excluded", reason, ...m });
      // магазин исключён, а товаров нет — запись на код магазина, как у неразобранного фида
      if (products.length === 0) for (const reason of shopIssues) this.#record({ kind: "offer.excluded", reason, ...m });
      for (const p of products) {
        const v = classifyOffer(p, shop, shopIssues, this.o.region, s.merchantId);
        const ref = { ...skuRef(p.product.sku), ...m };
        if (v.kind === "EXCLUDED") {
          if (v.reason === "MODEL") for (const reason of v.codes) this.#record({ kind: "offer.excluded", reason, ...ref });
          else this.#record({ kind: "offer.excluded", detail: "REGION", ...ref });
          continue;
        }
        for (const reason of v.a5) this.#record({ kind: "offer.flagged", reason, ...ref });
        // Д02 (Р48 п. 5): позиция уже расходилась с заказом у этого продавца — пометка в показе, источник — заказ
        if (this.o.orderMismatches.has(s.merchantId, p.product.sku) && !v.a5.includes("A5_PRICE_MISMATCH")) {
          v.a5.push("A5_PRICE_MISMATCH");
          this.#record({ kind: "offer.flagged", reason: "A5_PRICE_MISMATCH", detail: "ORDER_REPLY_MISMATCH", ...ref });
        }
        const offer: Offer = { shopId: shop.id, merchantId: s.merchantId, sku: p.product.sku, product: p.product, a5: v.a5 };
        if (s.inContour) zones.contour.push(offer);
        else zones.market.push({ ...offer, ...(s.link !== undefined && { link: s.link }) });
      }
    }
    return zones;
  }

  #context(): Omit<PaymentContext, "signal" | "sending"> {
    const [offer] = this.#need(this.#lines);
    if (offer === undefined) this.#halt("PIPELINE_TRANSITION_FORBIDDEN");
    return { intent: this.#need(this.#intent), cart: this.#need(this.#cart), shopId: offer.shopId, merchantId: offer.merchantId, order: this.#need(this.#order) };
  }

  /** Контекст шагу оплаты: копия снимков и связь с машиной — сигнал остановки и отметка «пакет уходит» (Р45, Б2в). */
  #forPayment(c: Omit<PaymentContext, "signal" | "sending">): PaymentContext {
    return { ...copy(c), signal: this.#machine.stopped, sending: () => this.#machine.sending(), notice: this.#late };
  }

  /** Стадия: переход не разрешён таблицей или идёт другая стадия — отказ машины до работы стадии (без обращений). */
  async #stage<T>(next: Exclude<PurchaseState, "STOPPED">, step: () => Promise<T>): Promise<T> {
    if (this.#busy) this.#machine.forbid(next);
    if (!allowed(this.#machine.state, next)) this.#machine.to(next);
    this.#busy = true;
    try {
      return await step();
    } finally {
      this.#busy = false;
    }
  }

  #need<T>(x: T | null): T {
    if (x === null) this.#halt("PIPELINE_TRANSITION_FORBIDDEN");
    return x;
  }

  /** Ворота (Р38 п. 3): мандаты держатся — лента не выводила их (отзыв, иной статус); иначе отказ действовать. */
  #held(...ms: Mandate[]): void {
    const held = new Set(this.o.mandates.held().map((m) => m.id));
    const out = ms.filter((m) => !held.has(m.id));
    if (out.length === 0) return;
    // отозван хоть один (GET дал REVOKED, запись mandate.revoked у клиента) — остановка кодом §7а: STOP_ALL (Р50 п. 4, Т13);
    // порядок мандатов не влияет (ревью КТ1 № 5). agent.refused — что увидели ворота: мандат не держится (нюанс Р50)
    const m = out.find((x) => this.o.mandates.revoked(x.id)) ?? out[0]!;
    this.#record({ kind: "agent.refused", reason: "MANDATE_NOT_ACTIVE", ...maskedMandate(m.id) });
    this.#halt(this.o.mandates.revoked(m.id) ? "MANDATE_REVOKED" : "MANDATE_NOT_ACTIVE");
  }

  /** Итог CART из своего снимка; CART без корзины — ответ не той формы (инвариант 4). */
  #total(cart: Mandate): Money {
    const total = cart.cart?.total;
    if (total === undefined) this.#halt("MANDATE_REPLY_MISMATCH");
    return total;
  }

  /** Политика до стадий 4–5 (Р39 п. 1.4, п. 4): итог не в RUB; доля в окне дробления по корневому INTENT. Отказ —
   *  agent.refused и STOPPED до запроса подтверждения и реквизита, без повтора (инвариант 7, 9). */
  #prepay(intent: Mandate, cart: Mandate): void {
    const total = this.#total(cart);
    if (!currencySupported(total)) this.#refuse({ allow: false, code: "CURRENCY_NOT_SUPPORTED" });
    if (this.o.split.isShare(intent.id, total, confirmThreshold(this.#thresholds))) this.#refuse({ allow: false, code: "SPLIT_WINDOW" });
  }

  /** Отказ политики — запись и STOPPED; mandate — по которому вышел отказ, иначе INTENT покупки (`#record`). */
  #refuse(d: PaymentDecision | null): void {
    if (d === null || d.allow) return;
    this.#record({ kind: "agent.refused", reason: d.code, ...(d.mandate && maskedMandate(d.mandate.id)) });
    this.#halt(d.code);
  }

  /** Живая проверка каждой позиции перед заказом (Р32 п. 3, Р44 п. 2): до первой не ok — отказ путём Р44. Итог — время
   *  каждой проверки (`checkedAt`, мс) для оценки возраста перед заказом (Р46 п. 4). */
  async #liveBeforeOrder(lines: readonly CartLine[], offers: readonly Offer[]): Promise<number[]> {
    const at: number[] = [];
    for (const [i, line] of lines.entries()) {
      const offer = offers[i]!;
      const req = { sku: line.sku, quantity: line.qty, ...(this.o.region !== undefined && { region: this.o.region }) };
      const live = await liveCheck(offer.product, req, this.o.live, this.o.params, () => this.now().getTime());
      this.#alive();
      const d = mayOrder(live);
      if (!d.allow) this.#refuseOrder(line.sku, offer, d);
      at.push(Date.parse(d.offer.checkedAt));
    }
    return at;
  }

  /** Проверка старше live_check_max_age_sec по часам агента; время не разобралось — старше (инвариант 4). */
  #stale(at: number): boolean {
    return !(this.now().getTime() - at <= this.o.params.live_check_max_age_sec * 1000);
  }

  /** Отказ перед заказом (Р44 п. 4): записи order.live_refused, оставленный CART, снимок стёрт, CART_ACTIVE → OFFERS. */
  #refuseOrder(sku: string, offer: Offer, d: Extract<OrderDecision, { allow: false }>): never {
    for (const reason of d.codes) this.#record({ kind: "order.live_refused", reason, detail: d.next, ...skuRef(sku), ...merchantRef(offer.merchantId) });
    // прежний CART больше не используется ничем и наружу как текущий не отдаётся — после любого отказа (Р44 п. 4,
    // выбор 4а; решение владельца по ревью КТ1 п. 1); новая цена — и выдача: новый CART только после нового поиска (Т6)
    this.#abandon("REFUSED_BEFORE_ORDER");
    if (this.#cart !== null) this.#relinquishCart(this.#cart.id); // Р63, дополнение 1 п. 1
    this.#cart = null;
    this.#lines = null;
    if (d.next === "NEW_CART_MANDATE") this.#zones = null;
    this.#machine.to("OFFERS");
    throw new OrderRefused(d.next, d.codes);
  }

  /** Оставленный CART — запись до того, как снимок стёрт (Р46 п. 3); CART не было — записи нет. Мандат — только CART:
   *  id не по маске — запись без mandate, а не с id INTENT (ревью reviewer К3 № 2). */
  #abandon(detail: CartAbandoned): void {
    if (this.#cart !== null) this.#record({ kind: "cart.abandoned", detail, ...maskedMandate(this.#cart.id) }, false);
  }

  /** После остановки (Р63 п. 7, дополнение 1): решение об отказе от CART по таблице; один раз на CART. Не бросает: сбой
   *  записи пропуска — без действия (остановка уже состоялась, отчёт ушёл). */
  #releaseOnStop(): void {
    if (this.#cartRelease !== "NONE" || this.#cartReleasing !== null) return;
    const cart = this.#cart;
    if (cart === null) {
      if (this.#cartRequested && CART_UNCONFIRMED.has(this.#machine.reason ?? "UNKNOWN")) this.#skipCart("UNKNOWN_CART");
      return;
    }
    this.#releaseCart(cart.id);
  }

  /** Ответ на запрос CART пришёл после остановки (КТ1 сессии 46 № 2 (б)): CART создан, а покупка его не использует —
   *  решение об отказе по нему, в том числе поверх UNKNOWN_CART (CART стал известен). При STOP_ALL — снят с удержания,
   *  как мандаты покупки в #stopAll (Р50 п. 4). Порядок с #releaseOnStop любой: решение одно. */
  #releaseLate(cart: Mandate): void {
    this.#cartRequested = false;
    const reason = this.#machine.reason;
    if (reason !== null && stopNext(reason) === "STOP_ALL") this.o.mandates.release(cart.id);
    if (this.#cartReleasing !== null || (this.#cartRelease !== "NONE" && this.#cartRelease !== "SKIPPED")) return;
    this.#releaseCart(cart.id);
  }

  /** Таблица причин (Р63 п. 7): пакет ушёл — KEPT; CART уже не действует — NOT_NEEDED; иначе фоновый отказ. */
  #releaseCart(id: string): void {
    if (this.#machine.paid) this.#skipCart("KEPT", id);
    else if (CART_NOT_NEEDED.has(this.#machine.reason ?? "UNKNOWN")) this.#skipCart("NOT_NEEDED", id);
    else this.#relinquishCart(id);
  }

  #skipCart(detail: CartReleaseSkip, id?: string): void {
    this.#cartRelease = detail === "KEPT" ? "KEPT" : detail === "NOT_NEEDED" ? "NOT_NEEDED" : "SKIPPED";
    try {
      this.#log({ kind: "cart.relinquish_skipped", detail, ...(id !== undefined && maskedMandate(id)) });
    } catch {
      // журнал недоступен: итог — в cartRelease
    }
  }

  /** Фоновый отказ от CART (Р63, дополнение 1 п. 2–4): защитное обращение с ключом cart-relinquish-<id>; цепочка ловит
   *  все ошибки — итог и ошибка в журнал и cartRelease (FAILED), необработанного отклонения нет. Предел времени — у
   *  адаптера и ограничителя (п. 3), своего таймера нет. */
  #relinquishCart(id: string): void {
    this.#cartRelease = "PENDING";
    const run = async (): Promise<CartRelease> => {
      if (this.o.signingStopped?.() === true) {
        this.#log({ kind: "cart.relinquish_skipped", detail: "STOPPED", ...maskedMandate(id) });
        return "SKIPPED";
      }
      let got: Mandate;
      try {
        got = await this.o.mandates.relinquish(id, { idempotencyKey: `cart-relinquish-${id}` });
      } catch (e) {
        if (this.o.signingStopped?.() === true) {
          this.#log({ kind: "cart.relinquish_skipped", detail: "STOPPED", ...maskedMandate(id) });
          return "SKIPPED";
        }
        const reason: DiagCode =
          e instanceof PlatformFailure ? e.code : e instanceof MandateRefused ? e.reason : (this.o.failureCode?.(e) ?? "UNKNOWN");
        this.#log({ kind: "cart.relinquish_failed", reason, ...maskedMandate(id) });
        return "FAILED";
      }
      // ответ или сверка GET — конечный статус (адаптер): отозван — отказ состоялся; иной конечный (EXPIRED, EXHAUSTED) —
      // CART уже не действует, отказ не нужен (решение владельца 28.10, КТ1 сессии 46 № 3)
      if (got.status !== "REVOKED") {
        this.#log({ kind: "cart.relinquish_skipped", detail: "NOT_NEEDED", ...maskedMandate(id) });
        return "NOT_NEEDED";
      }
      this.#log({ kind: "cart.relinquished", ...maskedMandate(id) });
      return "RELINQUISHED";
    };
    const releasing: Promise<CartRelease> = run()
      .catch((): CartRelease => "FAILED")
      .then((r) => {
        if (this.#cartReleasing === releasing) this.#cartRelease = r;
        return r;
      });
    this.#cartReleasing = releasing;
  }

  /** Запись фонового отказа: прямо в журнал, без остановки машины (#record останавливает и бросает — фону нельзя). */
  #log(e: DistributiveOmit<Parameters<PipelineJournal["record"]>[0], "at">): void {
    this.o.journal.record({ at: this.now().toISOString(), ...e } as Parameters<PipelineJournal["record"]>[0]);
  }

  /** Оплата отменена (Р51 п. 3): снимок операции REVERSED — до остановки, чтобы `purchase.operation` отдал op_ref и
   *  причину как есть (ревью КТ1 Р51 № 2); затем итоговая остановка OPERATION_REVERSED. */
  #reversed(op: Operation): never {
    this.#operation = op;
    this.#halt("OPERATION_REVERSED");
  }

  #halt(code: DiagCode, cause?: StopCause): never {
    this.#machine.stop(code, cause);
    this.#stopAll();
    // после отправки пакета наружу — тот же итоговый код, что у машины (Р49 п. 2)
    throw this.#stopped(this.#machine.outcome(code));
  }

  /** Отказ наружу с кодом остановки машины; `unfinished` — во всех местах, где он бросается, а не только в #halt (ревью
   *  КТ1 № 2: ожидающий шаг после STOP_ALL параллельного вызова). */
  #stopped(code: DiagCode, options?: { cause: unknown }): PurchaseStopped {
    return new PurchaseStopped(code, options, this.unfinished);
  }

  /** STOP_ALL (Р50 п. 4, Т13; A7 п. 6): по итоговому коду остановки — мандаты покупки сняты с удержания и дальше не
   *  используются, запись purchase.unfinished — что не завершено. У каждой покупки свой INTENT: «всё начатое по
   *  мандату» — эта покупка. Событие отзыва вне обращения — AG-14. */
  #stopAll(): void {
    const reason = this.#machine.reason;
    if (reason === null || stopNext(reason) !== "STOP_ALL") return;
    // запись — до исполнения: решение без записи не исполняется (инвариант 4; ревью КТ1 № 3)
    const unfinished = this.#machine.unfinished;
    if (unfinished !== null) this.#record({ kind: "purchase.unfinished", reason, detail: unfinished });
    this.o.mandates.release(...this.#mandateIds());
  }

  #mandateIds(): string[] {
    return [this.#intent?.id, this.#cart?.id].filter((id): id is string => id !== undefined);
  }

  /** Отказ клиента мандатов: «не действует» при отзыве мандата покупки (awaitSigned, каскад от INTENT) — код отзыва §7а,
   *  STOP_ALL (Р50 п. 4; ревью КТ1 № 4). */
  #refusal(reason: MandateRefused["reason"]): DiagCode {
    return reason === "MANDATE_NOT_ACTIVE" && this.#mandateIds().some((id) => this.o.mandates.revoked(id)) ? "MANDATE_REVOKED" : reason;
  }

  /** Отказ шага — STOPPED с кодом (Р38 п. 4); ожидание человека — без остановки; запрещённый переход — уже STOPPED.
   *  Ошибка без кода — UNKNOWN (инвариант 4), наружу — исходная. После успешного шага — покупка ещё не остановлена. */
  async #guard<T>(step: () => Promise<T>, waits: ReadonlySet<DiagCode> = NONE): Promise<T> {
    let result: T;
    try {
      result = await step();
    } catch (e) {
      if (e instanceof PurchaseTransitionForbidden || e instanceof PurchaseStopped) throw e;
      // отказ витрины на заказе, сбой списка витрин и шага оплаты — остановка этой сделки, не агента (Р42 п. 4, Р45, Р46 п. 2)
      const code =
        e instanceof MandateRefused
          ? this.#refusal(e.reason)
          : e instanceof PlatformFailure
            ? e.code
            : e instanceof ShopFailure || e instanceof PaymentFailure
              ? e.code
              : (this.o.failureCode?.(e) ?? "UNKNOWN");
      if (waits.has(code)) throw e;
      this.#machine.stop(code);
      this.#stopAll();
      // пакет уходил и код заменён: наружу — итоговый код машины, а не код шага с его текстом (Р49 п. 2, блокер Р-298;
      // ревью КТ1 № 1); итоговый код шага — его же ошибка
      if (this.#machine.paid && this.#machine.reason !== code) throw this.#stopped(this.#machine.reason ?? "OPERATION_RESULT_UNCONFIRMED", { cause: e });
      throw e;
    }
    this.#alive();
    return result;
  }

  /** Пока шаг ждал, покупку остановили (запрещённый переход параллельного вызова, ворота) — стадия дальше не идёт. */
  #alive(): void {
    if (this.#machine.state === "STOPPED") throw this.#stopped(this.#machine.reason ?? "UNKNOWN");
  }

  /** mandate — INTENT покупки, если запись не называет свой (ворота по CART). Сбой журнала — покупка остановлена
   *  (UNKNOWN), исходная ошибка наружу: решение без записи не исполняется (инвариант 4, ревью К5 № 1). */
  #record(e: DistributiveOmit<Parameters<PipelineJournal["record"]>[0], "at">, purchaseMandate = true): void {
    try {
      this.o.journal.record({ at: this.now().toISOString(), ...(purchaseMandate && this.#machine.mandate), ...e } as Parameters<PipelineJournal["record"]>[0]);
    } catch (err) {
      try {
        this.#machine.stop("UNKNOWN");
      } catch {
        // журнал недоступен и для purchase.stage: состояние машины уже STOPPED
      }
      if (this.#machine.paid) throw this.#stopped(this.#machine.reason ?? "OPERATION_RESULT_UNCONFIRMED", { cause: err });
      throw err;
    }
  }
}

/** Выбор — снимком: каждое поле и каждая позиция прочитаны один раз (Р-205); не массив позиций — пустой выбор. */
function pick(input: CartChoice): CartChoice {
  const { merchantId, lines, keyTermsShown } = input;
  const raw: unknown[] = Array.isArray(lines) ? Array.prototype.slice.call(lines) : [];
  const picked = raw.map((x) => {
    const { sku, qty, decision } = x as CartChoiceLine;
    return Object.freeze({ sku, qty, ...(decision !== undefined && { decision }) });
  });
  return Object.freeze({ merchantId, lines: Object.freeze(picked) as CartChoiceLine[], keyTermsShown });
}

/** Позиции корзины — свои копии (цена — из живой проверки). */
const keyLines = (lines: readonly CartLine[]): CartLine[] => lines.map((l) => ({ sku: l.sku, qty: l.qty, price: { ...l.price } }));

/** Проект CART: пределы — из INTENT, корзина — позиции по живым ценам продавца перед CART, итог — `cartTotal` (Р43 п.
 *  1–2, Р44 п. 3); живые цены сверяются ещё раз перед заказом (Р32 п. 3). */
function cartDraft(intent: Mandate, c: CartChoice, lines: CartLine[], total: Money): MandateDraft {
  return {
    kind: "CART",
    parentId: intent.id,
    subject: intent.subject,
    amountLimit: total,
    validTo: intent.validTo,
    merchantScope: [c.merchantId],
    principalRef: intent.principalRef,
    confirmationMode: intent.confirmationMode,
    keyTermsShown: c.keyTermsShown,
    cart: { merchantId: c.merchantId, lines, total },
  };
}

/** Свой снимок: глубокая копия, замороженная — ни порт, ни вызывающий его не изменят. */
function snapshot<T>(x: T): T {
  return deepFreeze(structuredClone(x));
}

function deepFreeze<T>(x: T): T {
  if (x !== null && typeof x === "object" && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}

/** Наружу — копия снимка: изменения вызывающего на решения конвейера не влияют. */
function copy<T>(x: T): T {
  return structuredClone(x);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// mandate_id и код продавца в журнале — по маске (Р37 п. 3, Р46 п. 1)
const maskedMandate = (id: string): { mandate?: string } => (SAFE_ID.test(id) ? { mandate: id } : {});
/** код продавца из выдачи — данные продавца: в журнале только по маске идентификатора (Р38 п. 5, инвариант 5) */
const merchantRef = (id: string): { merchant?: string } => (SAFE_ID.test(id) ? { merchant: id } : {});
