// Место сборки ядра (composition root) — единственное исключение из правила Р19: только здесь виден адаптер pao.
// Ядро (pipeline, policy, mandates, declines) получает платформу через порт и не знает, какая она.
// Подписант создаётся здесь из модуля signer; адаптер получает только порт подписи (инвариант 2).
import { createHash, randomUUID } from "node:crypto";
import { signRequest } from "@kuzin4u/agentic-core";
import { relative, resolve } from "node:path";
import { ConfigError, loadParams, type StandParams } from "../shared/config.js";
import { PLATFORM_EVENT_TYPES, PlatformFailure, type AgentSelf } from "../shared/domain.js";
import type { PaymentPlatform, PlatformCapabilities } from "./ports/payment-platform.js";
import { PAO_CLIENT_DIAG, PAO_DIAG, Pace, PaoPlatform, assertPaoVersion, type PaoPlatformOptions } from "./adapters/pao/index.js";
import { ShopsAdapter, type ShopsAdapterOptions } from "./adapters/shops/index.js";
import { CATALOG_DIAG } from "./catalog/index.js";
import { MemoryJournal, type Journal } from "./journal/index.js";
import { MandateClient } from "./mandates/index.js";
import { EventFeed, EventsStopped, FileCursorStore, acceptPush, type PushReply } from "./events/index.js";
import {
  KeyRing,
  SignerKeyRejected,
  SignerStopped,
  SignerSuspended,
  TlsCertExpired,
  TlsCertMissing,
  TlsTrustMismatch,
  pinRoot,
  tlsChannel,
  type TlsChannel,
  type TlsRoot,
} from "./signer/index.js";
import { Purchase } from "./pipeline/index.js";
import { OrderPriceMismatches, SplitWindow } from "./policy/index.js";
import type { LiveOfferSource } from "./ports/catalog.js";
import type { NoticeAmount, OfferSource, PaymentSteps, PurchaseNotice, ShopPaymentPort, ShopPort } from "./ports/shop.js";
import { ContourPayment } from "./payment-package/index.js";
import { Confirmations } from "./confirmations/index.js";
import { Operations } from "./operations/index.js";
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

/** Полный реестр кодов агента (Р36 п. 1): ПАО, клиент ПАО (Р37 п. 1) и каталог — записи ядра, свои — AGENT_DIAG; код в
 *  двух — ошибка сборки. */
export const DIAG: DiagRegistry = mergeDiag(PAO_DIAG, PAO_CLIENT_DIAG, CATALOG_DIAG, AGENT_DIAG);

