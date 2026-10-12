// kid — отпечаток JWK открытого ключа по RFC 7638 (ПАО §2, РП23 Платформы); агент вычисляет его сам.
// Эталон — RFC 8037 прил. A.3. public_key в ПАО — DER SPKI в обычном base64 (не base64url).
import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { SignerKeyRejected } from "./errors.js";
import { assertStrongEd25519 } from "./weak.js";

/** Обязательные члены JWK открытого ключа Ed25519 (RFC 7638 §3.2, RFC 8037 §2). */
export type Ed25519Jwk = {
  readonly crv: "Ed25519";
  readonly kty: "OKP";
  readonly x: string;
};

/** SHA-256 в base64url без дополнения — ровно 43 символа алфавита base64url. */
const KID = /^[A-Za-z0-9_-]{43}$/;

/** Строгая проверка формы kid; вызывается до любого обращения к файловой системе (kid входит в путь файла). */
export function assertKid(kid: unknown): asserts kid is string {
  if (typeof kid !== "string" || !KID.test(kid)) throw new SignerKeyRejected("kid не в форме RFC 7638 (43 символа base64url)");
}

/** Отпечаток JWK по RFC 7638: члены по возрастанию имён, JSON без пробелов, SHA-256, base64url без дополнения. */
export function jwkThumbprint(jwk: Readonly<Record<string, string>>): string {
  const canonical = `{${Object.keys(jwk)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(jwk[k])}`)
    .join(",")}}`;
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Разбор public_key ПАО: только каноническая base64 и DER SPKI Ed25519 без лишних байтов; иначе SignerKeyRejected. */
export function publicKeyObject(publicKeySpki: string): KeyObject {
  if (publicKeySpki === "" || !BASE64.test(publicKeySpki)) throw new SignerKeyRejected("public_key не в канонической base64");
  const der = Buffer.from(publicKeySpki, "base64");
  // Лишние биты перед «=» Buffer отбрасывает молча — один ключ получил бы несколько записей; требуем обратимость.
  if (der.toString("base64") !== publicKeySpki) throw new SignerKeyRejected("public_key не в канонической base64");
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new SignerKeyRejected("public_key не разбирается как DER SPKI");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new SignerKeyRejected("public_key не Ed25519");
  if (!key.export({ type: "spki", format: "der" }).equals(der)) throw new SignerKeyRejected("public_key не в канонической записи DER");
  return key;
}

/** JWK открытого ключа Ed25519 из public_key ПАО; слабый ключ — SignerKeyRejected. */
export function ed25519Jwk(publicKeySpki: string): Ed25519Jwk {
  const { crv, kty, x } = publicKeyObject(publicKeySpki).export({ format: "jwk" });
  if (crv !== "Ed25519" || kty !== "OKP" || typeof x !== "string") throw new SignerKeyRejected("JWK не Ed25519");
  assertStrongEd25519(Buffer.from(x, "base64url"));
  return { crv, kty, x };
}

/** kid открытого ключа Ed25519, заданного public_key ПАО. */
export const kidOf = (publicKeySpki: string): string => jwkThumbprint(ed25519Jwk(publicKeySpki));
