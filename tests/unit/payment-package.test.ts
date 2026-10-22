// Пакет агентской оплаты (Р45 п. 3) и номер заказа перед запросом реквизита (Р45 п. 2.1, В1а).
// Серии с верной суммой Луна собираются во время прогона (`luhnTail`) из префикса 9…: литералов, похожих на номер карты,
// в репозитории нет (инвариант 1, guard.py).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { inspect } from "node:util";
import { PAO_SCHEMAS, PAO_VERSION } from "@kuzin4u/agentic-core/pao";
import { ORDER_REF, SEALED, openPackage, orderRefIssue, sealPackage, type PaymentPackageBody } from "../../src/agent/payment-package/index.js";
import { luhnTail } from "../support/luhn.js";

const TOKEN = "tok_ag_секрет_7f2c";
const CRYPTO = "crypto_секрет_base64";
const BODY: PaymentPackageBody = {
  credential_ref: "CRD-91b0",
  kind: "CARD",
  payload: { token_ref: TOKEN, cryptogram: CRYPTO, valid_to: "2026-10-22T10:00:00Z" },
  aoi: { indicator: true, agent_code: "nspk:agent:buyref-01:v3", mandate_id: "MND-cart" },
  cart_mandate_id: "MND-cart",
  order_ref: "ORD-77a1",
};

const leaks = (s: string) => s.includes(TOKEN) || s.includes(CRYPTO);

describe("запечатанный пакет (Р45 п. 3)", () => {
  it("сериализация, строка и inspect — только метка, без реквизита (поломка: без toJSON — красный)", () => {
    const p = sealPackage(BODY);
    expect(JSON.stringify(p)).toBe(JSON.stringify(SEALED));
    expect(JSON.stringify({ deep: { p } })).toBe(JSON.stringify({ deep: { p: SEALED } }));
    expect(String(p)).toBe(SEALED);
    expect(`${p}`).toBe(SEALED);
    expect(inspect(p)).toBe(SEALED);
    expect(leaks(inspect({ a: [p] }, { depth: 10, showHidden: true }))).toBe(false);
    expect(Object.keys(p)).toEqual([]);
  });

  it("копия без закрытого поля не открывается: structuredClone, подмена прототипа", () => {
    const p = sealPackage(BODY);
    expect(() => openPackage(structuredClone(p))).toThrow(TypeError);
    expect(() => openPackage(Object.create(Object.getPrototypeOf(p)) as typeof p)).toThrow(TypeError);
  });

  it("тело — ровно поля ПАО §4, payload и aoi без изменений, суммы нет", () => {
    const body = JSON.parse(openPackage(sealPackage(BODY))) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["aoi", "cart_mandate_id", "credential_ref", "kind", "order_ref", "payload"]);
    expect(body).toEqual(BODY);
  });

  it("открывает пакет только адаптер витрин (и сам модуль пакета)", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith(".ts") ? [join(dir, f)] : []));
    const users = files("src").filter((f) => /openPackage|SealedPackage\.open/.test(readFileSync(f, "utf8")));
    expect(users.map((f) => f.split("\\").join("/")).sort()).toEqual([
      "src/agent/adapters/shops/adapter.ts",
      "src/agent/payment-package/index.ts",
      "src/agent/payment-package/package.ts",
    ]);
  });
});

describe("номер заказа продавца перед запросом реквизита (Р45 п. 2.1)", () => {
  /** 16 цифр с верной суммой Луна */
  const pan = luhnTail("900000000000000");
  /** те же 16 цифр, последняя изменена — Луна не сходится */
  const notPan = pan.slice(0, -1) + String((Number(pan.at(-1)) + 1) % 10);
  const groups = (s: string) => s.match(/.{1,4}/g)!.join("-");

  it("можно: свои ссылки, UUID (Р-160 снят), серия без Луна, длиннее 19 цифр, группы на 12 цифр", () => {
    for (const ref of [
      "ORD-77a1",
      "ORD-1f2e3d4c",
      "ORD-123e4567-e89b-12d3-a456-426614174000",
      `ORD-${notPan}`,
      `ORD-${pan}0000`,
      `ORD-${groups(pan.slice(0, 12))}`,
    ]) {
      expect(orderRefIssue(ref), ref).toBeNull();
    }
  });

  it("PAN_LIKE: сплошная серия, группы по 4, окно внутри серии чисел, последняя группа окна 1–4", () => {
    const pan13 = luhnTail("900000000000");
    for (const ref of [`ORD-${pan}`, `ORD${pan}x`, `ORD-${groups(pan)}`, `ORD-2026-${groups(pan)}-77`, `ORD-${groups(pan13)}`]) {
      expect(orderRefIssue(ref), "образец с верной суммой Луна").toBe("PAN_LIKE");
    }
  });

  it("UUID — не номер карты, как у Платформы (ПАО §4, РП49 (а) п. 3; ревью reviewer К2 № 3)", () => {
    // UUID, в котором окно групп 4-4-4-1 проходит Луна: без исключения UUID — ложный PAN_LIKE
    const w = luhnTail("494694044474");
    const uuid = `ea1c${w.slice(0, 4)}-${w.slice(4, 8)}-${w.slice(8, 12)}-${w[12]}d47-1482cc5ec722`;
    expect(orderRefIssue(uuid)).toBeNull();
    expect(orderRefIssue(`ORD-${uuid}`)).toBeNull();
    // то же окно вне формы UUID — PAN_LIKE
    expect(orderRefIssue(`ORD-${w.slice(0, 4)}-${w.slice(4, 8)}-${w.slice(8, 12)}-${w[12]}x`)).toBe("PAN_LIKE");
    // выборка: номер заказа на стенде — из UUID
    for (let i = 0; i < 20_000; i++) {
      const id = randomUUID();
      expect(orderRefIssue(id), "UUID").toBeNull();
    }
  });

  it.each([[""], ["-ORD"], ["ORD 77a1"], ["ORD/77a1"], ["заказ-1"], [`A${"b".repeat(128)}`]])("%j — PATTERN", (ref) => {
    expect(orderRefIssue(ref)).toBe("PATTERN");
  });

  it("маска — 128 символов, как у Платформы", () => {
    expect(ORDER_REF.test(`A${"b".repeat(127)}`)).toBe(true);
    expect(ORDER_REF.test(`A${"b".repeat(128)}`)).toBe(false);
  });

  it("сторож (В1а): в YAML ПАО у order_ref нет ограничений формата — появятся, маску сводим с YAML", () => {
    // схема ядра — из того же YAML (хэш сверяет pao-copy.test.ts)
    const schemas = PAO_SCHEMAS as unknown as Record<string, { properties: Record<string, unknown> }>;
    expect(schemas.CredentialRequest!.properties.order_ref).toEqual({ type: "string" });
    // и сама копия в docs/core/protocol (ревью reviewer К2 № 10): блок order_ref в CredentialRequest — только type: string
    const yaml = readFileSync(`docs/core/protocol/agent-protocol.v${PAO_VERSION}.yaml`, "utf8");
    const req = yaml.slice(yaml.indexOf("    CredentialRequest:"), yaml.indexOf("    Credential:"));
    expect(req).toMatch(/\n {8}order_ref:\n {10}type: string\n {8}merchant_id:/);
  });
});
