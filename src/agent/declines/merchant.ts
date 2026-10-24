// Реестр кодов отказа витрин эмулятора продавцов в формате К17 ядра (Р42 п. 7, передача #33, РП42 п. 7 платформы):
// источник — продавец (у отказов по подписи — и агент), действие, тексты для человека и оператора. Отдельно от AGENT_DIAG
// и в полный реестр DIAG не сливается: имена пересекаются с ПАО и агентом (SIGNATURE_INVALID, KEY_EXPIRED,
// UPSTREAM_UNAVAILABLE), а код витрины — окружение, не Платформа. В журнал код витрины идёт только как detail
// (shop.call, shop.unavailable). Файл — в declines/: формат /diag ядра разрешён только здесь (Р36 п. 1; Р42, нюанс К2).
// Повтор — не действием реестра (retry_same_key нет ни у одного кода), а признаком «повторяемый» (Р42 п. 4).
import type { DiagAction, DiagEntry, DiagSource } from "@kuzin4u/agentic-core/diag";
import { AGENT_VERSION } from "./registry.js";

/** Перечень кодов витрин эмулятора (`MERCHANT_ERROR_CODES`, PS-12): закрыт; код вне него — MERCHANT_CODE_UNKNOWN. */
export const MERCHANT_CODES = [
  "AGENT_UNIDENTIFIED",
  "KEY_UNKNOWN",
  "AGENT_MISMATCH",
  "KEY_EXPIRED",
  "SIGNATURE_INVALID",
  "SHOP_NOT_FOUND",
  "ORDER_NOT_FOUND",
  "ORDERS_NOT_ACCEPTED",
  "ITEM_INVALID",
  "ITEM_INCOMPLETE",
  "PACKAGE_INVALID",
  "PACKAGE_MISMATCH",
  "ORDER_NOT_PAYABLE",
  "QUERY_INVALID",
  "UPSTREAM_UNAVAILABLE",
  "RATE_LIMITED",
] as const;

export type MerchantCode = (typeof MERCHANT_CODES)[number];

/** Повторяемые коды (Р42 п. 4): только временный отказ витрины — один повтор `GET` после Retry-After; заказ — никогда. */
export const MERCHANT_RETRYABLE: ReadonlySet<MerchantCode> = new Set<MerchantCode>(["RATE_LIMITED", "UPSTREAM_UNAVAILABLE"]);

export const isMerchantCode = (c: unknown): c is MerchantCode => typeof c === "string" && (MERCHANT_CODES as readonly string[]).includes(c);

const UNAVAILABLE = "Продавец сейчас недоступен. Можно выбрать предложение другого продавца.";
const ORDER = "Продавец не принял заказ. Деньги не списывались; можно выбрать другое предложение.";

function e(code: MerchantCode, source: DiagSource[], action: DiagAction, human: string, operator: string, norm: string): DiagEntry {
  return { code, component: "agent", source, action, human: { ru: human }, operator: { ru: operator }, norm, since: AGENT_VERSION };
}

