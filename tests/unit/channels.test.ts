// Способ оплаты агента у витрины (дополнение 1 к Р66 п. 3): пересечение `payment_methods` витрины со способами агента;
// строки витрины — данные (инвариант 5), соответствие точное. Новый способ агента переводит ту же витрину в контур без
// правки правила.
import { describe, expect, it } from "vitest";
import { AGENT_CHANNELS, paymentChannel } from "../../src/agent/policy/channels.js";

describe("policy/channels: способ оплаты агента у витрины (дополнение 1 к Р66 п. 3)", () => {
  it("агент сейчас исполняет только CARD", () => {
    expect(AGENT_CHANNELS).toEqual(["CARD"]);
  });

  it("card — CARD; card и sbp — CARD; только sbp — нет способа", () => {
    expect(paymentChannel(["card"])).toBe("CARD");
    expect(paymentChannel(["sbp", "card"])).toBe("CARD");
    expect(paymentChannel(["sbp"])).toBeNull();
  });

  it("та же витрина без способа агента — после добавления способа агенту есть канал, правило то же", () => {
    const shop = ["sbp"];
    expect(paymentChannel(shop)).toBeNull();
    expect(paymentChannel(shop, ["CARD", "SBP"])).toBe("SBP");
  });

  it("канал — в порядке способов агента, не витрины", () => {
    expect(paymentChannel(["sbp", "card"], ["SBP", "CARD"])).toBe("SBP");
    expect(paymentChannel(["sbp", "card"], ["CARD", "SBP"])).toBe("CARD");
  });

  it.each([
    ["пустой список", []],
    ["наличные", ["cash"]],
    ["регистр", ["Card"]],
    ["пробелы", [" card", "card "]],
    ["значение ПАО вместо витрины", ["CARD"]],
    ["ключи прототипа", ["constructor", "__proto__", "toString"]],
  ])("нет способа: %s", (_name, methods) => {
    expect(paymentChannel(methods)).toBeNull();
  });
});
