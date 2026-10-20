// Покупка конвейера (Р38) на PaoStub: ядро с допуском, клиент мандатов на эмуляции согласий (consents.ts), тестовые порты
// стадий (shop.ts). Ленты у PaoStub нет — элементы ленты задаёт тест (`setFeed`) до ожидания подписи.
import { Purchase } from "../../src/agent/pipeline/index.js";
import type { FeedItem, LiveOfferSource, OfferSource, PaymentSteps, ShopPort } from "../../src/agent/ports/index.js";
import { loadParams } from "../../src/shared/config.js";
import type { Journal } from "../../src/agent/journal/index.js";
import type { DiagCode } from "../../src/shared/diag-codes.js";
import type { MandateDraft } from "../../src/shared/domain.js";
import { Consents, INTENT, feed } from "./consents.js";
import { coreOn } from "./core.js";
import { PaoStand } from "./pao-stand.js";
import { BAKERY_FEED, bakery, feedOffers, liveOffers, payments, shopOrders, type FeedShop } from "./shop.js";

export const SHOP: FeedShop = { feed: BAKERY_FEED, profile: bakery(), merchantId: "shop_1" };

export interface PurchaseSetup {
  shops?: FeedShop[];
  /** код отказа допуска; null — допуск есть */
  admission?: DiagCode | null;
  /** null — регион человека неизвестен (в профиле нет) */
  region?: string | null;
  offers?: OfferSource;
  live?: LiveOfferSource;
  shop?: ShopPort;
  payment?: PaymentSteps;
  /** запись журнала до журнала ядра: бросает — сбой журнала (ревью К5 № 1) */
  tap?: (entry: Parameters<Journal["record"]>[0]) => void;
  /** стендовые параметры поверх config/params.stand.json (граница порога и т. п.) */
  params?: Partial<ReturnType<typeof loadParams>>;
}

/** `track` получает стенд до первого обращения — тест закрывает его и проверяет нарушения схемы в afterEach. */
export async function purchaseOn(o: PurchaseSetup, track: (s: PaoStand) => void) {
  const consents: Consents = new Consents(() => s.clock);
  const s = new PaoStand({ handlers: consents.handlers() });
  track(s);
  const { core, journal } = await coreOn(s);
  await core.start();
  const first = (o.shops ?? [SHOP])[0]!;
  const offers = o.offers ?? feedOffers(...(o.shops ?? [SHOP]));
  const live = o.live ?? liveOffers(first, () => s.clock);
  const shop = o.shop ?? shopOrders(first);
  const payment = o.payment ?? payments();
  let items: FeedItem[] = [];
  let stream: (() => AsyncIterable<FeedItem>) | null = null;
  const purchase = new Purchase({
    mandates: core.mandates,
    events: () => (stream ? stream() : feed(...items)),
    offers,
    live,
    shop,
    payment,
    params: { ...loadParams(), ...o.params },
    journal: { record: (e) => (o.tap?.(e), core.journal.record(e)) },
    admission: () => o.admission ?? null,
    ...(o.region !== null && { region: o.region ?? "77" }),
    now: () => s.clock,
  });
  const start = journal.entries.length;
  const tail = () => journal.entries.slice(start);
  return {
    core,
    journal,
    consents,
    stand: s,
    offers: offers as OfferSource & { calls?: number },
    live: live as LiveOfferSource & { calls?: unknown[] },
    shop: shop as ShopPort & { calls?: unknown[] },
    payment: payment as PaymentSteps & { calls?: string[] },
    purchase,
    tail,
    setFeed: (...x: FeedItem[]) => ((items = x), (stream = null)),
    /** лента с действиями по ходу ожидания (отзыв посреди ожидания подписи) */
    setStream: (x: () => AsyncIterable<FeedItem>) => (stream = x),
  };
}

export type PurchaseRun = Awaited<ReturnType<typeof purchaseOn>>;

/** Покупка до INTENT_ACTIVE: запрос и подпись человека по ленте. */
export async function signedIntent(r: PurchaseRun, draft: MandateDraft = INTENT) {
  const m = await r.purchase.intent(draft, { idempotencyKey: "idem-intent-1" });
  r.setFeed({ kind: "event", event: r.consents.sign(m.id) });
  return r.purchase.awaitIntent();
}

/** Переходы покупки по журналу: состояние, при STOPPED — «STOPPED:код». */
export const stages = (r: { tail: () => { kind: string; detail?: string; reason?: string }[] }) =>
  r.tail().filter((e) => e.kind === "purchase.stage").map((e) => (e.reason ? `${e.detail}:${e.reason}` : e.detail));
