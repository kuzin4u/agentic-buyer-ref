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

  it("отказ при отсутствии файла", () => {
    expect(() => loadParams("config/missing.json")).toThrow(ConfigError);
  });
});
