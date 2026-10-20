// Покупка по стадиям 0–6 (Р38 п. 2–4) поверх готовых частей: клиент мандатов (Р37 п. 4), лента (Р34), политика каталога
// (Р32), порты стадий. Переход — только через машину (machine.ts): таблица — «можно ли вообще», ворота стадий здесь —
// «выполнены ли условия сейчас». Ход покупки задаёт вызывающий: каждое действие человека — типизированный вход метода
// (инвариант 3). Состояние — только в памяти (Р38 п. 6).
import type { StandParams } from "../../shared/config.js";
import { PlatformFailure, type Mandate, type MandateDraft, type Operation } from "../../shared/domain.js";
import type { DiagCode } from "../../shared/diag-codes.js";
import { liveCheck, type A5SignalCode, type CatalogIssueCode, type CatalogProduct, type LiveCheckParams, type LiveFactCode } from "../catalog/index.js";
import { ruleForDeclineReason } from "../declines/index.js";
import { MandateRefused, type MandateClient } from "../mandates/index.js";
import { classifyOffer, mayDraftCart, mayOrder, type HumanA5Decision, type OrderNext } from "../policy/catalog.js";
import type { LiveOfferSource } from "../ports/catalog.js";
import type { FeedItem } from "../ports/events.js";
import type { Mutation } from "../ports/mutation.js";
import type { OfferSource, PaymentContext, PaymentSteps, ShopOffers, ShopOrder, ShopPort } from "../ports/shop.js";
import { PurchaseMachine, PurchaseTransitionForbidden, allowed, type PurchaseJournal, type PurchaseState } from "./machine.js";

/** Записи конвейера сверх записей машины (Р38 п. 5, Р37 п. 5). */
export interface PipelineJournal extends PurchaseJournal {
  record(
    entry:
      | Parameters<PurchaseJournal["record"]>[0]
      /** ошибка модели каталога — reason; нет доставки в регион — detail REGION без reason; ref — sku по маске */
      | { at: string; kind: "offer.excluded"; reason: CatalogIssueCode; ref?: string; mandate?: string }
      | { at: string; kind: "offer.excluded"; detail: "REGION"; ref?: string; mandate?: string }
      /** сигнал A5 — показ с пометкой */
      | { at: string; kind: "offer.flagged"; reason: A5SignalCode; ref?: string; mandate?: string }
      /** ворота: держимый мандат вышел (отзыв, иной статус) — отказ действовать (Р38 п. 3) */
      | { at: string; kind: "agent.refused"; reason: "MANDATE_NOT_ACTIVE"; mandate?: string }
      /** выбор человека не из контура гарантий выдачи (Р38 п. 2, поправка К3) — отказ действовать; ref — sku по маске */
      | { at: string; kind: "agent.refused"; reason: "OFFER_NOT_IN_CONTOUR"; ref?: string; mandate?: string },
  ): void;
}

/** Товар выдачи. `a5` непустой — показ с пометкой «сведения продавца противоречивы» (Р32 п. 1). */
export interface Offer {
  shopId: string;
  merchantId: string;
  sku: string;
  product: CatalogProduct;
  a5: A5SignalCode[];
}

/** Две зоны (Р3, Т5): по зоне вне контура гарантий покупки нет — человеку ссылка (инвариант 10). */
export interface OfferZones {
  contour: Offer[];
  market: Offer[];
}

/** Выбор человека на стадии 3 — ключом товара выдачи этой покупки (`merchantId` + `sku`); `decision` — явное решение
 *  человека по сигналам A5 из оболочки (Р32 п. 2); `keyTermsShown` — карточка CART показана (Т3а). */
export interface CartChoice {
  merchantId: string;
  sku: string;
  qty: number;
  decision?: HumanA5Decision;
  keyTermsShown: boolean;
}

