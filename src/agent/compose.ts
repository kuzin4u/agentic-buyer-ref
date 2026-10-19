// Место сборки ядра (composition root) — единственное исключение из правила Р19: только здесь виден адаптер pao.
// Ядро (pipeline, policy, mandates, declines) получает платформу через порт и не знает, какая она.
// Подписант создаётся здесь из модуля signer; адаптер получает только порт подписи (инвариант 2).
import { createHash, randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import { ConfigError, loadParams, type StandParams } from "../shared/config.js";
import { PLATFORM_EVENT_TYPES, PlatformFailure, type AgentSelf } from "../shared/domain.js";
import type { PaymentPlatform, PlatformCapabilities } from "./ports/payment-platform.js";
import { PAO_DIAG, PaoPlatform, assertPaoVersion, type PaoPlatformOptions } from "./adapters/pao/index.js";
import { CATALOG_DIAG } from "./catalog/index.js";
import { MemoryJournal, type Journal, type JournalEntry } from "./journal/index.js";
import { MandateClient } from "./mandates/index.js";
import { EventFeed, EventsStopped, FileCursorStore, acceptPush, type PushReply } from "./events/index.js";
import { KeyRing, SignerKeyRejected, SignerStopped } from "./signer/index.js";
import {
  AGENT_DIAG,
  AGENT_STOP_CODES,
  AgentNotReady,
  failedCheck,
  mergeDiag,
  selfCheckReport,
  stopsAgent,
  type CheckResult,
  type DiagRegistry,
  type SelfCheckName,
  type SelfCheckReport,
} from "./declines/index.js";
import type { DiagCode } from "../shared/diag-codes.js";

/** Полный реестр кодов агента (Р36 п. 1): ПАО и каталог — записи ядра, свои — AGENT_DIAG; код в двух — ошибка сборки. */
export const DIAG: DiagRegistry = mergeDiag(PAO_DIAG, CATALOG_DIAG, AGENT_DIAG);

export interface AgentCore {
  params: StandParams;
  platform: PaymentPlatform;
  capabilities: PlatformCapabilities;
  /** клиент мандатов на порту мандатов той же платформы */
  mandates: MandateClient;
  journal: Journal;
  /** Полный реестр кодов (Р36): кто ошибся, действие, тексты для человека и оператора. */
  diag: DiagRegistry;
  /** Лента событий Платформы (Р34): курсор — в каталоге состояния; опрос и ожидание — `signal()`, `items()`. */
  events: EventFeed;
  /** Приём push (Р34 п. 2): только форма и сигнал ленте; HTTP-сервер — у оболочки. Заголовки — в нижнем регистре. */
  acceptPush(body: string, headers: Readonly<Record<string, string | string[] | undefined>>): PushReply;
  /** Самопроверка при старте (Р36 п. 6): отчёт последнего start() (и успешного, и с отказом); до start() — null. */
  selfCheck(): SelfCheckReport | null;
  /** Стадия 0 с самопроверкой (Р36 п. 6, дополнение 2). Порядок: ключи из хранилища и выбор ключа допуска, курсор ленты
   *  (оба — до обращений к Платформе), версия ПАО Платформы (Р33 п. 10: ниже 1.4.0 — агент остановлен, допуска нет; не
   *  определена — предупреждение platform.version_unknown и допуск), затем сверка с реестром (GET /pao/v1/agent); до
   *  успеха никакие обращения, кроме допуска, не подписываются. Отчёт — в журнал (agent.selfcheck) и в selfCheck().
   *  Отказ — AgentNotReady с отчётом, исходная ошибка (SignerStopped, PlatformFailure, EventsStopped, SignerKeyRejected) — в
   *  cause; действие кода в реестре stop (нет ключа, EXCLUDED / SUSPENDED, класс не BUYER, AGENT_UNKNOWN, UNKNOWN —
   *  ответ не по схеме или тайм-аут) — подписант остановлен; иначе (503, KEY_REJECTED) агент не допущен и start() можно
   *  повторить. После допуска — подписка на push, если задан `pushUrl` (Р34 п. 8): адрес отвергнут (400) —
   *  events.subscription_rejected; прочий отказ Платформы после повторов адаптера (503, UNKNOWN) —
   *  events.subscription_failed; в обоих случаях старт успешен, работа по ленте, повтор подписки — при следующем старте
   *  (дополнение Р34 п. 1) — events.subscription: warn. Коды остановки агента и остановленная подпись на подписке —
   *  events.subscription: fail, AgentNotReady (ревью К2.2 № 4, дополнение 2 п. 5). */
  start(): Promise<AgentSelf>;
  /** Повторная сверка с реестром (Р27): снимает приостановку подписи при ACTIVE и BUYER; не ACTIVE или не BUYER — остановка;
   *  ответ снова не по схеме или сбой — приостановка остаётся. Расписание сверок — за вызывающим (AG-12). */
  recheck(): Promise<AgentSelf>;
  /** плановая ротация ключа, если до valid_to (по данным платформы) осталось не больше key_overlap_days */
  maintainKeys(): Promise<void>;
  /** освободить каталог ключей (один процесс на каталог) */
  close(): void;
}

export interface AgentCoreOptions {
  /** путь к стендовым параметрам; по умолчанию config/params.stand.json */
  paramsPath?: string;
  /** каталог ключей подписи (keystore); в тестах — временный */
  keysDir: string;
  /** каталог состояния агента — курсор ленты событий (Р34 п. 4); не каталог ключей. Создаётся при первой записи. */
  stateDir: string;
  /** адрес приёма push (`https://`, хост из списка оператора Платформы); нет — только лента (Р34 п. 8) */
  pushUrl?: string;
  journal?: Journal;
  now?: () => Date;
  pao: Omit<PaoPlatformOptions, "params" | "signing">;
}

/** Один каталог внутри другого или они совпадают (по пути; символические ссылки — забота оператора, Р34 нюансы К2.3). */
function nested(a: string, b: string): boolean {
  const inside = (x: string, y: string) => {
    const r = relative(resolve(y), resolve(x));
    return r === "" || (!r.startsWith("..") && !r.startsWith("/"));
  };
  return inside(a, b) || inside(b, a);
}

const OK: CheckResult = { status: "ok" };

/** Код реестра по отказу старта; null — не отказ проверки (дефект), уходит наружу как есть. */
function startFailureCode(e: unknown): DiagCode | null {
  if (e instanceof SignerStopped) return e.reason === "CLOSED" ? null : e.reason;
  if (e instanceof PlatformFailure) return e.code;
  if (e instanceof EventsStopped) return "EVENTS_CURSOR_INVALID";
  if (e instanceof SignerKeyRejected) return "KEY_REJECTED";
  return null;
}

/** Отчёт — в журнал: по записи на проверку, только имя, итог и код (Р36 п. 6). */
function recordReport(journal: Journal, report: SelfCheckReport): void {
  for (const c of report.checks) {
    journal.record({ at: report.checked_at, kind: "agent.selfcheck", check: c.check, status: c.status, ...(c.code !== undefined && { reason: c.code }) });
  }
}

export function createAgentCore(o: AgentCoreOptions): AgentCore {
  const now = o.now ?? (() => new Date());
  const journal = o.journal ?? new MemoryJournal();
  // Самопроверка без сети при сборке (Р36 п. 6, дополнение 2 п. 1): без параметров агент не собрать — отказ сборки с отчётом.
  const notReady = (results: Partial<Record<SelfCheckName, CheckResult>>, cause: unknown): AgentNotReady => {
    const report = selfCheckReport(results, now());
    recordReport(journal, report);
    return new AgentNotReady(report, { cause });
  };
  let params: StandParams;
  try {
    params = loadParams(o.paramsPath);
  } catch (e) {
    if (e instanceof ConfigError) throw notReady({ "config.params": { status: "fail", code: "PARAMS_INVALID" } }, e);
    throw e;
  }
  try {
    assertPaoVersion();
  } catch (e) {
    throw notReady({ "config.params": OK, "core.pao": { status: "fail", code: "CORE_PAO_MISMATCH" } }, e);
  }
  if (nested(o.stateDir, o.keysDir)) throw new ConfigError("каталог состояния совпадает с каталогом ключей или вложен в него (или наоборот)");
  const ring = new KeyRing({ dir: o.keysDir, params, journal, ...(o.now && { now: o.now }) });
  // Рабочий адаптер получает порт, закрытый до допуска; запрос допуска идёт через отдельный адаптер с портом допуска.
  // События версии ПАО (Р33 п. 10) пишет адаптер; время записи — по часам ядра, как у прочих событий журнала.
  const protocolJournal = { record: (e: JournalEntry) => journal.record({ ...e, at: now().toISOString() }) };
  const platform = new PaoPlatform({ ...o.pao, params, signing: ring.port(), journal: protocolJournal });
  const at = (): string => now().toISOString();
  // Остановка по курсору — через порт подписи: агент целиком, запись agent.stopped — у связки ключей (Р34 п. 4).
  const signing = ring.port();
  const events = new EventFeed({
    port: platform,
    store: new FileCursorStore(o.stateDir, now),
    journal,
    stop: (reason, detail) => signing.stop(reason, detail),
    params,
    now,
  });
  // Подписка (Р34 п. 8, дополнение п. 2): Idempotency-Key — от (код агента, адрес, типы, идентификатор запуска).
  // Идентификатор запуска — случайный при старте и не хранится: повторы внутри запуска идут тем же ключом (адаптер,
  // инвариант 9), а новый запуск — новым ключом, поэтому A → B → A не вернёт сохранённый ответ первого PUT.
  const subscribe = async (url: string, run: string): Promise<CheckResult> => {
    const types = [...PLATFORM_EVENT_TYPES];
    const idempotencyKey = `sub-${createHash("sha256").update(`${o.pao.agentCode}\n${url}\n${types.join(",")}\n${run}`).digest("hex").slice(0, 32)}`;
    try {
      await platform.subscribe(url, types, { idempotencyKey });
      return OK;
    } catch (e) {
      // остановка агента (AGENT_SUSPENDED и др.) и дефекты — наружу; адрес и тело в журнал не идут
      if (!(e instanceof PlatformFailure) || AGENT_STOP_CODES.has(e.code)) throw e;
      const kind = e.code === "REQUEST_INVALID" ? "events.subscription_rejected" : "events.subscription_failed";
      journal.record({ at: at(), kind, reason: e.code });
      return { status: "warn", code: e.code };
    }
  };
  // Сверка с реестром одна на всех (Р27): событие agent.* и вызов recheck() снаружи ждут одну и ту же.
  let rechecking: Promise<AgentSelf> | null = null;
  const recheck = (): Promise<AgentSelf> =>
    (rechecking ??= ring.recheck((s) => new PaoPlatform({ ...o.pao, params, signing: s }).agentSelf()).finally(() => {
      rechecking = null;
    }));
  // agent.key_revoked / agent.suspended / agent.reinstated — сигнал: статус и ключи — по GET /pao/v1/agent (Р34 п. 5).
  // Идёт чужая сверка — её GET мог уйти до смены статуса: дождаться её и сверить заново (ревью К2.4 № 4).
  // Сверка не прошла (503, остановка) — слушатель падает, курсор на месте, событие прочитается снова (Р34 п. 3).
  let lastReport: SelfCheckReport | null = null;
  events.listen(async (item) => {
    if (item.kind !== "event" || !item.event.type.startsWith("agent.")) return;
    while (rechecking) await rechecking.catch(() => undefined);
    await recheck();
  });
  return {
    params,
    platform,
    capabilities: platform.capabilities(),
    mandates: new MandateClient({ port: platform, params, journal, ...(o.now && { now: o.now }) }),
    journal,
    diag: DIAG,
    events,
    acceptPush: (body, headers) => acceptPush({ wake: () => events.signal(), journal, now }, body, headers),
    selfCheck: () => lastReport,
    // Ключи загружаются до обращений к Платформе (сбой хранилища — без сети), затем курсор ленты и конфигурация, затем
    // GET /pao/v1/agent; курсор и конфигурация — один раз за start, повтор допуска (SIGNATURE_INVALID) их не повторяет.
    start: async () => {
      lastReport = null;
      const results: Partial<Record<SelfCheckName, CheckResult>> = { "config.params": OK, "core.pao": OK };
      // Отказ проверки: код — в отчёт; по действию кода в реестре stop — подписант остановлен (дополнение 2 п. 2; мог уже
      // остановиться сам — SIGNATURE_INVALID, SPEC §7а); отчёт — в журнал; наружу — AgentNotReady с исходной ошибкой.
      const fail = (check: SelfCheckName, code: DiagCode, cause: unknown): AgentNotReady => {
        results[check] = { status: "fail", code };
        if (stopsAgent(DIAG, code)) signing.stop(code);
        lastReport = selfCheckReport(results, now());
        recordReport(journal, lastReport);
        return new AgentNotReady(lastReport, { cause });
      };
      let connected = false;
      let self: AgentSelf;
      try {
        self = await ring.start(async (admission) => {
          if (!connected) {
            results["keys.store"] = OK;
            results["keys.active"] = OK;
            events.checkCursor();
            results["events.cursor"] = OK;
            // Р33 п. 10, шаг 1: до допуска и до любого обращения с мандатом. События версии пишет адаптер, остановку агента —
            // тоже он (порт подписи); отказ PLATFORM_PROTOCOL_UNSUPPORTED связка ключей пробрасывает как есть.
            const p = await platform.checkProtocol();
            results["platform.protocol"] = p.status === "confirmed" ? OK : { status: "warn", code: "PLATFORM_VERSION_UNKNOWN" };
            connected = true;
          }
          return new PaoPlatform({ ...o.pao, params, signing: admission }).agentSelf();
        });
      } catch (e) {
        const code = startFailureCode(e);
        if (code === null) throw e;
        const check = failedCheck(code);
        // выбор ключа идёт после загрузки хранилища: хранилище проверено (ревью К2.2 № 1)
        if (check === "keys.active") results["keys.store"] = OK;
        throw fail(check, code, e);
      }
      results["platform.admission"] = OK;
      // Подписка — часть старта (ревью К2.2 № 4): код остановки агента или остановленная подпись — отказ с отчётом, а не
      // ready: true с голой ошибкой; прочий отказ — предупреждение, старт успешен (дополнение Р34 п. 1).
      if (o.pushUrl !== undefined) {
        try {
          results["events.subscription"] = await subscribe(o.pushUrl, randomUUID());
        } catch (e) {
          const code = startFailureCode(e);
          if (code === null) throw e;
          throw fail("events.subscription", code, e);
        }
      }
      lastReport = selfCheckReport(results, now());
      recordReport(journal, lastReport);
      return self;
    },
    recheck,
    maintainKeys: () => ring.maintain(platform),
    close: () => ring.close(),
  };
}
