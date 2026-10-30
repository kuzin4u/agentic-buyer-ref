// Порты стадий 2–6 конвейера (Р38 п. 2, п. 8): источник выдачи, заказ у продавца, шаги оплаты. Здесь — только
// интерфейсы; реализации — в тестах (tests/support/), подписанные обращения к витринам — AG-09, корзина — AG-10,
// оплата — AG-11, подтверждение — AG-13. Всё, что приходит через эти порты от продавца, — данные (инвариант 5).
import type { CatalogFacts } from "../catalog/index.js";
import type { Mandate, Money, Operation, PaymentChannel } from "../../shared/domain.js";
import type { AgentDiagCode, DiagCode } from "../../shared/diag-codes.js";
import type { Mutation } from "./mutation.js";
import type { SealedPackage } from "../payment-package/package.js";

/** Магазин в выдаче: факты фида (`catalog/readFeed`) и признак контура гарантий (Р3). `merchantId` — код продавца
 *  для мандата корзины и заказа (у витрины эмулятора он отличается от `shop.id`). `link` — адрес витрины для человека
 *  (зона вне контура: платежа нет, человеку ссылка — инвариант 10, Р42 п. 3); строит адаптер, не из текста витрины, у
 *  каждого магазина: и при `inContour` товар уходит в зону рынка, если способа оплаты агента нет (дополнение 1 к Р66 п. 3). */
export interface ShopOffers {
  merchantId: string;
  inContour: boolean;
  facts: CatalogFacts;
  link?: string;
}

/** Почему магазин недоступен (Т4, Р42 п. 4): `detail` — код витрины из перечня, BAD_RESPONSE (ответ не по схеме) или
 *  NO_RESPONSE (нет ответа в срок); `reason` — код вне перечня (сам код не переносится, инвариант 5) или истёк общий срок
 *  поиска (Р44 п. 6) или знак готовности продавца по ПАО не проверен (Р53 п. 4). */
export type ShopUnavailableCause =
  | { detail: string; reason?: undefined }
  | { reason: Extract<AgentDiagCode, "MERCHANT_CODE_UNKNOWN" | "SHOP_SEARCH_DEADLINE" | "READINESS_UNAVAILABLE">; detail?: undefined };

/** Магазин, отказавший на стадии 2 (Т4): товаров нет, поиск по остальным идёт дальше; обходов нет. */
export interface ShopUnavailable {
  /** нет — запись списка без id по маске (обратиться к витрине нельзя) */
  shopId?: string;
  merchantId?: string;
  unavailable: ShopUnavailableCause;
}

/** Отказ витрины на заказе (Р42 п. 4) и сбой списка витрин (Р46 п. 2): остановка этой сделки, не агента. */
export class ShopFailure extends Error {
  override readonly name = "ShopFailure";
  constructor(readonly code: Extract<AgentDiagCode, "SHOP_ORDER_REFUSED" | "SHOP_ORDER_STATE_UNKNOWN" | "SHOP_LIST_UNAVAILABLE">) {
    super(`витрина: ${code}`);
  }
}

/** Отказ шага оплаты профиля contour (Р45): остановка этой сделки с кодом; сообщение — только код (инвариант 1). */
export class PaymentFailure extends Error {
  override readonly name = "PaymentFailure";
  constructor(readonly code: Extract<DiagCode, "SHOP_ORDER_REF_INVALID" | "CREDENTIAL_INVALID" | "OPERATION_RESULT_UNCONFIRMED" | "CONFIRMATION_REQUIRED" | "OPERATION_REPLY_MISMATCH" | "SETTLEMENT_PENDING">) {
    super(`оплата: ${code}`);
  }
}

/** Стадия 2: выдача по действующему INTENT. Ошибка вызова — отказ стадии (инвариант 4). */
export interface OfferSource {
  search(intent: Mandate): Promise<(ShopOffers | ShopUnavailable)[]>;
}

/** Заказ у продавца по мандату корзины: `cart_mandate_id` — мандат CART (эмулятор продавцов, Р26). */
export interface ShopOrderRequest {
  shopId: string;
  items: { sku: string; qty: number }[];
  cartMandateId: string;
}

/** Ответ продавца на заказ: сумму считает продавец, конвейер сверяет её с CART (Т6). */
export interface ShopOrder {
  orderId: string;
  total: Money;
}

/** Знак готовности продавца по ПАО (Р53 п. 2–4): статус или «знак не проверен» с уточнением для журнала. */
export type Readiness = { status: "ACTIVE" | "SUSPENDED" | "NONE"; unverified?: undefined } | { unverified: string; status?: undefined };

/** Стадия 3: заказ подписанным обращением к витрине (Р42). Отказ витрины или неизвестное состояние заказа — ShopFailure;
 *  иная ошибка вызова — отказ стадии (инвариант 4). Заказ — не больше одного нового и только после чтения «заказа нет»
 *  (Р55 п. 4). `readiness` — знак продавца по ПАО для ворот
 *  стадии 5 (Р53 п. 6): отказ по агенту — PlatformFailure или SignerStopped, иная ошибка — отказ стадии. */
export interface ShopPort {
  order(req: ShopOrderRequest, m: Mutation): Promise<ShopOrder>;
  readiness(merchantId: string, signal?: AbortSignal): Promise<Readiness>;
}

