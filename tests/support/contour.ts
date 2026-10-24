// Тестовый контур агента (AG-04, Р26 агента): один вход createContour({ pao }) — ПАО, витрины продавцов и журнал обращений.
//
// Правило выбора режима (ревью #23 п. 5; решение владельца 14.10.2026):
//  - "stub"  — модульные тесты ядра против ПАО: PaoStub agentic-core через обёртку PaoStand (Р16, расхождение № 9).
//              Витрин нет: эмулятор продавцов проверяет подпись по каталогу ключей стенда Платформы, а у PaoStub его нет.
//  - "stand" — совместные тесты: стенд Платформы createStand (Р24) и эмулятор продавцов createMerchants поверх него (Р26 п. 3).
//              Стенд v0.11.0 (Р41 п. 2) обслуживает GET /pao/v1/agent, ключи, мандаты, ленту событий и подписку (ПАО 1.4.0), шлюз участников
//              /participants/v1/* (подпись мандата, отзыв, revoke-all, лимиты) и /adp/v1/decide; тесты мандатов пока на PaoStub —
//              переход на стенд — STATUS «Открыто»; реквизит — после PS-14.
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
import type { HttpRequestSigning } from "../../src/agent/ports/request-signing.js";
import { KeyRing, generateKey } from "../../src/agent/signer/index.js";
import { loadParams, type StandParams } from "../../src/shared/config.js";
import type { DiagCode } from "../../src/shared/diag-codes.js";
import type { AgentSelf } from "../../src/shared/domain.js";
import { AGENT, PaoStand, type StandOptions } from "./pao-stand.js";

export type ContourMode = "stub" | "stand";

export interface ContourOptions {
  pao: ContourMode;
  /** только для "stand": часы клиента ПАО агента (x-timestamp подписи) — тест двигает их вместе с часами стенда */
  now?: () => Date;
  /** только для "stand", ПОДМЕНА ДО PS-11 (Р47, К4, решение владельца — вариант (а)): ОПКЦ стенда — заглушка, ADP
   *  продавец не достигает. Заглушка отвечает продавцу отказом, а копию сообщения эквайрера тест передаёт в настоящий
   *  ADP стенда (`POST /adp/v1/decide`): запрос подтверждения, событие и решение банка — настоящие. После PS-11 —
   *  снять. */
  adpUntilPs11?: boolean;
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
  /** стенд: кто обратился — "agent" (по сети, как клиент агента) или "test" (тестовая поддержка через `app.inject`: копия
   *  сообщения эквайрера до PS-11, сообщения процессинга ПИ-3, действия банка; с v0.24.0 — и участники самого стенда:
   *  подача знаков эквайрером при старте и метаданные пакета после авторизации, ПИ-8, #67); полный журнал агента — только
   *  "agent" (agentCalls) */
  source?: "agent" | "test";
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
  /** только "stand" с `adpUntilPs11`: ответы ADP стенда на копии сообщений эквайрера (подмена до PS-11), с `op_ref`
   *  сообщения */
  adpDecisions?(): Promise<unknown[]>;
  readonly mode: ContourMode;
  readonly agentCode: string;
  readonly keysDir: string;
  readonly params: StandParams;
  readonly journal: MemoryJournal;
  readonly platform: PaymentPlatform;
  /** стадия 0 — как AgentCore.start */
  start(): Promise<AgentSelf>;
  /** допуск для конвейера — как у места сборки (compose.ts): подпись остановлена — её код (CLOSED — UNKNOWN), иначе
   *  последний start() не дал допуска — NOT_ADMITTED; допуск есть — null (Р38 п. 2, К6) */
  admission(): DiagCode | null;
  /** только "stand" */
  readonly merchants?: Merchants;
  /** только "stand": подпись обращений к витринам действующим ключом агента — как у места сборки (compose.shops, Р42) */
  readonly shopSigning?: HttpRequestSigning;
  readonly stand?: Stand;
  /** только "stub" */
  readonly paoStand?: PaoStand;
  /** полный журнал обращений по порядку */
  calls(): ContourCall[];
  /** журнал обращений агента по порядку — без тестовой поддержки и участников стенда (source "test"); у PaoStub — весь */
  agentCalls(): ContourCall[];
  /** нарушения схемы ПАО, найденные PaoStub; в режиме "stand" — всегда [] (схему проверяет стенд ответом) */
  violations(): string[];
  /** только "stand": `token_ref` и криптограммы из ответов стенда на POST /pao/v1/credentials — образцы для проверки, что
   *  реквизит не утёк в журнал, вывод и ошибки (Р45 п. 3); в журнал обращений они не попадают */
  issuedSecrets(): string[];
  close(): Promise<void>;
}

