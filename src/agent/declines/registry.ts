// Реестр кодов агента в формате К17 ядра (Р36): кто ошибся, что делать, тексты для человека и оператора.
// Записи ядра (PAO_DIAG, CATALOG_DIAG) здесь не повторяются; полный реестр собирает место сборки (compose) — mergeDiag.
// Тексты — постоянные строки без подстановок, реквизитов, путей с идентификаторами и тел ответов (К17 п. 6, инвариант 1):
// подробности — в поле detail журнала. Человеку текст берётся отсюда по коду; сообщение исключения — текст журнала.
import type { DiagAction, DiagEntry, DiagRegistry, DiagSource } from "@kuzin4u/agentic-core/diag";
import type { AgentDiagCode } from "../../shared/diag-codes.js";

export type { DiagAction, DiagEntry, DiagRegistry, DiagSource };

/** Версия агента (package.json; тест diag-registry): с неё действуют записи, она же — в отчёте самопроверки. */
export const AGENT_VERSION = "0.0.1";
const SINCE = AGENT_VERSION;
/** Версия ПАО, с которой агент сверяет причины operation.declined (Р20, SPEC §7б). */
const SINCE_PAO = "1.2.0";

const TECH = "Покупка не выполнена по технической причине на стороне помощника. Обратитесь в поддержку сервиса.";
const STOPPED = "Помощник остановлен и не выполняет покупки. Обратитесь в поддержку сервиса.";

function e(
  code: AgentDiagCode,
  source: DiagSource[],
  action: DiagAction,
  human: string,
  operator: string,
  norm: string,
  component: DiagEntry["component"] = "agent",
  since = SINCE,
): DiagEntry {
  return { code, component, source, action, human: { ru: human }, operator: { ru: operator }, norm, since };
}

