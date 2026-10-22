// Покупка по стадиям 0–6 (Р38 п. 2–4) поверх готовых частей: клиент мандатов (Р37 п. 4), лента (Р34), политика каталога
// (Р32), порты стадий. Переход — только через машину (machine.ts): таблица — «можно ли вообще», ворота стадий здесь —
// «выполнены ли условия сейчас». Ход покупки задаёт вызывающий: каждое действие человека — типизированный вход метода
// (инвариант 3). Состояние — только в памяти (Р38 п. 6).
import type { StandParams } from "../../shared/config.js";
import { PlatformFailure, type CartLine, type Mandate, type MandateDraft, type Money, type Operation } from "../../shared/domain.js";
import type { DiagCode } from "../../shared/diag-codes.js";
import { SAFE_ID, SHOP_ID } from "../../shared/ids.js";
import { liveCheck, type A5SignalCode, type CatalogIssueCode, type CatalogProduct, type LiveCheckParams, type LiveFactCode } from "../catalog/index.js";
import { ruleForDeclineReason } from "../declines/index.js";
import { MandateRefused, type MandateClient } from "../mandates/index.js";
import { issuedByShell, spend } from "../policy/a5-issued.js";
import { acceptedA5, cartTotal, classifyOffer, mayDraftCart, mayOrder, type CartPurchase, type HumanA5Decision, type OfferVerdict, type OrderNext } from "../policy/catalog.js";
import { confirmThreshold, currencySupported, mandateRefusal, mayAuthorize, needsConfirmation, type PaymentDecision, type Thresholds } from "../policy/payment.js";
import type { SplitWindow } from "../policy/split.js";
import type { LiveOfferSource } from "../ports/catalog.js";
import type { FeedItem } from "../ports/events.js";
import type { Mutation } from "../ports/mutation.js";
import { orderRefIssue, type OrderRefIssue } from "../payment-package/order-ref.js";
import { PaymentFailure, ShopFailure, type OfferSource, type PaymentContext, type PaymentSteps, type ShopOffers, type ShopOrder, type ShopPort, type ShopUnavailable, type ShopUnavailableCause } from "../ports/shop.js";
import { PurchaseMachine, PurchaseTransitionForbidden, allowed, type PurchaseJournal, type PurchaseState, type StopCause } from "./machine.js";

