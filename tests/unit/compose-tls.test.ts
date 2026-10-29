// Канал mTLS в месте сборки (Р64 п. 5–7; К3.1б): `pao.tls = { caPem, caFingerprint }`, ключ и сертификат — из keysDir.
// PaoStub стоит за локальным прокси TLS 1.3 с проверкой клиентского сертификата (стенд — без mTLS, РП27 п. 5): допуск
// идёт через канал; отказы канала на start() — до ключей и до сети, проверка platform.tls (дополнение Р36 п. 6).
// Сертификаты — openssl во временном каталоге; без openssl — красный.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentCore } from "../../src/agent/compose.js";
import { AgentNotReady } from "../../src/agent/declines/index.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { TlsCertExpired, TlsCertMissing, TlsConfigInvalid, TlsTrustMismatch, generateTlsKey } from "../../src/agent/signer/index.js";
import { startCause } from "../support/core.js";
import { AGENT, PaoStand } from "../support/pao-stand.js";
import { issueClient, makeCa, type Ca } from "../support/tls-pki.js";

let pki: string;
let stand: PaoStand;
let proxy: Server | undefined;
let ca: Ca;
/** обращения, дошедшие до прокси: путь и SAN клиентского сертификата */
let seen: { path: string; san: string }[];
beforeEach(() => {
  pki = mkdtempSync(join(tmpdir(), "buyref-pki-"));
  // сначала корень, потом часы «сейчас»: начало срока корня openssl округлено до секунды, часы стенда взятые раньше
  // выпуска могут оказаться в предыдущей секунде — корень «ещё не действует», TlsConfigInvalid (К4.4, CI Node 20.19)
  ca = makeCa(pki, "root");
  stand = new PaoStand({ clock: new Date() });
  seen = [];
});
afterEach(async () => {
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise((r) => proxy!.close(r));
    proxy = undefined;
  }
  await stand.stub.close();
  rmSync(pki, { recursive: true, force: true });
  rmSync(stand.dir, { recursive: true, force: true });
});

/** Прокси TLS 1.3 перед PaoStub: требует клиентский сертификат от корня ca; тело и заголовки — как есть. `eku` —
 *  назначение сертификата прокси (clientAuth — сертификат не для сервера, INVALID_PURPOSE). */
async function tlsProxy(eku: "serverAuth" | "clientAuth" = "serverAuth"): Promise<string> {
  const target = await stand.stub.start();
  const { key, cert } = ca.server("srv", undefined, eku);
  proxy = createServer({ key, cert, ca: ca.pem, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" }, (req, res) => {
    seen.push({ path: req.url ?? "", san: (req.socket as TLSSocket).getPeerCertificate().subjectaltname ?? "" });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "connection", "content-length"].includes(k)) headers.set(k, v);
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      void fetch(`${target}${req.url}`, { method: req.method ?? "GET", headers, ...(body && { body }) }).then(async (r) => {
        const out: Record<string, string> = {};
        r.headers.forEach((v, k) => k !== "content-encoding" && k !== "transfer-encoding" && (out[k] = v));
        res.writeHead(r.status, out);
        res.end(Buffer.from(await r.arrayBuffer()));
      });
    });
  });
  await new Promise<void>((r) => proxy!.listen(0, "127.0.0.1", r));
  return `https://localhost:${(proxy.address() as AddressInfo).port}`;
}

function core(baseUrl: string, tls: { caPem: string; caFingerprint: string }, journal = new MemoryJournal(), now = () => stand.clock) {
  return createAgentCore({
    keysDir: stand.dir,
    stateDir: `${stand.dir}-state`,
    journal,
    now,
    pao: { baseUrl, agentCode: AGENT, sleep: async () => {}, tls },
  });
}

/** Проверка platform.tls в отчёте отказа start() и исходная ошибка. */
async function tlsFailure(p: Promise<unknown>): Promise<{ cause: unknown; report: AgentNotReady["report"] }> {
  let report: AgentNotReady["report"] | undefined;
  const cause = await startCause(
    p.catch((e: unknown) => {
      if (e instanceof AgentNotReady) report = e.report;
      throw e;
    }),
  ).catch((e: unknown) => e);
  return { cause, report: report! };
}

