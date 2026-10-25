// Покупка конвейера на стенде Платформы и эмуляторе продавцов (Р38 п. 8, Р42): клиент мандатов на стенде, лента стенда с
// курсором, адаптер витрин (stand-shop.ts; факты магазина и товара — из витрин эмулятора, Р54 п. 4), стадии 4–6 — тестовый порт PaymentSteps или шаги
// профиля contour (`contourPayment`, Р45): реквизит по ПАО стенда и пакет агентской оплаты витрине эмулятора; ожидание
// подтверждения — модуль подтверждений ядра на ленте стенда (Р47).
// Подпись INTENT и CART — эмулятором банка во время ожидания, решение — по событию mandate.signed (Р29 п. 5, Р34 п. 5).
import { expect } from "vitest";
import { MERCHANT_FIXTURES } from "agentic-ps-platform/fixtures";
import type { ShopsAdapter } from "../../src/agent/adapters/shops/index.js";
import { Confirmations } from "../../src/agent/confirmations/index.js";
import { MandateClient } from "../../src/agent/mandates/index.js";
import { Operations } from "../../src/agent/operations/index.js";
import { ContourPayment } from "../../src/agent/payment-package/index.js";
import { Purchase } from "../../src/agent/pipeline/index.js";
import { OrderPriceMismatches, SplitWindow } from "../../src/agent/policy/index.js";
import type { FeedItem, HttpRequestSigning, NoticeAmount, PaymentPlatform, PurchaseNotice } from "../../src/agent/ports/index.js";
import { loadParams, parseParams, type StandParams } from "../../src/shared/config.js";
import type { DiagCode } from "../../src/shared/diag-codes.js";
import type { Mandate } from "../../src/shared/domain.js";
import { INTENT } from "./consents.js";
import { createContour, type Contour } from "./contour.js";
import { payments } from "./shop.js";
import { standShops } from "./stand-shop.js";

/** Регион человека — общий регион доставки всех полных витрин эмулятора (с фактами магазина; у неполной `returns` нет), в
 *  их системе кодов — ISO 3166-2 (Р54 нюанс К3.1; ревью КТ1 reviewer № 5): из фикстур, не литералом. */
const FULL_SHOPS = MERCHANT_FIXTURES.filter((f) => f.returns !== undefined);
export const STAND_REGION = FULL_SHOPS[0]?.delivery_regions.find((r) => FULL_SHOPS.every((f) => f.delivery_regions.includes(r)));
if (STAND_REGION === undefined) throw new Error("у полных витрин эмулятора нет общего региона доставки");

/** Стенд в процессе теста под параллельной нагрузкой прогона бывает медленнее 5 с (нюанс К2.3 Р38). */
export const STAND_TIMEOUT_MS = 30_000;

/** Срок стадии 5 в тестах, где события operation.* не будет: не больше 1 с от стендового, чтобы тест не ждал полный срок
 *  (ревью КТ1 AG-11 ч. 2 № 13; ревью КТ1 Р51 № 5). Производное от конфигурации, не литерал. */
export const SHORT_DELAY_SEC = Math.min(loadParams().operation_outcome_max_delay_sec, 1);

export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Лента стенда с курсором: читает, пока ожидание не завершится; пустой ответ — пауза и снова (не больше `polls` раз). */
export function feedOf(platform: PaymentPlatform, polls = 100) {
  return async function* events(signal?: AbortSignal): AsyncIterable<FeedItem> {
    let cursor: string | null = null;
    for (let i = 0; i < polls && !signal?.aborted; i++) {
      const items = await platform.listEvents(cursor);
      if (items.length === 0) await pause(50);
      for (const item of items) {
        cursor = item.kind === "event" ? item.event.eventId : item.eventId;
        yield item;
      }
    }
  };
}

export interface StandPurchaseOptions {
  /** подмена ответа витрины поверх настоящего обращения к эмулятору — только то, чего эмулятор выдать не может */
  fetch?: typeof fetch;
  /** подпись обращений к витринам не ключом агента контура */
  signing?: HttpRequestSigning;
  /** стендовые параметры покупки поверх config/params.stand.json (граница порога подтверждения и т. п.): проходят схему
   *  запуска (`parseParams`); клиент мандатов работает на параметрах контура — порог ему не нужен */
  params?: Partial<StandParams>;
  /** стадии 4–6 — шаги профиля contour, как у места сборки (compose.payment, Р45 п. 6), а не тестовый порт */
  contourPayment?: boolean;
  /** выдача реквизита поверх настоящей платформы контура — действие теста посреди стадии 5 (параллельный вызов, Р45 Б2в) */
  issue?: (real: PaymentPlatform["issuePaymentPackage"]) => PaymentPlatform["issuePaymentPackage"];
  /** уведомление оболочки (Р47 п. 5, В3) */
  notify?: (code: PurchaseNotice, amount?: NoticeAmount) => void | Promise<void>;
  /** часы клиента ПАО и модуля подтверждений — тест двигает их вместе с часами стенда (истечение, РП51 п. 6) */
  now?: () => Date;
  /** часы конвейера (свежесть живой проверки сравнивается с ними, Р54 п. 6): подпись обращений и ПАО — на своих часах */
  purchaseNow?: () => Date;
  /** таймер модуля подтверждений — тест срабатывает его сам (срок решения — минуты по order_hold_sec Платформы) */
  confirmationTimer?: (fn: () => void, ms: number) => () => void;
  /** ПОДМЕНА ДО PS-11: авторизация продавца доходит до ADP стенда копией сообщения (createContour, `adpUntilPs11`) */
  adpUntilPs11?: boolean;
  /** код остановки сделки по исключению шага — как у места сборки (`startFailureCode`, compose.ts); без него — UNKNOWN */
  failureCode?: (e: unknown) => DiagCode | null;
}

