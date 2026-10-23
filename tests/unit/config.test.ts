import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ConfigError, loadParams, parseParams } from "../../src/shared/config.js";

const stand = JSON.parse(readFileSync("config/params.stand.json", "utf8"));

describe("стендовые параметры", () => {
  it("params.stand.json проходит схему", () => {
    const p = loadParams();
    expect(p.registry_cache_ttl_sec).toBe(stand.registry_cache_ttl_sec);
    expect(p.confirm_above_kop).toBe(stand.confirm_above_kop);
  });

  it("отказ при отсутствии ключа", () => {
    const rest = { ...stand };
    delete rest.registry_cache_ttl_sec;
    expect(() => parseParams(rest)).toThrow(ConfigError);
  });

  it("отказ при лишнем ключе", () => {
    expect(() => parseParams({ ...stand, unknown_key: 1 })).toThrow(/unknown_key|Unrecognized/);
  });

  it("отказ при дробном или отрицательном значении", () => {
    expect(() => parseParams({ ...stand, confirm_above_kop: 1.5 })).toThrow(ConfigError);
    expect(() => parseParams({ ...stand, order_hold_sec: -1 })).toThrow(ConfigError);
  });

  it("бюджет: attempts × timeout + 30 с (РП24) не больше registry_cache_ttl_sec", () => {
    expect(() => parseParams({ ...stand, pao_max_attempts: 3, pao_request_timeout_ms: 10001 })).toThrow(/registry_cache_ttl_sec/);
    expect(() => parseParams({ ...stand, registry_cache_ttl_sec: 44 })).toThrow(ConfigError);
    expect(() => parseParams({ ...stand, registry_cache_ttl_sec: 45 })).not.toThrow();
    expect(() => parseParams({ ...stand, pao_max_attempts: 0 })).toThrow(ConfigError);
  });

  it("Р48 п. 4б: бюджет повторов тем же ключом не больше idempotency_ttl_sec (срок хранения ключа на Платформе)", () => {
    // 3 × 5 с + 30 с = 45 с: при registry_cache_ttl_sec 45 срок ключа 44 с — отказ, 45 с — принят
    const tight = { ...stand, registry_cache_ttl_sec: 45, pao_max_attempts: 3, pao_request_timeout_ms: 5000 };
    expect(() => parseParams({ ...tight, idempotency_ttl_sec: 44 })).toThrow(/idempotency_ttl_sec/);
    expect(() => parseParams({ ...tight, idempotency_ttl_sec: 45 })).not.toThrow();
  });

  it("Р49 п. 1: operation_outcome_max_delay_sec — целое > 0, срок таймера Node и не больше registry_cache_ttl_sec", () => {
    const without = { ...stand };
    delete without.operation_outcome_max_delay_sec;
    expect(() => parseParams(without)).toThrow(/operation_outcome_max_delay_sec/);
    expect(() => parseParams({ ...stand, operation_outcome_max_delay_sec: 0 })).toThrow(ConfigError);
    expect(() => parseParams({ ...stand, operation_outcome_max_delay_sec: 1.5 })).toThrow(ConfigError);
    expect(() => parseParams({ ...stand, operation_outcome_max_delay_sec: stand.registry_cache_ttl_sec + 1 })).toThrow(/registry_cache_ttl_sec/);
    expect(() => parseParams({ ...stand, operation_outcome_max_delay_sec: stand.registry_cache_ttl_sec })).not.toThrow();
  });

  it("живая проверка (Р32 п. 7): три параметра обязательны, таймаут — целое 1…2^31 − 1 мс", () => {
    for (const k of ["live_check_timeout_ms", "live_check_max_age_sec", "live_check_clock_skew_sec"]) {
      const rest = { ...stand };
      delete rest[k];
      expect(() => parseParams(rest), k).toThrow(ConfigError);
    }
    expect(() => parseParams({ ...stand, live_check_timeout_ms: 0 })).toThrow(ConfigError);
    expect(() => parseParams({ ...stand, live_check_timeout_ms: 2_147_483_648 })).toThrow(ConfigError);
    expect(() => parseParams({ ...stand, live_check_timeout_ms: 2_147_483_647 })).not.toThrow();
    expect(() => parseParams({ ...stand, live_check_max_age_sec: -1 })).toThrow(ConfigError);
    expect(() => parseParams({ ...stand, live_check_clock_skew_sec: 0.5 })).toThrow(ConfigError);
    expect(() => parseParams({ ...stand, live_check_max_age_sec: 0, live_check_clock_skew_sec: 0 })).not.toThrow();
    const maxSec = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
    expect(() => parseParams({ ...stand, live_check_max_age_sec: maxSec })).not.toThrow();
    expect(() => parseParams({ ...stand, live_check_clock_skew_sec: maxSec + 1 })).toThrow(ConfigError);
  });

  it("витрины (Р42, Р44 п. 6): четыре параметра обязательны; таймауты — 1…2^31 − 1 мс, предел Retry-After — не больше ⌊(2^31 − 1) / 1000⌋ с", () => {
    for (const k of ["shop_request_timeout_ms", "shop_retry_after_max_sec", "shop_retry_default_ms", "shop_search_deadline_ms"]) {
      const rest = { ...stand };
      delete rest[k];
      expect(() => parseParams(rest), k).toThrow(ConfigError);
    }
    for (const k of ["shop_request_timeout_ms", "shop_retry_default_ms", "shop_search_deadline_ms"]) {
      // срок поиска — не меньше тайм-аута обращения (Р44 п. 6): граница таймера проверяется при наибольшем сроке
      const base = { ...stand, shop_search_deadline_ms: 2_147_483_647 };
      expect(() => parseParams({ ...base, [k]: 0 }), k).toThrow(ConfigError);
      expect(() => parseParams({ ...base, [k]: 2_147_483_648 }), k).toThrow(ConfigError);
      expect(() => parseParams({ ...base, [k]: 2_147_483_647 }), k).not.toThrow();
    }
    // срок поиска меньше тайм-аута обращения — отказ; равен — допустимо (Р44 п. 6)
    expect(() => parseParams({ ...stand, shop_search_deadline_ms: stand.shop_request_timeout_ms - 1 })).toThrow(ConfigError);
    expect(() => parseParams({ ...stand, shop_search_deadline_ms: stand.shop_request_timeout_ms })).not.toThrow();
    // пауза повтора — × 1000 в таймер Node: больше предела таймер сработал бы сразу (ревью К1 № 7)
    const maxSec = Math.floor(2_147_483_647 / 1000);
    expect(() => parseParams({ ...stand, shop_retry_after_max_sec: maxSec })).not.toThrow();
    expect(() => parseParams({ ...stand, shop_retry_after_max_sec: maxSec + 1 })).toThrow(ConfigError);
    expect(() => parseParams({ ...stand, shop_retry_after_max_sec: 0 })).not.toThrow();
    expect(() => parseParams({ ...stand, shop_retry_after_max_sec: -1 })).toThrow(ConfigError);
    expect(() => parseParams({ ...stand, shop_retry_after_max_sec: 1.5 })).toThrow(ConfigError);
    expect(() => parseParams({ ...stand, shop_request_timeout_ms: 1.5 })).toThrow(ConfigError);
    expect(() => parseParams({ ...stand, shop_retry_default_ms: 1.5 })).toThrow(ConfigError);
  });

  it("ожидание запроса подтверждения (Р47 п. 4): обязательно, целое 1…2^31 − 1 мс и не больше registry_cache_ttl_sec × 1000", () => {
    const rest = { ...stand };
    delete rest.confirmation_wait_ms;
    expect(() => parseParams(rest)).toThrow(ConfigError);
    expect(stand.confirmation_wait_ms).toBe(30_000);
    expect(() => parseParams({ ...stand, confirmation_wait_ms: 0 })).toThrow(ConfigError);
    expect(() => parseParams({ ...stand, confirmation_wait_ms: 1.5 })).toThrow(ConfigError);
    expect(() => parseParams({ ...stand, confirmation_wait_ms: stand.registry_cache_ttl_sec * 1000 })).not.toThrow();
    expect(() => parseParams({ ...stand, confirmation_wait_ms: stand.registry_cache_ttl_sec * 1000 + 1 })).toThrow(ConfigError);
  });

  it("отказ при отсутствии файла", () => {
    expect(() => loadParams("config/missing.json")).toThrow(ConfigError);
  });
});