export interface AgentCore {
  params: StandParams;
  platform: PaymentPlatform;
  capabilities: PlatformCapabilities;
  /** клиент мандатов на порту мандатов той же платформы */
  mandates: MandateClient;
  /** запись в журнал через обёртку места сборки — с кодом агента и временем ядра (Р37 п. 3); читать записи — из журнала,
   *  переданного при сборке */
  journal: Journal;
  /** Полный реестр кодов (Р36): кто ошибся, действие, тексты для человека и оператора. */
  diag: DiagRegistry;
  /** Лента событий Платформы (Р34): курсор — в каталоге состояния; опрос и ожидание — `signal()`, `items()`. */
  events: EventFeed;
  /** Приём push (Р34 п. 2): только форма и сигнал ленте; HTTP-сервер — у оболочки. Заголовки — в нижнем регистре. */
  acceptPush(body: string, headers: Readonly<Record<string, string | string[] | undefined>>): PushReply;
  /** Новая покупка (Р38): конвейер стадий 0–6 на клиенте мандатов, ленте и журнале ядра; порты стадий — от вызывающего.
   *  Стадия 0 — допуск последнего start() и подпись не остановлена; состояние покупки — только в памяти (Р38 п. 6). */
  purchase(o: PurchasePorts): Purchase;
  /** Адаптер витрин продавцов (Р42): `offers`, `live` и `shop` для `purchase()`; обращения подписаны действующим ключом
   *  агента, попытки — в журнал ядра (shop.call). Профиль магазина — от вызывающего (до kuzin4u/agentic-ps-platform#45). */
  shops(o: ShopsOptions): ShopsAdapter;
  /** Шаги стадий 4–6 профиля contour (Р45 п. 6, Р47): реквизит по ПАО этой платформы и пакет агентской оплаты продавцу
   *  через `shop` (адаптер витрин); до событий операции итог не подтверждается (OPERATION_RESULT_UNCONFIRMED); ответ
   *  продавца DECLINED — ожидание запроса подтверждения и решения человека (модуль подтверждений ядра). */
  payment(shop: ShopPaymentPort): PaymentSteps;
  /** Самопроверка при старте (Р36 п. 6): отчёт последнего start() (и успешного, и с отказом); до start() — null. */
  selfCheck(): SelfCheckReport | null;
  /** Стадия 0 с самопроверкой (Р36 п. 6, дополнение 2). Порядок: ключи из хранилища и выбор ключа допуска, курсор ленты
   *  (оба — до обращений к Платформе), версия ПАО Платформы (Р33 п. 10: ниже 1.4.0 — агент остановлен, допуска нет; не
   *  определена — предупреждение platform.version_unknown и допуск), затем сверка с реестром (GET /pao/v1/agent); до
   *  успеха никакие обращения, кроме допуска, не подписываются. Отчёт — в журнал (agent.selfcheck) и в selfCheck().
   *  Отказ — AgentNotReady с отчётом, исходная ошибка (SignerStopped, PlatformFailure, EventsStopped, SignerKeyRejected) — в
   *  cause; действие кода в реестре stop (нет ключа, EXCLUDED, класс не BUYER, AGENT_UNKNOWN, BAD_RESPONSE — ответ не по
   *  схеме, UNKNOWN) — подписант остановлен; иначе (503, NO_RESPONSE — нет ответа, Р48 п. 3; KEY_REJECTED) агент не допущен
   *  и start() можно повторить. AGENT_SUSPENDED на допуске (403 или SUSPENDED) — подпись приостановлена без остановки,
   *  start() можно повторить (Р63 п. 1; повтор — за вызывающим, не чаще agent_recheck_interval_sec). После допуска — подписка на push, если задан `pushUrl` (Р34 п. 8): адрес отвергнут (400) —
   *  events.subscription_rejected; прочий отказ Платформы после повторов адаптера (503, NO_RESPONSE, BAD_RESPONSE) —
   *  events.subscription_failed; в обоих случаях старт успешен, работа по ленте, повтор подписки — при следующем старте
   *  (дополнение Р34 п. 1) — events.subscription: warn. Коды остановки агента и остановленная подпись на подписке —
   *  events.subscription: fail, AgentNotReady (ревью К2.2 № 4, дополнение 2 п. 5). */
  start(): Promise<AgentSelf>;
  /** Повторная сверка с реестром (Р27): снимает приостановку подписи при ACTIVE и BUYER; SUSPENDED — приостановка
   *  остаётся (SignerSuspended, Р60 п. 2); иной статус или не BUYER — остановка; ответ снова не по схеме или сбой —
   *  приостановка остаётся. Расписание сверок — за вызывающим (до К1.2 AG-14, Р60 п. 4). */
  recheck(): Promise<AgentSelf>;
  /** сначала отзыв брошенных ключей, которые реестр показал действующими (Р63 п. 6: key.revoked с причиной ABANDONED;
   *  отказ отзыва ротацию не блокирует, повтор — при следующем вызове; идёт и при приостановке), затем плановая ротация
   *  ключа, если до valid_to (по данным платформы) осталось не больше key_overlap_days; при приостановке — SignerSuspended,
   *  ротации нет; ротация остановлена (новый ключ не принят подряд сверх предела) — SignerRotationStopped: нужен человек,
   *  не повторять (Р58 п. 4) */
  maintainKeys(): Promise<void>;
  /** освободить каталог ключей (один процесс на каталог) */
  close(): void;
}

/** Витрины для адаптера (Р42): адрес; факты магазина — из витрины (Р54 п. 4); подпись, параметры, журнал и часы — от
 *  места сборки. */
export type ShopsOptions = Pick<ShopsAdapterOptions, "baseUrl" | "fetch">;

