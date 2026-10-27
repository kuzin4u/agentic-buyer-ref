// 429 второго слоя лимита на стенде v0.28.0 (Р59 п. 4–5; ПАО §2, РП63): предел по коду агента после верной подписи —
// rate_limit_per_min из GET /pao/v1/agent, окна по 30 с, в окне — не больше половины. Стенд поднимается своим файлом
// параметров (PARAMS_PATH, L1 = 2 — одно подписанное обращение за окно), остальные значения — из параметров стенда.
// Окно стенда идёт по настоящим часам: успешный повтор после реального ожидания до 30 с сюда не входит (хвост, Р59 п. 7),
// он проверен на PaoStub (pao-adapter.test.ts); ожидание агента здесь — поддельное.
// Изменяющий запрос — регистрация ключа (POST /pao/v1/agent/keys): её исход виден в реестре ключей стенда без обращения
// к ПАО — квота окна уже израсходована.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStand, type Stand } from "agentic-ps-platform/stand";
import { afterEach, describe, expect, it } from "vitest";
import { Pace, PaoPlatform } from "../../src/agent/adapters/pao/index.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { generateKey } from "../../src/agent/signer/index.js";
import { PAO_RETRY_AFTER_MAX_SEC, loadParams } from "../../src/shared/config.js";
import { AGENT } from "../support/pao-stand.js";

const params = loadParams();
let stand: Stand | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await stand?.close();
  stand = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Стенд с пределом второго слоя L1 = `perMin`: файл параметров стенда с одной заменой, через PARAMS_PATH на время сборки. */
function standWithAgentLimit(perMin: number): Stand {
  // путь — от пакета стенда, не от каталога запуска (ревью КТ1 № 10)
  const pkg = dirname(createRequire(import.meta.url).resolve("agentic-ps-platform/package.json"));
  const base = JSON.parse(readFileSync(join(pkg, "config/params.stand.json"), "utf8")) as Record<string, unknown>;
  const file = join(tmp("rate-params-"), "params.json");
  writeFileSync(file, JSON.stringify({ ...base, pao_agent_rate_limit_per_min_l1: perMin }));
  const before = process.env.PARAMS_PATH;
  process.env.PARAMS_PATH = file;
  try {
    return createStand();
  } finally {
    if (before === undefined) delete process.env.PARAMS_PATH;
    else process.env.PARAMS_PATH = before;
  }
}

