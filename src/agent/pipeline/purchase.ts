// Покупка по стадиям 0–6 (Р38 п. 2–4) поверх готовых частей: клиент мандатов (Р37 п. 4), лента (Р34), политика каталога
// (Р32), порты стадий. Переход — только через машину (machine.ts): таблица — «можно ли вообще», ворота стадий здесь —
// «выполнены ли условия сейчас». Ход покупки задаёт вызывающий: каждое действие человека — типизированный вход метода
// (инвариант 3). Состояние — только в памяти (Р38 п. 6).
import { PlatformFailure, type Mandate, type MandateDraft } from "../../shared/domain.js";
import type { DiagCode } from "../../shared/diag-codes.js";
import type { A5SignalCode, CatalogIssueCode, CatalogProduct } from "../catalog/index.js";
import { MandateRefused, type MandateClient } from "../mandates/index.js";
import { classifyOffer } from "../policy/catalog.js";
import type { FeedItem } from "../ports/events.js";
import type { Mutation } from "../ports/mutation.js";
import type { OfferSource, ShopOffers } from "../ports/shop.js";
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
      | { at: string; kind: "agent.refused"; reason: "MANDATE_NOT_ACTIVE"; mandate?: string },
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

/** Отказ подписи — ждать человека, а не останавливать покупку (SPEC §7а PRINCIPAL_SIGNATURE_PENDING). */
const WAITS_HUMAN: ReadonlySet<DiagCode> = new Set(["MANDATE_SIGNATURE_PENDING"]);

export class Purchase {
  readonly machine: PurchaseMachine;
  private readonly now: () => Date;
  #intent: Mandate | null = null;
  #zones: OfferZones | null = null;

  constructor(private readonly o: PurchaseOptions) {
    this.now = o.now ?? (() => new Date());
    this.machine = new PurchaseMachine({ journal: o.journal, now: this.now });
  }

  get state(): PurchaseState {
    return this.machine.state;
  }

  get intentMandate(): Mandate | null {
    return this.#intent;
  }

  /** Стадии 0–1: допуск и запрос INTENT. Подписи ещё нет — INTENT_PENDING, дальше `awaitIntent`; запрос сразу вернул
   *  ACTIVE (РП35) — INTENT_ACTIVE, `awaitIntent` не вызывается (повтор перехода запрещён), дальше `search`. Отказ
   *  допуска — только purchase.stage: причину уже записали подписант или старт (agent.stopped, admission.failed). */
  async intent(draft: MandateDraft, m: Mutation): Promise<Mandate> {
    this.#expect("INTENT_PENDING");
    const refused = this.o.admission();
    if (refused !== null) this.#halt(refused);
    const intent = await this.#guard(() => this.o.mandates.request(draft, m));
    this.machine.bind(intent.id);
    this.#intent = intent;
    this.machine.to(intent.status === "ACTIVE" ? "INTENT_ACTIVE" : "INTENT_PENDING");
    return intent;
  }

  /** Стадия 1: подпись INTENT человеком по ленте. Лента кончилась без подписи — покупка ждёт (MANDATE_SIGNATURE_PENDING
   *  наружу, состояние прежнее); иной отказ — STOPPED. */
  async awaitIntent(signal?: AbortSignal): Promise<Mandate> {
    this.#expect("INTENT_ACTIVE");
    const intent = this.#need(this.#intent);
    const signed = await this.#guard(() => this.o.mandates.awaitSigned(intent, this.o.events(signal), signal));
    this.#intent = signed;
    this.machine.to("INTENT_ACTIVE");
    return signed;
  }

  /** Стадия 2: выдача в двух зонах. Перед поиском — INTENT держится и подтверждён verify (Т2); решения каталога —
   *  в журнал (Р37 п. 5): `policy/` журнала не получает (инвариант 3). */
  async search(): Promise<OfferZones> {
    this.#expect("OFFERS");
    const intent = this.#need(this.#intent);
    this.#held(intent);
    await this.#guard(() => this.o.mandates.requireActive(intent));
    const shops = await this.#guard(() => this.o.offers.search(intent));
    // разбор выдачи — тоже шаг стадии: сбой формы или журнала — STOPPED, а не покупка в прежнем состоянии (инвариант 4)
    const zones = await this.#guard(async () => this.#classify(shops));
    // отзыв мог прийти по ленте, пока шёл поиск (ревью К2.2 № 15)
    this.#held(intent);
    this.#zones = zones;
    this.machine.to("OFFERS");
    return zones;
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

  get offers(): OfferZones | null {
    return this.#zones;
  }

  /** Переход не разрешён таблицей — отказ машины до работы стадии (без обращений к Платформе). */
  #expect(next: Exclude<PurchaseState, "STOPPED">): void {
    if (!allowed(this.machine.state, next)) this.machine.to(next);
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
    this.machine.stop(code);
    throw new PurchaseStopped(code);
  }

  /** Отказ шага — STOPPED с кодом (Р38 п. 4); ожидание человека — без остановки; запрещённый переход — уже STOPPED.
   *  Ошибка без кода — UNKNOWN (инвариант 4), наружу — исходная. */
  async #guard<T>(step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (e) {
      if (e instanceof PurchaseTransitionForbidden || e instanceof PurchaseStopped) throw e;
      const code = e instanceof MandateRefused ? e.reason : e instanceof PlatformFailure ? e.code : (this.o.failureCode?.(e) ?? "UNKNOWN");
      if (!WAITS_HUMAN.has(code)) this.machine.stop(code);
      throw e;
    }
  }

  /** mandate — INTENT покупки, если запись не называет свой (ворота по CART). */
  #record(e: DistributiveOmit<Parameters<PipelineJournal["record"]>[0], "at">): void {
    this.o.journal.record({ at: this.now().toISOString(), ...this.machine.mandate, ...e } as Parameters<PipelineJournal["record"]>[0]);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const MANDATE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const maskedMandate = (id: string): { mandate?: string } => (MANDATE_ID.test(id) ? { mandate: id } : {});
