// Ответы транспорта ПАО на стенде v0.28.0 (Р57 п. 3; передачи #77 — PS-05б ч. 3, РП62, и #78 — PS-05б ч. 4, РП63;
// копия ПАО 1.4.0, §6 «Ответы транспорта»). Отказ до проверки обращения — тело §6 `{code, message, retry}`; до ПАО 1.5.0
// у 404 / 413 / 414 код — REQUEST_INVALID (`after_fix`) при своём HTTP, не 400 из таблицы `x-pao-errors`.
// Адаптер ПАО агента такой ответ не повторяет: пара «код, HTTP» не из `x-pao-errors` — BAD_RESPONSE `never`, одна
// попытка, отказ вызывающему (инвариант 4, инвариант 9; свои коды 404 / 413 / 414 — с ПАО 1.5.0, #37 платформы).
// Обращения тестовой поддержки подписаны действующим ключом агента (как tests/support/pao-unkeyed.ts); ответы адаптеру —
// настоящие ответы стенда: подменён только адрес или тело уже подписанного запроса, проверки подписи транспорт не ждёт.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signRequest } from "@kuzin4u/agentic-core";
import { createStand, type Stand } from "agentic-ps-platform/stand";
import { afterEach, describe, expect, it } from "vitest";
import { PaoPlatform } from "../../src/agent/adapters/pao/index.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { KeyRing, generateKey } from "../../src/agent/signer/index.js";
import { loadParams } from "../../src/shared/config.js";
import { INTENT } from "../support/consents.js";
import { AGENT } from "../support/pao-stand.js";

