// Ключ канала mTLS к ПАО (Р64 п. 2–3): P-256, свой на каждого агента, отдельно от ключа подписи ed25519.
// Закрытый ключ — PKCS8 в `<каталог ключей>/tls/client.key.pem` (0600, каталог 0700) и не покидает модуль signer
// (инвариант 2): наружу — описатель (открытый ключ) и CSR для заявления на допуск. Сертификат канала — DER в
// `tls/client.cert.der` (0600) после сверок п. 4; корень УЦ — только из настройки со сверкой отпечатка (п. 6). Канал — К3.1.
// CSR собирается своим DER без зависимостей: в node:crypto сборки CSR нет (как РП65 п. 2 Платформы).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, X509Certificate, type KeyObject } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Journal } from "../journal/index.js";
import { SignerKeyRejected, TlsCertificateRejected, TlsConfigInvalid, TlsTrustMismatch } from "./errors.js";
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

/** Закреплённый корень УЦ песочницы: только открытые сведения, отпечаток сверен с настройкой (Р64 п. 6). */
export interface TlsRoot {
  /** корень в PEM — единственный УЦ доверия канала (без публичных УЦ) */
  readonly pem: string;
  /** SHA-256 от DER корня, 64 знака hex в нижнем регистре */
  readonly fingerprint: string;
}

/**
 * Отпечаток из настройки: только полный SHA-256 — 64 знака hex; регистр и разделители «:» не учитываются (вывод
 * `npm run ca:init` и `fingerprint256` Node — «AB:CD:…»). Иной формат — TlsConfigInvalid; частичного сравнения нет.
 */
export function parseFingerprint(value: unknown): string {
  if (typeof value !== "string") throw new TlsConfigInvalid("отпечаток корня УЦ: не строка");
  const hex = value.replaceAll(":", "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new TlsConfigInvalid("отпечаток корня УЦ: не полный SHA-256 (64 знака hex)");
  return hex;
}

/** Ровно один самоподписанный сертификат УЦ (`CA:TRUE`), действующий в момент `at` (КТ1 № 6 сессии 49); иное —
 *  TlsConfigInvalid. */
function rootCertificate(pem: unknown, at: Date): X509Certificate {
  if (typeof pem !== "string" || (pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1) {
    throw new TlsConfigInvalid("корень УЦ: не один сертификат PEM");
  }
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    throw new TlsConfigInvalid("корень УЦ: сертификат не разбирается");
  }
  if (!cert.checkIssued(cert) || !cert.verify(cert.publicKey)) throw new TlsConfigInvalid("корень УЦ: не самоподписанный");
  if (!cert.ca) throw new TlsConfigInvalid("корень УЦ: не сертификат УЦ (нет CA:TRUE)");
  const t = at.getTime();
  if (t < new Date(cert.validFrom).getTime() || t >= new Date(cert.validTo).getTime()) {
    throw new TlsConfigInvalid("корень УЦ: вне срока действия");
  }
  return cert;
}

/**
 * Закрепление корня при загрузке настройки (Р64 п. 6): сначала форма отпечатка и корня — в т. ч. `CA:TRUE` и срок по
 * часам `now` (TlsConfigInvalid), затем сверка SHA-256 от DER корня с отпечатком — не совпал: TlsTrustMismatch
 * (TLS_TRUST_MISMATCH, остановка до обращений).
 */
export function pinRoot(caPem: unknown, caFingerprint: unknown, now: () => Date = () => new Date()): TlsRoot {
  const expected = parseFingerprint(caFingerprint);
  const cert = rootCertificate(caPem, now());
  const actual = createHash("sha256").update(cert.raw).digest("hex");
  if (actual !== expected) throw new TlsTrustMismatch();
  return Object.freeze({ pem: cert.toString(), fingerprint: actual });
}

const CERT_FILE = "client.cert.der";
const CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";

export interface InstallTlsOptions {
  /** код агента из реестра; SAN сертификата — ровно `URI:urn:<код>` (РП27 п. 2 Платформы, `urn:nspk:agent:<id>:v<N>`) */
  readonly agentCode: string;
  readonly root: TlsRoot;
  readonly journal: Journal;
  readonly now?: () => Date;
}

/** Установленный сертификат: только открытые сведения для журнала и оператора. */
export interface InstalledTlsCertificate {
  /** серийный номер hex в нижнем регистре — как в решении о допуске */
  readonly serial: string;
  readonly not_after: string;
}

/** Сертификат канала по сверкам Р64 п. 4; первое несовпадение — TlsCertificateRejected с причиной. */
function checkCertificate(der: unknown, key: KeyObject, o: InstallTlsOptions): X509Certificate {
  if (typeof der !== "string" || der.length === 0 || Buffer.from(der, "base64").toString("base64") !== der) {
    throw new TlsCertificateRejected("MALFORMED");
  }
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(Buffer.from(der, "base64"));
  } catch {
    throw new TlsCertificateRejected("MALFORMED");
  }
  const spki = (k: KeyObject) => createPublicKey(k).export({ type: "spki", format: "der" });
  if (!cert.publicKey.export({ type: "spki", format: "der" }).equals(spki(key))) throw new TlsCertificateRejected("KEY_MISMATCH");
  if (cert.subjectAltName !== `URI:urn:${o.agentCode}`) throw new TlsCertificateRejected("SAN_MISMATCH");
  if (!(cert.keyUsage ?? []).includes(CLIENT_AUTH)) throw new TlsCertificateRejected("NOT_CLIENT_AUTH");
  const root = new X509Certificate(o.root.pem);
  if (!cert.checkIssued(root) || !cert.verify(root.publicKey)) throw new TlsCertificateRejected("NOT_ISSUED_BY_ROOT");
  // not_before с моментом допуска на равенство не сверяется (передача #86 п. 5): запас Платформы — назад
  if ((o.now ?? (() => new Date()))().getTime() >= new Date(cert.validTo).getTime()) throw new TlsCertificateRejected("EXPIRED");
  return cert;
}

