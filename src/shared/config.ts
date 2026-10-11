// Стендовые параметры (config/params.stand.json, docs/core/PARAMS.md). Это настройки испытаний, не нормы:
// схема проверяет состав и типы, а не значения. Ошибка схемы — отказ запуска (fail-closed).
import { readFileSync } from "node:fs";
import { z } from "zod";

const count = z.number().int().nonnegative();

export const StandParamsSchema = z.strictObject({
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
});

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
