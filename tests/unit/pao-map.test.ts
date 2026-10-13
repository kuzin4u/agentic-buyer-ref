import { describe, it, expect } from "vitest";
import type * as Pao from "@kuzin4u/agentic-core/pao";
import * as map from "../../src/agent/adapters/pao/map.js";
import { PlatformFailure, type MandateDraft } from "../../src/shared/domain.js";

const draft: MandateDraft = {
  kind: "CART",
  parentId: "m_intent_1",
  subject: "продукты на неделю",
  amountLimit: 250000,
  currency: "RUB",
  validTo: "2026-10-20T00:00:00Z",
  merchantScope: ["shop_1"],
  principalRef: "pr_1",
  confirmationMode: "IMMEDIATE",
  keyTermsShown: true,
  cart: { merchantId: "shop_1", lines: [{ sku: "sku_1", qty: 2, price: 125000 }], total: 250000 },
};

describe("перевод ПАО ↔ ядро", () => {
  it("мандат туда и обратно", () => {
    const req = map.mandateDraftToPao(draft);
    const back = map.mandateFromPao({ ...req, id: "m_1", status: "PENDING_SIGNATURE", signature_type: "simple" });
    expect(back).toEqual({ ...draft, id: "m_1", status: "PENDING_SIGNATURE", signatureLevel: "simple" });
  });

  it("реквизит: payload не переносится (инвариант 1)", () => {
    const pao: Pao.Credential = {
      credential_ref: "cr_1",
      kind: "CARD",
      payload: { token_ref: "tok_secret_ref", cryptogram: "CRYPTOGRAM_VALUE", valid_to: "2026-10-11T12:00:00Z" },
      aoi: { indicator: true, agent_code: "nspk:agent:buyref-01:v1", mandate_id: "m_1" },
      status: "ISSUED",
    };
    const c = map.credentialFromPao(pao);
    expect(c).toEqual({
      credentialRef: "cr_1",
      channel: "CARD",
      status: "ISSUED",
      validTo: "2026-10-11T12:00:00Z",
      indicator: { agentCode: "nspk:agent:buyref-01:v1", mandateId: "m_1" },
    });
    const text = JSON.stringify(c);
    expect(text).not.toContain("CRYPTOGRAM_VALUE");
    expect(text).not.toContain("tok_secret_ref");
    expect(c).not.toHaveProperty("payload");
  });

  it("verify: остаток — как прислала платформа", () => {
    expect(map.mandateCheckFromPao({ outcome: "CONFIRMED", amount_left: 12345, valid_to: "2026-10-20T00:00:00Z" })).toEqual({
      outcome: "CONFIRMED",
      amountLeft: 12345,
      validTo: "2026-10-20T00:00:00Z",
      asOf: null,
    });
  });

  it("неполный ответ или дробные копейки — UNKNOWN (fail-closed)", () => {
    const req = map.mandateDraftToPao(draft);
    expect(() => map.mandateFromPao({ ...req, status: "ACTIVE" })).toThrow(PlatformFailure);
    expect(() => map.mandateCheckFromPao({ outcome: "CONFIRMED", amount_left: 1.5, valid_to: "x" })).toThrow(/копейки/);
    expect(() => map.operationFromPao({ status: "AUTHORIZED" })).toThrow(PlatformFailure);
  });

  // Р27: класс обязателен для ядра (в ПАО 1.2.0 необязателен) — нет поля или значение вне перечня — UNKNOWN.
  it("агент: класс переводится; нет class или значение вне перечня — UNKNOWN", () => {
    const a = { agent_code: "nspk:agent:x:v1", status: "ACTIVE" as const, keys: [] };
    expect(map.agentSelfFromPao({ ...a, class: "SELLER" })).toMatchObject({ agentClass: "SELLER" });
    expect(map.agentSelfFromPao({ ...a, class: "BUYER" })).toMatchObject({ agentClass: "BUYER" });
    for (const bad of [a, { ...a, class: "ADMIN" as "BUYER" }, { ...a, class: "buyer" as "BUYER" }]) {
      const err = (() => {
        try {
          return map.agentSelfFromPao(bad);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(PlatformFailure);
      expect(err).toMatchObject({ code: "UNKNOWN" });
    }
  });

  it("событие: известное переводится, неизвестное и deal.* игнорируются", () => {
    const e = map.eventFromPao({
      event_id: "ev_1",
      type: "operation.declined",
      at: "2026-10-11T10:00:00Z",
      data: { op_ref: "op_1", mandate_id: "m_1", reason: "INSUFFICIENT_FUNDS", pan: "ignored" },
    });
    expect(e).toEqual({
      eventId: "ev_1",
      type: "operation.declined",
      at: "2026-10-11T10:00:00Z",
      mandateId: "m_1",
      opRef: "op_1",
      confirmationId: null,
      declineReason: "INSUFFICIENT_FUNDS",
    });
    expect(map.eventFromPao({ event_id: "ev_2", type: "deal.funded", at: "x", data: {} })).toBeNull();
    expect(map.eventFromPao({ event_id: "ev_3", type: "future.kind" as Pao.Event["type"], at: "x", data: {} })).toBeNull();
  });
});
