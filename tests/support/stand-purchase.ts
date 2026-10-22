// Покупка конвейера на стенде Платформы и эмуляторе продавцов (Р38 п. 8, Р42): клиент мандатов на стенде, лента стенда с
// курсором, адаптер витрин (stand-shop.ts, ТЕСТОВЫЙ ПРОФИЛЬ магазина), стадии 4–6 — тестовый порт PaymentSteps или шаги
// профиля contour (`contourPayment`, Р45): реквизит по ПАО стенда и пакет агентской оплаты витрине эмулятора.
// Подпись INTENT и CART — эмулятором банка во время ожидания, решение — по событию mandate.signed (Р29 п. 5, Р34 п. 5).
import { expect } from "vitest";
import { MERCHANT_FIXTURES } from "agentic-ps-platform/fixtures";
import type { ShopsAdapter, ShopProfile } from "../../src/agent/adapters/shops/index.js";
import { MandateClient } from "../../src/agent/mandates/index.js";
import { ContourPayment } from "../../src/agent/payment-package/index.js";
import { Purchase } from "../../src/agent/pipeline/index.js";
import { SplitWindow } from "../../src/agent/policy/index.js";
import type { FeedItem, HttpRequestSigning, PaymentPlatform } from "../../src/agent/ports/index.js";
import { parseParams, type StandParams } from "../../src/shared/config.js";
import type { Mandate } from "../../src/shared/domain.js";
import { INTENT } from "./consents.js";
import { createContour, type Contour } from "./contour.js";
import { payments } from "./shop.js";
import { standShops } from "./stand-shop.js";

/** Стенд в процессе теста под параллельной нагрузкой прогона бывает медленнее 5 с (нюанс К2.3 Р38). */
export const STAND_TIMEOUT_MS = 30_000;

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
  profile?: (shopId: string) => ShopProfile | null;
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
}

/** Контур со стендом и витринами после start(), покупка на адаптере витрин. Закрыть — `c.close()` у вызывающего. */
export async function standPurchase(o: StandPurchaseOptions = {}) {
  const c: Contour = await createContour({ pao: "stand" });
  const self = await c.start();
  const { stand } = c;
  if (!stand) throw new Error("контур без стенда");
  const mandates = new MandateClient({ port: c.platform, params: c.params, journal: c.journal });
  const shops: ShopsAdapter = standShops(c, o);
  // тестовый порт остаётся для проверок «обращений к оплате не было»; конвейер получает шаги contour, если заданы
  const payment = payments();
  const real: PaymentPlatform["issuePaymentPackage"] = (d, m) => c.platform.issuePaymentPackage(d, m);
  const platform = { issuePaymentPackage: o.issue ? o.issue(real) : real };
  const steps = o.contourPayment ? new ContourPayment({ platform, shop: shops, journal: c.journal }) : payment;
  const params = parseParams({ ...c.params, ...o.params });
  const split = new SplitWindow(params, () => new Date());
  const purchase = new Purchase({
    mandates,
    events: feedOf(c.platform),
    offers: shops,
    live: shops,
    shop: shops,
    payment: steps,
    params,
    split,
    journal: c.journal,
    admission: () => c.admission(),
    region: "77",
  });
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
  return { c, self, stand, purchase, payment, split, params, signWhileWaiting, signedIntent };
}
