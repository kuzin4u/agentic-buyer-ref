// Адаптер ПАО к порту «платёжная платформа» (Р19). Единственное место ядра, где видны типы и клиент agentic-core/pao.
// Повторы клиента agentic-core отключены: клиент берёт retry из тела ответа при неизвестном коде (STATUS, ожидание CO-1).
// Повторяет адаптер — только по таблице ядра (RETRY_SAME_KEY), с прежним Idempotency-Key и новой подписью (Р21).
// AGENT_KEY_REVOKED (ROTATE_KEY): другой действующий ключ из порта подписи и один повтор тем же Idempotency-Key.
// NO_RESPONSE (Р48 п. 4): повтор тем же ключом без ожидания — только у методов с Idempotency-Key, кроме выдачи реквизита.
// SIGNATURE_INVALID (Р58 п. 3): сверка времени по Date ответа, один повтор новой подписью, затем остановка агента — здесь
// же для допуска и работы.
import {
  PAO_OPERATIONS,
  PAO_VERSION,
  PaoCallError,
  PaoClient,
  validatePao,
  type PaoCallArgs,
  type PaoOperationKey,
  type PaoOperations,
} from "@kuzin4u/agentic-core/pao";
import { PAO_RETRY_AFTER_MAX_SEC, type StandParams } from "../../../shared/config.js";
import { PlatformFailure, type AgentSelf, type FailureCode, type MandateRef, type PlatformEventType } from "../../../shared/domain.js";
import type { PaymentPlatform, PlatformCapabilities, ProtocolCheck, Mutation } from "../../ports/payment-platform.js";
import type { RequestSigning } from "../../ports/request-signing.js";
import { AGENT_STOP_CODES, ruleForFailure } from "../../declines/index.js";
import { toFailure } from "./errors.js";
import * as map from "./map.js";

const CONFIG = "GET /.well-known/pao-configuration";

/** Версия копии ПАО у агента (docs/core/protocol/SOURCE.md, Р20). */
export const PAO_COPY_VERSION = "1.4.0";

/** Нижняя граница версии ПАО Платформы (Р33 п. 10): ниже — в мандатах нет порядка отзыва (A7 п. 2.2). Свойство
 *  контракта, а не стендовый параметр. */
export const PAO_MIN_PLATFORM_VERSION = "1.4.0";

/** Описание PLATFORM_PROTOCOL_UNSUPPORTED для оператора (Р33 п. 10); version — только значение вида 1.x.y или null. */
export function protocolUnsupportedText(version: string | null): string {
  const v = version === null ? "версия не определена; ответ мандата без порядка отзыва" : `Платформа работает по ПАО ${version}`;
  return `${v}, агенту нужна не ниже ${PAO_MIN_PLATFORM_VERSION}: в мандатах нет порядка отзыва (A7 п. 2.2). Обновите Платформу или подключите совместимую`;
}

const SEMVER_1 = /^1\.(\d{1,4})\.(\d{1,6})$/;

