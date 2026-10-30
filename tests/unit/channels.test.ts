// Способ оплаты агента у витрины (дополнение 1 к Р66 п. 3): пересечение `payment_methods` витрины со способами агента;
// строки витрины — данные (инвариант 5), соответствие точное. Новый способ агента переводит ту же витрину в контур без
// правки правила.
import type * as Pao from "@kuzin4u/agentic-core/pao";
import { describe, expect, it } from "vitest";
import { packageFromPao } from "../../src/agent/adapters/pao/map.js";
import { bindOperation } from "../../src/agent/operations/bind.js";
import { AGENT_CHANNELS, paymentChannel } from "../../src/agent/policy/channels.js";
import { PlatformFailure, type Mandate } from "../../src/shared/domain.js";

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

// Предохранитель (ревью КТ1 № 1, решение владельца 30.10): способ попадает в AGENT_CHANNELS только вместе с исполнением —
// сверкой канала операции (operations/bind) и проверкой полноты реквизита этого вида (adapters/pao/map). Иначе покупка
// по новому каналу остановилась бы OPERATION_REPLY_MISMATCH уже после блокировки суммы или пакет ушёл бы без проверки.
describe("каждый способ из AGENT_CHANNELS исполняется: сверка канала операции и проверка реквизита", () => {
  const CART = { id: "m_cart", cart: { merchantId: "shop_1", lines: [], total: { amount: 100, currency: "RUB" } } } as unknown as Mandate;

  it.each(AGENT_CHANNELS.map((c) => [c]))("%s — bindOperation принимает операцию этого канала", (channel) => {
    const r = { opRef: "op_1", orderRef: "ORD-1", channel, amountMinor: 100, merchantId: "shop_1", indicator: { agentCode: "a", mandateId: "m_cart" }, status: "AUTHORIZED" as const, declineReason: null, fulfilment: null };
    expect(bindOperation(r, CART)).toMatchObject({ channel });
  });

  it.each(AGENT_CHANNELS.map((c) => [c]))("%s — packageFromPao проверяет полноту реквизита этого вида: пустой payload — BAD_RESPONSE", (channel) => {
    const credential: Pao.Credential = { credential_ref: "cr_1", kind: channel, payload: {}, aoi: { indicator: true, agent_code: "a", mandate_id: "m_cart" }, status: "ISSUED" };
    const draft = { mandate: { id: "m_cart", currency: "RUB" }, orderRef: "ORD-1", merchantId: "shop_1", amountMax: { amount: 100, currency: "RUB" }, channel };
    let err: unknown;
    try {
      packageFromPao(credential, draft);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PlatformFailure);
    expect((err as PlatformFailure).code).toBe("BAD_RESPONSE");
  });
});
