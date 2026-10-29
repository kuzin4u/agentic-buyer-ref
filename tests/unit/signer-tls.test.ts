// Ключ канала mTLS и CSR при допуске (Р64 п. 2–3, К2.1; передачи #86, #88). Ключ TLS — P-256, только в signer
// (инвариант 2): файл 0600 в каталоге 0700, наружу — описатель и CSR. CSR сверяется внешним инструментом (openssl) и
// строгим разбором Платформы — допуском на стенде v0.32.1 с полем csr. Без openssl тест красный, а не пропущенный
// (Р64 п. 8, как Р-726 Платформы).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { createStand, type Stand } from "agentic-ps-platform/stand";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import {
  SignerKeyRejected,
  TlsCertificateRejected,
  TlsConfigInvalid,
  TlsTrustMismatch,
  generateKey,
  generateTlsKey,
  installTlsCertificate,
  parseFingerprint,
  pinRoot,
  tlsCsr,
  tlsKeyDescriptor,
  type TlsRoot,
} from "../../src/agent/signer/index.js";
import { CSR_MAX_DER_BYTES, loadTlsCertificate, loadTlsKey } from "../../src/agent/signer/tls.js";
import { AGENT } from "../support/pao-stand.js";

let dir: string;
let stand: Stand | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buyref-tls-"));
});
afterEach(async () => {
  await stand?.close();
  stand = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const mode = (p: string): number => statSync(p).mode & 0o777;
const keyFile = (): string => join(dir, "tls", "client.key.pem");
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

/** openssl над файлом CSR в DER; нет openssl — исключение ENOENT, тест красный. */
function openssl(args: string[], csr: string): string {
  const path = join(dir, "csr.der");
  writeFileSync(path, Buffer.from(csr, "base64"));
  return execFileSync("openssl", ["req", "-inform", "DER", "-in", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("ключ TLS: создание и хранение (Р64 п. 2, инвариант 2)", () => {
  it("создание: tls/client.key.pem PKCS8 P-256 с правами 0600, каталоги 0700; описатель — только открытый ключ", () => {
    const d = generateTlsKey(dir);
    expect(mode(keyFile())).toBe(0o600);
    expect(mode(join(dir, "tls"))).toBe(0o700);
    expect(mode(dir)).toBe(0o700);
    const key = createPrivateKey({ key: readFileSync(keyFile()), format: "pem", type: "pkcs8" });
    expect(key.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(d).toEqual({ alg: "P-256", public_key: createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64") });
    expect(Object.isFrozen(d)).toBe(true);
    expect(inspect(d) + JSON.stringify(d)).not.toMatch(/PRIVATE|BEGIN/);
    expect(tlsKeyDescriptor(dir)).toEqual(d);
  });

  it("ключ один на агента: второй generateTlsKey — отказ, прежний файл не тронут", () => {
    generateTlsKey(dir);
    const before = sha(keyFile());
    expect(() => generateTlsKey(dir)).toThrow(SignerKeyRejected);
    expect(sha(keyFile())).toBe(before);
  });

  it("ключ TLS отдельно от ключей подписи: generateKey в том же каталоге не видит tls/, ключ TLS — не ed25519", () => {
    const sig = generateKey(dir);
    const d = generateTlsKey(dir);
    expect(d.public_key).not.toBe(sig.descriptor.public_key);
    expect(loadTlsKey(dir).asymmetricKeyType).toBe("ec");
  });

  it("загрузка: права не 0600, ссылка, нет файла, не PKCS8, не P-256 — отказ без пути в сообщении", () => {
    generateTlsKey(dir);
    const pem = readFileSync(keyFile());
    const check = (setup: () => void, message: RegExp) => {
      rmSync(keyFile(), { force: true });
      setup();
      let err: unknown;
      try {
        loadTlsKey(dir);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SignerKeyRejected);
      expect((err as Error).message).toMatch(message);
      expect((err as Error).message).not.toContain(dir);
    };
    check(() => writeFileSync(keyFile(), pem, { mode: 0o644 }), /права не 600|не читается/);
    check(() => {
      writeFileSync(join(dir, "other.pem"), pem, { mode: 0o600 });
      symlinkSync(join(dir, "other.pem"), keyFile());
    }, /не читается/);
    check(() => undefined, /не читается/);
    check(() => writeFileSync(keyFile(), "мусор", { mode: 0o600 }), /PKCS8/);
    const ed = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
    check(() => writeFileSync(keyFile(), ed, { mode: 0o600 }), /не P-256/);
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ type: "pkcs8", format: "pem" });
    check(() => writeFileSync(keyFile(), p384, { mode: 0o600 }), /не P-256/);
    chmodSync(join(dir, "tls"), 0o755);
    check(() => writeFileSync(keyFile(), pem, { mode: 0o600 }), /каталог ключей: права не 700/);
  });
});

describe("CSR при допуске (Р64 п. 3; передача #86 п. 2)", () => {
  it("PKCS#10 DER в канонической base64, не длиннее 2 048 байт; подпись верна по openssl; ключ — наш P-256", () => {
    const d = generateTlsKey(dir);
    const csr = tlsCsr(dir);
    expect(Buffer.from(csr, "base64").toString("base64")).toBe(csr);
    expect(csr).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(csr, "base64").length).toBeLessThanOrEqual(CSR_MAX_DER_BYTES);
    // неверная подпись — ненулевой код выхода openssl, execFileSync бросает
    expect(openssl(["-verify", "-noout"], csr)).toMatch(/verify OK/);
    const text = openssl(["-noout", "-text"], csr);
    expect(text).toMatch(/Signature Algorithm: ecdsa-with-SHA256/);
    expect(text).toMatch(/NIST CURVE: P-256|ASN1 OID: prime256v1/);
    expect(text).toMatch(/Subject:\s*\n/);
    const pub = createPublicKey(openssl(["-noout", "-pubkey"], csr)).export({ type: "spki", format: "der" }).toString("base64");
    expect(pub).toBe(d.public_key);
  });

  it("без ключа TLS — отказ; CSR не содержит закрытого ключа", () => {
    expect(() => tlsCsr(dir)).toThrow(SignerKeyRejected);
    generateTlsKey(dir);
    const der = Buffer.from(tlsCsr(dir), "base64");
    const priv = createPrivateKey(readFileSync(keyFile())).export({ format: "jwk" }).d!;
    expect(der.includes(Buffer.from(priv, "base64url"))).toBe(false);
  });

  it("стенд v0.32.1: допуск с csr — в решении сертификат на наш ключ, SAN — код агента, выдан УЦ стенда", async () => {
    stand = createStand();
    const sig = generateKey(dir);
    const d = generateTlsKey(dir);
    const decision = await stand.admit(
      { agent_code: AGENT, class: "BUYER", model: "buyer-agent-ref", runtime: "node-20", alg: "ed25519", public_key: sig.descriptor.public_key, csr: tlsCsr(dir) },
      "buyref-operator",
    );
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(decision.certificate).toBeDefined();
    const cert = new X509Certificate(Buffer.from(decision.certificate!.der, "base64"));
    expect(cert.publicKey.export({ type: "spki", format: "der" }).toString("base64")).toBe(d.public_key);
    expect(cert.subjectAltName).toMatch(/^URI:urn:nspk:agent:/);
    expect(decision.certificate!.agent_code).toBe(decision.record.agent_code);
    const ca = new X509Certificate(Buffer.from(stand.caCertificate, "base64"));
    expect(cert.verify(ca.publicKey)).toBe(true);
  });
});

/** Корень УЦ стенда в PEM и его отпечаток (SHA-256 от DER) в нижнем регистре без «:». */
function standRoot(s: Stand): { pem: string; fp: string } {
  const der = Buffer.from(s.caCertificate, "base64");
  return { pem: new X509Certificate(der).toString(), fp: createHash("sha256").update(der).digest("hex") };
}

/** Допуск на стенде с CSR ключа TLS каталога d; сертификат из решения (base64 DER) и закреплённый корень стенда. */
async function admitted(s: Stand, d: string, agentCode = AGENT): Promise<{ der: string; serial: string; root: TlsRoot }> {
  const sig = generateKey(d);
  if (!statExists(join(d, "tls", "client.key.pem"))) generateTlsKey(d);
  const decision = await s.admit(
    { agent_code: agentCode, class: "BUYER", model: "buyer-agent-ref", runtime: "node-20", alg: "ed25519", public_key: sig.descriptor.public_key, csr: tlsCsr(d) },
    "buyref-operator",
  );
  if (!decision.admitted || decision.certificate === undefined) throw new Error(`стенд не выдал сертификат: ${JSON.stringify(decision)}`);
  const { pem, fp } = standRoot(s);
  return { der: decision.certificate.der, serial: decision.certificate.serial, root: pinRoot(pem, fp) };
}

function statExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

describe("корень УЦ: отпечаток SHA-256 (Р64 п. 6, уточнение владельца 3)", () => {
  it("полный SHA-256 — без учёта регистра и «:»; закреплённый корень — PEM и отпечаток в нижнем регистре", () => {
    stand = createStand();
    const { pem, fp } = standRoot(stand);
    const colons = new X509Certificate(pem).fingerprint256; // вид Node и журнала запуска Платформы: «AB:CD:…»
    expect(colons).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    for (const form of [fp, fp.toUpperCase(), colons, colons.toLowerCase()]) {
      expect(pinRoot(pem, form)).toEqual({ pem: new X509Certificate(pem).toString(), fingerprint: fp });
    }
    expect(Object.isFrozen(pinRoot(pem, fp))).toBe(true);
  });

  it("короткий, длинный, частичный, не hex, не строка — TlsConfigInvalid до сравнения (и для префикса верного)", () => {
    stand = createStand();
    const { pem, fp } = standRoot(stand);
    const bad: unknown[] = [fp.slice(0, 63), fp.slice(0, 32), fp.slice(0, 2), `${fp}0`, `${fp.slice(0, 63)}g`, "", ` ${fp}`, `${fp}::`.replace("::", ":z"), 42, undefined];
    for (const v of bad) {
      expect(() => parseFingerprint(v), String(v)).toThrow(TlsConfigInvalid);
      expect(() => pinRoot(pem, v), String(v)).toThrow(TlsConfigInvalid);
    }
  });

  it("полный, но чужой — TlsTrustMismatch с кодом TLS_TRUST_MISMATCH; отпечатков в сообщении нет", () => {
    stand = createStand();
    const { pem, fp } = standRoot(stand);
    const other = createHash("sha256").update("другой корень").digest("hex");
    let err: unknown;
    try {
      pinRoot(pem, other);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TlsTrustMismatch);
    expect((err as TlsTrustMismatch).code).toBe("TLS_TRUST_MISMATCH");
    expect((err as Error).message).not.toContain(other);
    expect((err as Error).message).not.toContain(fp);
  });

  it("корень не по форме: не PEM, два сертификата, не самоподписанный — TlsConfigInvalid", async () => {
    stand = createStand();
    const { pem, fp } = standRoot(stand);
    expect(() => pinRoot("мусор", fp)).toThrow(TlsConfigInvalid);
    expect(() => pinRoot(pem + pem, fp)).toThrow(TlsConfigInvalid);
    const { der } = await admitted(stand, dir);
    const leaf = new X509Certificate(Buffer.from(der, "base64"));
    expect(() => pinRoot(leaf.toString(), createHash("sha256").update(leaf.raw).digest("hex"))).toThrow(TlsConfigInvalid);
  });

  it("самоподписанный, но не УЦ (CA:FALSE) — TlsConfigInvalid при верном отпечатке (КТ1 № 6 сессии 49)", () => {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "leaf.key", "-out", "leaf.pem", "-subj", "/CN=leaf", "-days", "2", "-addext", "basicConstraints=critical,CA:FALSE"], { cwd: dir, stdio: "pipe" });
    const pem = readFileSync(join(dir, "leaf.pem"), "utf8");
    const cert = new X509Certificate(pem);
    expect([cert.ca, cert.checkIssued(cert)]).toEqual([false, true]);
    expect(() => pinRoot(pem, createHash("sha256").update(cert.raw).digest("hex"))).toThrow(/нет CA:TRUE/);
  });

  it("корень вне срока по часам ядра — истёк или ещё не действует: TlsConfigInvalid; на границах — validFrom да, validTo нет (КТ1 № 6)", () => {
    stand = createStand();
    const { pem, fp } = standRoot(stand);
    const cert = new X509Certificate(pem);
    const from = new Date(cert.validFrom).getTime();
    const to = new Date(cert.validTo).getTime();
    expect(pinRoot(pem, fp, () => new Date(from)).fingerprint).toBe(fp);
    for (const at of [to, to + 1, from - 1000]) {
      expect(() => pinRoot(pem, fp, () => new Date(at)), new Date(at).toISOString()).toThrow(/вне срока действия/);
    }
  });
});

describe("установка сертификата из решения о допуске (Р64 п. 4)", () => {
  const certFile = (): string => join(dir, "tls", "client.cert.der");

  it("стенд: сертификат на наш ключ — файл 0600 (DER), серийный номер из решения, журнал без DER и ключа", async () => {
    stand = createStand();
    const { der, serial, root } = await admitted(stand, dir);
    const journal = new MemoryJournal();
    const installed = installTlsCertificate(dir, der, { agentCode: AGENT, root, journal });
    expect(installed.serial).toBe(serial);
    expect(installed.not_after).toBe(new Date(new X509Certificate(Buffer.from(der, "base64")).validTo).toISOString());
    expect(mode(certFile())).toBe(0o600);
    expect(readFileSync(certFile()).toString("base64")).toBe(der);
    expect(loadTlsCertificate(dir)?.serialNumber.toLowerCase()).toBe(serial);
    expect(journal.entries).toEqual([expect.objectContaining({ kind: "tls.certificate_installed", ref: serial })]);
    expect(JSON.stringify(journal.entries)).not.toContain(der.slice(0, 40));
    expect(JSON.stringify(journal.entries)).not.toMatch(/BEGIN|PRIVATE/);
  });

  it("нет установленного — loadTlsCertificate: null", () => {
    generateTlsKey(dir);
    expect(loadTlsCertificate(dir)).toBeNull();
  });

  it("отказы — с причиной, прежний сертификат остаётся, журнал — без записи: ключ, SAN, корень, срок, форма", async () => {
    stand = createStand();
    const good = await admitted(stand, dir);
    const journal = new MemoryJournal();
    installTlsCertificate(dir, good.der, { agentCode: AGENT, root: good.root, journal });
    const before = sha(certFile());
    const expectRejected = (der: unknown, reason: string, o: Partial<Parameters<typeof installTlsCertificate>[2]> = {}) => {
      let err: unknown;
      try {
        installTlsCertificate(dir, der, { agentCode: AGENT, root: good.root, journal, ...o });
      } catch (e) {
        err = e;
      }
      expect(err, reason).toBeInstanceOf(TlsCertificateRejected);
      expect((err as TlsCertificateRejected).reason).toBe(reason);
      expect(sha(certFile())).toBe(before);
    };
    // чужой ключ: сертификат выдан на ключ TLS другого каталога
    const other = mkdtempSync(join(tmpdir(), "buyref-tls-other-"));
    try {
      const foreign = await admitted(stand, other, "nspk:agent:buyref-02:v1");
      expectRejected(foreign.der, "KEY_MISMATCH", { agentCode: "nspk:agent:buyref-02:v1" });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    expectRejected(good.der, "SAN_MISMATCH", { agentCode: "nspk:agent:buyref-01:v4" });
    const otherStand = createStand();
    try {
      const { pem, fp } = standRoot(otherStand);
      expectRejected(good.der, "NOT_ISSUED_BY_ROOT", { root: pinRoot(pem, fp) });
    } finally {
      await otherStand.close();
    }
    const notAfter = new Date(new X509Certificate(Buffer.from(good.der, "base64")).validTo);
    expectRejected(good.der, "EXPIRED", { now: () => notAfter });
    for (const bad of ["", "не base64!", `${good.der}=`, Buffer.from("мусор").toString("base64"), 42]) expectRejected(bad, "MALFORMED");
    expect(journal.entries.filter((e) => e.kind === "tls.certificate_installed")).toHaveLength(1);
  });

  it("EKU без clientAuth — NOT_CLIENT_AUTH; тот же УЦ и SAN с clientAuth — принят (openssl; без openssl — красный)", () => {
    generateTlsKey(dir);
    const csr = join(dir, "csr.der");
    writeFileSync(csr, Buffer.from(tlsCsr(dir), "base64"));
    const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    run(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=test root", "-days", "2"]);
    const issue = (eku: string, out: string) => {
      writeFileSync(join(dir, `${out}.cnf`), `[v]\nsubjectAltName=URI:urn:${AGENT}\nextendedKeyUsage=${eku}\nbasicConstraints=CA:FALSE\n`);
      run(["x509", "-req", "-in", "csr.der", "-inform", "DER", "-CA", "ca.pem", "-CAkey", "ca.key", "-days", "1", "-extfile", `${out}.cnf`, "-extensions", "v", "-outform", "DER", "-out", `${out}.der`]);
      return readFileSync(join(dir, `${out}.der`)).toString("base64");
    };
    const caPem = readFileSync(join(dir, "ca.pem"), "utf8");
    const root = pinRoot(caPem, new X509Certificate(caPem).fingerprint256);
    const journal = new MemoryJournal();
    let err: unknown;
    try {
      installTlsCertificate(dir, issue("serverAuth", "server"), { agentCode: AGENT, root, journal });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TlsCertificateRejected);
    expect((err as TlsCertificateRejected).reason).toBe("NOT_CLIENT_AUTH");
    expect(loadTlsCertificate(dir)).toBeNull();
    expect(installTlsCertificate(dir, issue("clientAuth", "client"), { agentCode: AGENT, root, journal }).serial).toMatch(/^[0-9a-f]+$/);
  });
});
