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

  it("отказ при отсутствии файла", () => {
    expect(() => loadParams("config/missing.json")).toThrow(ConfigError);
  });
});
