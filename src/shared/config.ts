// Стендовые параметры (config/params.stand.json, docs/core/PARAMS.md). Это настройки испытаний, не нормы:
// схема проверяет состав и типы, а не значения. Ошибка схемы — отказ запуска (fail-closed).
import { readFileSync } from "node:fs";
import { z } from "zod";

const count = z.number().int().nonnegative();
const positive = z.number().int().positive();
/** Предел таймера Node: больше 2^31 − 1 мс таймер срабатывает через 1 мс (agentic-core `checkLiveOffer`). */
export const TIMER_MAX_MS = 2_147_483_647;
/** Секунды, которые переводятся в мс для ядра: после × 1000 значение остаётся safe integer — отказ при запуске, а не при проверке. */
const secToMs = count.max(Math.floor(Number.MAX_SAFE_INTEGER / 1000));

/** Потолок суммарного ожидания по Retry-After (429 и 503) у адаптера ПАО — не стендовое значение (PARAMS, «Значения
 *  агента»): для 503 — норма Платформы (РП24: Retry-After в границах 0…30 с), для 429 — собственное значение агента
 *  (Р50 п. 6 (в); РП24 для 429 потолка не задаёт). */
export const PAO_RETRY_AFTER_MAX_SEC = 30;

/** Предел обработчика POST /pao/v1/credentials у Платформы (передача #47 п. 3: до четырёх внешних вызовов по 5 с, предел
 *  30 с). Свойство Платформы, не стендовое значение (Р45 п. 2.5): тайм-аут агента на выдачу — строго больше. */
export const PAO_CREDENTIALS_HANDLER_MAX_MS = 30_000;

