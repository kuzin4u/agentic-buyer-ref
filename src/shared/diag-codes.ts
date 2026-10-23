// Коды агента вне ПАО и каталога ядра (Р36 п. 2): перечень — источник истины для реестра AGENT_DIAG
// (src/agent/declines/registry.ts); запись на каждый код проверяет тип реестра и тест полноты.
import type { FailureCode } from "./domain.js";

export const AGENT_DIAG_CODES = [
  // словарь ядра вне ПАО (FailureCode): агент выводит их сам из ответа Платформы (Р33)
  "MANDATE_REVOCATION_ORDER_MISSING",
  "PLATFORM_PROTOCOL_UNSUPPORTED",
  "UNKNOWN",
  // предупреждение: версия ПАО Платформы не определена (Р33 п. 10)
  "PLATFORM_VERSION_UNKNOWN",
  // остановка и приостановка агента
  "EVENTS_CURSOR_INVALID",
  "AGENT_EXCLUDED",
  "AGENT_CLASS_MISMATCH",
  "AGENT_SELF_UNKNOWN",
  // самопроверка при старте (Р36 п. 6): параметры и версия ПАО ядра
  "PARAMS_INVALID",
  "CORE_PAO_MISMATCH",
  // подписант и связка ключей
  "KEY_MISMATCH",
  "NO_ACTIVE_KEY",
  "NO_KEY",
  "KEY_AMBIGUOUS",
  "KEYSTORE_LOCKED",
  "KEYSTORE_WRITE_FAILED",
  "NOT_ADMITTED",
  "KEY_REJECTED",
  "KEY_NOT_ACTIVE",
  "KEY_REVOKED",
  "KEY_EXPIRED",
  // клиент мандатов (MandateRefusal; порядок отзыва — MANDATE_REVOCATION_ORDER_MISSING выше)
  "MANDATE_DRAFT_INVALID",
  "MANDATE_REPLY_MISMATCH",
  "MANDATE_NOT_ACTIVE",
  "MANDATE_SIGNATURE_PENDING",
  "MANDATE_NONE",
  "MANDATE_OUT_OF_SCOPE",
  // ворота перед стадией 5 (Р38 п. 3, К4а): verify подтвердил мандат, но остатка Платформы не хватает на итог CART
  "MANDATE_AMOUNT_LEFT_INSUFFICIENT",
  // политика до стадий 4–5 (Р39 п. 1.4, п. 4): итог не в RUB; покупка — доля в окне дробления по корневому INTENT
  "CURRENCY_NOT_SUPPORTED",
  "SPLIT_WINDOW",
  // конвейер стадий (Р38): запрещённый переход машины покупки — дефект вызывающего или конвейера
  "PIPELINE_TRANSITION_FORBIDDEN",
  // конвейер стадий (Р38 п. 2, поправка К3): выбор человека не из контура гарантий выдачи этой покупки — дефект или подмена вызывающего
  "OFFER_NOT_IN_CONTOUR",
  // конвейер стадий (Р43 п. 3): количество в выборе не целое ≥ 1 или итог корзины не безопасное целое — дефект или подмена вызывающего
  "CART_QTY_INVALID",
  // конвейер стадий (Р40 п. 3 б, п. 4): решение человека по A5 не выдано оболочкой (копия, подделка) — дефект или подмена вызывающего
  "A5_DECISION_FORGED",
  // конвейер стадий (Р38 п. 2): сумма или валюта заказа продавца не совпала с мандатом корзины (Т6)
  "ORDER_REPLY_MISMATCH",
  // каталог: ошибка вызова живой проверки (рядом с LIVE_* ядра, Р32 п. 4)
  "LIVE_CALL_ERROR",
  // витрины продавцов (Р42 п. 4): отказ витрины на заказе и неизвестное состояние заказа — остановка сделки, не агента;
  // код витрины вне перечня — магазин недоступен
  "SHOP_ORDER_REFUSED",
  "SHOP_ORDER_STATE_UNKNOWN",
  "MERCHANT_CODE_UNKNOWN",
  // общий срок стадии поиска истёк (Р44 п. 6): оставшиеся витрины недоступны в этой выдаче
  "SHOP_SEARCH_DEADLINE",
  // список витрин (`GET /v1/shops`) не получен или не по схеме (Р46 п. 2): сделка остановлена, агент работает дальше
  "SHOP_LIST_UNAVAILABLE",
  // стадия 5 (Р45 п. 2.1): номер заказа продавца не по маске ссылки или похож на номер карты — обращения за реквизитом нет
  "SHOP_ORDER_REF_INVALID",
  // стадия 5 до событий операции (Р45 п. 5, PS-16): пакет передан продавцу, итог Платформой не подтверждён
  "OPERATION_RESULT_UNCONFIRMED",
  // стадия 4 (Р47 п. 5, В3): уведомление оболочки — запрос подтверждения ждёт решения человека в приложении банка
  "CONFIRMATION_PENDING",
  // исходы стадии 4 (Р47 п. 4, 6): отклонено, истекло, одобрено без канала к продавцу (до AG-13 ч. 2), привязка неоднозначна
  "CONFIRMATION_REJECTED",
  "CONFIRMATION_EXPIRED",
  "CONFIRMATION_NOT_DELIVERED",
  "CONFIRMATION_UNBOUND",
  // причины operation.declined (SPEC §7б, Р48 п. 1): совпадающие с кодом §7а — с приставкой DECLINED_ (код ПАО уже в PAO_DIAG ядра)
  "AOI_MISSING",
  "AOI_MISMATCH",
  "DECLINED_AGENT_SUSPENDED",
  "DECLINED_CREDENTIAL_INVALID",
  "DECLINED_MANDATE_NOT_FOUND",
  "DECLINED_MANDATE_EXPIRED",
  "DECLINED_MANDATE_REVOKED",
  "DECLINED_MANDATE_SCOPE",
  "DECLINED_LIMIT_EXCEEDED",
  "DECLINED_STATE_UNAVAILABLE",
  "ISSUER_DECLINED",
  "INSUFFICIENT_FUNDS",
  "DECLINE_REASON_UNKNOWN",
] as const;

export type AgentDiagCode = (typeof AGENT_DIAG_CODES)[number];

/** Код, которым агент отказывает, останавливается или приостанавливается: отказ ПАО или код агента (Р36). */
export type DiagCode = FailureCode | AgentDiagCode;