const header = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const KEYID = /;keyid="([^"]+)"/;
/** user-agent запросов `app.inject` (light-my-request по умолчанию) */
const INJECT_AGENT = "lightMyRequest";
/** Пути участников Платформы (ADP, ПИ-3): агенту закрыты — его обращение туда — нарушение контура (ревью чата К4). */
const PARTICIPANT_ONLY = /^\S+ \/adp\//;

/** Журнал обращений к серверу Fastify: хук до listen; код отказа — только поле code тела ответа.
 *  Нюанс К2 (Р52): с v0.24.0 createStand загружает приложение сразу, хук после создания стенд не поддерживает (#67).
 *  addHook здесь проходит только потому, что createStand синхронный, а загрузка начинается первым app.inject подачи
 *  знаков; станет стенд загружаться раньше — все тесты на стенде упадут на addHook. Просьба платформе — журнал обращений
 *  от самого стенда с source agent / test (запасной вариант — createStand({ hooks })), STATUS «Открыто». */
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
      // app.inject (light-my-request) — тестовая поддержка, не сеть: клиент агента ходит только по сети
      source: header(req.headers["user-agent"]) === INJECT_AGENT ? "test" : "agent",
      ...(code !== undefined && { code }),
      ...(kid !== undefined && { kid }),
      ...(nonce !== undefined && { nonce }),
      ...(idempotencyKey !== undefined && { idempotencyKey }),
    });
    return payload;
  });
}

/** Реквизит из ответов на выдачу — отдельно от журнала обращений (в нём тел нет): только образцы для теста утечки. */
function captureCredentials(app: Stand["app"], out: string[]): void {
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.method === "POST" && req.url.split("?")[0] === "/pao/v1/credentials" && reply.statusCode === 201 && typeof payload === "string") {
      const p = (JSON.parse(payload) as { payload?: Record<string, unknown> }).payload ?? {};
      for (const v of [p.token_ref, p.cryptogram]) if (typeof v === "string" && v !== "") out.push(v);
    }
    return payload;
  });
}

