// Журнал решений агента (SPEC §4, Т15, Р37); без реквизитов и персональных данных в открытом виде.
// Записи — только идентификаторы (kid, mandate_id, event_id) и коды реестра; ключевого материала журнал не получает
// (инвариант 2). Набор полей закрыт (JOURNAL_FIELDS): тел ответов, Idempotency-Key, x-nonce и текста фида в нём нет.
import type { A5SignalCode, CatalogIssueCode, LiveCheckCode } from "../catalog/index.js";
import type { DiagCode } from "../../shared/diag-codes.js";

/** Код причины в записи — только код полного реестра DIAG (Р37 п. 3): отказ, остановка, код каталога ядра. */
export type JournalCode = DiagCode | CatalogIssueCode | A5SignalCode | LiveCheckCode;

/** Итог обращения или решения: подтверждён, отказ с кодом, исход не подтверждён (инвариант 4). */
export type JournalResult = "ok" | "refused" | "unknown";


export type JournalKind =
  /** ключ из хранилища загружен */
  | "key.loaded"
  /** новый ключ создан, ещё не зарегистрирован */
  | "key.created"
  /** платформа подтвердила регистрацию ключа */
  | "key.registered"
  /** временный файл ключа прошлого запуска (регистрация не подтверждена) — не используется */
  | "key.abandoned"
  /** брошенный временный ключ оказался зарегистрированным (ответ на регистрацию был потерян); отзыв — после PS-05 */
  | "key.abandoned_registered"
  /** подпись переведена на другой ключ */
  | "key.switched"
  /** платформа сообщила, что ключ отозван */
  | "key.revoked"
  /** в реестре платформы действующий ключ агента, которого нет в хранилище (A2 п. 5: признак регистрации в обход) */
  | "key.foreign"
  /** обращение подписано ключом kid */
  | "request.signed"
  /** допуск не пройден этим ключом или целиком (код отказа в reason); повтор — по действию кода в реестре (дополнение 2 к Р36) */
  | "admission.failed"
  /** рабочая подпись приостановлена до успешной повторной сверки с реестром (Р27) */
  | "signing.suspended"
  /** повторная сверка прошла (ACTIVE и BUYER) — подпись возобновлена */
  | "signing.resumed"
  /** агент остановлен (reason — код реестра) */
  | "agent.stopped"
  /** штатное закрытие подписанта (close); не остановка по коду — в реестр не входит (Р36 (в), Р37) */
  | "agent.closed"
  /** ротация остановлена: KEY_INVALID подряд сверх предела таблицы отказов (Р31); инцидент, нужен человек */
  | "key.rotation_stopped"
  /** ответ Платформы с мандатом без порядка отзыва — мандат не подтверждён, покупки нет (Р33 п. 4) */
  | "mandate.revocation_order_missing"
  /** версия ПАО Платформы при подключении не определена — проверка отложена до первого ответа с мандатом (Р33 п. 10);
   *  предупреждение, работа продолжается; detail — NO_VERSION, BAD_RESPONSE или NO_RESPONSE */
  | "platform.version_unknown"
  /** Платформа ниже ПАО 1.4.0 — агент остановлен (Р33 п. 10); detail — CONFIGURATION или MANDATE (на каком шаге) */
  | "platform.protocol_unsupported"
  /** событие ленты обработано (Р34 п. 3, 5); ref — event_id, detail — тип из перечня ПАО 1.4.0 */
  | "event.handled"
  /** событие ленты пропущено, курсор сдвинут (Р34 п. 6); detail — UNKNOWN_TYPE или INVALID_DATA, тип вне перечня не пишется */
  | "event.ignored"
  /** push не по форме — ответ 400, ленту не будит (Р34 п. 2); detail — причина */
  | "event.push_rejected"
  /** курсора ленты нет — первый запуск или сброс оператором: лента с начала (Р34 п. 4) */
  | "events.cursor_initial"
  /** STOP_ALL (Р50 п. 4, Т13): что не завершено — detail из перечня UNFINISHED, reason — код остановки */
  | "purchase.unfinished"
  /** начало серии неудачных чтений ленты (Р50 п. 2): reason — EVENTS_UNAVAILABLE, detail — код отказа первого чтения;
   *  серия не меньше registry_cache_ttl_sec — подпись приостановлена */
  | "events.unavailable"
  /** Платформа отвергла адрес подписки (400) — push нет, работа по ленте (Р34 п. 8) */
  | "events.subscription_rejected"
  /** подписка не удалась иначе (503 сверх попыток, UNKNOWN) — работа по ленте, повтор при следующем старте (дополнение Р34 п. 1) */
  | "events.subscription_failed"
  /** проверка самопроверки при старте (Р36 п. 6): check — имя, status — ok / warn / fail, reason — код из реестра при warn и fail */
  | "agent.selfcheck"
  /** попытка обращения к ПАО (Т15, Р37 п. 3): method — ключ операции, attempt — номер попытки (> 1 — попытка повтора),
   *  result и reason — итог попытки; detail — HTTP-статус */
  | "pao.call"
  /** держимый мандат отозван — особое событие Т15 (Р37 п. 4); мандат больше не держится */
  | "mandate.revoked"
  /** держимый мандат не ACTIVE (истёк, исчерпан и т. п.) — больше не держится; detail — статус (Р37 п. 4) */
  | "mandate.status_changed"
  /** аномалия: держимый ACTIVE-мандат пропал у Платформы — GET 404, reason MANDATE_NOT_FOUND; больше не держится, лента
   *  идёт дальше (Р37 п. 4, решение владельца по К2.3 — вариант (а)) */
  | "mandate.vanished"
  /** отказ агента действовать — особое событие Т15 (Р37 п. 5); reason — код реестра */
  | "agent.refused"
  /** переход машины покупки (Р38 п. 5): detail — новое состояние (у остановки с уточнением — `STOPPED:<уточнение>`,
   *  Р40 п. 6), mandate — INTENT, reason — код при STOPPED */
  | "purchase.stage"
  /** пакет ушёл продавцу, покупка остановлена неитоговым кодом (Р49 п. 2): reason — исходный код для оператора; покупка
   *  остановлена с OPERATION_RESULT_UNCONFIRMED (следующая запись purchase.stage) */
  | "payment.unconfirmed"
  /** товар исключён из выдачи (Р32 п. 1, 5): reason — код ошибки модели каталога; пишет конвейер (Р37 п. 5) */
  | "offer.excluded"
  /** товар с сигналом A5 — показ с пометкой (Р32 п. 1): reason — код сигнала; пишет конвейер */
  | "offer.flagged"
  /** проект мандата корзины не готовится (Р32 п. 2): reason — код сигнала A5; пишет конвейер */
  | "cart.refused"
  /** заказа нет: живая проверка не ok (Р32 п. 3–4): reason — код LIVE_*; пишет конвейер */
  | "order.live_refused"
  /** запроса CART нет: живая проверка перед ним не ok (Р43 п. 1, Р32 п. 4): reason — код LIVE_*; пишет конвейер */
  | "cart.live_refused"
  /** прежний CART больше не используется (Т15, Р46 п. 3): mandate — id CART, detail — NEW_SEARCH или
   *  REFUSED_BEFORE_ORDER; сумм, позиций и продавца нет; пишет конвейер */
  | "cart.abandoned"
  /** попытка обращения к витрине (Т15, Р42): method — шаблон пути, attempt > 1 — попытка повтора, ref — id витрины по
   *  маске, mandate — мандат корзины у заказа; detail — код витрины из перечня, BAD_RESPONSE или NO_RESPONSE; код вне
   *  перечня — reason MERCHANT_CODE_UNKNOWN; обращение прервано общим сроком поиска — reason SHOP_SEARCH_DEADLINE (Р44 п. 6);
   *  у оплаты (`…/payment`, Р45 п. 4) при ok — статус заказа из ответа PAID / DECLINED / REJECTED: слова продавца, не итог */
  | "shop.call"
  /** магазин недоступен в выдаче (Т4, Р42 п. 4): detail и reason — как у последней попытки shop.call, merchant — код
   *  продавца; пишет конвейер. Исключения по сроку поиска (Р44 п. 6) — reason SHOP_SEARCH_DEADLINE: срок истёк до
   *  обращения (shop.call нет) или повтор не начат, потому что Retry-After не меньше остатка (у shop.call — detail кода
   *  витрины) */
  | "shop.unavailable"
  /** статус запроса подтверждения по GET (Р47 п. 3): ref — confirmation_id, detail — PENDING / APPROVED / REJECTED /
   *  EXPIRED; ни link, ни confirmation_ref в журнал не попадают */
  | "confirmation.status"
  /** запрос подтверждения не этого агента — 400 на GET (Р47 п. 3): ref — confirmation_id, действий нет */
  | "confirmation.foreign"
  /** запрос подтверждения пришёл, когда ни одна покупка его не ждёт (Р47 п. 4, В1а): ref — confirmation_id; хранится в
   *  памяти не дольше confirmation_wait_ms */
  | "confirmation.unclaimed"
  /** невостребованный запрос выброшен по сроку (Р47 п. 4, В1а): ref — confirmation_id */
  | "confirmation.discarded"
  /** запрос не привязан: ожидающих покупок две и больше или невостребованных больше одного (Р47 п. 4): ref —
   *  confirmation_id, если он один */
  | "confirmation.unbound"
  /** уведомление оболочки (notify) упало (Р47 п. 5, В3): reason — код уведомления; исход покупки не меняется */
  | "notify.failed"
  /** статус операции по GET после operation.* (Р49 п. 3): ref — op_ref по маске, detail — статус из перечня ПАО */
  | "operation.status"
  /** операция не этого агента — 400 на GET (Р49 п. 3): ref — op_ref, действий нет */
  | "operation.foreign"
  /** операция без ожидающей покупки (Р49 п. 3): ref — op_ref; действий нет */
  | "operation.unclaimed"
  /** GET операции не подтверждён и не повторяется (ответ не по схеме, отказ): ref — op_ref, reason — код; ожидающая
   *  покупка получит исход по сроку (Р49 п. 3) */
  | "operation.unread"
  /** привязанная операция не сходится с заказом и CART (Р49 п. 4): ref — op_ref, detail — поле AOI / MERCHANT / AMOUNT /
   *  CHANNEL / OP_REF, reason — OPERATION_REPLY_MISMATCH */
  | "operation.mismatch"
  /** запись об исполнении (Р49 п. 7): ref — op_ref, detail — scope_check из перечня или OTHER (значение вне перечня в
   *  журнал не пишется, инвариант 5) */
  | "operation.settled"
  /** GET операции — REVERSED (Р51 п. 3): ref — op_ref, detail — REVERSAL / AUTH_EXPIRED / OTHER (значение вне перечня в
   *  журнал не пишется, инвариант 5) */
  | "operation.reversed"
  /** граница ожидания клиринга reservation_ttl_sec прошла, последний GET — AUTHORIZED (Р51 п. 2 (б)): ref — op_ref; покупка
   *  остановлена с OPERATION_RESULT_UNCONFIRMED */
  | "operation.unsettled";