/**
 * Установка сертификата из решения о допуске (`certificate.der`, base64; Р64 п. 4). Сверки — ключ наш, SAN — код
 * агента, EKU clientAuth, выдан закреплённым корнем, срок не истёк; иначе — TlsCertificateRejected, прежний сертификат
 * остаётся, агент не останавливается. Запись — временный файл (wx, 0600) и переименование поверх прежнего; затем
 * журнал `tls.certificate_installed` с серийным номером (без DER и ключа). Сбой журнала установку не отменяет.
 */
export function installTlsCertificate(dir: string, der: unknown, o: InstallTlsOptions): InstalledTlsCertificate {
  const abs = tlsDir(dir, false);
  const cert = checkCertificate(der, loadTlsKey(dir), o);
  const tmp = join(abs, `${CERT_FILE}.${process.pid}.tmp`);
  try {
    try {
      unlinkSync(tmp); // остаток прерванной записи
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    writeFileSync(tmp, cert.raw, { mode: 0o600, flag: "wx" });
    renameSync(tmp, join(abs, CERT_FILE));
  } catch (e) {
    throw new SignerKeyRejected("сертификат канала не записан", { cause: e });
  }
  const installed: InstalledTlsCertificate = Object.freeze({ serial: cert.serialNumber.toLowerCase(), not_after: new Date(cert.validTo).toISOString() });
  o.journal.record({ at: (o.now ?? (() => new Date()))().toISOString(), kind: "tls.certificate_installed", ref: installed.serial });
  return installed;
}

/** Установленный сертификат канала; нет — null (TLS_CERT_MISSING решает вызывающий, К3.1). */
export function loadTlsCertificate(dir: string): X509Certificate | null {
  const raw = readOwnerFile(join(tlsDir(dir, false), CERT_FILE), "файл сертификата канала", true);
  if (raw === null) return null;
  try {
    return new X509Certificate(raw);
  } catch {
    throw new SignerKeyRejected("файл сертификата канала не разбирается");
  }
}