export const MERCHANT_DIAG: Readonly<Record<MerchantCode, DiagEntry>> = {
  AGENT_UNIDENTIFIED: e("AGENT_UNIDENTIFIED", ["merchant", "agent"], "after_fix", UNAVAILABLE,
    "Витрина не опознала агента: обращение без подписи или подпись не дошла. Агент подписывает каждое обращение; обхода (без подписи, другим ключом) нет — магазин недоступен в этой выдаче.",
    "A5 п. 2; Т4; Р42 п. 4"),
  KEY_UNKNOWN: e("KEY_UNKNOWN", ["merchant", "agent"], "after_fix", UNAVAILABLE,
    "Ключа подписи нет в каталоге ключей реестра у витрины (не допущен, отозван, приостановлен или каталог витрины устарел). Ключ по слову витрины не меняется — состояние ключа агент берёт только от Платформы.",
    "A2 п. 5; Т4; Р42 п. 4"),
  AGENT_MISMATCH: e("AGENT_MISMATCH", ["merchant", "agent"], "after_fix", UNAVAILABLE,
    "Витрина считает ключ подписи ключом другого агента: расхождение каталога ключей витрины и реестра. Без повтора; сверка ключей — по реестру Платформы.",
    "A2 п. 5; Т4; Р42 п. 4"),
  KEY_EXPIRED: e("KEY_EXPIRED", ["merchant", "agent"], "after_fix", UNAVAILABLE,
    "Витрина считает ключ подписи истёкшим. Ротацию ведёт агент по реестру Платформы, а не по слову витрины; без повтора.",
    "A2 п. 5.3; Т4; Р42 п. 4"),
  SIGNATURE_INVALID: e("SIGNATURE_INVALID", ["merchant", "agent"], "after_fix", UNAVAILABLE,
    "Витрина не приняла подпись обращения (состав, окно времени, повтор x-nonce). Без повтора; при повторяемости — сверить профиль подписи и часы.",
    "A2 п. 5.1; Т4; Р42 п. 4"),
  SHOP_NOT_FOUND: e("SHOP_NOT_FOUND", ["merchant"], "after_fix", UNAVAILABLE,
    "Витрины с таким id нет, хотя она есть в списке витрин: расхождение списка и витрины. Магазин недоступен в этой выдаче.",
    "Р42 п. 4"),
  ORDER_NOT_FOUND: e("ORDER_NOT_FOUND", ["merchant"], "after_human", ORDER,
    "Витрина не нашла заказ агента. Сделка остановлена без повтора.",
    "Р42 п. 4"),
  ORDERS_NOT_ACCEPTED: e("ORDERS_NOT_ACCEPTED", ["merchant"], "after_human", ORDER,
    "Витрина не принимает заказы (только чтение). Агент заказывает только в контуре гарантий; такой ответ — расхождение зоны витрины. Сделка остановлена.",
    "Р3; Р42 п. 3–4"),
  ITEM_INVALID: e("ITEM_INVALID", ["merchant", "agent"], "after_fix", ORDER,
    "Витрина отклонила позицию заказа (sku или количество не по её схеме). Сделка остановлена без повтора.",
    "Р42 п. 4"),
  ITEM_INCOMPLETE: e("ITEM_INCOMPLETE", ["merchant"], "after_human", ORDER,
    "У карточки нет обязательных сведений (A5 п. 1.1, цена): заказ без цены витрина не принимает. Агент такую карточку не переводит (REQUIRED) и до заказа не доводит; ответ — сделка остановлена (SHOP_ORDER_REFUSED).",
    "A5 п. 1.1; Р42 п. 6"),
  PACKAGE_INVALID: e("PACKAGE_INVALID", ["agent", "merchant"], "after_fix", ORDER,
    "Витрина отклонила пакет агентской оплаты как не по схеме. Без повтора (AG-11).",
    "Р42 п. 4; Т8"),
  PACKAGE_MISMATCH: e("PACKAGE_MISMATCH", ["agent", "merchant"], "after_fix", ORDER,
    "Пакет агентской оплаты не совпал с заказом (заказ, агент или мандат корзины). Без повтора (AG-11).",
    "Р42 п. 4; Т8"),
  ORDER_NOT_PAYABLE: e("ORDER_NOT_PAYABLE", ["merchant"], "after_human", ORDER,
    "Заказ у витрины нельзя оплатить (уже оплачивается, оплачен или отклонён). Без повтора (AG-11).",
    "Р42 п. 4; инвариант 9"),
  QUERY_INVALID: e("QUERY_INVALID", ["agent", "merchant"], "after_fix", "Не удалось узнать у продавца состояние заказа. Деньги не списывались; заказ не повторяется.",
    "Чтение заказов витрины без cart_mandate_id, с пустым или повторённым (422, РП58 платформы, передача #70) — дефект запроса агента. Без повтора; чтение заказа — AG-09 ч. 2г.",
    "Р42 п. 4, 7; Р49 п. 9; Р53 п. 9"),
  UPSTREAM_UNAVAILABLE: e("UPSTREAM_UNAVAILABLE", ["merchant", "environment"], "after_fix", UNAVAILABLE,
    "Витрине недоступен её источник (каталог ключей и т. п.). Повторяемый: один повтор GET после Retry-After не больше shop_retry_after_max_sec; заказ не повторяется.",
    "Р42 п. 4; инвариант 9"),
  RATE_LIMITED: e("RATE_LIMITED", ["merchant"], "after_fix", UNAVAILABLE,
    "Витрина ограничила частоту обращений. Повторяемый: один повтор GET после Retry-After не больше shop_retry_after_max_sec; заказ не повторяется.",
    "Р42 п. 4; инвариант 9"),
};