export interface JournalEntry {
  at: string;
  /** код агента — ставит место сборки (compose), писатели его не передают (Р37 п. 3) */
  agent?: string;
  kind: JournalKind;
  kid?: string;
  /** код отказа или причина остановки — код реестра (Р37 п. 3) */
  reason?: JournalCode;
  /** уточнение — только значение закрытого перечня: ПАО (класс из реестра при AGENT_CLASS_MISMATCH, Р27), агента
   *  (NO_VERSION, REGION) или состояние машины покупки и запрошенный переход «откуда->куда» (Р38 п. 5); у остановки
   *  покупки с уточнением — «STOPPED:CART_POLICY_EXCLUDED» (Р40 п. 6); у shop.call и shop.unavailable — код витрины из
   *  перечня, BAD_RESPONSE или NO_RESPONSE (Р42); у cart.abandoned — NEW_SEARCH или REFUSED_BEFORE_ORDER (Р46 п. 3) */
  detail?: string;
  /** идентификатор объекта по маске адаптера — event_id события ленты (Р34 п. 11), sku у решений каталога, id витрины у
   *  shop.call (Р42) */
  ref?: string;
  /** имя проверки самопроверки (agent.selfcheck, Р36 п. 6) */
  check?: string;
  /** итог проверки самопроверки: ok, warn или fail */
  status?: "ok" | "warn" | "fail";
  /** mandate_id мандата, к которому относится запись */
  mandate?: string;
  /** код продавца из выдачи по маске идентификатора — у решений каталога (Р38 п. 5, поправка К5) */
  merchant?: string;
  /** ключ операции ПАО по контракту — шаблон пути без подстановок (`POST /pao/v1/mandates/{id}/verify`) */
  method?: string;
  /** итог обращения или решения */
  result?: JournalResult;
  /** номер попытки обращения, с 1 */
  attempt?: number;
}

/** Закрытый набор полей записи (Р37 п. 3): тест сверяет ключи записей с ним. */
export const JOURNAL_FIELDS = [
  "at",
  "agent",
  "kind",
  "kid",
  "reason",
  "detail",
  "ref",
  "check",
  "status",
  "mandate",
  "merchant",
  "method",
  "result",
  "attempt",
] as const satisfies readonly (keyof JournalEntry)[];

export interface Journal {
  record(entry: JournalEntry): void;
}

/** Журнал в памяти — для тестов и минимальной оболочки. */
export class MemoryJournal implements Journal {
  readonly entries: JournalEntry[] = [];
  record(entry: JournalEntry): void {
    this.entries.push(Object.freeze({ ...entry }));
  }
}
