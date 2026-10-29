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
import { SignerKeyRejected, generateKey, generateTlsKey, tlsCsr, tlsKeyDescriptor } from "../../src/agent/signer/index.js";
import { CSR_MAX_DER_BYTES, loadTlsKey } from "../../src/agent/signer/tls.js";
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
