import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SignerKeyRejected, assertStrongEd25519, kidOf } from "../../src/agent/signer/index.js";
import { isWeakEd25519 } from "../../src/agent/signer/weak.js";
import vectors from "../vectors/ed25519-weak.json" with { type: "json" };

const SPKI_HEADER = Buffer.from("302a300506032b6570032100", "hex");
const spkiOf = (hex: string): Buffer => Buffer.concat([SPKI_HEADER, Buffer.from(hex, "hex")]);
const RFC8037_X = Buffer.from("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", "base64url");

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
  const Y_P_PLUS_3 = ["f0" + "ff".repeat(30) + "7f", "f0" + "ff".repeat(31)];
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