let stand: Stand | undefined;
let ring: KeyRing | undefined;
const dirs: string[] = [];
afterEach(async () => {
  ring?.close();
  ring = undefined;
  await stand?.close();
  stand = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Предел тела ПАО — 64 КиБ (§6, РП62); тело больше него. */
const OVER_BODY_LIMIT = 64 * 1024 + 1;
/** Предел параметра пути — 256 знаков (§4, РП57 доп. 1); параметр длиннее него. */
const OVER_PARAM_LIMIT = "m".repeat(257);
const TRANSPORT = { code: "REQUEST_INVALID", message: expect.any(String), retry: "after_fix" };

/** Подмена уже подписанного запроса адаптера: адрес или тело — по маршруту «метод путь». */
type Rewrite = { path?: (p: string) => string; body?: (b: string) => string };

async function setup() {
  const s = createStand();
  stand = s;
  const dir = mkdtempSync(join(tmpdir(), "transport-keys-"));
  dirs.push(dir);
  const { descriptor } = generateKey(dir);
  const decision = s.admit(
    { agent_code: AGENT, class: "BUYER", model: "buyer-agent-ref", runtime: "node-20", alg: "ed25519", public_key: descriptor.public_key },
    "buyref-operator",
  );
  if (!decision.admitted) throw new Error("стенд не допустил агента");
  const baseUrl = await s.listen();
  const params = loadParams();
  const journal = new MemoryJournal();
  /** обращения адаптера по сети: метод, путь без query, статус; тела не сохраняются (инвариант 1) */
  const calls: { route: string; status: number }[] = [];
  const rewrite = new Map<string, Rewrite>();
  const fetchLog: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const r = [...rewrite.entries()].find(([route]) => route === `${method} ${u.pathname}` || (route.endsWith("*") && `${method} ${u.pathname}`.startsWith(route.slice(0, -1))))?.[1];
    if (r?.path) u.pathname = r.path(u.pathname);
    const body = r?.body && typeof init?.body === "string" ? r.body(init.body) : init?.body;
    const res = await fetch(u, { ...init, ...(body !== undefined && { body }) });
    calls.push({ route: `${method} ${new URL(String(url)).pathname}`, status: res.status });
    return res;
  };
  const r = new KeyRing({ dir, params, journal });
  ring = r;
  const pao = { baseUrl, agentCode: AGENT, params, sleep: async () => {}, journal, fetch: fetchLog };
  await r.start((signing) => new PaoPlatform({ ...pao, signing }).agentSelf());
  const platform = new PaoPlatform({ ...pao, signing: r.port() });
  calls.length = 0;

  /** Обращение тестовой поддержки к ПАО стенда: подпись действующим ключом агента или только `x-agent-code`. */
  async function raw(method: string, path: string, o: { body?: string; contentType?: string; agentCode?: string; signed?: boolean } = {}) {
    let headers: Record<string, string> = {
      ...(o.body !== undefined && { "content-type": o.contentType ?? "application/json" }),
      "x-agent-code": o.agentCode ?? AGENT,
      "x-timestamp": new Date().toISOString().slice(0, 19) + "Z",
      "x-nonce": randomUUID(),
    };
    if (o.signed !== false) headers = signRequest({ method, path, query: "", headers, body: o.body ?? "" }, r.port().current()).headers;
    const res = await fetch(`${baseUrl}${path}`, { method, headers, ...(o.body !== undefined && { body: o.body }) });
    const text = await res.text();
    return { status: res.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
  }
  return { platform, calls, rewrite, raw, journal };
}

describe("ответы транспорта ПАО на стенде v0.28.0 (§6, РП62, РП63; Р57 п. 3)", () => {
  it("допущенный агент: нет маршрута — 404, HEAD — 404, тело больше 64 КиБ — 413, параметр пути длиннее 256 — 414; тело §6, REQUEST_INVALID after_fix", async () => {
    const { raw } = await setup();
    expect(await raw("GET", "/pao/v1/no-such-route")).toEqual({ status: 404, body: TRANSPORT });
    expect(await raw("HEAD", "/pao/v1/agent")).toMatchObject({ status: 404 });
    const big = JSON.stringify({ pad: "x".repeat(OVER_BODY_LIMIT) });
    expect(await raw("POST", "/pao/v1/mandates", { body: big })).toEqual({ status: 413, body: TRANSPORT });
    expect(await raw("GET", `/pao/v1/mandates/${OVER_PARAM_LIMIT}`)).toEqual({ status: 414, body: TRANSPORT });
  });

  it("% в пути — 400 REQUEST_INVALID до проверки подписи (в том числе у отзыва ключа и чтения реквизита)", async () => {
    const { raw } = await setup();
    const bad = { status: 400, body: { ...TRANSPORT } };
    expect(await raw("GET", "/pao/v1/mandates/m%41")).toEqual(bad);
    expect(await raw("POST", "/pao/v1/agent/keys/k%41/revoke", { body: "" })).toEqual(bad);
    expect(await raw("GET", "/pao/v1/credentials/c%41")).toEqual(bad);
  });

  it("неизвестный агент и без x-agent-code: тело больше 64 КиБ или неразборный Content-Type — 401 AGENT_UNKNOWN, а не 413 / 400 (РП63 п. 9–10)", async () => {
    const { raw } = await setup();
    const unknown = { status: 401, body: expect.objectContaining({ code: "AGENT_UNKNOWN" }) };
    const big = JSON.stringify({ pad: "x".repeat(OVER_BODY_LIMIT) });
    expect(await raw("POST", "/pao/v1/mandates", { body: big, agentCode: "agent-unknown", signed: false })).toEqual(unknown);
    expect(await raw("POST", "/pao/v1/mandates", { body: "{}", contentType: "application/json;;;=", agentCode: "agent-unknown", signed: false })).toEqual(unknown);
    expect(await raw("POST", "/pao/v1/mandates", { body: big, agentCode: "", signed: false })).toEqual(unknown);
  });

  it("адаптер ПАО: REQUEST_INVALID при HTTP 404 / 413 / 414 — BAD_RESPONSE never, одна попытка, без повтора (инвариант 4)", async () => {
    const { platform, calls, rewrite, journal } = await setup();
    const from = journal.entries.length; // после допуска

    // Пара «код, HTTP» не совпадает с x-pao-errors (REQUEST_INVALID — 400): ответ не подтверждён контрактом — BAD_RESPONSE
    // `never`, код Платформы сохранён (adapters/pao/errors.ts, инвариант 4); поведение ядра прежнее (Р57, нюанс К2.1).
    const refused = (httpStatus: number, idempotencyKey: string | null) =>
      expect.objectContaining({ code: "BAD_RESPONSE", retry: "never", platformCode: "REQUEST_INVALID", httpStatus, idempotencyKey });
    rewrite.set("GET /pao/v1/mandates/*", { path: (p) => p.replace("/mandates/", "/mandatez/") });
    await expect(platform.getMandate("m_404")).rejects.toEqual(refused(404, null));
    rewrite.set("GET /pao/v1/mandates/*", { path: () => `/pao/v1/mandates/${OVER_PARAM_LIMIT}` });
    await expect(platform.getMandate("m_414")).rejects.toEqual(refused(414, null));
    rewrite.set("POST /pao/v1/mandates", { body: (b) => b + " ".repeat(OVER_BODY_LIMIT) });
    await expect(platform.requestMandate(INTENT, { idempotencyKey: "idem-413" })).rejects.toEqual(refused(413, "idem-413"));

    // одна попытка на каждое обращение, повтора нет — ни нового x-nonce, ни того же ключа идемпотентности
    expect(calls).toEqual([
      { route: "GET /pao/v1/mandates/m_404", status: 404 },
      { route: "GET /pao/v1/mandates/m_414", status: 414 },
      { route: "POST /pao/v1/mandates", status: 413 },
    ]);
    // в журнале — попытка с исходом «не подтверждён» (unknown), как у любого BAD_RESPONSE
    expect(journal.entries.slice(from).filter((e) => e.kind === "pao.call")).toEqual([
      expect.objectContaining({ method: "GET /pao/v1/mandates/{id}", attempt: 1, result: "unknown", reason: "BAD_RESPONSE", detail: "404" }),
      expect.objectContaining({ method: "GET /pao/v1/mandates/{id}", attempt: 1, result: "unknown", reason: "BAD_RESPONSE", detail: "414" }),
      expect.objectContaining({ method: "POST /pao/v1/mandates", attempt: 1, result: "unknown", reason: "BAD_RESPONSE", detail: "413" }),
    ]);
  });
});
