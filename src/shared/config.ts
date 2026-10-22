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

/** Потолок суммарного ожидания по Retry-After (429 и 503) у адаптера ПАО. Норма Платформы, не стендовое значение:
 *  РП24 платформы — Retry-After у 503 в границах 0…30 с; см. STATUS, «Передача для AG-03». */
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
})
  // Обращения и ожидание повторов укладываются в registry_cache_ttl_sec (инвариант 4, Р20).
  .refine(
    (p) => (p.pao_max_attempts * p.pao_request_timeout_ms) / 1000 + PAO_RETRY_AFTER_MAX_SEC <= p.registry_cache_ttl_sec,
    { message: "pao_max_attempts × pao_request_timeout_ms + 30 с (РП24) больше registry_cache_ttl_sec" },
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
