import { describe, it, expect } from "vitest";
import type * as Pao from "@kuzin4u/agentic-core/pao";
import * as map from "../../src/agent/adapters/pao/map.js";
import { PlatformFailure, type MandateDraft } from "../../src/shared/domain.js";

const draft: MandateDraft = {
  kind: "CART",
  parentId: "m_intent_1",
  subject: "продукты на неделю",
  amountLimit: { amount: 250000, currency: "RUB" },
  validTo: "2026-10-20T00:00:00Z",
  merchantScope: ["shop_1"],
  principalRef: "pr_1",
  confirmationMode: "IMMEDIATE",
  keyTermsShown: true,
  cart: {
    merchantId: "shop_1",
    lines: [{ sku: "sku_1", qty: 2, price: { amount: 125000, currency: "RUB" } }],
    total: { amount: 250000, currency: "RUB" },
  },
};
const CUR: map.Currencies = new Set(["RUB"]);
const AG = "nspk:agent:x:v1";
const M1 = { id: "m_1", currency: "RUB" };

describe("перевод ПАО ↔ ядро", () => {
  it("мандат туда и обратно", () => {
    const req = map.mandateDraftToPao(draft, CUR);
    const back = map.mandateFromPao({ ...req, agent_code: AG, id: "m_1", status: "PENDING_SIGNATURE", signature_type: "simple" }, CUR, AG);
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
    const c = map.credentialFromPao(pao, "m_1", "nspk:agent:buyref-01:v1");
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
    expect(map.mandateCheckFromPao({ outcome: "CONFIRMED", amount_left: 12345, valid_to: "2026-10-20T00:00:00Z" }, M1)).toEqual({
      outcome: "CONFIRMED",
      amountLeft: { amount: 12345, currency: "RUB" },
      validTo: "2026-10-20T00:00:00Z",
      asOf: null,
    });
  });

  it("неполный ответ или дробная сумма — UNKNOWN (fail-closed)", () => {
    const req = map.mandateDraftToPao(draft, CUR);
    expect(() => map.mandateFromPao({ ...req, agent_code: AG, status: "ACTIVE" }, CUR, AG)).toThrow(PlatformFailure);
    expect(() => map.mandateCheckFromPao({ outcome: "CONFIRMED", amount_left: 1.5, valid_to: "x" }, M1)).toThrow(/минимальных единиц/);
    expect(() => map.operationFromPao({ status: "AUTHORIZED" }, M1, "single", AG)).toThrow(PlatformFailure);
  });

  // Р29: валюта суммы — из мандата; множество платформы — допустимое, не источник.
  it("корзина в чужой валюте и мандат вне множества — отказ до обращения", () => {
    const usdLine = { ...draft, cart: { ...draft.cart!, total: { amount: 250000, currency: "USD" } } };
    expect(() => map.mandateDraftToPao(usdLine, CUR)).toThrow(/обращение не отправлено/);
    const usd = { ...draft, amountLimit: { amount: 1, currency: "USD" }, cart: null };
    expect(() => map.mandateDraftToPao(usd, CUR)).toThrow(/вне возможностей платформы/);
    const usdPrice = { ...draft, cart: { ...draft.cart!, lines: [{ sku: "sku_1", qty: 2, price: { amount: 125000, currency: "USD" } }] } };
    expect(() => map.mandateDraftToPao(usdPrice, CUR)).toThrow(/cart\.lines\[0\]\.price — валюта USD/);
    expect(() => map.mandateDraftToPao({ ...draft, amountLimit: { amount: 0, currency: "RUB" } }, CUR)).toThrow(/меньше 1/);
    // та же корзина при платформе с USD — проходит: тип ядра валюту не ограничивает
    const both: map.Currencies = new Set(["RUB", "USD"]);
    expect(map.mandateDraftToPao(usd, both)).toMatchObject({ amount_limit: 1, currency: "USD" });
  });

  it("платформа с двумя валютами: остаток и операция — в валюте своего мандата", () => {
    const both: map.Currencies = new Set(["RUB", "USD"]);
    const req = { ...map.mandateDraftToPao({ ...draft, amountLimit: { amount: 9, currency: "USD" }, cart: null }, both), agent_code: AG, id: "m_u", status: "ACTIVE" as const };
    expect(map.mandateFromPao(req, both, AG).amountLimit).toEqual({ amount: 9, currency: "USD" });
    const u = { id: "m_u", currency: "USD" };
    expect(map.mandateCheckFromPao({ outcome: "CONFIRMED", amount_left: 7, valid_to: "x" }, u).amountLeft).toEqual({ amount: 7, currency: "USD" });
    expect(map.operationFromPao({ op_ref: "op_1", amount: 3, status: "AUTHORIZED" }, u, "list", AG).amount).toEqual({ amount: 3, currency: "USD" });
  });

  it("выписка: валюта операции — её мандата в цепочке; мандата нет — UNKNOWN", () => {
    const intent = { ...map.mandateDraftToPao({ ...draft, kind: "INTENT", parentId: null, cart: null }, CUR), agent_code: AG, id: "m_i", status: "ACTIVE" as const };
    const aoi = (id: string) => ({ indicator: true as const, agent_code: "nspk:agent:x:v1", mandate_id: id });
    const ev = map.evidenceFromPao({ mandate_chain: [intent], operations: [{ op_ref: "op_1", amount: 5, status: "AUTHORIZED", aoi: aoi("m_i") }], integrity: "OK" }, "m_i", CUR, AG);
    expect(ev.operations[0]!.amount).toEqual({ amount: 5, currency: "RUB" });
    expect(() =>
      map.evidenceFromPao({ mandate_chain: [intent], operations: [{ op_ref: "op_2", amount: 5, status: "AUTHORIZED", aoi: aoi("m_x") }], integrity: "OK" }, "m_i", CUR, AG),
    ).toThrow(PlatformFailure);
    const bare = map.evidenceFromPao({ mandate_chain: [intent], operations: [{ op_ref: "op_3", amount: 4, status: "DECLINED" }], integrity: "OK" }, "m_i", CUR, AG);
    expect(bare.operations[0]).toMatchObject({ amount: { amount: 4, currency: "RUB" }, indicator: null });
  });

  it("подтверждение: сумма в валюте мандата, иначе отказ до обращения (Р29 п. 3)", () => {
    const c = { mandate: M1, merchantId: "shop_1", amount: { amount: 300001, currency: "RUB" }, summary: "s", channel: "UPK" as const };
    expect(map.confirmationDraftToPao(c, CUR)).toMatchObject({ mandate_id: "m_1", amount: 300001 });
    expect(() => map.confirmationDraftToPao({ ...c, amount: { amount: 300001, currency: "USD" } }, CUR)).toThrow(/обращение не отправлено/);
  });

  // «Открыто» № 17, ревью К2 № 3а: признак и мандат — только свои.
  it("aoi чужого агента или чужого мандата, мандат чужого агента — UNKNOWN", () => {
    const cred = (aoi: Pao.Aoi): Pao.Credential => ({ credential_ref: "cr_1", kind: "CARD", payload: {}, aoi, status: "ISSUED" });
    expect(() => map.credentialFromPao(cred({ indicator: true, agent_code: "nspk:agent:other:v1", mandate_id: "m_1" }), "m_1", AG)).toThrow(/не этот агент/);
    expect(() => map.credentialFromPao(cred({ indicator: true, agent_code: AG, mandate_id: "m_2" }), "m_1", AG)).toThrow(/не мандат запроса/);
    expect(map.credentialFromPao(cred({ indicator: true, agent_code: AG, mandate_id: "m_1" }), "m_1", AG).indicator).toEqual({ agentCode: AG, mandateId: "m_1" });
    const op = { op_ref: "op_1", amount: 1, status: "AUTHORIZED" as const };
    expect(() => map.operationFromPao({ ...op, aoi: { indicator: true, agent_code: "nspk:agent:other:v1", mandate_id: "m_1" } }, M1, "single", AG)).toThrow(/не этот агент/);
    expect(() => map.operationFromPao({ ...op, aoi: { indicator: true, agent_code: AG, mandate_id: "m_2" } }, M1, "single", AG)).toThrow(/не мандат запроса/);
    const req = { ...map.mandateDraftToPao(draft, CUR), id: "m_1", status: "ACTIVE" as const };
    expect(() => map.mandateFromPao({ ...req, agent_code: "nspk:agent:other:v1" }, CUR, AG)).toThrow(/не этот агент/);
    expect(map.mandateFromPao({ ...req, agent_code: AG }, CUR, AG).id).toBe("m_1");
  });

  // Р27: класс обязателен для ядра (в ПАО 1.4.0 необязателен) — нет поля или значение вне перечня — UNKNOWN.
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
