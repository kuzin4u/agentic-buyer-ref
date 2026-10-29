// Отказы канала mTLS (Р64 п. 7; К3.2; решение владельца 29.10): закрытый перечень в адаптере ПАО. Алерт о сертификате
// клиента (коды Node или номер 42, 44, 45, 46, 48, 116 в тексте OpenSSL) — как 401 AGENT_UNKNOWN: остановка без ротации
// ключа подписи; сервер не прошёл проверку (в т. ч. алерт 70 — не TLS 1.3) — TLS_SERVER_UNTRUSTED, остановка без повтора;
// срок сертификата канала — TLS_CERT_EXPIRED; прочее, обрыв, сброс при рукопожатии, тайм-аут — NO_RESPONSE.
import { PaoCallError } from "@kuzin4u/agentic-core/pao";
import { afterEach, describe, expect, it } from "vitest";
import { toFailure } from "../../src/agent/adapters/pao/errors.js";
import { SignerStopped } from "../../src/agent/signer/index.js";
import { Consents, INTENT } from "../support/consents.js";
import { coreOn } from "../support/core.js";
import { PaoStand } from "../support/pao-stand.js";

/** Ошибка сокета или TLS, как её отдаёт node:https: код и текст OpenSSL. */
const nodeError = (code: string, message = `${code} error`): Error => Object.assign(new Error(message), { code });
const alertText = (n: number) => `write EPROTO 00:error:0A000412:SSL routines:ssl3_read_bytes:sslv3 alert:ssl/record/rec_layer_s3.c:918:SSL alert number ${n}\n`;
const viaClient = (cause: unknown) => toFailure(new PaoCallError(0, undefined, 1, "idem-1", { cause }), "idem-1").code;

describe("перевод отказа канала (Р64 п. 7)", () => {
  it("шесть кодов Node алерта о сертификате клиента — AGENT_UNKNOWN", () => {
    for (const code of [
      "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE",
      "ERR_SSL_SSLV3_ALERT_CERTIFICATE_REVOKED",
      "ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED",
      "ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN",
      "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
      "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED",
    ]) {
      expect(viaClient(nodeError(code)), code).toBe("AGENT_UNKNOWN");
    }
  });

  it("номер алерта в тексте OpenSSL (EPROTO): 42, 44, 45, 46, 48, 116 — AGENT_UNKNOWN; 70 — TLS_SERVER_UNTRUSTED", () => {
    for (const n of [42, 44, 45, 46, 48, 116]) expect(viaClient(nodeError("EPROTO", alertText(n))), String(n)).toBe("AGENT_UNKNOWN");
    expect(viaClient(nodeError("EPROTO", alertText(70)))).toBe("TLS_SERVER_UNTRUSTED");
  });

  it("чужой номер алерта, нет номера, шаблон не тот — NO_RESPONSE", () => {
    for (const n of [0, 10, 40, 43, 47, 49, 50, 80, 115, 117]) expect(viaClient(nodeError("EPROTO", alertText(n))), String(n)).toBe("NO_RESPONSE");
    expect(viaClient(nodeError("EPROTO", "write EPROTO ssl3_read_bytes:sslv3 alert bad certificate"))).toBe("NO_RESPONSE");
    expect(viaClient(nodeError("EPROTO", "SSL alert number 48 и дальше текст"))).toBe("NO_RESPONSE");
    expect(viaClient(nodeError("EPROTO", "SSL alert number 4800\n"))).toBe("NO_RESPONSE");
    expect(viaClient(nodeError("EPROTO", "ssl alert number 48\n"))).toBe("NO_RESPONSE");
  });

  it("сервер не прошёл проверку — TLS_SERVER_UNTRUSTED", () => {
    for (const code of ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "SELF_SIGNED_CERT_IN_CHAIN", "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION"]) {
      expect(viaClient(nodeError(code)), code).toBe("TLS_SERVER_UNTRUSTED");
    }
  });

  it("срок сертификата канала (TlsCertExpired канала) — TLS_CERT_EXPIRED; обрыв, сброс, тайм-аут, прочее — NO_RESPONSE", () => {
    expect(viaClient(Object.assign(new Error("срок сертификата канала истёк"), { code: "TLS_CERT_EXPIRED" }))).toBe("TLS_CERT_EXPIRED");
    for (const cause of [nodeError("ECONNRESET", "socket hang up"), nodeError("ECONNREFUSED"), nodeError("ETIMEDOUT"), nodeError("ABORT_ERR"), new TypeError("fetch failed"), "строка", null, undefined]) {
      expect(viaClient(cause)).toBe("NO_RESPONSE");
    }
  });
});