export const AGENT_DIAG: Readonly<Record<AgentDiagCode, DiagEntry>> = {
  MANDATE_REVOCATION_ORDER_MISSING: e("MANDATE_REVOCATION_ORDER_MISSING", ["platform"], "stop",
    "Банк не указал порядок отзыва поручения, поэтому покупка по нему невозможна. Обратитесь в банк или создайте поручение заново.",
    "Ответ Платформы с мандатом без revocation_order при подтверждённой версии ПАО: Платформа старше 1.4.0 или её дефект. Мандат не подтверждён, без повтора.",
    "A7 п. 2.2; Р33 п. 4; SPEC §7а"),
  PLATFORM_PROTOCOL_UNSUPPORTED: e("PLATFORM_PROTOCOL_UNSUPPORTED", ["platform"], "stop",
    STOPPED,
    "Платформа работает по ПАО ниже 1.4.0 (конфигурация или первый мандат без порядка отзыва): в мандатах нет порядка отзыва. Обновите Платформу или подключите совместимую; версия — в журнале.",
    "A7 п. 2.2; Р33 п. 10; SPEC §7а"),
  UNKNOWN: e("UNKNOWN", ["platform", "environment", "agent"], "stop",
    "Покупка остановлена: результат обращения к сервису оплаты не подтверждён. Повторите позже или обратитесь в поддержку сервиса.",
    "Итог обращения не опознан: код вне ПАО, пара код и HTTP-статус не по таблице, тело не по схеме (Платформа); тайм-аут или сбой сети (среда); пустой Idempotency-Key — обращение не отправлено (агент). Источник неразличим; остановка без повтора, событие в журнал.",
    "SPEC §7а; инвариант 4"),
  PLATFORM_VERSION_UNKNOWN: e("PLATFORM_VERSION_UNKNOWN", ["platform"], "after_fix",
    "Помощник работает; проверка совместимости сервиса оплаты завершится при первой покупке.",
    "Предупреждение: версия ПАО Платформы не определена при подключении (нет 1.x.y в versions, ответ не по схеме или адрес конфигурации не ответил). Проверьте /.well-known/pao-configuration; проверка — по первому мандату.",
    "Р33 п. 10; Р36 (б)"),
  EVENTS_CURSOR_INVALID: e("EVENTS_CURSOR_INVALID", ["agent", "environment", "platform"], "stop",
    STOPPED,
    "Курсор ленты событий не читается или не по схеме (UNREADABLE) либо отвергнут Платформой (REJECTED). Агент остановлен; сброс курсора — только оператором (удалить файл курсора).",
    "Р34 п. 4; инвариант 4"),
  AGENT_EXCLUDED: e("AGENT_EXCLUDED", ["platform"], "stop",
    "Помощник отключён от покупок. Обратитесь в поддержку сервиса.",
    "Агент исключён из реестра Платформы (статус EXCLUDED в GET /pao/v1/agent). Возобновление — только новым допуском у оператора Платформы.",
    "Р27; SPEC §7а"),
  AGENT_CLASS_MISMATCH: e("AGENT_CLASS_MISMATCH", ["agent", "platform"], "stop",
    STOPPED,
    "Класс агента в реестре Платформы не BUYER: проверьте заявку на допуск. Класс из реестра — в журнале.",
    "Р27; SPEC §7а"),
  AGENT_SELF_UNKNOWN: e("AGENT_SELF_UNKNOWN", ["platform"], "retry_same_key",
    "Покупки временно приостановлены. Повторите позже.",
    "Ответ GET /pao/v1/agent после допуска не по схеме: подпись приостановлена до успешной повторной сверки с реестром.",
    "Р27"),
  PARAMS_INVALID: e("PARAMS_INVALID", ["agent", "environment"], "after_fix",
    STOPPED,
    "Стендовые параметры не прочитаны или не по схеме (config/params.stand.json): агент не собран, сеть не трогалась. Причина — в сообщении ошибки.",
    "Р36 п. 6; CLAUDE.md «Стендовые значения»"),
  CORE_PAO_MISMATCH: e("CORE_PAO_MISMATCH", ["agent"], "after_fix",
    STOPPED,
    "Версия ПАО в подключённом agentic-core не совпадает с копией ПАО агента: переход — через решение (Р20). Агент не собран, сеть не трогалась.",
    "Р20; Р36 п. 6"),
  KEY_MISMATCH: e("KEY_MISMATCH", ["agent", "platform"], "stop",
    TECH,
    "Ключ в реестре Платформы не совпадает с ключом в хранилище агента (kid, открытый ключ или алгоритм). Сверьте хранилище ключей и регистрацию.",
    "A2 п. 5; Р25; инвариант 2"),
  NO_ACTIVE_KEY: e("NO_ACTIVE_KEY", ["agent"], "stop",
    TECH,
    "Нет действующего ключа подписи, подтверждённого реестром Платформы. Зарегистрируйте новый ключ.",
    "Р25; SPEC §7а (AGENT_KEY_REVOKED)"),
  NO_KEY: e("NO_KEY", ["agent"], "stop",
    TECH,
    "Хранилище ключей пусто: ключ подписи не создан или не загружен.",
    "Р25"),
  KEY_AMBIGUOUS: e("KEY_AMBIGUOUS", ["agent"], "stop",
    TECH,
    "Несколько действующих ключей без однозначного выбора для подписи. Проверьте сроки ключей в реестре и хранилище.",
    "Р25"),
  KEYSTORE_LOCKED: e("KEYSTORE_LOCKED", ["environment"], "stop",
    STOPPED,
    "Каталог ключей занят другим процессом агента: один процесс на каталог.",
    "Р25"),
  KEYSTORE_WRITE_FAILED: e("KEYSTORE_WRITE_FAILED", ["environment"], "stop",
    STOPPED,
    "Запись в хранилище ключей не удалась: проверьте права и место на диске.",
    "Р25"),
  NOT_ADMITTED: e("NOT_ADMITTED", ["agent"], "stop",
    TECH,
    "Подпись запрошена до допуска к Платформе — дефект агента.",
    "Р22; инвариант 8"),
  KEY_REJECTED: e("KEY_REJECTED", ["agent", "environment"], "after_fix",
    "Помощник не смог подключиться к сервису оплаты. Повторите позже.",
    "Допуск не состоялся не по отказу Платформы (ключ не принят, сбой хранилища или подписи). Допуск можно повторить после устранения причины.",
    "Р25; Р27"),
  KEY_NOT_ACTIVE: e("KEY_NOT_ACTIVE", ["platform"], "new_key",
    TECH,
    "Платформа не подтвердила зарегистрированный ключ как ACTIVE: ключ отклонён, следующая ротация — новым ключом.",
    "Р31"),
  KEY_REVOKED: e("KEY_REVOKED", ["platform"], "new_key",
    TECH,
    "Ключ в реестре Платформы отозван: подпись — другим действующим ключом, иначе регистрация нового.",
    "Р25; Р27"),
  KEY_EXPIRED: e("KEY_EXPIRED", ["agent"], "new_key",
    TECH,
    "Срок ключа в реестре Платформы истёк: подпись — другим действующим ключом, иначе регистрация нового. Проверьте плановую ротацию.",
    "Р25"),
  MANDATE_DRAFT_INVALID: e("MANDATE_DRAFT_INVALID", ["agent"], "after_fix",
    "Поручение на покупку не оформлено: не хватает обязательных сведений.",
    "В проекте мандата нет обязательного реквизита (A7 п. 2.2); обращения к Платформе не было. Список полей — в журнале.",
    "A7 п. 2.2"),
  MANDATE_REPLY_MISMATCH: e("MANDATE_REPLY_MISMATCH", ["platform"], "stop",
    "Поручение на покупку не подтверждено: сервис оплаты вернул другие условия.",
    "Платформа вернула мандат с другими пределами, другой мандат или порядок отзыва CART не совпал с INTENT: пределы не подтверждены.",
    "A7 п. 8.6; инвариант 4"),
  MANDATE_NOT_ACTIVE: e("MANDATE_NOT_ACTIVE", ["client", "bank", "platform"], "after_human",
    "Поручение на покупку не действует. Новое поручение — только по вашему решению.",
    "Мандат не ACTIVE по GET: отклонён, отозван, исчерпан или событие подписи не подтвердилось статусом.",
    "A7 п. 6; Р29 п. 5"),
  MANDATE_SIGNATURE_PENDING: e("MANDATE_SIGNATURE_PENDING", ["client"], "after_human",
    "Помощник ждёт вашей подписи поручения в приложении банка и без неё не продолжит.",
    "Мандат PENDING_SIGNATURE: ждать mandate.signed и подтверждения статусом по GET.",
    "SPEC §7а (PRINCIPAL_SIGNATURE_PENDING); Р34 п. 5"),
  MANDATE_NONE: e("MANDATE_NONE", ["client"], "after_human",
    "Без вашего поручения помощник не действует от вашего имени. Оформите поручение на покупку.",
    "Действующего мандата нет: ссылки нет или мандат не ACTIVE.",
    "Т2; A7 п. 2"),
  MANDATE_OUT_OF_SCOPE: e("MANDATE_OUT_OF_SCOPE", ["agent", "platform"], "after_human",
    "Покупка не подтверждена поручением: вне его пределов или состояние сейчас не проверить. Повторите позже или оформите новое поручение.",
    "verify не вернул CONFIRMED: OUT_OF_SCOPE или STATE_UNKNOWN (неподтверждённое состояние — вне пределов).",
    "A7 п. 8.6; инвариант 4, 6"),
  PIPELINE_TRANSITION_FORBIDDEN: e("PIPELINE_TRANSITION_FORBIDDEN", ["agent"], "after_fix",
    TECH,
    "Конвейер получил переход покупки вне таблицы разрешённых (например, к авторизации без мандата корзины): дефект вызывающего или конвейера. Покупка остановлена без повтора; состояния — в журнале (purchase.stage).",
    "Р38 п. 1; SPEC §4 (pipeline); инвариант 3"),
  OFFER_NOT_IN_CONTOUR: e("OFFER_NOT_IN_CONTOUR", ["agent"], "after_fix",
    TECH,
    "На стадию корзины передан товар не из контура гарантий выдачи этой покупки (зона вне контура или товара нет в выдаче): дефект или подмена вызывающего. Покупка остановлена без обращений к Платформе; по зоне вне контура — ссылка человеку (Р3).",
    "Р38 п. 2 (поправка К3); Р3; инвариант 10"),
  ORDER_REPLY_MISMATCH: e("ORDER_REPLY_MISMATCH", ["merchant"], "after_human",
    "Продавец посчитал заказ не на ту сумму, которую вы подтвердили в поручении на корзину. Заказ не оплачен.",
    "Сумма или валюта заказа у продавца не равна итогу мандата CART: оплата не начата, без повтора. Новый заказ — только новым выбором человека (новый CART).",
    "Р38 п. 2; Т6; инвариант 4"),
  LIVE_CALL_ERROR: e("LIVE_CALL_ERROR", ["agent", "environment"], "after_fix",
    "Не удалось проверить цену и наличие: сбой на стороне помощника. Заказ не оформлен; если повторится — обратитесь в поддержку сервиса.",
    "Ошибка вызова живой проверки: не тот sku, неверное количество или параметры проверки — дефект агента или среды, а не ответ продавца.",
    "Р32 п. 4; Р36 п. 4 (ревью К1.2б № 7)"),
  AOI_MISSING: e("AOI_MISSING", ["agent"], "after_fix",
    TECH,
    "Операция отклонена: пакет агентской оплаты без признака aoi — дефект агента; операцию не повторять, исправить агента.",
    "SPEC §7б; инвариант 8", "pao", SINCE_PAO),
  AOI_MISMATCH: e("AOI_MISMATCH", ["agent", "merchant"], "stop",
    TECH,
    "Операция отклонена: признак aoi не совпал с агентом или мандатом — инцидент, остановка.",
    "SPEC §7б; инвариант 8", "pao", SINCE_PAO),
  INSUFFICIENT_FUNDS: e("INSUFFICIENT_FUNDS", ["client", "bank"], "after_human",
    "Банк отклонил оплату: недостаточно средств. Пополните счёт или выберите другой способ оплаты.",
    "Операция отклонена банком по остатку средств; без повтора.",
    "SPEC §7б", "pao", SINCE_PAO),
  DECLINE_REASON_UNKNOWN: e("DECLINE_REASON_UNKNOWN", ["platform", "bank"], "stop",
    "Оплата отклонена. Покупка по этой операции остановлена; при необходимости обратитесь в банк.",
    "Причина operation.declined вне перечня SPEC §7б: остановка по операции без повтора, событие в журнал; причина — в журнале.",
    "SPEC §7б; Р20 (уточнение 11.10.2026)"),
};

/** Полный реестр: записи ядра и агента; код в двух реестрах — ошибка сборки (Р36 п. 1). */
export function mergeDiag(...registries: DiagRegistry[]): DiagRegistry {
  const out: Record<string, DiagEntry> = {};
  for (const r of registries) {
    for (const [code, entry] of Object.entries(r)) {
      if (Object.hasOwn(out, code)) throw new Error(`код ${code} — в двух реестрах (Р36 п. 1)`);
      out[code] = entry;
    }
  }
  return Object.freeze(out);
}
