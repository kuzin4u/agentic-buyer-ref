import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SignerKeyRejected, assertKid, kidOf } from "../../src/agent/signer/index.js";
import { ed25519Jwk, jwkThumbprint } from "../../src/agent/signer/kid.js";

// Эталон RFC 8037 прил. A.3: открытый ключ Ed25519 и его отпечаток по RFC 7638 (ПАО §2).
const RFC8037_X = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const RFC8037_KID = "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k";
// Тот же ключ в виде public_key ПАО: DER SPKI (заголовок Ed25519 + 32 байта x), обычный base64.
const RFC8037_SPKI = Buffer.concat([
  Buffer.from("302a300506032b6570032100", "hex"),
  Buffer.from(RFC8037_X, "base64url"),
]).toString("base64");

const spkiOf = (type: "ed25519" | "x25519"): string =>
  generateKeyPairSync(type as "ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");

describe("kid — отпечаток JWK по RFC 7638 (ПАО §2, П01)", () => {
  it("эталон RFC 8037 прил. A.3: порядок членов на входе не важен", () => {
    expect(jwkThumbprint({ kty: "OKP", crv: "Ed25519", x: RFC8037_X })).toBe(RFC8037_KID);
    expect(jwkThumbprint({ x: RFC8037_X, kty: "OKP", crv: "Ed25519" })).toBe(RFC8037_KID);
  });

  it("эталон через public_key ПАО: DER SPKI → JWK → kid", () => {
    expect(ed25519Jwk(RFC8037_SPKI)).toEqual({ crv: "Ed25519", kty: "OKP", x: RFC8037_X });
    expect(kidOf(RFC8037_SPKI)).toBe(RFC8037_KID);
  });

  it.each([
    ["base64url вместо base64", RFC8037_SPKI.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + "_"],
    ["без дополнения", RFC8037_SPKI.replace(/=+$/, "")],
    ["с пробелом", ` ${RFC8037_SPKI}`],
    ["пустая строка", ""],
    ["лишние биты перед «=» (у одного ключа две записи)", RFC8037_SPKI.slice(0, -2) + "p="], // «o» → «p»: те же байты DER
    ["ключ X25519", spkiOf("x25519")],
    ["32 байта без SPKI", Buffer.from(RFC8037_X, "base64url").toString("base64")],
    ["лишний байт после DER", Buffer.concat([Buffer.from(RFC8037_SPKI, "base64"), Buffer.from([0])]).toString("base64")],
  ])("неканоническая запись или не Ed25519 — SignerKeyRejected: %s", (_name, pk) => {
    expect(() => kidOf(pk)).toThrow(SignerKeyRejected);
  });
});

describe("форма kid — 43 символа base64url", () => {
  it("эталон и вычисленный kid проходят", () => {
    expect(() => assertKid(RFC8037_KID)).not.toThrow();
    expect(() => assertKid(kidOf(spkiOf("ed25519")))).not.toThrow();
  });

  it.each([
    ["«../»", `../${RFC8037_KID.slice(3)}`],
    ["«/»", `/${RFC8037_KID.slice(1)}`],
    ["пустой", ""],
    ["44 символа", `${RFC8037_KID}A`],
    ["42 символа", RFC8037_KID.slice(1)],
    ["base64 «+»", `+${RFC8037_KID.slice(1)}`],
    ["с дополнением «=»", `${RFC8037_KID.slice(1)}=`],
    ["перевод строки в конце", `${RFC8037_KID}\n`],
    ["не строка", 42],
  ])("%s — SignerKeyRejected", (_name, kid) => {
    expect(() => assertKid(kid)).toThrow(SignerKeyRejected);
  });
});