/** Наибольшее значение вида 1.x.y в Configuration.versions; прочие значения (например, `v1` — версия пути) не учитываются. */
export function highestPaoVersion(versions: readonly string[]): string | null {
  let best: [number, number] | null = null;
  for (const v of versions) {
    const m = typeof v === "string" ? SEMVER_1.exec(v) : null;
    if (m === null) continue;
    const cur: [number, number] = [Number(m[1]), Number(m[2])];
    if (best === null || cur[0] > best[0] || (cur[0] === best[0] && cur[1] > best[1])) best = cur;
  }
  return best === null ? null : `1.${best[0]}.${best[1]}`;
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function belowMin(version: string): boolean {
  const [, a = 0, b = 0] = version.split(".").map(Number);
  const [, x = 0, y = 0] = PAO_MIN_PLATFORM_VERSION.split(".").map(Number);
  return a < x || (a === x && b < y);
}

/** Валюты Платформы ПС по ПАО 1.4.0 — допустимое множество, не источник валюты (Р29 п. 2). */
export const PAO_CURRENCIES = ["RUB"] as const;

export function assertPaoVersion(actual: string = PAO_VERSION): void {
  if (actual !== PAO_COPY_VERSION) {
    throw new Error(`ПАО в agentic-core ${actual}, копия у агента ${PAO_COPY_VERSION}: переход — через /decision (Р20)`);
  }
}

/** Часть журнала агента, которую видит адаптер: только события версии ПАО Платформы (Р33 п. 10; Journal подходит). */
export interface ProtocolJournal {
  record(
    entry:
      | { at: string; kind: "platform.version_unknown"; reason: "PLATFORM_VERSION_UNKNOWN"; detail: "NO_VERSION" | "BAD_RESPONSE" | "NO_RESPONSE" }
      | { at: string; kind: "platform.protocol_unsupported"; reason: "PLATFORM_PROTOCOL_UNSUPPORTED"; detail: "CONFIGURATION" | "MANDATE" }
      | { at: string; kind: "signature.rejected"; kid: string; reason: "SIGNATURE_INVALID"; detail: string }
      | PaoCallEntry,
  ): void;
}

/** Что видно об одной попытке, кроме тела: Retry-After, HTTP-статус, x-timestamp запроса и Date ответа (Р58 п. 3). */
type Last = { retryAfter?: number; status?: number; timestamp?: string; date?: string | null };

/** HTTP-date только в форме IMF-fixdate (RFC 9110 §5.6.7): Date.parse принимает и мусор (данные — это данные). */
const IMF_FIXDATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** Расхождение x-timestamp запроса и Date ответа в секундах (свои часы впереди — плюс); не разобрать — undefined. */
function skewSec(last: Last): number | undefined {
  const date = last.date ?? "";
  if (!IMF_FIXDATE.test(date) || last.timestamp === undefined) return undefined;
  const d = Date.parse(date);
  const t = Date.parse(last.timestamp);
  return Number.isNaN(d) || Number.isNaN(t) ? undefined : Math.round((t - d) / 1000);
}

/** Попытка обращения к ПАО (Т15, Р37 п. 3): ключ операции — шаблон пути без подстановок; mandate — по маске
 *  идентификатора; detail — HTTP-статус ответа (нет ответа — без detail). Тел, заголовков, Idempotency-Key и x-nonce нет. */
type PaoCallEntry = {
  at: string;
  kind: "pao.call";
  method: PaoOperationKey;
  attempt: number;
  result: "ok" | "refused" | "unknown";
  mandate?: string;
  reason?: FailureCode;
  detail?: string;
};

/** mandate_id обращения: из пути операции над мандатом, из запроса или тела (mandate_id), у POST мандата — из ответа. */
function mandateOf(op: PaoOperationKey, args: unknown, r?: unknown): string | undefined {
  const field = (o: unknown, k: string): unknown => (typeof o === "object" && o !== null ? (o as Record<string, unknown>)[k] : undefined);
  const a = args as { path?: unknown; query?: unknown; body?: unknown };
  const v =
    (op.includes("/mandates/{id}") ? field(a.path, "id") : undefined) ??
    field(a.query, "mandate_id") ??
    field(a.body, "mandate_id") ??
    (op === "POST /pao/v1/mandates" ? field(r, "id") : undefined);
  return map.safeId(v) ?? undefined;
}

/** Операции, ответ которых — мандат или выписка с цепочкой мандатов (Р33 п. 10, шаг 2). */
const MANDATE_OPS: ReadonlySet<PaoOperationKey> = new Set<PaoOperationKey>([
  "POST /pao/v1/mandates",
  "GET /pao/v1/mandates/{id}",
  "POST /pao/v1/mandates/{id}/relinquish",
]);

/** Объект с `id` мандата без непустого `revocation_order`; пустое тело, не объект — не мандат (тогда UNKNOWN). */
const noOrder = (m: unknown): boolean => {
  if (typeof m !== "object" || m === null) return false;
  const { id, revocation_order: ro } = m as { id?: unknown; revocation_order?: unknown };
  return typeof id === "string" && id !== "" && !(typeof ro === "string" && ro.trim() !== "");
};

/** В ответе есть мандат без порядка отзыва — признак Платформы старше 1.4.0, даже если ответ не по схеме 1.4.0
 *  (в 1.3.0 `agent_code` мандата был необязателен — ревью К2.3 № 2). */
function mandateWithoutOrder(op: PaoOperationKey, r: unknown): boolean {
  if (MANDATE_OPS.has(op)) return noOrder(r);
  if (op !== "GET /pao/v1/mandates/{id}/evidence") return false;
  const chain = typeof r === "object" && r !== null ? (r as { mandate_chain?: unknown }).mandate_chain : undefined;
  return Array.isArray(chain) && chain.some(noOrder);
}

export interface PaoPlatformOptions {
  baseUrl: string;
  agentCode: string;
  /** подпись из модуля signer через порт; ключ адаптеру не передаётся (инвариант 2) */
  signing: RequestSigning;
  params: StandParams;
  /** события версии ПАО Платформы (Р33 п. 10) и попытки обращений (pao.call, Р37 п. 3) — у каждого адаптера, в т. ч.
   *  допуска и сверки с реестром: без журнала обращения не собрать (ревью К2.1 № 2) */
  journal: ProtocolJournal;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  nonce?: () => string;
  /** монотонные часы в мс — длительность попыток выдачи реквизита для её общего срока (Р45 п. 2.4); по умолчанию
   *  performance.now */
  monotonic?: () => number;
}

/** Выдача реквизита (Р45 п. 2.4–2.5): свой тайм-аут и общий срок попыток вместе с ожиданием повторов. */
const CREDENTIALS: PaoOperationKey = "POST /pao/v1/credentials";

/** Методы, где ПАО требует Idempotency-Key (ПАО §1; YAML 1.4.0 — обязательный заголовок; SPEC §7а, Р48 п. 4а). */
export const KEYED_OPERATIONS: ReadonlySet<PaoOperationKey> = new Set<PaoOperationKey>([
  "POST /pao/v1/agent/keys",
  "POST /pao/v1/agent/keys/{kid}/revoke",
  "POST /pao/v1/mandates",
  "POST /pao/v1/mandates/{id}/relinquish",
  "POST /pao/v1/credentials",
  "POST /pao/v1/confirmations",
  "POST /pao/v1/disputes",
  "PUT /pao/v1/subscription",
]);

/** Нет ответа — повтор тем же ключом: метод с Idempotency-Key, кроме выдачи реквизита (Р45 п. 3, Р48 п. 4). */
const retriesNoResponse = (op: PaoOperationKey): boolean => KEYED_OPERATIONS.has(op) && op !== CREDENTIALS;

/** Исход обращения не подтверждён (а не отказ Платформы) — в журнале попытка unknown. */
const UNCONFIRMED: ReadonlySet<FailureCode> = new Set<FailureCode>(["UNKNOWN", "NO_RESPONSE", "BAD_RESPONSE"]);

/** Retry-After в секундах; по копии ПАО — integer ≥ 0. Дату и мусор не принимаем: повтора не будет. */
function retryAfterSec(v: string | null): number | undefined {
  return v !== null && /^\d{1,6}$/.test(v.trim()) ? Number(v.trim()) : undefined;
}

/** Ключ читается у вызывающего один раз: проверенный и отправленный — одно значение (инвариант 9; ревью К1а). */
function keyOf(m: Mutation): string {
  const key = m.idempotencyKey;
  if (typeof key !== "string" || key.trim() === "") {
    throw new PlatformFailure("AGENT_REQUEST_DEFECT", "never", null, 0, null, "пустой Idempotency-Key, обращение не отправлено");
  }
  return key;
}

export class PaoPlatform implements PaymentPlatform {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly cur: map.Currencies = new Set(PAO_CURRENCIES);
  /** версия ПАО Платформы подтверждена — конфигурацией или первым ответом с мандатом; до перезапуска (Р33 п. 10) */
  private protocolConfirmed = false;
  /** Платформа признана несовместимой — флаг подтверждения больше не ставится (ревью К2.3 № 5) */
  private protocolUnsupported = false;

  constructor(private readonly o: PaoPlatformOptions) {
    assertPaoVersion();
    this.fetchImpl = o.fetch ?? globalThis.fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  capabilities(): PlatformCapabilities {
    return {
      platform: "pao",
      protocolVersion: PAO_COPY_VERSION,
      currencies: [...PAO_CURRENCIES],
      verifiableMandate: true,
      disputeResolution: true,
      humanConfirmation: true,
      // События и ответы Платформы не подписаны до ПАО 1.5.0 (РП39 п. 6): событие — сигнал, статус — по GET (Р34).
      signedEvents: false,
      guaranteeContour: true,
      conditionalSettlement: false,
    };
  }

  /**
   * Р33 п. 10, шаг 1: GET /.well-known/pao-configuration без подписи, один раз, без повторов. Наибольшее 1.x.y ниже
   * PAO_MIN_PLATFORM_VERSION — остановка агента и отказ PLATFORM_PROTOCOL_UNSUPPORTED; не ниже — версия подтверждена;
   * значений 1.x.y нет, `versions` не массив строк, ответ не объект или отказ — версия не определена, проверка по первому
   * мандату (шаг 2).
   */
  async checkProtocol(): Promise<ProtocolCheck> {
    let versions: string[] | undefined;
    const last: { retryAfter?: number; status?: number } = {};
    try {
      // Клиент без подписанта (ядро v0.9.0, Р37 п. 1): по типам он допускает только операции без подписи.
      const r: unknown = await this.client(last).call(CONFIG, {});
      // По схеме — только `versions` (string[]); прочие поля конфигурации агенту не нужны и игнорируются (ПАО §7):
      // алгоритм или ключ Платформы вне перечня не прячет явную версию ниже 1.4.0 (ревью К2.3 № 9).
      // Ответ не по форме — попытка unknown, как в call() (ревью К2.2 № 2).
      const v = typeof r === "object" && r !== null && !Array.isArray(r) ? (r as { versions?: unknown }).versions : null;
      if (v === null || (v !== undefined && !isStringArray(v))) {
        this.logCall(CONFIG, 1, "unknown", last.status ?? 200, "BAD_RESPONSE");
        return this.unknownVersion("BAD_RESPONSE");
      }
      this.logCall(CONFIG, 1, "ok", last.status ?? 200);
      versions = v;
    } catch (e) {
      // Тело и сообщение исключения не переносятся (инвариант 1). Наружу — всё, что не ответ и не разбор: дефект агента
      // (например, вызов подписи) не маскируется под «адрес не отвечает» (ревью К2.3 № 4).
      // попытка — только запрос, ушедший в сеть: PAO_CLIENT_SIGNER_MISSING в pao.call не пишется (ревью К2.2 № 1)
      if (e instanceof SyntaxError || (e instanceof PaoCallError && e.clientCode !== "PAO_CLIENT_SIGNER_MISSING")) {
        // битый JSON 2xx — тот же BAD_RESPONSE, что в platform.version_unknown (ревью reviewer К2 № 2)
        const f = e instanceof SyntaxError ? new PlatformFailure("BAD_RESPONSE", "never", null, last.status ?? 200, null) : toFailure(e);
        this.logCall(CONFIG, 1, UNCONFIRMED.has(f.code) ? "unknown" : "refused", f.httpStatus || (last.status ?? 0), f.code);
      }
      if (e instanceof SyntaxError) return this.unknownVersion("BAD_RESPONSE");
      // Отказ самого клиента — не «адрес не отвечает»: 3xx — ответ указывает на другой адрес, агент не стартует (Р37 п. 2);
      // PAO_CLIENT_SIGNER_MISSING — дефект агента, не маскируется (ревью К0 № 1).
      if (e instanceof PaoCallError && e.clientCode !== undefined) throw toFailure(e);
      if (e instanceof PaoCallError) return this.unknownVersion("NO_RESPONSE");
      throw e;
    }
    const version = versions === undefined ? null : highestPaoVersion(versions);
    if (version === null) return this.unknownVersion("NO_VERSION");
    if (belowMin(version)) {
      const failure = this.unsupported("CONFIGURATION", version, 200, null);
      this.o.signing.stop("PLATFORM_PROTOCOL_UNSUPPORTED", version);
      throw failure;
    }
    this.protocolConfirmed = true;
    return { status: "confirmed", version };
  }

  private unknownVersion(detail: "NO_VERSION" | "BAD_RESPONSE" | "NO_RESPONSE"): ProtocolCheck {
    this.o.journal.record({ at: this.at(), kind: "platform.version_unknown", reason: "PLATFORM_VERSION_UNKNOWN", detail });
    return { status: "unknown", detail };
  }

  /** Несовместимая Платформа: событие в журнал (одна точка для обоих шагов и всех путей с мандатом — ревью К2.3 № 1).
   *  Остановку агента делает вызывающий: шаг 1 — checkProtocol, шаг 2 — call по AGENT_STOP_CODES. */
  private unsupported(step: "CONFIGURATION" | "MANDATE", version: string | null, httpStatus: number, key: string | null): PlatformFailure {
    this.protocolUnsupported = true;
    this.o.journal.record({ at: this.at(), kind: "platform.protocol_unsupported", reason: "PLATFORM_PROTOCOL_UNSUPPORTED", detail: step });
    return new PlatformFailure("PLATFORM_PROTOCOL_UNSUPPORTED", "never", null, httpStatus, key, protocolUnsupportedText(version));
  }

  /** Запись pao.call (Р37 п. 3): на каждую попытку, attempt > 1 — попытка повтора (Т15). */
  private logCall(method: PaoOperationKey, attempt: number, result: PaoCallEntry["result"], httpStatus: number, reason?: FailureCode, mandate?: string): void {
    this.o.journal.record({
      at: this.at(),
      kind: "pao.call",
      method,
      attempt,
      result,
      ...(mandate !== undefined && { mandate }),
      ...(reason !== undefined && { reason }),
      ...(httpStatus > 0 && { detail: String(httpStatus) }),
    });
  }

  private at(): string {
    return (this.o.now ?? (() => new Date()))().toISOString();
  }

  /** Одно обращение без повторов клиента; тайм-аут — pao_request_timeout_ms. Retry-After и HTTP-статус ответа — в last.
   *  Без подписанта — только операции без подписи (конфигурация); подписанная — PAO_CLIENT_SIGNER_MISSING до запроса.
   *  Свой fetch получает init целиком, вместе с redirect: "manual" клиента (передача #34 п. 4). */
  private client(last: Last, signer?: ReturnType<RequestSigning["current"]>, timeoutMs = this.o.params.pao_request_timeout_ms): PaoClient {
    const f = this.fetchImpl;
    return new PaoClient({
      baseUrl: this.o.baseUrl,
      agentCode: this.o.agentCode,
      ...(signer && { signer }),
      maxAttempts: 1,
      fetch: async (url, init) => {
        const ts = (init?.headers as Record<string, string> | undefined)?.["x-timestamp"];
        if (ts !== undefined) last.timestamp = ts;
        const res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        last.status = res.status;
        last.retryAfter = retryAfterSec(res.headers.get("retry-after"));
        last.date = res.headers.get("date");
        return res;
      },
      ...(this.o.now && { now: this.o.now }),
      ...(this.o.nonce && { nonce: this.o.nonce }),
      idempotencyKey: () => {
        throw new Error("Idempotency-Key задаёт ядро (инвариант 9)");
      },
    });
  }

  private async call<K extends PaoOperationKey, R>(
    op: K,
    args: PaoCallArgs<K>,
    to: (r: PaoOperations[K]["response"]) => R,
  ): Promise<R> {
    const key = args.idempotencyKey ?? null;
    let waitedSec = 0;
    let rotations = 0;
    let signatureRetries = 0;
    // выдача реквизита — свой тайм-аут (выше предела обработчика Платформы) и общий срок: попытки и ожидание повторов
    // вместе — не больше registry_cache_ttl_sec (Р45 п. 2.4, В2а; инвариант 4)
    const credentials = op === CREDENTIALS;
    const timeoutMs = credentials ? this.o.params.pao_credentials_timeout_ms : this.o.params.pao_request_timeout_ms;
    const clock = this.o.monotonic ?? (() => performance.now());
    let spentMs = 0;
    // ещё одна попытка выдачи (после ожидания `waitMs`) помещается в срок; NaN часов — не помещается (fail-closed)
    const fits = (waitMs: number) => !credentials || spentMs + waitMs + timeoutMs <= this.o.params.registry_cache_ttl_sec * 1000;
    // попытки обращения для журнала: повторы тем же ключом и переход на другой ключ (Т15)
    let tries = 0;
    for (let attempt = 1; ; ) {
      const last: Last = {};
      const signer = this.o.signing.current(); // остановлен — SignerStopped, обращения нет
      tries++;
      let failure: PlatformFailure;
      const began = clock();
      try {
        const r = await this.client(last, signer, timeoutMs).call(op, args);
        // «Открыто» № 4 (ревью AG-02): ответ 2xx — по схеме ПАО до перевода; значение вне перечня (`status`, `outcome`,
        // `decision`, `kind`…) или пропущенное обязательное поле — UNKNOWN. Неизвестные поля допускаются (validatePao,
        // ПАО §7). Текст нарушений (в нём значения из тела) в отказ не переносится (инвариант 1). Ключ со статусом вне
        // перечня делает UNKNOWN весь ответ GET /agent — осознанный fail-closed (ревью 3b № 10): по ПАО §7 новое
        // значение перечня — не совместимое изменение версии 1.4.0, реестр с ним не подтверждает и остальное.
        // Ленту (GET /pao/v1/events) так проверять нельзя: неизвестный тип события ПАО §7 велит пропускать, а не
        // отвергать весь ответ — её разбирает map.feedFromPao по элементам (Р34 п. 6).
        const schema = op === "GET /pao/v1/events" ? undefined : PAO_OPERATIONS[op].response;
        if (schema !== undefined && validatePao(schema, r).length > 0) {
          if (!this.protocolConfirmed && mandateWithoutOrder(op, r)) throw this.unsupported("MANDATE", null, last.status ?? 200, key);
          throw new PlatformFailure("BAD_RESPONSE", "never", null, last.status ?? 200, key, "ответ ПАО не по схеме");
        }
        const out = to(r);
        this.logCall(op, tries, "ok", last.status ?? 200, undefined, mandateOf(op, args, r));
        return out;
      } catch (e) {
        failure = toFailure(e, key);
        // Заголовки пришли, но ответ не разобран (не JSON, пустое тело, не по схеме, обрыв или тайм-аут при чтении тела) —
        // BAD_RESPONSE с HTTP-статусом ответа: «ответ не подтверждён» (Р27, fail-closed) отличается от тайм-аута и обрыва до
        // заголовков (NO_RESPONSE, httpStatus 0). При 2xx изменяющего запроса действие, вероятно, выполнено — повтора нет
        // (Р48 п. 3; сверка по GET — ч. 2).
        if ((failure.code === "UNKNOWN" || failure.code === "BAD_RESPONSE") && failure.httpStatus === 0 && last.status !== undefined) {
          failure = new PlatformFailure("BAD_RESPONSE", "never", null, last.status, key, "ответ ПАО не по схеме");
        }
        // Нет ответа у метода без повтора (GET, выдача реквизита) — класс never: вызывающий не повторяет (Р48 п. 4а).
        if (failure.code === "NO_RESPONSE" && !retriesNoResponse(op)) {
          failure = new PlatformFailure("NO_RESPONSE", "never", null, 0, key, "нет ответа; метод без повтора");
        }
      }
      spentMs += clock() - began;
      // попытка — только запрос, ушедший в сеть (ревью К2.2 № 1): отказ клиента до сети (PAO_CLIENT_SIGNER_MISSING) — не попытка;
      // SignerStopped и пустой Idempotency-Key — тоже до сети, сюда не доходят
      if (failure.code !== "PAO_CLIENT_SIGNER_MISSING") {
        this.logCall(op, tries, UNCONFIRMED.has(failure.code) ? "unknown" : "refused", failure.httpStatus, failure.code, mandateOf(op, args));
      }
      const rule = ruleForFailure(failure.code);
      // Отказ в допуске — остановка агента целиком (SPEC §7а, П03).
      if (AGENT_STOP_CODES.has(failure.code)) {
        this.o.signing.stop(failure.code);
        throw failure;
      }
      // Отозванный ключ: другой действующий (нет — SignerStopped); повтор не больше maxRetries за обращение.
      if (rule.action === "ROTATE_KEY") {
        this.o.signing.keyRevoked(signer.kid, failure);
        if (rotations >= (rule.maxRetries ?? 0)) throw failure;
        // повтор выдачи другим ключом — тоже в пределах срока (Р45 п. 2.4; ревью reviewer К3 № 1)
        if (!fits(0)) throw failure;
        rotations++;
        continue;
      }
      // Подпись не принята (SPEC §7а, Р58 п. 3): часы вне signature_skew_sec по Date ответа — повтор не поможет, остановка
      // сразу; иначе один повтор за обращение новой подписью и тем же Idempotency-Key, затем остановка агента. Остановка — в
      // finally: сбой журнала её не отменяет (Р53 ревью К2.1 № 8).
      if (failure.code === "SIGNATURE_INVALID") {
        const skew = skewSec(last);
        const clock = skew !== undefined && Math.abs(skew) > this.o.params.signature_skew_sec;
        const halt = clock || signatureRetries >= (rule.maxRetries ?? 0) || !fits(0);
        try {
          const detail = skew === undefined ? "NO_DATE" : `DATE:${skew >= 0 ? "+" : ""}${skew}`;
          this.o.journal.record({ at: this.at(), kind: "signature.rejected", kid: signer.kid, reason: "SIGNATURE_INVALID", detail });
        } finally {
          if (halt) this.o.signing.stop("SIGNATURE_INVALID", clock ? "CLOCK_SKEW" : undefined);
        }
        if (halt) throw failure;
        signatureRetries++;
        continue;
      }
      // Повтор — только по таблице ядра, в пределах попыток и потолка ожидания (инвариант 4, Р20).
      if (rule.action !== "RETRY_SAME_KEY" || attempt >= this.o.params.pao_max_attempts) throw failure;
      // Нет ответа (Р48 п. 4): тем же ключом и без ожидания — Retry-After нет; GET и выдача реквизита — без повтора.
      // Число попыток и тайм-аут каждой укладываются в registry_cache_ttl_sec и idempotency_ttl_sec (проверка конфигурации).
      if (failure.code === "NO_RESPONSE") {
        if (!retriesNoResponse(op)) throw failure;
        attempt++;
        continue;
      }
      attempt++;
      // Без Retry-After повтор не раньше срока невозможен — не повторяем (ПАО §6, инвариант 9).
      const waitSec = last.retryAfter;
      if (waitSec === undefined || waitedSec + waitSec > PAO_RETRY_AFTER_MAX_SEC) throw failure;
      // повтор выдачи — только если до конца срока остаётся не меньше ожидания и ещё одной попытки целиком (В2а)
      if (!fits(waitSec * 1000)) throw failure;
      spentMs += waitSec * 1000;
      waitedSec += waitSec;
      await this.sleep(waitSec * 1000);
    }
  }

  /** Агент не ACTIVE по ответу платформы (EXCLUDED — 200 по РП23 п. 6.3) или класс не BUYER (Р27; сначала статус) —
   *  остановка подписи, кто бы ни спросил. */
  async agentSelf() {
    let self: AgentSelf;
    try {
      self = await this.call("GET /pao/v1/agent", {}, map.agentSelfFromPao);
    } catch (e) {
      // Р27: ответ 2xx получен, но не по схеме — состояние агента в реестре не подтверждено: приостановка подписи
      // до успешной повторной сверки (не бессрочно: ответы Платформы не подписаны до ПАО 1.5.0, Р34 п. 11).
      if (e instanceof PlatformFailure && e.code === "BAD_RESPONSE" && e.httpStatus >= 200 && e.httpStatus < 300) {
        this.o.signing.suspend("AGENT_SELF_UNKNOWN");
      }
      throw e;
    }
    if (self.status !== "ACTIVE") this.o.signing.stop(`AGENT_${self.status}`);
    else if (self.agentClass !== "BUYER") this.o.signing.stop("AGENT_CLASS_MISMATCH", self.agentClass);
    return self;
  }

  async registerKey(draft: Parameters<PaymentPlatform["registerKey"]>[0], m: Mutation) {
    return this.call("POST /pao/v1/agent/keys", { body: map.keyDraftToPao(draft), idempotencyKey: keyOf(m) }, map.keyFromPao);
  }

  async requestMandate(draft: Parameters<PaymentPlatform["requestMandate"]>[0], m: Mutation) {
    return this.call("POST /pao/v1/mandates", { body: map.mandateDraftToPao(draft, this.cur), idempotencyKey: keyOf(m) }, this.mandate);
  }

  private readonly mandate = (r: Parameters<typeof map.mandateFromPao>[0]) => this.confirming(() => map.mandateFromPao(r, this.cur, this.o.agentCode));

  /** Р33 п. 10, шаг 2: каждый разбор ответа с мандатом (POST, GET, relinquish, evidence). Версия не подтверждена и порядка
   *  отзыва нет — PLATFORM_PROTOCOL_UNSUPPORTED (call останавливает агента по AGENT_STOP_CODES); разобран — версия
   *  подтверждена, если в ответе был хоть один мандат (выписка с пустой цепочкой версию не подтверждает). После
   *  подтверждения — MANDATE_REVOCATION_ORDER_MISSING как есть (Р33 п. 4). */
  private confirming<R>(parse: () => R, mandates: (r: R) => number = () => 1): R {
    let r: R;
    try {
      r = parse();
    } catch (e) {
      if (!this.protocolConfirmed && e instanceof PlatformFailure && e.code === "MANDATE_REVOCATION_ORDER_MISSING") {
        throw this.unsupported("MANDATE", null, e.httpStatus, e.idempotencyKey);
      }
      throw e;
    }
    if (mandates(r) > 0 && !this.protocolUnsupported) this.protocolConfirmed = true;
    return r;
  }

  getMandate(id: string) {
    return this.call("GET /pao/v1/mandates/{id}", { path: { id } }, this.mandate);
  }

  async verifyMandate(ref: MandateRef) {
    map.checkRef(ref, this.cur);
    return this.call("GET /pao/v1/mandates/{id}/verify", { path: { id: ref.id } }, (r) => map.mandateCheckFromPao(r, ref));
  }

  async relinquishMandate(id: string, m: Mutation) {
    return this.call("POST /pao/v1/mandates/{id}/relinquish", { path: { id }, idempotencyKey: keyOf(m) }, this.mandate);
  }

  mandateEvidence(id: string) {
    return this.call("GET /pao/v1/mandates/{id}/evidence", { path: { id } }, (r) =>
      this.confirming(
        () => map.evidenceFromPao(r, id, this.cur, this.o.agentCode),
        (e) => e.mandateChain.length,
      ),
    );
  }

  async issueCredential(draft: Parameters<PaymentPlatform["issueCredential"]>[0], m: Mutation) {
    return this.call("POST /pao/v1/credentials", { body: map.credentialDraftToPao(draft, this.cur), idempotencyKey: keyOf(m) }, (r) =>
      map.credentialFromPao(r, draft.mandate.id, this.o.agentCode),
    );
  }

  /** Выдача с запечатанным пакетом (Р45 п. 3): тот же POST, `payload` — только в пакете. */
  async issuePaymentPackage(draft: Parameters<PaymentPlatform["issuePaymentPackage"]>[0], m: Mutation) {
    return this.call("POST /pao/v1/credentials", { body: map.credentialDraftToPao(draft, this.cur), idempotencyKey: keyOf(m) }, (r) => ({
      credential: map.credentialFromPao(r, draft.mandate.id, this.o.agentCode),
      sealed: map.packageFromPao(r, draft),
    }));
  }

  async requestConfirmation(draft: Parameters<PaymentPlatform["requestConfirmation"]>[0], m: Mutation) {
    return this.call(
      "POST /pao/v1/confirmations",
      { body: map.confirmationDraftToPao(draft, this.cur), idempotencyKey: keyOf(m) },
      map.confirmationFromPao,
    );
  }

  getConfirmation(id: string) {
    return this.call("GET /pao/v1/confirmations/{id}", { path: { id } }, map.confirmationFromPao);
  }

  async listOperations(ref: MandateRef) {
    map.checkRef(ref, this.cur);
    return this.call("GET /pao/v1/operations", { query: { mandate_id: ref.id } }, (r) => need(r).map((o) => map.operationFromPao(o, ref, "list", this.o.agentCode)));
  }

  async getOperation(opRef: string, ref: MandateRef) {
    map.checkRef(ref, this.cur);
    return this.call("GET /pao/v1/operations/{op_ref}", { path: { op_ref: opRef } }, (r) => map.operationFromPao(r, ref, "single", this.o.agentCode));
  }

  /** Операция по `op_ref` из события до привязки к покупке (Р49 п. 3): мандата вызывающий не знает. */
  readOperation(opRef: string) {
    return this.call("GET /pao/v1/operations/{op_ref}", { path: { op_ref: opRef } }, (r) => map.operationRecordFromPao(r, this.o.agentCode));
  }

  /** Операции по мандату до привязки к покупке (Р51 п. 5): восстановление `op_ref` после потерянного события. 404, 400 и
   *  403 у пути объявятся в YAML 1.5.0 (#37) — разбираются общей моделью ошибок ПАО; 403 AGENT_SUSPENDED — остановка
   *  подписи в `call`. Элемент не по форме — весь ответ BAD_RESPONSE (fail-closed). */
  readOperations(mandateId: string) {
    return this.call("GET /pao/v1/operations", { query: { mandate_id: mandateId } }, (r) => need(r).map((o) => map.operationRecordFromPao(o, this.o.agentCode)));
  }

  async openDispute(draft: Parameters<PaymentPlatform["openDispute"]>[0], m: Mutation) {
    return this.call("POST /pao/v1/disputes", { body: map.disputeDraftToPao(draft), idempotencyKey: keyOf(m) }, map.disputeFromPao);
  }

  getDispute(id: string) {
    return this.call("GET /pao/v1/disputes/{id}", { path: { id } }, map.disputeFromPao);
  }

  /** Лента (Р34 п. 1): `after` — курсор агента; 400 REQUEST_INVALID на курсор — отказ как есть, решает модуль events. */
  listEvents(after: string | null) {
    return this.call("GET /pao/v1/events", after === null ? {} : { query: { after } }, map.feedFromPao);
  }

  /** Подписка (Р34 п. 8, РП40 п. 1): ответ — та же подписка; другой адрес или состав в ответе — BAD_RESPONSE. */
  async subscribe(url: string, types: readonly PlatformEventType[], m: Mutation) {
    const events = [...types];
    // ответ — не та подписка: BAD_RESPONSE; httpStatus 0 — call подставит статус ответа 2xx и ключ (как «не по схеме»)
    await this.call("PUT /pao/v1/subscription", { body: { url, events }, idempotencyKey: keyOf(m) }, (r) => {
      const same = r.events.length === events.length && events.every((t) => r.events.includes(t));
      if (r.url !== url || !same) throw new PlatformFailure("BAD_RESPONSE", "never", null, 0, null, "ответ ПАО: подписка не та");
    });
  }
}

function need<T>(r: T[] | undefined): T[] {
  if (!Array.isArray(r)) throw new PlatformFailure("BAD_RESPONSE", "never", null, 200, null, "ответ ПАО неполон: ожидался список");
  return r;
}