/** Пакет агентской оплаты продавцу по заказу (Р45 п. 4): `orderId` — `Order.id` продавца, он же `order_ref` пакета. */
export interface ShopPaymentRequest {
  shopId: string;
  orderId: string;
  cartMandateId: string;
  package: SealedPackage;
}

/** Ответ продавца на оплату — его слова, а не итог (инвариант 8): статус заказа закрытым перечнем, только для журнала. */
export interface ShopPaymentReply {
  status: "PAID" | "DECLINED" | "REJECTED";
}

/** Стадия 5: передача пакета продавцу подписанным обращением; не повторяется. Отказ витрины или неизвестный исход —
 *  ShopFailure; иная ошибка вызова — отказ стадии (инвариант 4). */
export interface ShopPaymentPort {
  pay(req: ShopPaymentRequest): Promise<ShopPaymentReply>;
}

/** Что известно шагам оплаты о покупке: только идентификаторы и сумма заказа, без реквизитов (инвариант 1). */
export interface PaymentContext {
  intent: Mandate;
  cart: Mandate;
  shopId: string;
  merchantId: string;
  /** способ оплаты агента у витрины выбора — канал реквизита (дополнение 1 к Р66 п. 3, `policy/channels`) */
  channel: PaymentChannel;
  order: ShopOrder;
  /** покупка остановлена (Р45, Б2в (а)): шаги проверяют его перед запросом реквизита и перед отправкой пакета */
  signal: AbortSignal;
  /** пакет уходит продавцу — вызвать синхронно сразу после последней проверки `signal` и до отправки (Р45, Б2в (б)) */
  sending(): void;
  /** уведомление этой покупки для наблюдения после итога (Р51 п. 4): итог стадии 5 — OPERATION_REVERSED */
  notice?: LateNotice;
}

/** Исход стадии 4 (Р47 п. 3–4): решение по GET; UNBOUND — привязка неоднозначна; NONE — запроса нет за
 *  confirmation_wait_ms; UNKNOWN — статус не подтверждён (fail-closed). */
export type ConfirmationOutcome = "APPROVED" | "REJECTED" | "EXPIRED" | "UNBOUND" | "NONE" | "UNKNOWN";

/** Уведомление оболочки — не исход покупки (Р47 п. 5, Р49 п. 7): запрос подтверждения ждёт человека; запись об исполнении
 *  с scope_check не WITHIN_LIMITS; возврат по операции (Р51 п. 3). Текст — из реестра по коду; значение вне перечня — из
 *  `purchase.operation`; сумма — вторым аргументом уведомления (`NoticeAmount`), в тексте подстановок нет. */
export type PurchaseNotice = Extract<
  AgentDiagCode,
  | "CONFIRMATION_PENDING"
  | "SCOPE_EXCEEDS_AUTHORIZATION"
  | "SCOPE_NOT_RESERVED"
  | "SCOPE_CHECK_UNRECOGNIZED"
  | "OPERATION_REFUNDED"
  | "OPERATION_SETTLED_LATE"
>;

/** Сумма к уведомлению (Р51 п. 3–4): у SCOPE_*, OPERATION_REFUNDED и OPERATION_SETTLED_LATE — сумма списания по операции в
 *  валюте её мандата (до ПАО 1.5.0 и у возврата — сумма списания, не возврата); у прочих уведомлений — нет. */
export type NoticeAmount = Money;

/** Уведомление покупки после её итога (Р51 п. 4): наблюдение за операцией шлёт его через уведомление той покупки;
 *  исход покупки не меняется. */
export type LateNotice = (code: PurchaseNotice, amount?: NoticeAmount) => void;

/** Стадии 4–6. Исход каждого шага — из подписанного события Платформы, не со слов продавца (инвариант 8, Р14). */
export interface PaymentSteps {
  /** Стадия 4 (Р47 п. 2): после отказа авторизации с требованием подтверждения — ожидание запроса ADP и решения человека
   *  (AG-13); конвейер решения не создаёт (инвариант 7). `notify` — уведомление оболочки, один раз на запрос, без link;
   *  `signal` — покупка остановлена. */
  confirm(c: PaymentContext, notify: () => void, signal: AbortSignal): Promise<ConfirmationOutcome>;
  /** Стадия 5: реквизит (`POST /pao/v1/credentials`), пакет агентской оплаты продавцу и итог авторизации (AG-11). Платформа
   *  требует подтверждения — PaymentFailure CONFIRMATION_REQUIRED (профиль contour — ответ продавца DECLINED, Р47 п. 4)
   *  или ответ со статусом CONFIRMATION_REQUIRED: дальше стадия 4. */
  authorize(c: PaymentContext, m: Mutation): Promise<Operation>;
  /** Стадия 6 (Р49 п. 6, Р51 п. 2): итог расчёта по операции. Расчёта ещё нет, ожидание прервано `signal` — PaymentFailure
   *  SETTLEMENT_PENDING (ожидание, не остановка); операция не та — OPERATION_REPLY_MISMATCH. `authorizedAt` — когда
   *  конвейер получил AUTHORIZED: от него граница ожидания reservation_ttl_sec (нет — с начала ожидания). `notice` —
   *  уведомление покупки для наблюдения после итога (Р51 п. 4): итог расчёта, REVERSED, граница. */
  settle(op: Operation, signal?: AbortSignal, authorizedAt?: Date, notice?: LateNotice): Promise<Operation>;
}