export const StandParamsSchema = z
  .strictObject({
  _comment: z.string().optional(),
  confirm_above_kop: count,
  key_ttl_days: count,
  key_overlap_days: count,
  signature_skew_sec: count,
  registry_cache_ttl_sec: count,
  order_hold_sec: count,
  idempotency_ttl_sec: count,
  split_window_sec: count,
  split_min_ops: count,
  qualified_signature_above_kop: count,
  qualified_signature_above_days: count,
  price_corridor_pct: z.number().nonnegative(),
  revocation_propagation_max_ms: count,
  pao_max_attempts: positive,
  pao_request_timeout_ms: positive,
  // Частота обращений к ПАО, пока предел второго слоя неизвестен (Р59 п. 3, fail-closed): до первого GET /pao/v1/agent,
  // нет rate_limit_per_min или значение не целое ≥ 1.
  pao_rate_limit_fallback_per_min: positive,
  // Тайм-аут выдачи реквизита POST /pao/v1/credentials (Р45 п. 2.5): выше предела обработчика Платформы.
  pao_credentials_timeout_ms: positive.max(TIMER_MAX_MS),
  // Живая проверка перед заказом (Р32 п. 7): в checkLiveOffer ядра передаются в мс.
  live_check_timeout_ms: positive.max(TIMER_MAX_MS),
  live_check_max_age_sec: secToMs,
  live_check_clock_skew_sec: secToMs,
  // Лента событий (Р34 п. 9): наименьший промежуток между чтениями и пауза опроса без push.
  event_poll_interval_ms: positive.max(TIMER_MAX_MS),
  // Витрины продавцов (Р42 п. 1, 4): тайм-аут обращения; повтор 429 и 503 на GET — после Retry-After не больше предела,
  // без Retry-After — через shop_retry_default_ms.
  shop_request_timeout_ms: positive.max(TIMER_MAX_MS),
  // × 1000 — пауза таймера: не больше его предела, иначе таймер сработает сразу (ревью К1 № 7)
  shop_retry_after_max_sec: count.max(Math.floor(TIMER_MAX_MS / 1000)),
  shop_retry_default_ms: positive.max(TIMER_MAX_MS),
  // Общий срок стадии поиска (Р44 п. 6, Р-183): по истечении оставшиеся витрины недоступны (SHOP_SEARCH_DEADLINE).
  shop_search_deadline_ms: positive.max(TIMER_MAX_MS),
  // Ожидание запроса подтверждения после ответа продавца DECLINED (Р47 п. 4): не пришёл — OPERATION_RESULT_UNCONFIRMED.
  confirmation_wait_ms: positive.max(TIMER_MAX_MS),
  // Предел задержки события итога операции (#57 п. 4, Р49 п. 1): на стадии 5 — ожидание operation.* после ответа продавца,
  // на стадии 6 — пауза повтора GET после отказа с просьбой повторить (плановое перечитывание — operation_reread_interval_sec,
  // Р51 п. 2). Равен параметру стенда (тест стенда).
  // × 1000 — срок таймера: не больше его предела (как shop_retry_after_max_sec); 0 — ожидания нет, не допускается
  operation_outcome_max_delay_sec: positive.max(Math.floor(TIMER_MAX_MS / 1000)),
  // Стадия 6 (РП55, Р51 п. 2): плановое перечитывание GET операции — не чаще раза в operation_reread_interval_sec (срок
  // таймера: не больше его предела); граница ожидания клиринга — reservation_ttl_sec от привязки AUTHORIZED (срок по часам,
  // не таймер: × 1000 остаётся safe integer). Равны параметрам стенда Платформы.
  operation_reread_interval_sec: positive.max(Math.floor(TIMER_MAX_MS / 1000)),
  reservation_ttl_sec: positive.max(Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
  // Окно обработанных event_id у модулей операций и подтверждений (Р50 п. 1): вытеснение старейшего, рост ограничен.
  event_seen_max: positive,
})
  // Обращения и ожидание повторов укладываются в registry_cache_ttl_sec (инвариант 4, Р20).
  .refine(
    (p) => (p.pao_max_attempts * p.pao_request_timeout_ms) / 1000 + PAO_RETRY_AFTER_MAX_SEC <= p.registry_cache_ttl_sec,
    { message: "pao_max_attempts × pao_request_timeout_ms + 30 с (РП24) больше registry_cache_ttl_sec" },
  )
  // Повторы тем же ключом (Р48 п. 4б): весь бюджет повторов — в сроке хранения ключа идемпотентности на Платформе.
  .refine(
    (p) => (p.pao_max_attempts * p.pao_request_timeout_ms) / 1000 + PAO_RETRY_AFTER_MAX_SEC <= p.idempotency_ttl_sec,
    { message: "pao_max_attempts × pao_request_timeout_ms + 30 с (РП24) больше idempotency_ttl_sec" },
  )
  // Выдача реквизита (Р45 п. 2.4–2.5): тайм-аут строго больше предела обработчика Платформы, не меньше общего тайм-аута ПАО
  // и вмещается в registry_cache_ttl_sec — срок выдачи вместе с повторами (В2а, инвариант 4).
  .refine((p) => p.pao_credentials_timeout_ms > PAO_CREDENTIALS_HANDLER_MAX_MS, {
    message: `pao_credentials_timeout_ms не больше предела обработчика Платформы ${PAO_CREDENTIALS_HANDLER_MAX_MS} мс`,
  })
  .refine((p) => p.pao_credentials_timeout_ms >= p.pao_request_timeout_ms, { message: "pao_credentials_timeout_ms меньше pao_request_timeout_ms" })
  .refine((p) => p.pao_credentials_timeout_ms <= p.registry_cache_ttl_sec * 1000, { message: "pao_credentials_timeout_ms больше registry_cache_ttl_sec" })
  // Ожидание запроса подтверждения — в пределах registry_cache_ttl_sec (Р47 п. 4, инвариант 4).
  .refine((p) => p.confirmation_wait_ms <= p.registry_cache_ttl_sec * 1000, { message: "confirmation_wait_ms больше registry_cache_ttl_sec" })
  // Ожидание итога операции — в пределах registry_cache_ttl_sec (Р49 п. 1, инвариант 4).
  .refine((p) => p.operation_outcome_max_delay_sec <= p.registry_cache_ttl_sec, { message: "operation_outcome_max_delay_sec больше registry_cache_ttl_sec" })
  // Перечитывание укладывается в границу ожидания клиринга: хотя бы одно плановое чтение до границы (Р51 п. 2).
  .refine((p) => p.operation_reread_interval_sec <= p.reservation_ttl_sec, { message: "operation_reread_interval_sec больше reservation_ttl_sec" })
  // Опрос ленты — не больше половины запасной частоты обращений к ПАО (Р59 п. 3).
  .refine((p) => 60_000 / p.event_poll_interval_ms <= p.pao_rate_limit_fallback_per_min / 2, {
    message: "60 000 / event_poll_interval_ms больше pao_rate_limit_fallback_per_min / 2",
  })
  // Срок поиска вмещает хотя бы одно обращение к витрине (Р44 п. 6).
  .refine((p) => p.shop_search_deadline_ms >= p.shop_request_timeout_ms, { message: "shop_search_deadline_ms меньше shop_request_timeout_ms" });

export type StandParams = z.infer<typeof StandParamsSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function parseParams(raw: unknown): StandParams {
  const r = StandParamsSchema.safeParse(raw);
  if (!r.success) {
    const where = r.error.issues.map((i) => `${i.path.join(".") || "(корень)"}: ${i.message}`).join("; ");
    throw new ConfigError(`Стендовые параметры не прошли схему: ${where}`);
  }
  return r.data;
}

export function loadParams(path = "config/params.stand.json"): StandParams {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`Стендовые параметры не прочитаны (${path}): ${(e as Error).message}`);
  }
  return parseParams(raw);
}