/** Порты стадий покупки от вызывающего (Р38 п. 2) и регион человека из профиля (Р32 п. 5). */
export interface PurchasePorts {
  offers: OfferSource;
  live: LiveOfferSource;
  shop: ShopPort;
  payment: PaymentSteps;
  region?: string;
  /** уведомление оболочки (Р47 п. 5, В3; Р49 п. 7): CONFIRMATION_PENDING — нужно подтверждение в приложении банка; SCOPE_*
   *  — запись об исполнении не WITHIN_LIMITS (значение вне перечня — из `purchase.operation`); OPERATION_REFUNDED — возврат
   *  (Р51 п. 3); `amount` — сумма списания по операции у SCOPE_* и OPERATION_REFUNDED */
  notify?: (code: PurchaseNotice, amount?: NoticeAmount) => void | Promise<void>;
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
  pao: Omit<PaoPlatformOptions, "params" | "signing" | "journal" | "pace"> & { tls?: PaoTlsOptions };
}

/** Канал mTLS к ПАО (Р64 п. 5–6): корень УЦ песочницы в PEM и его отпечаток — только полный SHA-256 (64 знака hex,
 *  регистр и «:» не учитываются). Ключ TLS и сертификат — из `keysDir` (`tls/`, К2.1; отдельного каталога нет — решение
 *  владельца 29.10). Задан — все обращения к ПАО идут через канал, свой `pao.fetch` не используется; нет — прежний транспорт. */