describe("канал mTLS в compose (Р64 п. 5–7)", () => {
  it("допуск через канал: все обращения — с клиентским сертификатом агента; platform.tls — ok; ключа и PEM нет в журнале", async () => {
    issueClient(pki, stand.dir, ca, "root", AGENT);
    const url = await tlsProxy();
    const journal = new MemoryJournal();
    const c = core(url, { caPem: ca.pem, caFingerprint: ca.fingerprint }, journal);
    await c.start();
    expect(c.selfCheck()?.checks.map((x) => [x.check, x.status])).toContainEqual(["platform.tls", "ok"]);
    expect(seen.map((s) => s.path)).toEqual(["/.well-known/pao-configuration", "/pao/v1/agent"]);
    expect(new Set(seen.map((s) => s.san))).toEqual(new Set([`URI:urn:${AGENT}`]));
    const dump = JSON.stringify(journal.entries);
    expect(dump).not.toMatch(/BEGIN|PRIVATE|CERTIFICATE/);
    // сверка с реестром — свой адаптер ПАО, тоже через канал
    await c.recheck();
    expect(seen.at(-1)).toEqual({ path: "/pao/v1/agent", san: `URI:urn:${AGENT}` });
    expect(seen).toHaveLength(3);
  });

  it("знак готовности витрин (ПАО) — тоже через канал; витрины — своим транспортом", async () => {
    issueClient(pki, stand.dir, ca, "root", AGENT);
    const url = await tlsProxy();
    const c = core(url, { caPem: ca.pem, caFingerprint: ca.fingerprint });
    await c.start();
    const shopCalls: string[] = [];
    const shops = c.shops({ baseUrl: "http://shops.test", fetch: async (u) => (shopCalls.push(String(u)), new Response(null, { status: 404 })) });
    // у PaoStub пути знака нет — ответ сервера за каналом: «не проверено», не отказ канала (КТ1 № 7 сессии 49)
    expect(await shops.readiness("merchant-1")).toEqual({ unverified: "HTTP_404" });
    expect(seen.at(-1)).toEqual({ path: "/pao/v1/merchants/merchant-1/readiness", san: `URI:urn:${AGENT}` });
    expect(shopCalls).toEqual([]);
  });

  it("отпечаток не совпал — TLS_TRUST_MISMATCH на start(): platform.tls fail, остановка, обращений нет", async () => {
    issueClient(pki, stand.dir, ca, "root", AGENT);
    const url = await tlsProxy();
    const other = makeCa(pki, "other");
    const c = core(url, { caPem: ca.pem, caFingerprint: other.fingerprint });
    const { cause, report } = await tlsFailure(c.start());
    expect(cause).toBeInstanceOf(TlsTrustMismatch);
    expect(report.checks.find((x) => x.status === "fail")).toMatchObject({ check: "platform.tls", code: "TLS_TRUST_MISMATCH" });
    expect(seen).toEqual([]);
    expect(stand.stub.calls).toEqual([]);
    // остановка: повторный start() не допускает агента и в сеть не идёт
    await expect(c.start()).rejects.toThrow();
    expect(stand.stub.calls).toEqual([]);
  });

  it("сервер предъявил сертификат clientAuth того же УЦ — INVALID_PURPOSE → TLS_SERVER_UNTRUSTED: остановка, до PaoStub не дошло (КТ1 № 3 сессии 49)", async () => {
    issueClient(pki, stand.dir, ca, "root", AGENT);
    const url = await tlsProxy("clientAuth");
    const c = core(url, { caPem: ca.pem, caFingerprint: ca.fingerprint });
    const { cause, report } = await tlsFailure(c.start());
    expect(cause).toMatchObject({ name: "PlatformFailure", code: "TLS_SERVER_UNTRUSTED" });
    expect(report.checks.find((x) => x.status === "fail")).toMatchObject({ code: "TLS_SERVER_UNTRUSTED" });
    expect(seen).toEqual([]);
    expect(stand.stub.calls).toEqual([]);
    // остановка: повторный start() не допускает агента и в сеть не идёт
    await expect(c.start()).rejects.toThrow();
    expect(stand.stub.calls).toEqual([]);
  });

  it("отпечаток не по форме — TlsConfigInvalid при сборке, до start()", () => {
    expect(() => core("https://localhost:1", { caPem: ca.pem, caFingerprint: ca.fingerprint.slice(0, 20) })).toThrow(TlsConfigInvalid);
  });

  it("pao.tls с адресом не https или со своим pao.fetch — TlsConfigInvalid при сборке (КТ1 № 5 сессии 49)", () => {
    const tls = { caPem: ca.pem, caFingerprint: ca.fingerprint };
    expect(() => core("http://localhost:1", tls)).toThrow(/не https/);
    const own = () =>
      createAgentCore({
        keysDir: stand.dir,
        stateDir: `${stand.dir}-state`,
        now: () => stand.clock,
        pao: { baseUrl: "https://localhost:1", agentCode: AGENT, sleep: async () => {}, fetch: async () => new Response(), tls },
      });
    expect(own).toThrow(TlsConfigInvalid);
    expect(own).toThrow(/свой pao\.fetch/);
  });

  it("корень вне срока по часам ядра — TlsConfigInvalid при сборке (КТ1 № 6 сессии 49)", () => {
    expect(() => core("https://localhost:1", { caPem: ca.pem, caFingerprint: ca.fingerprint }, new MemoryJournal(), () => new Date(Date.now() + 3 * 86_400_000))).toThrow(/вне срока действия/);
  });

  it("отказ повторного start() (TLS_CERT_MISSING) не снимает рабочий канал: обращения идут через него (КТ1 № 4 сессии 49)", async () => {
    issueClient(pki, stand.dir, ca, "root", AGENT);
    const url = await tlsProxy();
    const c = core(url, { caPem: ca.pem, caFingerprint: ca.fingerprint });
    await c.start();
    const before = seen.length;
    rmSync(join(stand.dir, "tls", "client.cert.der"));
    const { cause } = await tlsFailure(c.start());
    expect(cause).toBeInstanceOf(TlsCertMissing);
    expect(seen).toHaveLength(before);
    await c.recheck();
    expect(seen.at(-1)).toEqual({ path: "/pao/v1/agent", san: `URI:urn:${AGENT}` });
  });

  it("сертификат не установлен — TLS_CERT_MISSING: допуска нет, обращений нет; после установки start() проходит", async () => {
    generateTlsKey(stand.dir);
    const url = await tlsProxy();
    const c = core(url, { caPem: ca.pem, caFingerprint: ca.fingerprint });
    const { cause, report } = await tlsFailure(c.start());
    expect(cause).toBeInstanceOf(TlsCertMissing);
    expect(report.checks.find((x) => x.status === "fail")).toMatchObject({ check: "platform.tls", code: "TLS_CERT_MISSING" });
    expect(seen).toEqual([]);
    // after_fix: агент не остановлен — оператор устанавливает сертификат, start() повторяется
    rmSync(join(stand.dir, "tls"), { recursive: true });
    issueClient(pki, stand.dir, ca, "root", AGENT);
    await c.start();
    expect(seen.length).toBeGreaterThan(0);
  });

  it("срок сертификата истёк по часам агента — TLS_CERT_EXPIRED: остановка до обращения", async () => {
    issueClient(pki, stand.dir, ca, "root", AGENT);
    const url = await tlsProxy();
    // сертификат клиента — сутки, корень — двое: через полтора дня корень ещё в сроке, сертификат — нет
    const c = core(url, { caPem: ca.pem, caFingerprint: ca.fingerprint }, new MemoryJournal(), () => new Date(Date.now() + 1.5 * 86_400_000));
    const { cause, report } = await tlsFailure(c.start());
    expect(cause).toBeInstanceOf(TlsCertExpired);
    expect(report.checks.find((x) => x.status === "fail")).toMatchObject({ check: "platform.tls", code: "TLS_CERT_EXPIRED" });
    expect(seen).toEqual([]);
    expect(stand.stub.calls).toEqual([]);
  });
});
