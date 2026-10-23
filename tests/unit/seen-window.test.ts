// Окно обработанных event_id (Р50 п. 1; жёсткое условие владельца 3 к Р49): размер не растёт сверх предела.
import { describe, expect, it } from "vitest";
import { SeenWindow } from "../../src/agent/events/seen.js";
import { ConfigError, loadParams, parseParams } from "../../src/shared/config.js";

describe("SeenWindow", () => {
  it("размер не больше event_seen_max при любом числе событий; вытесняется старейший", () => {
    const max = loadParams().event_seen_max;
    const w = new SeenWindow(max);
    for (let i = 0; i < max + 50; i++) w.add(`evt_${i.toString(36)}`);
    expect(w.size).toBe(max);
    expect(w.has("evt_0")).toBe(false);
    expect(w.has(`evt_${(max + 49).toString(36)}`)).toBe(true);
  });

  it("повторная отметка не сдвигает и не удваивает; delete — снять отметку (событие прочитается снова)", () => {
    const w = new SeenWindow(2);
    w.add("evt_a");
    w.add("evt_a");
    w.add("evt_b");
    expect(w.size).toBe(2);
    w.delete("evt_a");
    expect(w.has("evt_a")).toBe(false);
    expect(w.size).toBe(1);
  });

  it("предел — целое не меньше 1: иначе отказ (в конфигурации — отказ запуска)", () => {
    expect(() => new SeenWindow(0)).toThrow(RangeError);
    expect(() => new SeenWindow(1.5)).toThrow(RangeError);
    const stand = loadParams();
    expect(() => parseParams({ ...stand, event_seen_max: 0 })).toThrow(ConfigError);
    expect(() => parseParams({ ...stand, event_seen_max: 2.5 })).toThrow(ConfigError);
  });
});
