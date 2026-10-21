// Реестр кодов витрин (Р42 п. 7, передача #33): полнота по перечню эмулятора Платформы (MERCHANT_ERROR_CODES, PS-12),
// формат К17, HTTP-статусы адаптера — как у эмулятора; повторяемые — только временные; отдельно от полного реестра DIAG.
import { describe, expect, it } from "vitest";
import { checkDiagRegistry } from "@kuzin4u/agentic-core/diag";
import { MERCHANT_ERROR_CODES } from "agentic-ps-platform/fixtures";
import { MERCHANT_HTTP } from "../../src/agent/adapters/shops/index.js";
import { DIAG } from "../../src/agent/compose.js";
import { MERCHANT_CODES, MERCHANT_DIAG, MERCHANT_RETRYABLE } from "../../src/agent/declines/index.js";

describe("реестр кодов витрин MERCHANT_DIAG (Р42 п. 7)", () => {
  it("полнота: перечень агента = перечень эмулятора; запись на каждый код по К17, тексты ru", () => {
    expect([...MERCHANT_CODES].sort()).toEqual(MERCHANT_ERROR_CODES.map((c) => c.code).sort());
    expect(new Set(MERCHANT_CODES).size).toBe(MERCHANT_CODES.length);
    expect(checkDiagRegistry(MERCHANT_CODES, MERCHANT_DIAG, { langs: ["ru"] })).toEqual([]);
  });

  it("HTTP-статус каждого кода у адаптера — как у эмулятора", () => {
    expect(Object.fromEntries(MERCHANT_ERROR_CODES.map((c) => [c.code, c.http]))).toEqual({ ...MERCHANT_HTTP });
  });

  it("источник — продавец у каждого кода; повтора действием реестра нет; повторяемые — только 429 и 503", () => {
    for (const e of Object.values(MERCHANT_DIAG)) {
      expect(e.source).toContain("merchant");
      expect(e.action).not.toBe("retry_same_key");
    }
    expect([...MERCHANT_RETRYABLE].sort()).toEqual(["RATE_LIMITED", "UPSTREAM_UNAVAILABLE"]);
    expect([...MERCHANT_RETRYABLE].map((c) => MERCHANT_HTTP[c]).sort()).toEqual([429, 503]);
  });

  it("в полный реестр DIAG не слит: коды только витрин в DIAG отсутствуют, у пересекающихся — запись ПАО или агента, не витрины", () => {
    for (const [code, entry] of Object.entries(MERCHANT_DIAG)) {
      const own = DIAG[code];
      if (own === undefined) continue;
      expect(own, code).not.toBe(entry);
      expect(own.source, code).not.toContain("merchant");
    }
    // хотя бы часть кодов витрин — только витрин: копия реестра в DIAG их бы добавила
    const only = MERCHANT_CODES.filter((c) => DIAG[c] === undefined);
    expect(only).toEqual(expect.arrayContaining(["SHOP_NOT_FOUND", "ITEM_INCOMPLETE", "ORDER_NOT_PAYABLE"]));
  });
});
