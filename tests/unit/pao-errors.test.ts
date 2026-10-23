import { describe, it, expect } from "vitest";
import { PAO_ERRORS, PaoCallError, type ErrorCode } from "@kuzin4u/agentic-core/pao";
import { toFailure } from "../../src/agent/adapters/pao/errors.js";
import { FAILURE_RULES } from "../../src/agent/declines/index.js";

describe("отказ ПАО → отказ ядра", () => {
  it.each(Object.entries(PAO_ERRORS))("%s: код по ПАО, retry по таблице ядра", (code, row) => {
    const f = toFailure(new PaoCallError(row.http, { code: code as ErrorCode, message: "m", retry: row.retry }, 1, "idem_1"));
    expect(f.code).toBe(code);
    expect(f.retry).toBe(FAILURE_RULES[code as ErrorCode].retry);
    expect(f.message).toBe(`Отказ платформы: ${code}, HTTP ${row.http}`);
    expect(f.idempotencyKey).toBe("idem_1");
  });

  it("неизвестный код — UNKNOWN, never, даже если платформа разрешает повтор", () => {
    const f = toFailure(new PaoCallError(409, { code: "NEW_CODE" as ErrorCode, message: "m", retry: "same_key" }, 1));
    expect([f.code, f.retry, f.platformCode]).toEqual(["UNKNOWN", "never", "NEW_CODE"]);
  });

  it("нет ответа (status 0) — NO_RESPONSE, same_key; отказ без тела — BAD_RESPONSE, never; не разобрано — UNKNOWN (Р48 п. 3)", () => {
    expect([toFailure(new PaoCallError(0, undefined, 3)).code, toFailure(new PaoCallError(0, undefined, 3)).retry]).toEqual(["NO_RESPONSE", "same_key"]);
    expect([toFailure(new PaoCallError(503, undefined, 3)).code, toFailure(new PaoCallError(503, undefined, 3)).retry]).toEqual(["BAD_RESPONSE", "never"]);
    expect(toFailure(new Error("сбой")).code).toBe("UNKNOWN");
  });

  it("отказ клиента ПАО (clientCode, К18) — свой код, after_fix; тело не читается (Р37 п. 1)", () => {
    const r = toFailure(new PaoCallError(302, undefined, 1, "idem_1", { clientCode: "PAO_CLIENT_REDIRECT" }));
    expect([r.code, r.retry, r.platformCode, r.httpStatus, r.idempotencyKey]).toEqual(["PAO_CLIENT_REDIRECT", "after_fix", null, 302, "idem_1"]);
    const s = toFailure(new PaoCallError(0, undefined, 0, undefined, { clientCode: "PAO_CLIENT_SIGNER_MISSING" }));
    expect([s.code, s.retry]).toEqual(["PAO_CLIENT_SIGNER_MISSING", "after_fix"]);
    // код клиента вне словаря (dist ядра новее типов) — UNKNOWN, never (ревью К0 № 6)
    const u = toFailure(new PaoCallError(0, undefined, 0, undefined, { clientCode: "PAO_CLIENT_NEW" as "PAO_CLIENT_REDIRECT" }));
    expect([u.code, u.retry]).toEqual(["UNKNOWN", "never"]);
  });

  it("известный код с чужим HTTP-статусом — BAD_RESPONSE, never (Р48 п. 3)", () => {
    const f = toFailure(new PaoCallError(500, { code: "UPSTREAM_UNAVAILABLE", message: "m", retry: "same_key" }, 1));
    expect([f.code, f.retry, f.platformCode]).toEqual(["BAD_RESPONSE", "never", "UPSTREAM_UNAVAILABLE"]);
  });

  it("сообщение исключения и мусорный код не переносятся", () => {
    const f = toFailure(new SyntaxError('Unexpected token S in JSON at "cryptogram": SECRETCRYP'));
    expect(f.message).not.toContain("SECRETCRYP");
    const g = toFailure(new PaoCallError(409, { code: "x\" SECRET" as ErrorCode, message: "m", retry: "never" }, 1));
    expect(g.platformCode).toBeNull();
  });
});