let stand: PaoStand | undefined;
afterEach(async () => {
  await stand?.stub.close();
  stand = undefined;
});

/** Агент на PaoStub: после допуска обращения к ПАО отказывают ошибкой канала `fail` (null — сеть как есть). */
async function agentWith() {
  const consents: Consents = new Consents(() => s.clock);
  const s: PaoStand = (stand = new PaoStand({ handlers: consents.handlers(), configuration: { versions: ["1.4.0"] } }));
  let fail: unknown = null;
  const { core, journal } = await coreOn(s, { fetch: (url, init) => (fail === null ? fetch(url, init) : Promise.reject(fail)) });
  await core.start();
  const calls = () => journal.entries.filter((e) => e.kind === "pao.call" && e.method === "POST /pao/v1/mandates");
  return { core, s, calls, set: (e: unknown) => (fail = e) };
}

describe("отказ канала на PaoStub (Р64 п. 7)", () => {
  it("алерт о сертификате клиента — остановка агента как AGENT_UNKNOWN, без повтора и без ротации ключа подписи", async () => {
    const a = await agentWith();
    a.set(nodeError("ERR_SSL_TLSV1_ALERT_UNKNOWN_CA", alertText(48)));
    await expect(a.core.mandates.request(INTENT, { idempotencyKey: "idem-tls-1" })).rejects.toMatchObject({ code: "AGENT_UNKNOWN" });
    expect(a.calls()).toHaveLength(1);
    expect(a.s.registrations).toEqual([]);
    a.set(null);
    await expect(a.core.mandates.request(INTENT, { idempotencyKey: "idem-tls-2" })).rejects.toBeInstanceOf(SignerStopped);
  });

  it("сервер не прошёл проверку (в т. ч. алерт 70) — TLS_SERVER_UNTRUSTED: остановка без повтора", async () => {
    const a = await agentWith();
    a.set(nodeError("EPROTO", alertText(70)));
    await expect(a.core.mandates.request(INTENT, { idempotencyKey: "idem-tls-3" })).rejects.toMatchObject({ code: "TLS_SERVER_UNTRUSTED" });
    expect(a.calls()).toHaveLength(1);
    a.set(null);
    await expect(a.core.mandates.request(INTENT, { idempotencyKey: "idem-tls-4" })).rejects.toBeInstanceOf(SignerStopped);
  });

  it("сброс соединения при рукопожатии — NO_RESPONSE: повтор тем же ключом, агент не остановлен", async () => {
    const a = await agentWith();
    a.set(nodeError("ECONNRESET", "socket hang up"));
    await expect(a.core.mandates.request(INTENT, { idempotencyKey: "idem-tls-5" })).rejects.toMatchObject({ code: "NO_RESPONSE" });
    // повтор тем же ключом внутри адаптера (Р48 п. 4): попытки 1, 2, … одного обращения
    expect(a.calls().map((e) => e.attempt)).toEqual(Array.from({ length: a.calls().length }, (_, i) => i + 1));
    expect(a.calls().length).toBeGreaterThan(1);
    a.set(null);
    await expect(a.core.mandates.request(INTENT, { idempotencyKey: "idem-tls-6" })).resolves.toBeDefined();
  });
});
