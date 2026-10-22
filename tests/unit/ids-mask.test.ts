// Маски идентификаторов — одна копия в src/shared/ids.ts (Р46 п. 1): копии расходились (Р45 К2 № 12).
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ORDER_REF } from "../../src/agent/payment-package/index.js";
import { EVENT_ID } from "../../src/agent/events/cursor.js";
import { SAFE_ID, SHOP_ID } from "../../src/shared/ids.js";

const SRC = resolve(process.cwd(), "src");
const OWNER = join(SRC, "shared", "ids.ts");
/** Класс знаков маски идентификатора с любыми границами длины (ревью reviewer К1 № 3): `[A-Za-z0-9_.:-]{…}`. */
const LITERAL = /\[A-Za-z0-9_\.:-\]\{\d*,?\d*\}/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

describe("маски идентификаторов (Р46 п. 1)", () => {
  it("в src литерал маски идентификатора — только в shared/ids.ts", () => {
    const copies = files(SRC).filter((f) => f !== OWNER && LITERAL.test(readFileSync(f, "utf8")));
    expect(copies).toEqual([]);
    expect(LITERAL.test(readFileSync(OWNER, "utf8"))).toBe(true);
  });

  it("ORDER_REF и EVENT_ID — та же маска SAFE_ID (128); SHOP_ID — 64", () => {
    expect(ORDER_REF).toBe(SAFE_ID);
    expect(EVENT_ID).toBe(SAFE_ID);
    expect(SAFE_ID.test("a".repeat(128))).toBe(true);
    expect(SAFE_ID.test("a".repeat(129))).toBe(false);
    expect(SHOP_ID.test("a".repeat(64))).toBe(true);
    expect(SHOP_ID.test("a".repeat(65))).toBe(false);
  });
});
