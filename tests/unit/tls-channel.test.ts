// Канал mTLS к ПАО (Р64 п. 5, 8; К3.1а): свой fetch поверх node:https — TLS 1.3 с клиентским сертификатом, доверие
// только закреплённому корню, проверка имени, без возобновления сессии. Сертификаты — openssl во временном каталоге;
// без openssl тест красный, а не пропущенный. Классификация ошибок канала — в адаптере ПАО (К3.2), здесь — что канал
// отказывает, и коды Node, по которым адаптер различает отказы.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { createServer, type Server } from "node:https";
import type { TLSSocket } from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TlsCertExpired, TlsCertMissing, generateTlsKey, tlsChannel } from "../../src/agent/signer/index.js";
import { issueClient, makeCa, type Ca } from "../support/tls-pki.js";

const AGENT = "nspk:agent:buyref-01:v3";

let pki: string;
let keys: string;
let servers: (Server | NetServer)[];
let sockets: Set<Socket>;
let procs: ChildProcess[];
let ca: Ca;
beforeEach(() => {
  pki = mkdtempSync(join(tmpdir(), "buyref-pki-"));
  keys = mkdtempSync(join(tmpdir(), "buyref-keys-"));
  servers = [];
  sockets = new Set();
  procs = [];
  ca = makeCa(pki, "root");
});
afterEach(async () => {
  for (const p of procs) p.kill();
  for (const c of sockets) c.destroy();
  for (const s of servers) {
    if ("closeAllConnections" in s) s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  rmSync(pki, { recursive: true, force: true });
  rmSync(keys, { recursive: true, force: true });
});

interface Seen {
  reused: boolean[];
  clientCerts: string[];
  versions: string[];
}

/** Локальный сервер TLS: требует клиентский сертификат от `trust` (по умолчанию — корень ca). */
async function serve(o: { name?: string; san?: string; eku?: "serverAuth" | "clientAuth"; issuer?: Ca; trust?: Ca; maxVersion?: "TLSv1.2" | "TLSv1.3" } = {}): Promise<{ url: string; seen: Seen }> {
  const { key, cert } = (o.issuer ?? ca).server(o.name ?? "srv", o.san, o.eku);
  const seen: Seen = { reused: [], clientCerts: [], versions: [] };
  const s = createServer(
    { key, cert, ca: (o.trust ?? ca).pem, requestCert: true, rejectUnauthorized: true, ...(o.maxVersion && { maxVersion: o.maxVersion }) },
    (req, res) => {
      const sock = req.socket as TLSSocket;
      seen.clientCerts.push(sock.getPeerCertificate().subjectaltname ?? "");
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json", "x-echo-method": req.method ?? "" });
        res.end(JSON.stringify({ path: req.url, body }));
      });
    },
  );
  s.on("secureConnection", (sock: TLSSocket) => {
    seen.reused.push(sock.isSessionReused());
    seen.versions.push(sock.getProtocol() ?? "");
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `https://localhost:${(s.address() as AddressInfo).port}`, seen };
}

/** Код ошибки Node из причины отказа fetch (у канала — сама ошибка сокета или TLS); у алерта TLS — `EPROTO:<номер>`
 *  (номер алерта Node отдаёт только в тексте OpenSSL «SSL alert number N»). */
async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const code = String((e as NodeJS.ErrnoException).code ?? (e as Error).name);
    const alert = /SSL alert number (\d+)/.exec((e as Error).message)?.[1];
    return alert === undefined ? code : `${code}:${alert}`;
  }
  throw new Error("канал не отказал");
}