/** Проект корзины не готовится (Р32 п. 2): покупка остаётся в OFFERS, обращений не было (Р38 п. 4, поправка К3). */
export class CartRefused extends Error {
  constructor(readonly code: "EXCLUDED" | "A5_AUTONOMOUS" | "A5_NEEDS_HUMAN") {
    super(`Корзина не готовится: ${code}`);
    this.name = "CartRefused";
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
const SKU = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const skuRef = (sku: string): { ref?: string } => (SKU.test(sku) ? { ref: sku } : {});

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
  #offer: Offer | null = null;
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
   *  в журнал (Р37 п. 5): `policy/` журнала не получает (инвариант 3). */
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
      this.#machine.to("OFFERS");
      return copy(zones);
    });
  }

  /** Стадия 3: выбор человека → проект CART (Р32 п. 2) → мандат корзины с родителем INTENT. Товар ищется по ключу в своей
   *  выдаче (зона, A5, цена — из неё, не от вызывающего). Отказ политики — CartRefused, покупка остаётся в OFFERS,
   *  обращений нет. Перед CART — INTENT держится и подтверждён verify (Р38 п. 3). CART сразу ACTIVE (РП35) —
   *  CART_PENDING и CART_ACTIVE подряд, `awaitCart` не вызывается. */
  cart(choice: CartChoice, m: Mutation): Promise<Mandate> {
    return this.#stage("CART_PENDING", async () => {
      const intent = this.#need(this.#intent);
      // товар — только из контура гарантий этой выдачи: по зоне вне контура покупки нет (инвариант 10); выбор вне контура —
      // дефект или подмена вызывающего, а не решение политики — остановка (Р38 п. 2, поправка К3, решение владельца 20.10)
      const offer = this.#zones?.contour.find((x) => x.merchantId === choice.merchantId && x.sku === choice.sku);
      if (offer === undefined) {
        this.#record({ kind: "agent.refused", reason: "OFFER_NOT_IN_CONTOUR", ...skuRef(String(choice.sku)) });
        this.#halt("OFFER_NOT_IN_CONTOUR");
      }
      const d = mayDraftCart(offer.sku, { kind: "AVAILABLE", a5: [...offer.a5] }, intent.confirmationMode, choice.decision);
      if (!d.allow) throw new CartRefused(d.code);
      this.#held(intent);
      await this.#guard(() => this.o.mandates.requireActive(intent));
      const cart = snapshot(await this.#guard(() => this.o.mandates.request(cartDraft(intent, offer, choice), m, intent)));
      this.#offer = offer;
      this.#cart = cart;
      this.#approved = false;
      this.#machine.to("CART_PENDING");
      if (cart.status === "ACTIVE") this.#machine.to("CART_ACTIVE");
      return copy(cart);
    });
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

  /** Стадия 3: живая проверка непосредственно перед заказом (Р32 п. 3) → заказ у продавца → сверка суммы (Т6). Позиции
   *  заказа и проверки — из подписанного CART, магазин — из своей выдачи. Проверка не ok — OrderRefused,
   *  CART_ACTIVE → OFFERS (Р38 п. 1); сумма или валюта заказа ≠ CART — STOPPED ORDER_REPLY_MISMATCH. */
  placeOrder(m: Mutation): Promise<ShopOrder> {
    return this.#stage("ORDERED", async () => {
      const intent = this.#need(this.#intent);
      const cart = this.#need(this.#cart);
      const offer = this.#need(this.#offer);
      const basket = cart.cart;
      const line = basket?.lines.length === 1 ? basket.lines[0] : undefined;
      // CART без корзины или не с одной позицией — ответ не той формы (инвариант 4); состав сверил клиент мандатов (sameTerms)
      if (basket === null || basket === undefined || line === undefined) this.#halt("MANDATE_REPLY_MISMATCH");
      this.#held(intent, cart);
      const req = { sku: line.sku, quantity: line.qty, ...(this.o.region !== undefined && { region: this.o.region }) };
      const live = await liveCheck(offer.product, req, this.o.live, this.o.params, () => this.now().getTime());
      this.#alive();
      const d = mayOrder(live);
      if (!d.allow) {
        this.#machine.to("OFFERS");
        throw new OrderRefused(d.next, d.codes);
      }
      const order = await this.#guard(async () => {
        const reply = snapshot(await this.o.shop.order({ shopId: offer.shopId, items: [{ sku: line.sku, qty: line.qty }], cartMandateId: cart.id }, m));
        if (reply.total.amount !== basket.total.amount || reply.total.currency !== basket.total.currency) this.#halt("ORDER_REPLY_MISMATCH");
        return reply;
      });
      this.#held(intent, cart);
      this.#order = order;
      this.#machine.to("ORDERED");
      return copy(order);
    });
  }

  /** Нужна ли стадия 4 (Т7): итог CART строго выше порога `confirm_above_kop`; порог — в копейках, иная валюта —
   *  нужна (fail-closed). Итог — из своего снимка CART. Ответ Платформы CONFIRMATION_REQUIRED на стадии 5 — `authorize`. */
  get needsConfirmation(): boolean {
    const total = this.#cart?.cart?.total;
    if (total === undefined) return true;
    return total.currency !== "RUB" || total.amount > this.o.params.confirm_above_kop;
  }

  /** Стадия 4: подтверждение человеком через порт (AG-13): исход — из события Платформы, конвейер его не создаёт
   *  (инвариант 7). Без надобности — запрещённый переход. Не APPROVED — STOPPED CONFIRMATION_REQUIRED. */
  confirm(signal?: AbortSignal): Promise<void> {
    return this.#stage("CONFIRMING", async () => {
      if (!this.needsConfirmation) this.#machine.forbid("CONFIRMING");
      const c = this.#context();
      this.#held(c.intent, c.cart);
      this.#machine.to("CONFIRMING");
      const status = await this.#guard(() => this.o.payment.confirm(copy(c), signal));
      this.#held(c.intent, c.cart);
      if (status !== "APPROVED") this.#halt("CONFIRMATION_REQUIRED");
      this.#approved = true;
    });
  }

  /** Стадия 5: авторизация через порт (AG-11): реквизит и пакет продавцу; итог — из события Платформы (инвариант 8).
   *  Подтверждение нужно, а APPROVED не получен (из ORDERED или пока стадия 4 ждёт) — запрещённый переход. DECLINED —
   *  STOPPED с кодом причины (SPEC §7б); Платформа требует подтверждения — STOPPED CONFIRMATION_REQUIRED (инвариант 7). */
  authorize(m: Mutation): Promise<Operation> {
    return this.#stage("AUTHORIZING", async () => {
      if (this.needsConfirmation && !this.#approved) this.#machine.forbid("AUTHORIZING");
      const c = this.#context();
      await this.#gate(c.intent, c.cart);
      this.#machine.to("AUTHORIZING");
      const op = await this.#guard(async () => {
        const reply = snapshot(await this.o.payment.authorize(copy(c), m));
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

  /** Ворота перед стадией 5 (Р38 п. 3): INTENT и CART оба среди держимых (сигнал, без сети) и оба подтверждены verify
   *  (решение, инвариант 6) — непосредственно перед запросом реквизита; после verify — держимые ещё раз (отзыв по ленте
   *  во время проверки). Отзыв — agent.refused MANDATE_NOT_ACTIVE; verify не CONFIRMED — MANDATE_OUT_OF_SCOPE (запись
   *  клиента мандатов); и то и другое — STOPPED до реквизита. */
  async #gate(intent: Mandate, cart: Mandate): Promise<void> {
    this.#held(intent, cart);
    await this.#guard(() => this.o.mandates.requireActive(intent));
    await this.#guard(() => this.o.mandates.requireActive(cart));
    this.#held(intent, cart);
    // без пропуска машина не пустит в AUTHORIZING: запрещённый переход по К2.1, даже если таблица его разрешает
    this.#machine.passGate5();
  }

  /** Решения каталога — в журнал по каждому товару (Р37 п. 5): исключение — код модели или REGION, A5 — пометка. */
  #classify(shops: ShopOffers[]): OfferZones {
    const zones: OfferZones = { contour: [], market: [] };
    for (const s of shops) {
      const { shop, shopIssues, products, dropped } = s.facts;
      // фид не разобран — товаров нет, исключён весь магазин: запись на код без sku
      if (shop === null) {
        for (const reason of shopIssues) this.#record({ kind: "offer.excluded", reason });
        continue;
      }
      // предложения, которые коннектор не перевёл (sku у них нет): запись на код без ref
      for (const reason of dropped) this.#record({ kind: "offer.excluded", reason });
      // магазин исключён, а товаров нет — запись на код магазина, как у неразобранного фида
      if (products.length === 0) for (const reason of shopIssues) this.#record({ kind: "offer.excluded", reason });
      for (const p of products) {
        const v = classifyOffer(p, shop, shopIssues, this.o.region);
        const ref = skuRef(p.product.sku);
        if (v.kind === "EXCLUDED") {
          if (v.reason === "MODEL") for (const reason of v.codes) this.#record({ kind: "offer.excluded", reason, ...ref });
          else this.#record({ kind: "offer.excluded", detail: "REGION", ...ref });
          continue;
        }
        for (const reason of v.a5) this.#record({ kind: "offer.flagged", reason, ...ref });
        (s.inContour ? zones.contour : zones.market).push({ shopId: shop.id, merchantId: s.merchantId, sku: p.product.sku, product: p.product, a5: v.a5 });
      }
    }
    return zones;
  }

  #context(): PaymentContext {
    const offer = this.#need(this.#offer);
    return { intent: this.#need(this.#intent), cart: this.#need(this.#cart), shopId: offer.shopId, merchantId: offer.merchantId, order: this.#need(this.#order) };
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

  #halt(code: DiagCode): never {
    this.#machine.stop(code);
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
      const code = e instanceof MandateRefused ? e.reason : e instanceof PlatformFailure ? e.code : (this.o.failureCode?.(e) ?? "UNKNOWN");
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

  /** mandate — INTENT покупки, если запись не называет свой (ворота по CART). */
  #record(e: DistributiveOmit<Parameters<PipelineJournal["record"]>[0], "at">): void {
    this.o.journal.record({ at: this.now().toISOString(), ...this.#machine.mandate, ...e } as Parameters<PipelineJournal["record"]>[0]);
  }
}

/** Проект CART: пределы — из INTENT, корзина — одна позиция по цене своей выдачи; живая цена сверяется перед заказом. */
function cartDraft(intent: Mandate, offer: Offer, c: CartChoice): MandateDraft {
  const price = { ...offer.product.price };
  const total = { amount: price.amount * c.qty, currency: price.currency };
  return {
    kind: "CART",
    parentId: intent.id,
    subject: intent.subject,
    amountLimit: total,
    validTo: intent.validTo,
    merchantScope: [offer.merchantId],
    principalRef: intent.principalRef,
    confirmationMode: intent.confirmationMode,
    keyTermsShown: c.keyTermsShown,
    cart: { merchantId: offer.merchantId, lines: [{ sku: offer.sku, qty: c.qty, price }], total },
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

const MANDATE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const maskedMandate = (id: string): { mandate?: string } => (MANDATE_ID.test(id) ? { mandate: id } : {});
