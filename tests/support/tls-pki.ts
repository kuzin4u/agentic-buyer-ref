// Учебный УЦ для тестов канала mTLS (Р64 п. 8): корень, сертификат сервера и клиентский сертификат по CSR агента —
// openssl во временном каталоге. Нет openssl — исключение ENOENT, тест красный, а не пропущенный (как Р-726 Платформы).
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { generateTlsKey, installTlsCertificate, pinRoot, tlsCsr, type TlsRoot } from "../../src/agent/signer/index.js";

export interface Ca {
  readonly pem: string;
  readonly fingerprint: string;
  readonly root: TlsRoot;
  /** сертификат сервера от этого корня: SAN — `san` (по умолчанию DNS:localhost и IP:127.0.0.1) */
  server(name: string, san?: string): { key: string; cert: string };
}

const run = (dir: string, args: string[]): void => {
  execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
};

/** Корень УЦ P-256 (`<name>.pem`, `<name>.key`) в каталоге dir. */
export function makeCa(dir: string, name: string): Ca {
  run(dir, ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.pem`, "-subj", `/CN=${name}`, "-days", "2"]);
  const pem = readFileSync(join(dir, `${name}.pem`), "utf8");
  const fingerprint = new X509Certificate(pem).fingerprint256;
  return {
    pem,
    fingerprint,
    root: pinRoot(pem, fingerprint),
    server(srv, san = "DNS:localhost,IP:127.0.0.1") {
      writeFileSync(join(dir, `${srv}.cnf`), `[v]\nsubjectAltName=${san}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n`);
      run(dir, ["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", `${srv}.key`, "-out", `${srv}.csr`, "-subj", `/CN=${srv}`]);
      run(dir, ["x509", "-req", "-in", `${srv}.csr`, "-CA", `${name}.pem`, "-CAkey", `${name}.key`, "-days", "1", "-extfile", `${srv}.cnf`, "-extensions", "v", "-out", `${srv}.pem`]);
      return { key: readFileSync(join(dir, `${srv}.key`), "utf8"), cert: readFileSync(join(dir, `${srv}.pem`), "utf8") };
    },
  };
}

/** Ключ TLS агента в keysDir, CSR — в УЦ ca (SAN `URI:urn:<agentCode>`, clientAuth), сертификат установлен. */
export function issueClient(pki: string, keysDir: string, ca: Ca, caName: string, agentCode: string, days = 1): void {
  generateTlsKey(keysDir);
  writeFileSync(join(pki, "client.csr.der"), Buffer.from(tlsCsr(keysDir), "base64"));
  writeFileSync(join(pki, "client.cnf"), `[v]\nsubjectAltName=URI:urn:${agentCode}\nextendedKeyUsage=clientAuth\nbasicConstraints=CA:FALSE\n`);
  run(pki, ["x509", "-req", "-in", "client.csr.der", "-inform", "DER", "-CA", `${caName}.pem`, "-CAkey", `${caName}.key`, "-days", String(days), "-extfile", "client.cnf", "-extensions", "v", "-outform", "DER", "-out", "client.der"]);
  installTlsCertificate(keysDir, readFileSync(join(pki, "client.der")).toString("base64"), { agentCode, root: ca.root, journal: new MemoryJournal() });
}