describe("429 второго слоя на стенде v0.28.0 (Р59 п. 4–5)", () => {
  it("изменяющий запрос: 429 — повтор новой подписью с тем же Idempotency-Key после Retry-After, после предела — RATE_LIMITED; исполнен не был", async () => {
    const s = standWithAgentLimit(2);
    stand = s;
    expect(s.params.pao_agent_rate_limit_per_min_l1).toBe(2);
    const a = generateKey(tmp("rate-keys-a-"));
    const decision = await s.admit(
      { agent_code: AGENT, class: "BUYER", model: "buyer-agent-ref", runtime: "node-20", alg: "ed25519", public_key: a.descriptor.public_key },
      "buyref-operator",
    );
    expect(decision.admitted).toBe(true);
    const baseUrl = await s.listen();

    const journal = new MemoryJournal();
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    // время агента не ждёт: ожидания записываются (окно стенда — по настоящим часам)
    const pace = new Pace({ fallbackPerMin: params.pao_rate_limit_fallback_per_min, journal, sleep });
    const sent: { method: string; path: string; status: number; nonce: string | null; key: string | null; retryAfter: string | null }[] = [];
    const fixedA = { current: () => a.signer, keyRevoked: () => a.signer, stop: () => {}, suspend: () => {} };
    const platform = new PaoPlatform({
      baseUrl,
      agentCode: AGENT,
      signing: fixedA,
      params,
      journal,
      sleep,
      pace,
      fetch: async (url, init) => {
        const res = await fetch(url, init);
        const h = new Headers(init?.headers);
        sent.push({
          method: init?.method ?? "GET",
          path: new URL(String(url)).pathname,
          status: res.status,
          nonce: h.get("x-nonce"),
          key: h.get("idempotency-key"),
          retryAfter: res.headers.get("retry-after"),
        });
        return res;
      },
    });

    // первое подписанное обращение открывает окно стенда (LocalStore @fastify/rate-limit — от первого обращения агента)
    const started = performance.now();
    // первое подписанное обращение окна: 200 и предел 2 / мин — запись до смены
    await expect(platform.agentSelf()).resolves.toMatchObject({ agentCode: AGENT, rateLimitPerMin: 2 });
    expect(journal.entries.filter((e) => e.kind === "pao.rate_limit").map((e) => e.detail)).toEqual(["AGENT:2"]);

    // второе — изменяющий запрос сверх половины предела в окне: 429 второго слоя
    const b = generateKey(tmp("rate-keys-b-"));
    const err = await platform.registerKey({ alg: "ed25519", publicKey: b.descriptor.public_key }, { idempotencyKey: "idem-rate-key-b" }).catch((e: unknown) => e);
    // исход зависит от того, что окно 30 с ещё не истекло (ревью КТ1, фокус 2): настоящего ожидания в тесте нет, но под
    // тяжёлой нагрузкой CI окно может кончиться — тогда регистрация пройдёт, и сообщение назовёт причину
    expect(performance.now() - started, "между первым обращением и последней попыткой прошло ≥ 25 с — окно стенда на исходе (нагрузка CI)").toBeLessThan(25_000);
    expect(err).toMatchObject({ code: "RATE_LIMITED", retry: "same_key", httpStatus: 429 });

    const posts = sent.filter((x) => x.method === "POST" && x.path === "/pao/v1/agent/keys");
    // Retry-After стенда у 429 — остаток окна (≤ 30 с): после первого ожидания второе превышает потолок 30 с
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts.length).toBeLessThanOrEqual(params.pao_max_attempts);
    // журнал обращений целиком: одно GET /pao/v1/agent, затем только попытки регистрации — без сверки чтением (ревью КТ1 № 9)
    expect(sent.map((x) => `${x.method} ${x.path} ${x.status}`)).toEqual(["GET /pao/v1/agent 200", ...posts.map(() => "POST /pao/v1/agent/keys 429")]);
    // Retry-After у 429 — целые секунды 1…30 (ПАО §2); адаптер ждал перед каждым повтором ровно его
    const after = posts.map((x) => Number(x.retryAfter));
    expect(posts.every((x) => /^\d+$/.test(x.retryAfter ?? ""))).toBe(true);
    expect(after.every((s) => s >= 1 && s <= PAO_RETRY_AFTER_MAX_SEC)).toBe(true);
    for (const s of after.slice(0, -1)) expect(sleeps).toContain(s * 1000);
    expect(journal.entries.filter((e) => e.kind === "pao.contract_violation")).toEqual([]);
    // повтор — новой подписью (новый x-nonce: прежний израсходован, ПАО §2) с тем же Idempotency-Key (инвариант 9)
    expect(new Set(posts.map((x) => x.nonce)).size).toBe(posts.length);
    expect(new Set(posts.map((x) => x.key))).toEqual(new Set(["idem-rate-key-b"]));
    // второй слой отвечает до обработчика: ключ B не зарегистрирован — двойного (и вообще) исполнения нет
    expect((await s.keys.list(AGENT)).map((k) => k.kid)).not.toContain(b.descriptor.kid);
    expect((await s.keys.list(AGENT)).map((k) => k.kid)).toContain(a.descriptor.kid);

    // журнал: каждая попытка — refused RATE_LIMITED 429, номер попытки растёт
    expect(
      journal.entries.filter((e) => e.kind === "pao.call" && e.method === "POST /pao/v1/agent/keys").map((e) => [e.attempt, e.result, e.reason, e.detail]),
    ).toEqual(posts.map((_, i) => [i + 1, "refused", "RATE_LIMITED", "429"]));
    // пауза ограничителя после 429 здесь от интервала 30 с (предел 2 / мин) не отличима — проверена в pao-pace.test.ts

    // первый слой (по адресу, до подписи) не исчерпан: конфигурация отвечает
    expect((await fetch(`${baseUrl}/.well-known/pao-configuration`)).status).toBe(200);
  });
});
