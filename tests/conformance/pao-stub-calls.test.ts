// Фильтр журнала PaoStub набора соответствия — синтетические записи (сессия 62, PR #99; решение владельца
// #issuecomment-6608172924 п. 3): чужой agentCode со своим kid и чужой kid без agentCode — не обращения агента цели.
import type { PaoStubCall } from "@kuzin4u/agentic-core/pao";
import { describe, expect, it } from "vitest";
import { isOwnCall, ownCalls } from "./pao-stub-calls.js";

const OWN = { agentCode: "nspk:agent:buyref-01:v1", kid: "kid_conformance" };
const OTHER = "nspk:agent:buyref-02:v1";

const call = (over: Partial<PaoStubCall>): PaoStubCall => ({
  op: "POST /pao/v1/mandates",
  method: "POST",
  path: "/pao/v1/mandates",
  status: 201,
  replayed: false,
  ...over,
});

describe("журнал PaoStub глазами набора (agentCode, ядро v0.12.0+)", () => {
  it("свой agentCode и свой kid — своё, подписано", () => {
    const c = call({ agentCode: OWN.agentCode, kid: OWN.kid, idempotencyKey: "k1" });
    expect(isOwnCall(c, OWN)).toBe(true);
    expect(ownCalls([c], OWN)).toEqual([{ mutating: true, status: 201, signed: true, idempotencyKey: "k1" }]);
  });

  it("свой kid, чужой agentCode — не своё (ключ агента принят под кодом другого)", () => {
    const c = call({ agentCode: OTHER, kid: OWN.kid });
    expect(isOwnCall(c, OWN)).toBe(false);
    expect(ownCalls([c], OWN)).toEqual([]);
  });

  it("без agentCode, чужой kid — не своё (отказ подписи другого агента)", () => {
    const c = call({ kid: "kid_conformance_other", status: 401, code: "SIGNATURE_INVALID" });
    expect(isOwnCall(c, OWN)).toBe(false);
    expect(ownCalls([c], OWN)).toEqual([]);
  });

  it("без agentCode, свой kid — своё, не подписано (подпись не прошла проверку)", () => {
    const c = call({ kid: OWN.kid, status: 401, code: "SIGNATURE_INVALID" });
    expect(ownCalls([c], OWN)).toEqual([{ mutating: true, status: 401, code: "SIGNATURE_INVALID", signed: false }]);
  });

  it("без agentCode и kid — своё, не подписано (неподписанная операция)", () => {
    const c = call({ op: undefined, method: "GET", path: "/pao/v1/configuration", status: 200 });
    expect(ownCalls([c], OWN)).toEqual([{ mutating: false, status: 200, signed: false }]);
  });

  it("свой agentCode, чужой kid — своё, но не подписано своим ключом", () => {
    const c = call({ agentCode: OWN.agentCode, kid: "kid_rotated" });
    expect(ownCalls([c], OWN)).toEqual([{ mutating: true, status: 201, signed: false }]);
  });
});