/** Повтор compose до AG-09 (см. шапку): связка ключей и адаптер ПАО с портом подписи. */
function agent(o: { dir: string; baseUrl: string; agentCode: string; params: StandParams; journal: MemoryJournal; now?: () => Date; paoNow?: () => Date }) {
  const ring = new KeyRing({ dir: o.dir, params: o.params, journal: o.journal, ...(o.now && { now: o.now }) });
  // Часы клиента ПАО — системные, как в tests/support/core.ts: окно времени подписи проверяет сервер по своим часам.
  // `paoNow` — только для стенда, когда тест двигает часы стенда (setClock) и клиента вместе (истечение подтверждения, Р47)
  const pao = { baseUrl: o.baseUrl, agentCode: o.agentCode, params: o.params, sleep: async () => {}, journal: o.journal, ...(o.paoNow && { now: o.paoNow }) };
  const platform = new PaoPlatform({ ...pao, signing: ring.port() });
  let admitted = false;
  return {
    ring,
    platform,
    start: async () => {
      admitted = false;
      const self = await ring.start((signing) => new PaoPlatform({ ...pao, signing }).agentSelf());
      admitted = true;
      return self;
    },
    admission: (): DiagCode | null => {
      const stopped = ring.stopReason;
      if (stopped !== null) return stopped === "CLOSED" ? "UNKNOWN" : stopped;
      return admitted ? null : "NOT_ADMITTED";
    },
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
  return o.pao === "stub" ? stubContour(o.stub) : standContour(o.now, o.adpUntilPs11 === true);
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
  // у PaoStub обращается только агент: полный журнал и журнал агента совпадают
  const stubCalls = (): ContourCall[] =>
    paoStand.stub.calls.map((c) => ({
      target: "pao" as const,
      route: c.op ?? "(нет операции)",
      status: c.status,
      ...(c.nonce !== undefined && { nonce: c.nonce }),
      ...(c.idempotencyKey !== undefined && { idempotencyKey: c.idempotencyKey }),
      replayed: c.replayed,
    }));
  return {
    mode: "stub",
    agentCode: AGENT,
    keysDir: paoStand.dir,
    params,
    journal,
    platform: a.platform,
    start: a.start,
    admission: a.admission,
    paoStand,
    calls: stubCalls,
    agentCalls: stubCalls,
    violations: () => [...paoStand.stub.violations],
    issuedSecrets: () => [],
    async close() {
      try {
        a.ring.close();
      } finally {
        await paoStand.close(); // удаляет и папку ключей
      }
    },
  };
}

async function standContour(paoNow?: () => Date, adpUntilPs11 = false): Promise<Contour> {
  const fixture = AGENT_FIXTURES.find((f) => f.registered && f.class === "BUYER");
  if (!fixture) throw new Error("в AGENT_FIXTURES нет зарегистрированного агента BUYER");
  const params = loadParams();
  const journal = new MemoryJournal();
  const log: ContourCall[] = [];
  const secrets: string[] = [];
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
    const adp: Promise<unknown>[] = [];
    const s = stand;
    emulator = adpUntilPs11
      ? createMerchants(stand, {
          // до PS-11: решение заглушки — отказ продавцу; решение ADP — по копии сообщения, без влияния на ответ продавца
          decide: (msg) => {
            // op_ref — из сообщения эквайрера: процессинг (тест) шлёт по нему ответ эмитента и клиринг (ПИ-3, Р49 К5)
            const op_ref = (msg as { op_ref?: unknown }).op_ref;
            adp.push(s.app.inject({ method: "POST", url: "/adp/v1/decide", payload: msg }).then((res) => ({ op_ref, ...(res.json() as object) }) as unknown));
            return { approved: false, reason: "CONFIRMATION_REQUIRED" };
          },
        })
      : createMerchants(stand);
    record(stand.app, "pao", log);
    record(emulator.app, "merchants", log);
    captureCredentials(stand.app, secrets);
    // Допуск — заявлением оператора по фикстуре: только открытый ключ (инвариант 2).
    const { descriptor } = generateKey(dir);
    const decision = stand.admit(agentApplication(fixture, { alg: descriptor.alg, public_key: descriptor.public_key }), fixture.operator);
    if (!decision.admitted) throw new Error(`стенд не допустил агента фикстуры: ${JSON.stringify(decision)}`);
    const [baseUrl, merchantsUrl] = await Promise.all([stand.listen(), emulator.listen()]);
    const a = agent({ dir, baseUrl, agentCode: fixture.agent_code, params, journal, ...(paoNow && { paoNow }) });
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
      admission: a.admission,
      merchants,
      shopSigning: { sign: (req) => signRequest(req, signing.current()) },
      stand,
      calls: () => log.map((c) => ({ ...c })),
      agentCalls: () => log.filter((c) => c.source !== "test").map((c) => ({ ...c })),
      // агент не обращается к путям участников (ADP, ПИ-3): копию сообщения эквайрера и ПИ-3 шлёт только тестовая поддержка
      violations: () => log.filter((c) => c.source === "agent" && PARTICIPANT_ONLY.test(c.route)).map((c) => `агент обратился к пути участника: ${c.route}`),
      adpDecisions: () => Promise.all(adp),
      issuedSecrets: () => [...secrets],
      close: release,
    };
  } catch (e) {
    await release();
    throw e;
  }
}
