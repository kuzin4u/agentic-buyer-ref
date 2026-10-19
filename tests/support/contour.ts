// Тестовый контур агента (AG-04, Р26 агента): один вход createContour({ pao }) — ПАО, витрины продавцов и журнал обращений.
//
// Правило выбора режима (ревью #23 п. 5; решение владельца 14.10.2026):
//  - "stub"  — модульные тесты ядра против ПАО: PaoStub agentic-core через обёртку PaoStand (Р16, расхождение № 9).
//              Витрин нет: эмулятор продавцов проверяет подпись по каталогу ключей стенда Платформы, а у PaoStub его нет.
//  - "stand" — совместные тесты: стенд Платформы createStand (Р24) и эмулятор продавцов createMerchants поверх него (Р26 п. 3).
//              Стенд v0.5.0 обслуживает GET /pao/v1/agent, ключи, мандаты, ленту событий и подписку (ПАО 1.4.0); тесты мандатов пока на PaoStub —
//              переход на стенд — STATUS «Открыто»; реквизит — после PS-07.
//              Агент — из AGENT_FIXTURES, допуск — заявлением agentApplication (fixtures Платформы).
//
// Сборка агента — ПОВТОР compose (src/agent/compose.ts) до AG-09: связка ключей KeyRing и адаптер PaoPlatform с портом
// подписи ring.port(). Повтор нужен, чтобы запросы к витринам подписывал порт подписи агента (ревью #23 п. 2), а не код
// теста: клиента витрин у агента ещё нет, а createAgentCore порт наружу не отдаёт. С клиентом витрин (AG-09) контур
// переходит на createAgentCore. Ключ через порт не проходит (инвариант 2).
//
// Журнал обращений — все обращения к ПАО и витринам по порядку: маршрут, статус, код отказа, kid подписи, x-nonce,
// Idempotency-Key. Тела запросов и ответов не сохраняются (инвариант 1); код отказа берётся только из поля code.
// Режим "stub" журналирует то, что отдаёт PaoStub (PaoStubCall): операцию, статус, x-nonce, Idempotency-Key и признак
// replayed; кода отказа и kid в нём нет. Обращение вне операций ПАО записывается как «(нет операции)» без метода и пути —
// PaoStub их не сообщает (просьба в CO-1). Нарушения схемы ПАО, найденные заглушкой, — violations(); тест ждёт [].
//
// Часы: x-timestamp клиента ПАО и запросов к витринам — системные; часы проверяющей стороны (стенд, PaoStub) тест может
// сдвинуть отдельно — так видно расхождение часов клиента и сервера. Связка ключей в "stub" — по часам PaoStand (сроки
// ключей заглушки отсчитаны от них, как в tests/support/core.ts), в "stand" — системные.
// Поля stand, paoStand и merchants.emulator — только для подготовки контура (допуск, статус агента, отказы заглушки),
// не для подмены ответов в сценарии: изменение состояния Платформы в обход ПАО — обход нормы (правило приёмки).
// Изоляция (ревью #23 п. 4): каждый контур — свои серверы на порту 0 и своя временная папка ключей; close() удаляет всё.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signRequest } from "@kuzin4u/agentic-core";
import { AGENT_FIXTURES, MERCHANT_FIXTURES, agentApplication, type MerchantFixture, type ShopBehaviour } from "agentic-ps-platform/fixtures";
import { createMerchants, createStand, type MerchantsStand, type Stand } from "agentic-ps-platform/stand";
import { PaoPlatform } from "../../src/agent/adapters/pao/index.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import type { PaymentPlatform } from "../../src/agent/ports/payment-platform.js";
import { KeyRing, generateKey } from "../../src/agent/signer/index.js";
import { loadParams, type StandParams } from "../../src/shared/config.js";
import type { AgentSelf } from "../../src/shared/domain.js";
import { AGENT, PaoStand, type StandOptions } from "./pao-stand.js";

export type ContourMode = "stub" | "stand";

export interface ContourOptions {
  pao: ContourMode;
  /** только для "stub": настройки обёртки PaoStand (ключи, обработчики операций, незарегистрированный агент) */
  stub?: StandOptions;
}