/** Контур со стендом и витринами после start(), покупка на адаптере витрин. Закрыть — `c.close()` у вызывающего. */
export async function standPurchase(o: StandPurchaseOptions = {}) {
  const c: Contour = await createContour({ pao: "stand", ...(o.now && { now: o.now }), ...(o.adpUntilPs11 && { adpUntilPs11: true }) });
  const self = await c.start();
  const { stand } = c;
  if (!stand) throw new Error("контур без стенда");
  const mandates = new MandateClient({ port: c.platform, params: c.params, journal: c.journal });
  const shops: ShopsAdapter = standShops(c, o);
  // тестовый порт остаётся для проверок «обращений к оплате не было»; конвейер получает шаги contour, если заданы
  const payment = payments();
  const real: PaymentPlatform["issuePaymentPackage"] = (d, m) => c.platform.issuePaymentPackage(d, m);
  const platform = { issuePaymentPackage: o.issue ? o.issue(real) : real };
  const params = parseParams({ ...c.params, ...o.params });
  // модули подтверждений и операций на ленте стенда, как у места сборки (compose): wake — одно чтение ленты со своим
  // курсором, событие — обоим слушателям; слушатель упал — курсор на месте, событие прочитается снова (Р34 п. 3)
  let cursor: string | null = null;
  const wake = async () => {
    const items = await c.platform.listEvents(cursor);
    if (items.length === 0) await pause(20);
    for (const item of items) {
      await confirmations.listener(item);
      await operations.listener(item);
      cursor = item.kind === "event" ? item.event.eventId : item.eventId;
    }
  };
  const confirmations: Confirmations = new Confirmations({
    port: c.platform,
    journal: c.journal,
    params,
    ...(o.now && { now: o.now }),
    ...(o.confirmationTimer && { timer: o.confirmationTimer }),
    wake,
  });
  const operations: Operations = new Operations({ port: c.platform, journal: c.journal, params, ...(o.now && { now: o.now }), wake });
  const steps = o.contourPayment ? new ContourPayment({ platform, shop: shops, journal: c.journal, confirmations, operations, params }) : payment;
  const split = new SplitWindow(params, () => new Date());
  // пометка Д02 — одна на ядро, как у места сборки (Р48 п. 5): следующая покупка (next) видит расхождение прежней
  const orderMismatches = new OrderPriceMismatches();
  const next = () =>
    new Purchase({
      mandates,
      events: feedOf(c.platform),
      offers: shops,
      live: shops,
      shop: shops,
      payment: steps,
      params,
      split,
      orderMismatches,
      journal: c.journal,
      admission: () => c.admission(),
      // регион человека — в кодах регионов доставки витрин: у эмулятора ISO 3166-2 (#45, Р54 нюанс К3.1)
      region: STAND_REGION,
      ...(o.purchaseNow && { now: o.purchaseNow }),
      ...(o.notify !== undefined && { notify: o.notify }),
      ...(o.failureCode !== undefined && { failureCode: o.failureCode }),
    });
  const purchase = next();
  /** обращений к ПАО за мандатом id — GET мандата */
  const gets = (id: string) => c.calls().filter((x) => x.target === "pao" && x.route === `GET /pao/v1/mandates/${id}`).length;
  /** Подпись человека во время ожидания: после первого GET ожидания — эмулятор банка подписывает, решение — по событию. */
  async function signWhileWaiting(id: string, wait: () => Promise<unknown>) {
    const before = gets(id);
    const waiting = wait();
    for (let i = 0; gets(id) === before && i < 200; i++) await pause(10);
    expect(gets(id)).toBe(before + 1);
    expect((await stand!.issuer.sign(id)).statusCode).toBe(200);
    await waiting;
    // GET до ожидания и GET по событию mandate.signed: решение принято по событию ленты (Р29 п. 5, Р34 п. 5)
    expect(gets(id)).toBe(before + 2);
  }
  /** INTENT на всех продавцов фикстур подписан человеком — покупка готова к поиску. */
  async function signedIntent(): Promise<Mandate> {
    const intent = await purchase.intent({ ...INTENT, merchantScope: MERCHANT_FIXTURES.map((f) => f.merchant_id) }, { idempotencyKey: "idem-intent-stand" });
    await signWhileWaiting(intent.id, () => purchase.awaitIntent());
    return intent;
  }
  // readFeed — одно чтение ленты тем же курсором, что у ожиданий: после итога покупки ленту читает оболочка (events.items)
  // или push, а не конвейер — тест делает это сам (наблюдение после итога, Р51 п. 4)
  return { c, self, stand, purchase, next, orderMismatches, payment, split, params, confirmations, signWhileWaiting, signedIntent, readFeed: wake };
}
