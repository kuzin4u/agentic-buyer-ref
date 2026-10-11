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

  it("нет ответа (status 0) и отказ без тела — UNKNOWN, never", () => {
    expect(toFailure(new PaoCallError(0, undefined, 3)).code).toBe("UNKNOWN");
    expect(toFailure(new PaoCallError(503, undefined, 3)).retry).toBe("never");
    expect(toFailure(new Error("сбой")).code).toBe("UNKNOWN");
  });

  it("известный код с чужим HTTP-статусом — UNKNOWN, never", () => {
    const f = toFailure(new PaoCallError(500, { code: "UPSTREAM_UNAVAILABLE", message: "m", retry: "same_key" }, 1));
    expect([f.code, f.retry, f.platformCode]).toEqual(["UNKNOWN", "never", "UPSTREAM_UNAVAILABLE"]);
  });

  it("сообщение исключения и мусорный код не переносятся", () => {
    const f = toFailure(new SyntaxError('Unexpected token S in JSON at "cryptogram": SECRETCRYP'));
    expect(f.message).not.toContain("SECRETCRYP");
    const g = toFailure(new PaoCallError(409, { code: "x\" SECRET" as ErrorCode, message: "m", retry: "never" }, 1));
    expect(g.platformCode).toBeNull();
  });
});