/** Запись журнала обращений: без тел (инвариант 1). */
export interface ContourCall {
  target: "pao" | "merchants";
  /** "GET /v1/shops/<id>/catalog" — путь без query; для PaoStub — ключ операции */
  route: string;
  status: number;
  /** код отказа из поля code ответа */
  code?: string;
  /** kid из Signature-Input; PaoStub его не сообщает */
  kid?: string;
  nonce?: string;
  idempotencyKey?: string;
  /** PaoStub: ответ выдан повторно по прежнему Idempotency-Key (инвариант 9) */
  replayed?: boolean;
}

export interface MerchantResponse {
  status: number;
  body: unknown;
}

export interface MerchantRequest {
  query?: string;
  body?: unknown;
  /** false — запрос человека, без подписи (A5 п. 2.1); по умолчанию подписывает порт подписи агента */
  signed?: boolean;
}

export interface Merchants {
  readonly baseUrl: string;
  readonly emulator: MerchantsStand;
  request(method: "GET" | "POST", path: string, r?: MerchantRequest): Promise<MerchantResponse>;
}

export interface Contour {
  readonly mode: ContourMode;
  readonly agentCode: string;
  readonly keysDir: string;
  readonly params: StandParams;
  readonly journal: MemoryJournal;
  readonly platform: PaymentPlatform;
  /** стадия 0 — как AgentCore.start */
  start(): Promise<AgentSelf>;
  /** только "stand" */
  readonly merchants?: Merchants;
  readonly stand?: Stand;
  /** только "stub" */
  readonly paoStand?: PaoStand;
  /** полный журнал обращений по порядку */
  calls(): ContourCall[];
  /** нарушения схемы ПАО, найденные PaoStub; в режиме "stand" — всегда [] (схему проверяет стенд ответом) */
  violations(): string[];
  close(): Promise<void>;
}

const header = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const KEYID = /;keyid="([^"]+)"/;

/** Журнал обращений к серверу Fastify: хук до listen; код отказа — только поле code тела ответа. */
function record(app: Stand["app"], target: ContourCall["target"], log: ContourCall[]): void {
  app.addHook("onSend", async (req, reply, payload) => {
    let code: string | undefined;
    if (reply.statusCode >= 400 && typeof payload === "string") {
      try {
        const c = (JSON.parse(payload) as { code?: unknown }).code;
        if (typeof c === "string") code = c;
      } catch {
        // не JSON — кода нет
      }
    }
    const kid = KEYID.exec(header(req.headers["signature-input"]) ?? "")?.[1];
    const nonce = header(req.headers["x-nonce"]);
    const idempotencyKey = header(req.headers["idempotency-key"]);
    log.push({
      target,
      route: `${req.method} ${req.url.split("?")[0]}`,
      status: reply.statusCode,
      ...(code !== undefined && { code }),
      ...(kid !== undefined && { kid }),
      ...(nonce !== undefined && { nonce }),
      ...(idempotencyKey !== undefined && { idempotencyKey }),
    });
    return payload;
  });
}

/** Повтор compose до AG-09 (см. шапку): связка ключей и адаптер ПАО с портом подписи. */
function agent(o: { dir: string; baseUrl: string; agentCode: string; params: StandParams; journal: MemoryJournal; now?: () => Date }) {
  const ring = new KeyRing({ dir: o.dir, params: o.params, journal: o.journal, ...(o.now && { now: o.now }) });
  // Часы клиента ПАО — системные, как в tests/support/core.ts: окно времени подписи проверяет сервер по своим часам.
  const pao = { baseUrl: o.baseUrl, agentCode: o.agentCode, params: o.params, sleep: async () => {}, journal: o.journal };
  const platform = new PaoPlatform({ ...pao, signing: ring.port() });
  return {
    ring,
    platform,
    start: () => ring.start((signing) => new PaoPlatform({ ...pao, signing }).agentSelf()),
  };
}

/** Витрина эмулятора по поведению — только из MERCHANT_FIXTURES (Р26 п. 3, К1.2): тесты не пишут id, merchant_id и sku
 *  витрин литералами, чтобы смена фикстур в эмуляторе не расходилась с тестами молча. */
export function shopBy(behaviour: ShopBehaviour): MerchantFixture {
  const found = MERCHANT_FIXTURES.filter((f) => f.behaviour === behaviour);
  if (found.length !== 1) throw new Error(`в MERCHANT_FIXTURES витрин с поведением ${behaviour}: ${found.length}, ждали одну`);
  return found[0]!;
}

export async function createContour(o: ContourOptions): Promise<Contour> {
  return o.pao === "stub" ? stubContour(o.stub) : standContour();
}