/** Сервер openssl s_server (TLS 1.3, проверка клиента в OpenSSL — с алертом); процесс закрывается после теста. */
async function opensslServer(args: string[]): Promise<string> {
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  const p = spawn("openssl", ["s_server", "-accept", `127.0.0.1:${port}`, "-tls1_3", "-www", "-quiet", ...args], { cwd: pki, stdio: "ignore" });
  procs.push(p);
  for (let i = 0; i < 100; i++) {
    const up = await new Promise<boolean>((r) => {
      const c = connect(port, "127.0.0.1", () => (c.destroy(), r(true)));
      c.on("error", () => r(false));
    });
    if (up) return `https://localhost:${port}`;
    if (p.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("openssl s_server не поднялся");
}

describe("канал mTLS (Р64 п. 5, 8)", () => {
  it("рукопожатие TLS 1.3 с клиентским сертификатом агента; тело и заголовки — в обе стороны", async () => {
    issueClient(pki, keys, ca, "root", AGENT);
    const { url, seen } = await serve();
    const ch = tlsChannel(keys, { root: ca.root });
    const res = await ch.fetch(`${url}/pao/v1/mandates?x=1`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-echo-method")).toBe("POST");
    expect(await res.json()).toEqual({ path: "/pao/v1/mandates?x=1", body: '{"a":1}' });
    expect(seen.versions).toEqual(["TLSv1.3"]);
    expect(seen.clientCerts).toEqual([`URI:urn:${AGENT}`]);
  });

  it("второе подключение — полное рукопожатие, без возобновления (isSessionReused — false)", async () => {
    issueClient(pki, keys, ca, "root", AGENT);
    const { url, seen } = await serve();
    const ch = tlsChannel(keys, { root: ca.root });
    for (let i = 0; i < 3; i++) expect((await ch.fetch(`${url}/x`)).status).toBe(200);
    expect(seen.reused).toEqual([false, false, false]);
  });

  it("сервер только TLS 1.2 — отказ канала (алерт protocol_version, 70)", async () => {
    issueClient(pki, keys, ca, "root", AGENT);
    const { url, seen } = await serve({ maxVersion: "TLSv1.2" });
    expect(await failure(tlsChannel(keys, { root: ca.root }).fetch(`${url}/x`))).toBe("EPROTO:70");
    expect(seen.versions).toEqual([]);
  });

  it("сертификат сервера от чужого УЦ — отказ канала (публичных и иных УЦ в доверии нет)", async () => {
    issueClient(pki, keys, ca, "root", AGENT);
    const other = makeCa(pki, "other");
    const { url } = await serve({ issuer: other });
    expect(await failure(tlsChannel(keys, { root: ca.root }).fetch(`${url}/x`))).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
  });

  it("имя сервера не совпало с сертификатом — отказ канала (проверка имени не отключена)", async () => {
    issueClient(pki, keys, ca, "root", AGENT);
    const { url } = await serve({ san: "DNS:pao.example" });
    expect(await failure(tlsChannel(keys, { root: ca.root }).fetch(`${url}/x`))).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
  });

  it("сертификат сервера того же УЦ, но с назначением clientAuth — отказ канала INVALID_PURPOSE (КТ1 № 3 сессии 49)", async () => {
    issueClient(pki, keys, ca, "root", AGENT);
    const { url, seen } = await serve({ eku: "clientAuth" });
    expect(await failure(tlsChannel(keys, { root: ca.root }).fetch(`${url}/x`))).toBe("INVALID_PURPOSE");
    expect(seen.clientCerts).toEqual([]);
  });

  it("сервер (OpenSSL) не доверяет сертификату клиента — алерт unknown_ca (48)", async () => {
    issueClient(pki, keys, ca, "root", AGENT);
    makeCa(pki, "other");
    ca.server("srv");
    const url = await opensslServer(["-cert", "srv.pem", "-key", "srv.key", "-CAfile", "other.pem", "-Verify", "1", "-verify_return_error"]);
    expect(await failure(tlsChannel(keys, { root: ca.root }).fetch(`${url}/x`))).toBe("ERR_SSL_TLSV1_ALERT_UNKNOWN_CA:48");
  });

  it("сервер Node не доверяет сертификату клиента — закрывает соединение без алерта: ECONNRESET", async () => {
    // Node проверяет сертификат клиента после рукопожатия и рвёт сокет; Платформа отвечает 401 AGENT_UNKNOWN (#88 п. 5)
    issueClient(pki, keys, ca, "root", AGENT);
    const { url } = await serve({ trust: makeCa(pki, "other") });
    expect(await failure(tlsChannel(keys, { root: ca.root }).fetch(`${url}/x`))).toBe("ECONNRESET");
  });

  it("сброс соединения во время рукопожатия — ошибка сокета, не ошибка проверки TLS", async () => {
    issueClient(pki, keys, ca, "root", AGENT);
    const s = createNetServer((sock) => sock.once("data", () => sock.resetAndDestroy()));
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    expect(await failure(tlsChannel(keys, { root: ca.root }).fetch(`https://localhost:${(s.address() as AddressInfo).port}/x`))).toBe("ECONNRESET");
  });

  it("тайм-аут — отказ по сигналу init (как у прежнего транспорта)", async () => {
    issueClient(pki, keys, ca, "root", AGENT);
    const s = createNetServer((c) => sockets.add(c)); // принимает и молчит; сокеты закрываются после теста
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const url = `https://localhost:${(s.address() as AddressInfo).port}/x`;
    expect(await failure(tlsChannel(keys, { root: ca.root }).fetch(url, { signal: AbortSignal.timeout(100) }))).toBe("ABORT_ERR");
  });

  it("не https — отказ до сети; Request вместо адреса — отказ", async () => {
    issueClient(pki, keys, ca, "root", AGENT);
    const ch = tlsChannel(keys, { root: ca.root });
    await expect(ch.fetch("http://localhost:1/x")).rejects.toThrow(TypeError);
    await expect(ch.fetch(new Request("https://localhost:1/x"))).rejects.toThrow(TypeError);
  });

  it("сертификат не установлен — TlsCertMissing (TLS_CERT_MISSING)", () => {
    generateTlsKey(keys);
    expect(() => tlsChannel(keys, { root: ca.root })).toThrow(TlsCertMissing);
  });

  it("срок сертификата истёк по часам агента — TlsCertExpired при создании и перед обращением, без сети", async () => {
    issueClient(pki, keys, ca, "root", AGENT);
    const { url, seen } = await serve();
    let at = new Date();
    const ch = tlsChannel(keys, { root: ca.root, now: () => at });
    at = new Date(ch.notAfter.getTime());
    await expect(ch.fetch(`${url}/x`)).rejects.toThrow(TlsCertExpired);
    expect(seen.versions).toEqual([]);
    expect(() => tlsChannel(keys, { root: ca.root, now: () => at })).toThrow(TlsCertExpired);
    expect(new TlsCertExpired().code).toBe("TLS_CERT_EXPIRED");
    expect(new TlsCertMissing().code).toBe("TLS_CERT_MISSING");
  });

  it("наружу — только fetch и срок: ключа и PEM в канале нет (инвариант 2)", () => {
    issueClient(pki, keys, ca, "root", AGENT);
    const ch = tlsChannel(keys, { root: ca.root });
    expect(Object.keys(ch).sort()).toEqual(["fetch", "notAfter"]);
    expect(Object.isFrozen(ch)).toBe(true);
    expect(inspect(ch, { depth: 5 }) + JSON.stringify(ch)).not.toMatch(/PRIVATE|BEGIN/);
  });
});
