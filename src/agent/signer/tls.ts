// Ключ канала mTLS к ПАО (Р64 п. 2–3): P-256, свой на каждого агента, отдельно от ключа подписи ed25519.
// Закрытый ключ — PKCS8 в `<каталог ключей>/tls/client.key.pem` (0600, каталог 0700) и не покидает модуль signer
// (инвариант 2): наружу — описатель (открытый ключ) и CSR для заявления на допуск. Сертификат и канал — К2.2, К3.1.
// CSR собирается своим DER без зависимостей: в node:crypto сборки CSR нет (как РП65 п. 2 Платформы).
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SignerKeyRejected } from "./errors.js";
import { privateDir, readOwnerFile } from "./keystore.js";

/** Описатель ключа TLS: только открытые сведения. */
export interface TlsKeyDescriptor {
  readonly alg: "P-256";
  /** DER SPKI в обычном base64 */
  readonly public_key: string;
}

const TLS_DIR = "tls";
const KEY_FILE = "client.key.pem";
/** Предел CSR в DER (передача #86 п. 2, РП65 п. 2 Платформы). */
export const CSR_MAX_DER_BYTES = 2048;

/** Каталог ключа TLS внутри каталога ключей; create — создать оба с правами 0700. */
function tlsDir(dir: string, create: boolean): string {
  return privateDir(join(privateDir(dir, create), TLS_DIR), create);
}

/** Закрытый ключ — только P-256 (prime256v1). */
function assertP256(key: KeyObject): void {
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new SignerKeyRejected("ключ TLS не P-256");
  }
}

function describe(privateKey: KeyObject): TlsKeyDescriptor {
  const public_key = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
  return Object.freeze({ alg: "P-256", public_key });
}

/**
 * Новый ключ TLS P-256; файл — O_EXCL (wx): ключ уже есть, файл или ссылка на его месте — отказ. Ключ один на агента:
 * новый ключ — только вместе с новым CSR и новым допуском у оператора (Р64 п. 2); прежний файл удаляет оператор.
 */
export function generateTlsKey(dir: string): TlsKeyDescriptor {
  const abs = tlsDir(dir, true);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  try {
    writeFileSync(join(abs, KEY_FILE), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  } catch (e) {
    throw new SignerKeyRejected("файл ключа TLS не создан", { cause: e });
  }
  return describe(privateKey);
}

/** Закрытый ключ TLS из каталога; не обычный файл, ссылка, чужой владелец, права не 0600, не PKCS8, не P-256 — отказ. */
export function loadTlsKey(dir: string): KeyObject {
  const pem = readOwnerFile(join(tlsDir(dir, false), KEY_FILE), "файл ключа TLS")!;
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
  } catch {
    throw new SignerKeyRejected("файл ключа TLS не разбирается как PKCS8");
  } finally {
    pem.fill(0);
  }
  assertP256(privateKey);
  return privateKey;
}

/** Описатель ключа TLS из каталога. */
export function tlsKeyDescriptor(dir: string): TlsKeyDescriptor {
  return describe(loadTlsKey(dir));
}

// DER: длина — кратчайшая форма (X.690 §10.1), тег — однобайтовый.
function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, n >> 8, n & 0xff]);
}
const tlv = (tag: number, ...content: Buffer[]): Buffer => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const SEQUENCE = 0x30;
const INTEGER_0 = Buffer.from([0x02, 0x01, 0x00]);
/** Name без RDN — пустой субъект: SAN ставит Платформа из кода агента (передача #86 п. 2). */
const EMPTY_NAME = Buffer.from([0x30, 0x00]);
/** attributes [0] IMPLICIT SET OF — пустой набор, но поле присутствует (PKCS#10, RFC 2986 §4.1). */
const EMPTY_ATTRIBUTES = Buffer.from([0xa0, 0x00]);
/** AlgorithmIdentifier ecdsa-with-SHA256 (1.2.840.10045.4.3.2) без параметров (RFC 5758 §3.2). */
const ECDSA_SHA256 = Buffer.from("300a06082a8648ce3d040302", "hex");

/**
 * CSR для заявления на допуск (Р64 п. 3): PKCS#10 DER в канонической base64 (RFC 4648 §3.5), ключ P-256, подпись
 * ecdsa-with-SHA256, пустой субъект, без атрибутов, не длиннее CSR_MAX_DER_BYTES. Подаёт оператор агента.
 */
export function tlsCsr(dir: string): string {
  const key = loadTlsKey(dir);
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const info = tlv(SEQUENCE, INTEGER_0, EMPTY_NAME, spki, EMPTY_ATTRIBUTES);
  const signature = sign("sha256", info, { key, dsaEncoding: "der" });
  const der = tlv(SEQUENCE, info, ECDSA_SHA256, tlv(0x03, Buffer.from([0x00]), signature));
  if (der.length > CSR_MAX_DER_BYTES) throw new SignerKeyRejected("CSR длиннее предела");
  return der.toString("base64");
}