async function stubContour(opts: StandOptions | undefined): Promise<Contour> {
  const paoStand = new PaoStand(opts);
  const params = loadParams();
  const journal = new MemoryJournal();
  let a: ReturnType<typeof agent>;
  try {
    const baseUrl = await paoStand.stub.start();
    a = agent({ dir: paoStand.dir, baseUrl, agentCode: AGENT, params, journal, now: () => paoStand.clock });
  } catch (e) {
    await paoStand.close().catch(() => {});
    throw e;
  }
  return {
    mode: "stub",
    agentCode: AGENT,
    keysDir: paoStand.dir,
    params,
    journal,
    platform: a.platform,
    start: a.start,
    paoStand,
    calls: () =>
      paoStand.stub.calls.map((c) => ({
        target: "pao" as const,
        route: c.op ?? "(нет операции)",
        status: c.status,
        ...(c.nonce !== undefined && { nonce: c.nonce }),
        ...(c.idempotencyKey !== undefined && { idempotencyKey: c.idempotencyKey }),
        replayed: c.replayed,
      })),
    violations: () => [...paoStand.stub.violations],
    async close() {
      try {
        a.ring.close();
      } finally {
        await paoStand.close(); // удаляет и папку ключей
      }
    },
  };
}

async function standContour(): Promise<Contour> {
  const fixture = AGENT_FIXTURES.find((f) => f.registered && f.class === "BUYER");
  if (!fixture) throw new Error("в AGENT_FIXTURES нет зарегистрированного агента BUYER");
  const params = loadParams();
  const journal = new MemoryJournal();
  const log: ContourCall[] = [];
  let dir: string | undefined;
  let stand: Stand | undefined;
  let emulator: MerchantsStand | undefined;
  let ring: KeyRing | undefined;
  const release = async () => {
    try {
      ring?.close();
    } finally {
      await Promise.allSettled([emulator?.close(), stand?.close()]);
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  };
  try {
    dir = mkdtempSync(join(tmpdir(), "buyref-contour-"));
    stand = createStand();
    emulator = createMerchants(stand);
    record(stand.app, "pao", log);
    record(emulator.app, "merchants", log);
    // Допуск — заявлением оператора по фикстуре: только открытый ключ (инвариант 2).
    const { descriptor } = generateKey(dir);
    const decision = stand.admit(agentApplication(fixture, { alg: descriptor.alg, public_key: descriptor.public_key }), fixture.operator);
    if (!decision.admitted) throw new Error(`стенд не допустил агента фикстуры: ${JSON.stringify(decision)}`);
    const [baseUrl, merchantsUrl] = await Promise.all([stand.listen(), emulator.listen()]);
    const a = agent({ dir, baseUrl, agentCode: fixture.agent_code, params, journal });
    ring = a.ring;
    const signing = a.ring.port();

    const merchants: Merchants = {
      baseUrl: merchantsUrl,
      emulator,
      async request(method, path, r = {}) {
        const body = r.body === undefined ? undefined : JSON.stringify(r.body);
        let headers: Record<string, string> = body === undefined ? {} : { "content-type": "application/json" };
        if (r.signed !== false) {
          // Подписывает порт подписи агента: до допуска и после остановки — SignerStopped, запроса нет (fail-closed).
          const signer = signing.current();
          const signed = signRequest(
            {
              method,
              path,
              query: r.query ?? "",
              headers: {
                ...headers,
                "x-agent-code": fixture.agent_code,
                "x-timestamp": new Date().toISOString().slice(0, 19) + "Z", // системные часы, как у клиента ПАО
                "x-nonce": randomUUID(),
              },
              body: body ?? "", // пустое тело подписывается как "" — как в PaoClient (РП16)
            },
            signer,
          );
          headers = signed.headers;
        }
        const res = await fetch(`${merchantsUrl}${path}${r.query ? `?${r.query}` : ""}`, {
          method,
          headers,
          ...(body !== undefined && { body }),
        });
        const text = await res.text();
        return { status: res.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
      },
    };

    return {
      mode: "stand",
      agentCode: fixture.agent_code,
      keysDir: dir,
      params,
      journal,
      platform: a.platform,
      start: a.start,
      merchants,
      stand,
      calls: () => log.map((c) => ({ ...c })),
      violations: () => [],
      close: release,
    };
  } catch (e) {
    await release();
    throw e;
  }
}