/** Записи конвейера сверх записей машины (Р38 п. 5, Р37 п. 5). */
export interface PipelineJournal extends PurchaseJournal {
  record(
    entry:
      | Parameters<PurchaseJournal["record"]>[0]
      /** ошибка модели каталога — reason; нет доставки в регион — detail REGION без reason; ref — sku, merchant — код
       *  продавца, оба по маске (у решений каталога ниже — так же) */
      | { at: string; kind: "offer.excluded"; reason: CatalogIssueCode; ref?: string; mandate?: string; merchant?: string }
      | { at: string; kind: "offer.excluded"; detail: "REGION"; ref?: string; mandate?: string; merchant?: string }
      /** сигнал A5 — показ с пометкой */
      | { at: string; kind: "offer.flagged"; reason: A5SignalCode; ref?: string; mandate?: string; merchant?: string }
      /** проект CART не готовится (Р32 п. 2, Р40 п. 4): reason — код сигнала A5, detail — решение политики */
      | { at: string; kind: "cart.refused"; reason: A5SignalCode; detail: CartRefusal; ref?: string; mandate?: string; merchant?: string }
      /** заказа нет — живая проверка не ok (Р32 п. 3–4): reason — код проверки, detail — следующий шаг */
      | { at: string; kind: "order.live_refused"; reason: LiveFactCode; detail: OrderNext; ref?: string; mandate?: string; merchant?: string }
      /** запроса CART нет — живая проверка перед ним не ok (Р43 п. 1): как order.live_refused */
      | { at: string; kind: "cart.live_refused"; reason: LiveFactCode; detail: OrderNext; ref?: string; mandate?: string; merchant?: string }
      /** магазин отказал в каталоге (Т4, Р42 п. 4): detail — код витрины, BAD_RESPONSE или NO_RESPONSE; reason — код вне
       *  перечня; merchant — код продавца по маске */
      | ({ at: string; kind: "shop.unavailable"; mandate?: string; merchant?: string } & ShopUnavailableCause)
      /** ворота: держимый мандат вышел (отзыв, иной статус) — отказ действовать (Р38 п. 3) */
      | { at: string; kind: "agent.refused"; reason: "MANDATE_NOT_ACTIVE"; mandate?: string }
      /** ворота: остатка Платформы по мандату не хватает на итог CART (Р38 п. 3, К4а) */
      | { at: string; kind: "agent.refused"; reason: "MANDATE_AMOUNT_LEFT_INSUFFICIENT"; mandate?: string }
      /** политика в воротах: verify CONFIRMED, но остаток 0 или в чужой валюте, продавец или валюта итога вне пределов
       *  мандата (Р39 п. 1.1, 1.3; К2а) */
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
      | { at: string; kind: "agent.refused"; reason: "SHOP_ORDER_REF_INVALID"; detail: OrderRefIssue; mandate?: string },
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
  constructor(readonly code: DiagCode) {
    super(`Покупка остановлена: ${code}`);
    this.name = "PurchaseStopped";
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
  journal: PipelineJournal;
  /** стадия 0 (Р38 п. 2): null — последний start() дал допуск (Р36 п. 6) и подпись не остановлена; иначе код остановки */
  admission: () => DiagCode | null;
  /** код остановки по ошибке вне ядра (остановленная подпись — у места сборки); null — не знает */
  failureCode?: (e: unknown) => DiagCode | null;
  /** регион человека из профиля; нет — доступен только самовывоз (Р32 п. 5) */
  region?: string;
  now?: () => Date;
}

/** sku из фида — в журнале только по маске идентификатора (Р38 п. 5, инвариант 5). */
const skuRef = (sku: string): { ref?: string } => (SHOP_ID.test(sku) ? { ref: sku } : {});

/** Отказ подписи — ждать человека, а не останавливать покупку (SPEC §7а PRINCIPAL_SIGNATURE_PENDING); только у ожидания
 *  подписи мандата: тот же код из порта витрины или оплаты — остановка (ревью К3 повторное Н1, инвариант 4). */
const WAITS_HUMAN: ReadonlySet<DiagCode> = new Set(["MANDATE_SIGNATURE_PENDING"]);
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
  /** стадия 4 пройдена: порт вернул APPROVED (ревью К3 № 4); вторая защита — иной выход из стадии 4 уже STOPPED */
  #approved = false;
  /** стадия идёт: повторный вход до её окончания — запрещённый переход (ревью К3 № 4) */
  #busy = false;

  constructor(private readonly o: PurchaseOptions) {
    this.now = o.now ?? (() => new Date());
    this.#machine = new PurchaseMachine({ journal: o.journal, now: this.now });
  }

  get state(): PurchaseState {
    return this.#machine.state;
  }

  /** Код остановки; до STOPPED — null. */
  get reason(): DiagCode | null {
    return this.#machine.reason;
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
   *  в журнал (Р37 п. 5): `policy/` журнала не получает (инвариант 3). Новая выдача стирает снимок прежнего CART (К2а). */
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
      // показ — из своей выдачи: продавец, sku, цена и коды A5, к которым привязано решение человека (Р39 п. 5), и
      // покупка — корневой INTENT (Р40 п. 1)
      const verdicts = offers.map((o): Extract<OfferVerdict, { kind: "AVAILABLE" }> => ({ kind: "AVAILABLE", merchantId: o.merchantId, sku: o.sku, price: { ...o.product.price }, a5: [...o.a5] }));
      const purchase: CartPurchase = { intentId: intent.id, mode: intent.confirmationMode };
      verdicts.forEach((v, i) => this.#draftable(v, purchase, choice.lines[i]!.decision));
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
      const cart = snapshot(await this.#guard(() => this.o.mandates.request(cartDraft(intent, choice, keyLines(lines), total), m, intent)));
      this.#lines = Object.freeze(offers);
      this.#cart = cart;
      this.#approved = false;
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
      for (const [i, line] of basket.lines.entries()) {
        const offer = offers[i]!;
        const req = { sku: line.sku, quantity: line.qty, ...(this.o.region !== undefined && { region: this.o.region }) };
        const live = await liveCheck(offer.product, req, this.o.live, this.o.params, () => this.now().getTime());
        this.#alive();
        const d = mayOrder(live);
        if (d.allow) continue;
        for (const reason of d.codes) this.#record({ kind: "order.live_refused", reason, detail: d.next, ...skuRef(line.sku), ...merchantRef(offer.merchantId) });
        // прежний CART больше не используется ничем и наружу как текущий не отдаётся — после любого отказа (Р44 п. 4,
        // выбор 4а; решение владельца по ревью КТ1 п. 1); новая цена — и выдача: новый CART только после нового поиска (Т6)
        this.#cart = null;
        this.#lines = null;
        if (d.next === "NEW_CART_MANDATE") this.#zones = null;
        this.#machine.to("OFFERS");
        throw new OrderRefused(d.next, d.codes);
      }
      // проверка по мандату непосредственно перед заказом (Р44 п. 5, Р-149): остаток не меньше итога CART, продавец и
      // валюта в пределах — иначе STOPPED до заказа, у продавца не остаётся неоплаченного заказа; ворота стадии 5 остаются
      await this.#scope(intent, cart);
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
        if (reply.total.amount !== basket.total.amount || reply.total.currency !== basket.total.currency) this.#halt("ORDER_REPLY_MISMATCH");
        return reply;
      });
      this.#held(intent, cart);
      this.#order = order;
      this.#machine.to("ORDERED");
      return copy(order);
    });
  }

  /** Нужна ли стадия 4 (Т7): итог CART строго выше порога — меньшего из рыночного и клиентского (Р39 п. 1.5). Итога нет
   *  или он не в RUB — нужна (fail-closed): ни `confirm()`, ни `authorize()` такую покупку дальше не пустят — валюта
   *  проверяется в обоих до проверки стадии 4 (`#prepay`, CURRENCY_NOT_SUPPORTED). Итог — из своего снимка CART. Ответ
   *  Платформы CONFIRMATION_REQUIRED на стадии 5 — `authorize`. */
  get needsConfirmation(): boolean {
    const total = this.#cart?.cart?.total;
    if (total === undefined || !currencySupported(total)) return true;
    return needsConfirmation(total, this.#thresholds);
  }

  /** Канала клиентского порога в ПАО нет (STATUS «Открыто», Р39) — только рыночный. */
  get #thresholds(): Thresholds {
    return { marketKop: this.o.params.confirm_above_kop };
  }

  /** Стадия 4: подтверждение человеком через порт (AG-13): исход — из события Платформы, конвейер его не создаёт
   *  (инвариант 7). Без надобности — запрещённый переход. До запроса — та же проверка по мандату, что в воротах стадии 5
   *  (Р40 п. 5): человека не просят подтвердить покупку, которую ворота затем отклонят. Не APPROVED — STOPPED
   *  CONFIRMATION_REQUIRED. */
  confirm(signal?: AbortSignal): Promise<void> {
    return this.#stage("CONFIRMING", async () => {
      // валюта и доля — до решения о стадии 4: код отказа не зависит от пути вызывающего (ревью К2 В1)
      const c = this.#context();
      this.#prepay(c.intent, c.cart);
      if (!this.needsConfirmation) this.#machine.forbid("CONFIRMING");
      await this.#scope(c.intent, c.cart);
      this.#machine.to("CONFIRMING");
      const status = await this.#guard(() => this.o.payment.confirm(this.#forPayment(c), signal));
      this.#held(c.intent, c.cart);
      if (status !== "APPROVED") this.#halt("CONFIRMATION_REQUIRED");
      this.#approved = true;
    });
  }

  /** Стадия 5: авторизация через порт (AG-11): реквизит и пакет продавцу; итог — из события Платформы (инвариант 8). До
   *  событий операции (PS-16) порт профиля contour отвечает PaymentFailure OPERATION_RESULT_UNCONFIRMED — STOPPED, место в
   *  окне дробления занято, повторной оплаты нет: из STOPPED переходов нет (Р45 п. 5).
   *  Подтверждение нужно, а APPROVED не получен (из ORDERED или пока стадия 4 ждёт) — запрещённый переход. DECLINED —
   *  STOPPED с кодом причины (SPEC §7б); Платформа требует подтверждения — STOPPED CONFIRMATION_REQUIRED (инвариант 7). */
  authorize(m: Mutation): Promise<Operation> {
    return this.#stage("AUTHORIZING", async () => {
      const c = this.#context();
      this.#prepay(c.intent, c.cart);
      if (this.needsConfirmation && !this.#approved) this.#machine.forbid("AUTHORIZING");
      await this.#gate(c.intent, c.cart);
      // окно дробления — повторно после ворот (доля могла появиться, пока шёл verify) и сразу место в нём, без ожидания
      // между ними (Р39 п. 4): параллельная покупка под тем же INTENT увидит эту операцию. Место — после перехода:
      // отказ перехода не оставит в окне операцию, которой не было (ревью К2 М4)
      this.#prepay(c.intent, c.cart);
      this.#machine.to("AUTHORIZING");
      const slot = this.o.split.open(c.intent.id, this.#total(c.cart));
      const op = await this.#guard(async () => {
        let reply: Operation;
        try {
          reply = snapshot(await this.o.payment.authorize(this.#forPayment(c), m));
        } catch (e) {
          // сбой или неизвестный исход (в том числе пакет передан, итог не подтверждён — Р45 п. 5) — место занято
          slot.settle("UNKNOWN");
          // шаг прерван остановкой покупки (Р45, Б2в (а)) — наружу та же ошибка, что у остановленной стадии
          if (e === this.#machine.stopped.reason) throw new PurchaseStopped(this.#machine.reason ?? "UNKNOWN");
          throw e;
        }
        // отказ и CONFIRMATION_REQUIRED окно не занимают; сбой и неизвестный исход — занимают (fail-closed)
        if (reply.status === "DECLINED" || reply.status === "CONFIRMATION_REQUIRED") slot.settle("REFUSED");
        else if (reply.status === "AUTHORIZED") slot.settle("APPROVED");
        else slot.settle("UNKNOWN");
        if (reply.status === "DECLINED") this.#halt(ruleForDeclineReason(reply.declineReason).code);
        if (reply.status === "CONFIRMATION_REQUIRED") this.#halt("CONFIRMATION_REQUIRED");
        if (reply.status !== "AUTHORIZED") this.#halt("UNKNOWN");
        return reply;
      });
      this.#operation = op;
      this.#held(c.intent, c.cart);
      this.#machine.to("SETTLING");
      return copy(op);
    });
  }

  /** Стадия 6: итог расчёта через порт (AG-11), из события Платформы. Не SETTLED — STOPPED UNKNOWN (инвариант 4). */
  settle(signal?: AbortSignal): Promise<Operation> {
    return this.#stage("DONE", async () => {
      const authorized = this.#need(this.#operation);
      const op = await this.#guard(async () => {
        const reply = snapshot(await this.o.payment.settle(copy(authorized), signal));
        if (reply.status !== "SETTLED") this.#halt("UNKNOWN");
        return reply;
      });
      this.#operation = op;
      this.#machine.to("DONE");
      return copy(op);
    });
  }

  /** Ворота перед стадией 5 (Р38 п. 3): проверка по мандату (`#scope`) непосредственно перед запросом реквизита, затем
   *  пропуск машины в AUTHORIZING. */
  async #gate(intent: Mandate, cart: Mandate): Promise<void> {
    await this.#scope(intent, cart);
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
    return { ...copy(c), signal: this.#machine.stopped, sending: () => this.#machine.sending() };
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
    for (const m of ms) {
      if (held.has(m.id)) continue;
      this.#record({ kind: "agent.refused", reason: "MANDATE_NOT_ACTIVE", ...maskedMandate(m.id) });
      this.#halt("MANDATE_NOT_ACTIVE");
    }
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

  #halt(code: DiagCode, cause?: StopCause): never {
    this.#machine.stop(code, cause);
    throw new PurchaseStopped(code);
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
          ? e.reason
          : e instanceof PlatformFailure
            ? e.code
            : e instanceof ShopFailure || e instanceof PaymentFailure
              ? e.code
              : (this.o.failureCode?.(e) ?? "UNKNOWN");
      if (!waits.has(code)) this.#machine.stop(code);
      throw e;
    }
    this.#alive();
    return result;
  }

  /** Пока шаг ждал, покупку остановили (запрещённый переход параллельного вызова, ворота) — стадия дальше не идёт. */
  #alive(): void {
    if (this.#machine.state === "STOPPED") throw new PurchaseStopped(this.#machine.reason ?? "UNKNOWN");
  }

  /** mandate — INTENT покупки, если запись не называет свой (ворота по CART). Сбой журнала — покупка остановлена
   *  (UNKNOWN), исходная ошибка наружу: решение без записи не исполняется (инвариант 4, ревью К5 № 1). */
  #record(e: DistributiveOmit<Parameters<PipelineJournal["record"]>[0], "at">): void {
    try {
      this.o.journal.record({ at: this.now().toISOString(), ...this.#machine.mandate, ...e } as Parameters<PipelineJournal["record"]>[0]);
    } catch (err) {
      try {
        this.#machine.stop("UNKNOWN");
      } catch {
        // журнал недоступен и для purchase.stage: состояние машины уже STOPPED
      }
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