export interface PaoTlsOptions {
  caPem: string;
  caFingerprint: string;
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
export function startFailureCode(e: unknown): DiagCode | null {
  if (e instanceof SignerStopped) return e.reason === "CLOSED" ? null : e.reason;
  // приостановка во время шага покупки — её код, а не UNKNOWN (Р50 дополнение 1); после отправки пакета — итоговый (Р49 п. 2)
  if (e instanceof SignerSuspended) return e.reason;
  if (e instanceof PlatformFailure) return e.code;
  if (e instanceof EventsStopped) return "EVENTS_CURSOR_INVALID";
  // коды канала mTLS — раньше общего отказа ключа: их классы — наследники SignerKeyRejected (Р64 п. 6–7)
  if (e instanceof TlsTrustMismatch || e instanceof TlsCertMissing || e instanceof TlsCertExpired) return e.code;
  if (e instanceof SignerKeyRejected) return "KEY_REJECTED";
  return null;
}

/** Отчёт — в журнал: по записи на проверку, только имя, итог и код (Р36 п. 6). */
function recordReport(journal: Journal, report: SelfCheckReport, results: Partial<Record<SelfCheckName, CheckResult>>): void {
  for (const c of report.checks) {
    // код — из CheckResult (DiagCode), а не из отчёта ядра, где он строка (ревью К2.1 № 6); время записи ставит обёртка
    const r = results[c.check as SelfCheckName];
    journal.record({ at: report.checked_at, kind: "agent.selfcheck", check: c.check, status: c.status, ...(r !== undefined && r.status !== "ok" && { reason: r.code }) });
  }
}

export function createAgentCore(o: AgentCoreOptions): AgentCore {
  const now = o.now ?? (() => new Date());
  const sink = o.journal ?? new MemoryJournal();
  // Одна обёртка для всех писателей (Р37 п. 3): время — по часам ядра, код агента — отсюда; подсистемы его не знают.
  const journal: Journal = { record: (e) => sink.record({ ...e, at: now().toISOString(), agent: o.pao.agentCode }) };
  // Самопроверка без сети при сборке (Р36 п. 6, дополнение 2 п. 1): без параметров агент не собрать — отказ сборки с отчётом.
  const notReady = (results: Partial<Record<SelfCheckName, CheckResult>>, cause: unknown): AgentNotReady => {
    const report = selfCheckReport(results, now());
    recordReport(journal, report, results);
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
  // Канал mTLS (Р64 п. 5–6): форма настройки — при сборке (TlsConfigInvalid наружу, до start()); несовпадение отпечатка —
  // отказ start() до первого обращения; сертификат и его срок — на каждом start() (сертификат мог быть переустановлен).
  // Канал подставляется во все адаптеры ПАО — основной, допуска, сверки — и в знак готовности витрин (п. 5).
  const { tls, ...paoBase } = o.pao;
  let root: TlsRoot | TlsTrustMismatch | null = null;
  if (tls !== undefined) {
    try {
      root = pinRoot(tls.caPem, tls.caFingerprint);
    } catch (e) {
      if (!(e instanceof TlsTrustMismatch)) throw e;
      root = e;
    }
  }
  let channel: TlsChannel | null = null;
  const channelFetch = ((url: string | URL | Request, init?: RequestInit) =>
    channel === null ? Promise.reject(new TlsCertMissing()) : channel.fetch(url, init)) as typeof fetch;
  const pao = tls === undefined ? paoBase : { ...paoBase, fetch: channelFetch };
  const ring = new KeyRing({ dir: o.keysDir, params, journal, ...(o.now && { now: o.now }), onState: () => syncRecheck() });
  // Рабочий адаптер получает порт, закрытый до допуска; запрос допуска идёт через отдельный адаптер с портом допуска.
  // События версии ПАО (Р33 п. 10) и попытки обращений (pao.call) пишет адаптер — через ту же обёртку; журнал получают и
  // адаптеры допуска и сверки с реестром (ревью К2.1 № 2).
  // Один ограничитель частоты на агента (Р59 п. 1): счётчик Платформы — по коду агента, общий для адаптеров основного,
  // допуска и сверки; предел из GET /pao/v1/agent любого из них действует для всех.
  const pace = new Pace({
    fallbackPerMin: params.pao_rate_limit_fallback_per_min,
    journal,
    now,
    ...(o.pao.sleep && { sleep: o.pao.sleep }),
    ...(o.pao.monotonic && { monotonic: o.pao.monotonic }),
  });
  // Лента недоступна дольше срока и не прочитана полностью — обязательств агент не берёт, даже после снятия приостановки
  // сверкой (Р60 п. 4, нюанс К1.2; Т14): мандат, реквизит, подтверждение, заказ у витрины; защитные и ротация — можно.
  const hold = (): void => {
    if (events.failing) throw new SignerSuspended("EVENTS_UNAVAILABLE");
  };
  const platform = new PaoPlatform({ ...pao, params, signing: ring.port(), journal, pace, hold });
  const at = (): string => now().toISOString();
  // Остановка по курсору — через порт подписи: агент целиком, запись agent.stopped — у связки ключей (Р34 п. 4).
  const signing = ring.port();
  const events = new EventFeed({
    port: platform,
    store: new FileCursorStore(o.stateDir, now),
    journal,
    stop: (reason, detail) => signing.stop(reason, detail),
    // недоступность дольше registry_cache_ttl_sec — приостановка до recheck() (Р50 дополнение 1)
    suspend: (reason) => signing.suspend(reason),
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
      // остановка или приостановка агента (AGENT_SUSPENDED — приостановка, Р60 п. 1) и дефекты — наружу; адрес и тело
      // в журнал не идут
      if (!(e instanceof PlatformFailure) || AGENT_STOP_CODES.has(e.code)) throw e;
      const kind = e.code === "REQUEST_INVALID" ? "events.subscription_rejected" : "events.subscription_failed";
      journal.record({ at: at(), kind, reason: e.code });
      return { status: "warn", code: e.code };
    }
  };
  // Сверка с реестром одна на всех (Р27): событие agent.* и вызов recheck() снаружи ждут одну и ту же.
  let rechecking: Promise<AgentSelf> | null = null;
  const recheck = (): Promise<AgentSelf> =>
    (rechecking ??= ring.recheck((s) => new PaoPlatform({ ...pao, params, signing: s, journal, pace }).agentSelf()).finally(() => {
      rechecking = null;
    }));
  // Сверка по расписанию и по push (Р60 п. 4–5а): итог — прочитанный статус (ACTIVE, SUSPENDED) или null — сверка не
  // прошла или агент остановлен. Отказ не роняет процесс и не глушится: запись agent.recheck_failed с кодом — первая в
  // серии и при смене кода; серию закрывает прочитанный статус (Р-645). Остановку записывает связка ключей.
  let recheckFailure: DiagCode | null = null;
  const scheduledRecheck = (): Promise<"ACTIVE" | "SUSPENDED" | null> =>
    recheck().then(
      () => {
        recheckFailure = null;
        return "ACTIVE" as const;
      },
      (e: unknown) => {
        if (e instanceof SignerStopped) return null;
        if (e instanceof SignerSuspended && e.reason === "AGENT_SUSPENDED") {
          recheckFailure = null;
          return "SUSPENDED" as const;
        }
        const code: DiagCode = e instanceof PlatformFailure ? e.code : "UNKNOWN";
        if (recheckFailure !== code) {
          recheckFailure = code;
          // сбой журнала здесь отдать некому (таймер): сверка повторится следующим тиком, запись — при следующем отказе
          try {
            journal.record({ at: at(), kind: "agent.recheck_failed", reason: code });
          } catch {
            recheckFailure = null;
          }
        }
        return null;
      },
    );
  // Расписание (Р60 п. 4): пока подпись приостановлена (любая причина), раз в agent_recheck_interval_sec — recheck();
  // таймер только вызывает сверку, время GET задаёт общий Pace (условие (а)), сверка одна на ядро (rechecking). Ставится
  // при приостановке, снимается при снятии, остановке и close() (onState связки ключей); процесс не держит. До допуска
  // расписания нет: приостановку при допуске снимает повторный start (Р63 п. 1).
  let recheckTimer: ReturnType<typeof setInterval> | null = null;
  let wasSuspended = false;
  const syncRecheck = (): void => {
    const suspended = ring.stopReason === null && ring.suspendReason !== null && ring.admitted;
    if (suspended && recheckTimer === null) {
      recheckTimer = setInterval(() => void scheduledRecheck(), params.agent_recheck_interval_sec * 1000);
      recheckTimer.unref();
    } else if (!suspended && recheckTimer !== null) {
      clearInterval(recheckTimer);
      recheckTimer = null;
    }
    // Снятие — лента с сохранённого курсора (Р60 п. 2); после EVENTS_UNAVAILABLE только это чтение закрывает серию
    // (нюанс К1.2). Отказ чтения записывает и считает сама лента (events.unavailable).
    if (wasSuspended && !suspended && ring.stopReason === null) void events.signal().catch(() => undefined);
    wasSuspended = suspended;
  };
  // Push при приостановке (Р60 п. 5): лента и подписка — 403, поэтому сразу сверка, а не чтение ленты. Тип push — из
  // неподписанного тела, только ожидание (п. 5а): прочитано иное — ещё одна сверка через тот же Pace (версии статуса в
  // ПАО 1.4.0 нет); дальше — расписание. Подделка — не больше двух GET.
  const PUSH_EXPECTS: ReadonlyMap<string, "ACTIVE" | "SUSPENDED"> = new Map([
    ["agent.suspended", "SUSPENDED"],
    ["agent.reinstated", "ACTIVE"],
  ]);
  const wake = async (type: string): Promise<void> => {
    if (ring.stopReason !== null || ring.suspendReason === null || !ring.admitted) return events.signal();
    const read = await scheduledRecheck();
    const expected = PUSH_EXPECTS.get(type);
    if (expected === undefined || read === null || read === expected) return;
    while (rechecking) await rechecking.catch(() => undefined);
    await scheduledRecheck();
  };
  // agent.key_revoked / agent.suspended / agent.reinstated — сигнал: статус и ключи — по GET /pao/v1/agent (Р34 п. 5).
  // Идёт чужая сверка — её GET мог уйти до смены статуса: дождаться её и сверить заново (ревью К2.4 № 4).
  // Сверка не прошла (503, остановка) — слушатель падает, курсор на месте, событие прочитается снова (Р34 п. 3).
  let lastReport: SelfCheckReport | null = null;
  // допуск отказал с AGENT_SUSPENDED (Р63 п. 1): снятие — следующий успешный start(), а не расписание сверки (его до допуска
  // нет), поэтому чтение ленты с сохранённого курсора запускает он (Р60 п. 2, передача #61 п. 6; К5.5)
  let suspendedAtAdmission = false;
  events.listen(async (item) => {
    if (item.kind !== "event" || !item.event.type.startsWith("agent.")) return;
    while (rechecking) await rechecking.catch(() => undefined);
    await recheck();
  });
  const mandates = new MandateClient({ port: platform, params, journal, ...(o.now && { now: o.now }) });
  // mandate.* о держимом мандате и пропуск INVALID_DATA мандатного типа — перечитать по GET (Р34 ответ (б), Р37 п. 4);
  // сбой GET — слушатель падает, курсор на месте (Р34 п. 3): лента стоит для всех, и ожидание подписи другого мандата
  // (awaitSigned) получает тот же отказ — fail-closed, нюанс Р37 (ревью К2.3 № 6). awaitSigned читает ленту само.
  events.listen((item) => mandates.refreshHeld(item));
  // подтверждение человеком (Р47 п. 3–4): confirmation.* — сигнал, статус по GET; один модуль на ядро — привязка запроса
  // к покупке считает все ожидающие покупки агента; пока покупка ждёт, лента читается
  const confirmations = new Confirmations({ port: platform, journal, params, wake: () => events.signal(), now });
  events.listen(confirmations.listener);
  // итог операции (Р49 п. 3–6): operation.* — сигнал, итог по GET; один модуль на ядро — привязка по order_ref среди всех
  // покупок агента; пока покупка ждёт, лента читается
  const operations = new Operations({ port: platform, journal, params, wake: () => events.signal(), now });
  events.listen(operations.listener);
  // окно дробления — одно на ядро: доли разных покупок под одним INTENT видят друг друга (Р39 п. 4)
  const split = new SplitWindow(params, now);
  // пометка Д02 — одна на ядро: расхождение заказа одной покупки видно в выдачах следующих (Р48 п. 5)
  const orderMismatches = new OrderPriceMismatches();
  return {
    params,
    platform,
    capabilities: platform.capabilities(),
    mandates,
    journal,
    diag: DIAG,
    events,
    acceptPush: (body, headers) => acceptPush({ wake, journal, now }, body, headers),
    selfCheck: () => lastReport,
    // остановленная подпись и курсор — код как у отказа старта; штатное закрытие (CLOSED) — UNKNOWN у конвейера.
    // Порты вызывающего — поимённо: лишнее поле объекта не подменит допуск, клиент мандатов или журнал (ревью К2.2 № 3).
    purchase: (p) =>
      new Purchase({
        mandates,
        events: (signal) => events.items(signal),
        journal,
        admission: () => {
          const stopped = ring.stopReason;
          if (stopped !== null) return stopped === "CLOSED" ? "UNKNOWN" : stopped;
          // приостановка (AGENT_SELF_UNKNOWN, EVENTS_UNAVAILABLE) — отказ стадии 0 без обращения (Р50 дополнение 1 п. 2)
          if (ring.suspendReason !== null) return ring.suspendReason;
          // снята сверкой, а лента после EVENTS_UNAVAILABLE ещё не прочитана полностью (Р60 п. 4, нюанс К1.2)
          if (events.failing) return "EVENTS_UNAVAILABLE";
          return lastReport?.ready === true ? null : "NOT_ADMITTED";
        },
        failureCode: startFailureCode,
        // подпись остановлена (не приостановлена) — отказ от CART не пытается (Р63, дополнение 1 п. 1: SKIPPED STOPPED)
        signingStopped: () => ring.stopReason !== null,
        now,
        offers: p.offers,
        live: p.live,
        shop: p.shop,
        payment: p.payment,
        params,
        split,
        orderMismatches,
        ...(p.region !== undefined && { region: p.region }),
        ...(p.notify !== undefined && { notify: p.notify }),
      }),
    // Подпись витрин — тем же действующим ключом и профилем, что ПАО; остановленная подпись — исключение, обращения нет.
    shops: (s) =>
      new ShopsAdapter({
        baseUrl: s.baseUrl,
        ...(s.fetch !== undefined && { fetch: s.fetch }),
        agentCode: o.pao.agentCode,
        // заказ и оплата у витрины — обязательство: при недоступной ленте не идут (Р60 п. 4, нюанс К1.2); чтение — можно
        signing: {
          sign: (req) => {
            if (req.method.toUpperCase() !== "GET") hold();
            return signRequest(req, signing.current());
          },
        },
        // знак готовности по ПАО (Р53 п. 1, 5): адрес Платформы и порт подписи — те же, что у адаптера ПАО
        platform: { baseUrl: pao.baseUrl, signing, ...(pao.fetch !== undefined && { fetch: pao.fetch }) },
        params,
        journal,
        now,
      }),
    payment: (shop) => new ContourPayment({ platform, shop, journal, confirmations, operations, params, now }),
    // Ключи загружаются до обращений к Платформе (сбой хранилища — без сети), затем курсор ленты и конфигурация, затем
    // GET /pao/v1/agent; курсор и конфигурация — один раз за start (повтор при SIGNATURE_INVALID — внутри адаптера, Р58 п. 3).
    start: async () => {
      lastReport = null;
      const results: Partial<Record<SelfCheckName, CheckResult>> = { "config.params": OK, "core.pao": OK };
      // Отказ проверки: код — в отчёт; по действию кода в реестре stop — подписант остановлен (дополнение 2 п. 2; мог уже
      // остановиться сам — SIGNATURE_INVALID, SPEC §7а); отчёт — в журнал; наружу — AgentNotReady с исходной ошибкой.
      const fail = (check: SelfCheckName, code: DiagCode, cause: unknown): AgentNotReady => {
        results[check] = { status: "fail", code };
        // приостановление при допуске — без остановки, start можно повторить (Р63 п. 1); на подписке — остановка, как
        // прежде (нюанс К1.1 Р63)
        const suspended = check === "platform.admission" && code === "AGENT_SUSPENDED";
        if (suspended) suspendedAtAdmission = true;
        if (stopsAgent(DIAG, code) && !suspended) signing.stop(code);
        lastReport = selfCheckReport(results, now());
        recordReport(journal, lastReport, results);
        return new AgentNotReady(lastReport, { cause });
      };
      // Канал mTLS (Р64 п. 6–7) — до ключей и до сети: отпечаток не совпал — TLS_TRUST_MISMATCH (остановка), сертификата
      // нет — TLS_CERT_MISSING (допуска нет, start() можно повторить после установки), срок истёк — TLS_CERT_EXPIRED
      // (остановка). Канал прошлого start() не используется, пока не проверен заново.
      if (root !== null) {
        channel = null;
        try {
          if (root instanceof TlsTrustMismatch) throw root;
          channel = tlsChannel(o.keysDir, { root, now });
        } catch (e) {
          const code = startFailureCode(e);
          if (code === null) throw e;
          throw fail(failedCheck(code), code, e);
        }
        results["platform.tls"] = OK;
      }
      let connected = false;
      // идёт запрос конфигурации: её отказ (PlatformFailure: PAO_CLIENT_REDIRECT, PLATFORM_PROTOCOL_UNSUPPORTED) — проверка
      // platform.protocol, а не допуск (Р37 п. 2); прочее (SignerStopped) — по failedCheck (ревью К0 № 3)
      let protocolPending = false;
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
            protocolPending = true;
            const p = await platform.checkProtocol();
            protocolPending = false;
            results["platform.protocol"] = p.status === "confirmed" ? OK : { status: "warn", code: "PLATFORM_VERSION_UNKNOWN" };
            connected = true;
          }
          return new PaoPlatform({ ...pao, params, signing: admission, journal, pace }).agentSelf();
        });
      } catch (e) {
        const code = startFailureCode(e);
        if (code === null) throw e;
        const check = protocolPending && e instanceof PlatformFailure ? "platform.protocol" : failedCheck(code);
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
      recordReport(journal, lastReport, results);
      // снятие приостановки допуска — лента с курсора, как syncRecheck при снятии после допуска; отказ чтения записывает и
      // считает сама лента (events.unavailable). Обычный старт ленту не читает
      if (suspendedAtAdmission) {
        suspendedAtAdmission = false;
        void events.signal().catch(() => undefined);
      }
      return self;
    },
    recheck,
    maintainKeys: () => ring.maintain(platform),
    close: () => ring.close(),
  };
}
