import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { isWeakEd25519 as coreIsWeak } from "@kuzin4u/agentic-core";
import { describe, expect, it } from "vitest";
import { SignerKeyRejected, assertStrongEd25519, kidOf } from "../../src/agent/signer/index.js";
import * as weakModule from "../../src/agent/signer/weak.js";
import vectors from "../vectors/ed25519-weak.json" with { type: "json" };

/** Общие векторы ядра (К10): точка — hex, `weak` — ожидаемый ответ; длины 31 и 33 байта — тоже слабые. */
interface CoreWeakVector { point: string; weak: boolean; why: string }
// Подпути vectors у пакета нет (exports — "." и "./pao"): корень ядра — вверх от точки входа (как в core-dependency).
function coreRoot(): string {
  let dir = dirname(createRequire(import.meta.url).resolve("@kuzin4u/agentic-core"));
  while (!existsSync(`${dir}/package.json`) || JSON.parse(readFileSync(`${dir}/package.json`, "utf8")).name !== "@kuzin4u/agentic-core") {
    if (dirname(dir) === dir) throw new Error("package.json ядра не найден");
    dir = dirname(dir);
  }
  return dir;
}
const CORE_ROOT = coreRoot();
const coreVectors = (JSON.parse(readFileSync(`${CORE_ROOT}/vectors/vectors.json`, "utf8")) as {
  ed25519_weak_keys: CoreWeakVector[];
}).ed25519_weak_keys;
const { isWeakEd25519 } = weakModule;
// y = p + 3 со знаковым битом — только у агента; в векторах ядра v0.8.0 нет (передать в CO-1, STATUS «Открыто»).
const LOCAL_ONLY = ["f0" + "ff".repeat(31)];
// Неканоническая запись точки большого порядка (y = 3): её отсекает только проверка y < p; [8]A = O не срабатывает.
const Y_P_PLUS_3 = ["f0" + "ff".repeat(30) + "7f", ...LOCAL_ONLY];

const SPKI_HEADER = Buffer.from("302a300506032b6570032100", "hex");
const spkiOf = (hex: string): Buffer => Buffer.concat([SPKI_HEADER, Buffer.from(hex, "hex")]);
const RFC8037_X = Buffer.from("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", "base64url");

describe("слабые ключи Ed25519 — функция и векторы ядра (К10, AG-05 К1.3)", () => {
  it("signer проверяет функцией ядра v0.8.0, своей копии нет", () => {
    expect(JSON.parse(readFileSync(`${CORE_ROOT}/package.json`, "utf8")).version).toBe("0.8.0");
    expect(isWeakEd25519).toBe(coreIsWeak);
    expect(Object.keys(weakModule).sort()).toEqual(["assertStrongEd25519", "isWeakEd25519"]);
  });

  it("векторы ядра на месте: слабые и сильные, длины 31 и 33", () => {
    expect(coreVectors.length).toBeGreaterThanOrEqual(19);
    expect(coreVectors.some((v) => !v.weak)).toBe(true);
    expect(coreVectors.map((v) => v.point.length / 2)).toEqual(expect.arrayContaining([31, 32, 33]));
  });

  // Поломка (ревью плана № 2): assertStrongEd25519 без isWeakEd25519 или с инвертированным ответом — красный.
  it.each(coreVectors.map((v) => [v.why, v.point, v] as const))("вектор ядра «%s» %s", (_, __, v) => {
    const x = Buffer.from(v.point, "hex");
    expect(isWeakEd25519(x)).toBe(v.weak);
    if (v.weak) expect(() => assertStrongEd25519(x)).toThrow(SignerKeyRejected);
    else expect(() => assertStrongEd25519(x)).not.toThrow();
  });

  it("прежние векторы (копия платформы и y = p + 3) — подмножество слабых векторов ядра", () => {
    const weak = new Set(coreVectors.filter((v) => v.weak).map((v) => v.point));
    for (const hex of [...vectors.small_order, ...vectors.non_canonical, ...Y_P_PLUS_3]) {
      if (LOCAL_ONLY.includes(hex)) expect(weak, hex).not.toContain(hex);
      else expect(weak, hex).toContain(hex);
    }
  });
});

describe("слабые ключи Ed25519 — SignerKeyRejected (A2 п. 5.1, инвариант 4)", () => {
  it("векторы — копия платформы: 8 точек малого порядка и 4 неканонические записи", () => {
    expect(vectors.source).toContain("agentic-ps-platform v0.1.0");
    expect(vectors.small_order).toHaveLength(8);
    expect(vectors.non_canonical).toHaveLength(4);
  });

  it("почему это блокер: с ключом-нейтралью подпись «R = нейтраль, S = 0» верна для любого сообщения", () => {
    const neutral = vectors.small_order[0]!;
    const pub = createPublicKey({ key: spkiOf(neutral), format: "der", type: "spki" });
    const forged = Buffer.concat([Buffer.from(neutral, "hex"), Buffer.alloc(32)]);
    expect(verify(null, Buffer.from("любое обращение"), pub, forged)).toBe(true);
  });

  it.each(vectors.small_order)("точка малого порядка %s — отклоняется", (hex) => {
    expect(isWeakEd25519(Buffer.from(hex, "hex"))).toBe(true);
    expect(() => assertStrongEd25519(Buffer.from(hex, "hex"))).toThrow(SignerKeyRejected);
  });

  it.each(vectors.non_canonical)("неканоническая запись %s — отклоняется", (hex) => {
    expect(isWeakEd25519(Buffer.from(hex, "hex"))).toBe(true);
    expect(() => assertStrongEd25519(Buffer.from(hex, "hex"))).toThrow(SignerKeyRejected);
  });

  // Свой вектор, в копии платформы его нет: y = p + 3 — неканоническая запись точки большого порядка (y = 3).
  // Её отсекает только проверка y < p; [8]A = O не срабатывает. Передать в CO-1 для общих векторов.
  it.each(Y_P_PLUS_3)("y = p + 3, точка большого порядка в неканонической записи %s — отклоняется", (hex) => {
    expect(isWeakEd25519(Buffer.from(hex, "hex"))).toBe(true);
    expect(() => assertStrongEd25519(Buffer.from(hex, "hex"))).toThrow(SignerKeyRejected);
    expect(() => kidOf(spkiOf(hex).toString("base64"))).toThrow(SignerKeyRejected);
  });

  it("длина не 32 байта — отклоняется", () => {
    expect(() => assertStrongEd25519(RFC8037_X.subarray(1))).toThrow(SignerKeyRejected);
    expect(() => assertStrongEd25519(Buffer.concat([RFC8037_X, Buffer.from([0])]))).toThrow(SignerKeyRejected);
  });

  it("эталон RFC 8037 и 50 случайных ключей — не слабые", () => {
    expect(() => assertStrongEd25519(RFC8037_X)).not.toThrow();
    for (let i = 0; i < 50; i++) {
      const der = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
      expect(isWeakEd25519(der.subarray(SPKI_HEADER.length))).toBe(false);
    }
  });

  it.each([...vectors.small_order, ...vectors.non_canonical])("kid слабого ключа %s не вычисляется — SignerKeyRejected", (hex) => {
    expect(() => kidOf(spkiOf(hex).toString("base64"))).toThrow(SignerKeyRejected);
  });
});
