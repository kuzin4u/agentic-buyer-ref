// Тестовые порты стадий конвейера (Р38 п. 8): выдача из фида YML (tests/fixtures) — до AG-09 (подписанные обращения
// к витринам), живое предложение, заказ и шаги оплаты — до AG-09, AG-11, AG-13. Не поведение продавца, а подготовленные
// факты `catalog/readFeed` и исходы, которые задаёт тест.
import { readFileSync } from "node:fs";
import { readFeed, type CatalogShop } from "../../src/agent/catalog/index.js";
import type { Money, Operation } from "../../src/shared/domain.js";
import type {
  ConfirmationOutcome,
  LiveOffer,
  LiveOfferRequest,
  LiveOfferSource,
  OfferSource,
  PaymentContext,
  PaymentSteps,
  ShopOffers,
  ShopOrder,
  ShopOrderRequest,
  ShopPort,
} from "../../src/agent/ports/index.js";

export const BAKERY_FEED = readFileSync(new URL("../fixtures/massa-madre.yml", import.meta.url), "utf8");

export const bakery = (over: Partial<CatalogShop> = {}): CatalogShop => ({
  id: "massa-madre",
  inn: "7705123452",
  mcc: "5462",
  paymentMethods: ["sbp", "card"],
  deliveryRegions: ["77"],
  returns: { days: 0, text: "Продовольственные товары надлежащего качества возврату не подлежат" },
  ...over,
});

export interface FeedShop {
  feed: string;
  profile: CatalogShop;
  merchantId: string;
  inContour?: boolean;
}

/** Выдача из фидов; `calls` — сколько раз спросили (обращений до ворот быть не должно). */
export function feedOffers(...shops: FeedShop[]): OfferSource & { calls: number } {
  const src = {
    calls: 0,
    search: async (): Promise<ShopOffers[]> => {
      src.calls++;
      return shops.map((s) => ({
        merchantId: s.merchantId,
        inContour: s.inContour ?? true,
        facts: readFeed(s.feed, s.profile, { exponent: 2, offset: "+03:00" }),
      }));
    },
  };
  return src;
}

/** Цена товара по фиду — источник цены для тестовых живого предложения и витрины. */
export function feedPrice(s: FeedShop, sku: string): Money {
  const p = readFeed(s.feed, s.profile, { exponent: 2, offset: "+03:00" }).products.find((x) => x.product.sku === sku);
  if (!p) throw new Error(`нет товара ${sku} в фиде`);
  return p.product.price;
}

/** Живое предложение продавца: по умолчанию цена — как в фиде, в наличии, время ответа — часы стенда; `over` меняет ответ,
 *  `n` — номер вызова с 1 (перед CART и перед заказом — по вызову, Р43 п. 1). */
export function liveOffers(s: FeedShop, clock: () => Date, over: (req: LiveOfferRequest, n: number) => Partial<LiveOffer> = () => ({})): LiveOfferSource & { calls: LiveOfferRequest[] } {
  const src = {
    calls: [] as LiveOfferRequest[],
    fetch: async (req: LiveOfferRequest): Promise<LiveOffer> => {
      src.calls.push(req);
      return { sku: req.sku, price: feedPrice(s, req.sku), availability: { inStock: true }, checkedAt: clock().toISOString(), ...over(req, src.calls.length) };
    },
  };
  return src;
}

/** Знак готовности продавца по ПАО для ворот стадии 5 — ACTIVE: ворота знака проверяются своими тестами (Р53 п. 6). */
export const READY: Pick<ShopPort, "readiness"> = { readiness: async () => ({ status: "ACTIVE" }) };

/** Витрина: сумму заказа считает «продавец» по цене фида — Σ по позициям; `total` — подмена суммы (дефект продавца). */
export function shopOrders(s: FeedShop, total?: (req: ShopOrderRequest) => Money): ShopPort & { calls: ShopOrderRequest[] } {
  const port = {
    ...READY,
    calls: [] as ShopOrderRequest[],
    order: async (req: ShopOrderRequest): Promise<ShopOrder> => {
      port.calls.push(req);
      const sum = req.items.reduce((acc, l) => acc + feedPrice(s, l.sku).amount * l.qty, 0);
      return { orderId: `ord_${port.calls.length}`, total: total ? total(req) : { amount: sum, currency: feedPrice(s, req.items[0]!.sku).currency } };
    },
  };
  return port;
}

/** Шаги оплаты (стадии 4–6) до AG-11 и AG-13: исходы задаёт тест; `calls` — какие шаги вызваны, `carts` — id CART и
 *  сумма заказа в контексте каждого `confirm` и `authorize` (Р44 п. 4: оплата только по CART, итог которого = заказу). */
export function payments(
  o: { confirm?: ConfirmationOutcome; authorize?: Partial<Operation>; settle?: Operation["status"] | ((x: Operation, authorizedAt?: Date) => Promise<Operation>) } = {},
): PaymentSteps & { calls: string[]; carts: { cart: string; total: Money | undefined; order: Money }[] } {
  const seen = (c: PaymentContext) => steps.carts.push({ cart: c.cart.id, total: c.cart.cart?.total, order: c.order.total });
  const op = (c: PaymentContext, over: Partial<Operation>): Operation => ({
    opRef: "op_1",
    orderRef: c.order.orderId,
    channel: "CARD",
    amount: c.order.total,
    merchantId: c.merchantId,
    indicator: null,
    status: "AUTHORIZED",
    declineReason: null,
    fulfilment: null,
    ...over,
  });
  const steps = {
    calls: [] as string[],
    carts: [] as { cart: string; total: Money | undefined; order: Money }[],
    // уведомление — как у модуля ядра: только когда запрос привязан и был PENDING (не NONE и не UNBOUND, В3)
    confirm: async (c: PaymentContext, notify: () => void): Promise<ConfirmationOutcome> => {
      steps.calls.push("confirm");
      seen(c);
      const outcome = o.confirm ?? "APPROVED";
      if (outcome !== "NONE" && outcome !== "UNBOUND") notify();
      return outcome;
    },
    // пакет уходит продавцу до итога — как у настоящего порта (Р45 Б2в; ревью КТ1 AG-11 ч. 2 № 2)
    authorize: async (c: PaymentContext): Promise<Operation> => (steps.calls.push("authorize"), seen(c), c.sending(), op(c, o.authorize ?? {})),
    // расчёт — с записью об исполнении в пределах одобренного (Р49 п. 7); функция — исход задаёт тест
    settle: async (x: Operation, _signal?: AbortSignal, authorizedAt?: Date): Promise<Operation> => {
      steps.calls.push("settle");
      if (typeof o.settle === "function") return o.settle(x, authorizedAt);
      const status = o.settle ?? "SETTLED";
      const fulfilment = status === "SETTLED" && x.amount !== null ? { ref: "ful_1", finalAmount: x.amount, scopeCheck: "WITHIN_LIMITS" as const, spentPosition: x.amount, at: "2026-10-23T12:05:00.000Z" } : null;
      return { ...x, status, fulfilment };
    },
  };
  return steps;
}
