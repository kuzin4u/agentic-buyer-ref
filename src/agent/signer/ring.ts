// Связка ключей подписи (Т1, A2 п. 5): допуск, выбор действующего ключа, плановая ротация, переход при отзыве, остановка.
// Сроки ключей — только из ответа платформы (РП23): агент их не вычисляет; key_overlap_days — лишь момент начала ротации.
// Fail-closed (инвариант 4): до подтверждённого допуска рабочий порт не подписывает ничего — запрос допуска идёт через
// отдельный порт, который есть только у start; после допуска — только ключом, подтверждённым платформой как ACTIVE
// в пределах [valid_from, valid_to). Ответ реестра не по схеме после допуска — рабочая подпись приостановлена до
// успешной повторной сверки (Р27): сверку подписывает отдельный порт, действующий только на время recheck.
// Состояние ключей хранится в хранилище (keystore): новый ключ — под временным именем
// до подтверждения регистрации; ключ допуска — с самым поздним подтверждённым valid_from из метаданных хранилища.
import type { Signer } from "@kuzin4u/agentic-core";
import { PlatformFailure, type AgentKey, type AgentSelf } from "../../shared/domain.js";
import type { StandParams } from "../../shared/config.js";
import type { DiagCode } from "../../shared/diag-codes.js";
import { ruleForFailure } from "../declines/index.js";
import type { Journal, JournalKind } from "../journal/index.js";
import type { PaymentPlatform } from "../ports/payment-platform.js";
import type { RequestSigning } from "../ports/request-signing.js";
import { SignerKeyRejected, SignerStopped, SignerSuspended, type SignerStopReason } from "./errors.js";
import { KeystoreLocked, generateKey, listKeys, loadKey, lockDir, markKey, pruneKey, readMeta, writeMeta, type KeyMeta, type KeyState, type LoadedKey } from "./keystore.js";
import { kidOf } from "./kid.js";

const DAY_MS = 86_400_000;

export interface KeyRingOptions {
  /** каталог ключей (keystore) */
  dir: string;
  params: Pick<StandParams, "key_overlap_days">;
  journal: Journal;
  now?: () => Date;
}

interface Held {
  readonly loaded: LoadedKey;
  /** состояние для выбора ключа (в памяти) */
  state: KeyState;
  /** состояние, записанное в хранилище */
  disk: KeyState;
  /** сведения платформы о ключе из последнего ответа; null — ключ не подтверждён */
  info: AgentKey | null;
  /** регистрация подтверждена платформой в этом процессе, переход на ключ ещё не подтверждён сверкой;
   *  сбрасывается при переходе на ключ */
  awaiting: boolean;
}

type Admission = "none" | "admitting" | "admitted";
/** Запрос допуска через данный порт подписи (адаптер платформы, собранный для допуска). */
export type Admit = (signing: RequestSigning) => Promise<AgentSelf>;
type Registrar = Pick<PaymentPlatform, "registerKey" | "agentSelf">;

export class KeyRing {
  readonly #o: KeyRingOptions;
  readonly #now: () => Date;
  readonly #held = new Map<string, Held>();
  #currentKid: string | null = null;
  #stopped: SignerStopReason | null = null;
  /** приостановка рабочей подписи до успешной повторной сверки (Р27); остановка сильнее приостановки */
  #suspended: DiagCode | null = null;
  /** счётчик приостановок: сверка снимает только ту, что поставлена до её начала (не позднее, из параллельного ответа) */
  #suspensions = 0;
  /** метка идущей сверки: порт сверки обходит приостановку только пока жива его метка (снимается в finally) */
  #recheckToken: object | null = null;
  #admission: Admission = "none";
  #rotating: Promise<void> | null = null;
  /** close() вызван: записи в хранилище запрещены безусловно (каталог мог взять другой процесс) */
  #closed = false;
  #unlock: (() => void) | null = null;
  /** метаданные хранилища, прочитанные при допуске */
  #meta: KeyMeta = {};
  /** в этой попытке допуска уже был переход на другой подтверждённый ключ; повторный start — новая попытка
   *  (как перезапуск процесса: отзыв записан в хранилище) */
  #admissionSwitched = false;
  /** брошенные временные ключи прошлых запусков (не загружаются) */
  readonly #abandoned = new Set<string>();
  /** KEY_INVALID подряд при регистрации (Р31); успешная регистрация сбрасывает. Счёт — в процессе: перезапуск — решение человека */
  #keyInvalidStreak = 0;
  /** ротация остановлена по пределу KEY_INVALID (Р31); подпись прежним подтверждённым ключом продолжается */
  #rotationStopped = false;

  constructor(o: KeyRingOptions) {
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
  }

  /** Рабочий порт подписи для адаптера: до допуска и после остановки — SignerStopped, при приостановке — SignerSuspended
   *  (Р27). Наружу — только методы порта. */
  port(): RequestSigning {
    return Object.freeze({
      current: () => this.#current(false),
      keyRevoked: (kid: string, failure?: unknown) => this.#keyRevoked(kid, failure, false),
      stop: (reason: DiagCode, detail?: string) => this.#stop(reason, detail),
      suspend: (reason: DiagCode) => this.#suspend(reason),
    });
  }

  /**
   * Повторная сверка с реестром (Р27): GET /pao/v1/agent подписывается и при приостановке; ACTIVE и BUYER по
   * разобранному ответу — подпись возобновляется; не ACTIVE или не BUYER — остановка (#reconcile); ответ снова не по
   * схеме или сбой — приостановка остаётся. Когда и как часто сверять — решает вызывающий (STATUS, «Открыто», AG-12).
   */
  async recheck(admit: Admit): Promise<AgentSelf> {
    if (this.#stopped !== null) throw new SignerStopped(this.#stopped);
    if (this.#admission !== "admitted") throw new SignerStopped("NOT_ADMITTED");
    if (this.#recheckToken !== null) throw new Error("сверка уже идёт");
    const token = {};
    const live = () => this.#recheckToken === token;
    const signing: RequestSigning = Object.freeze({
      current: () => this.#current(false, live()),
      keyRevoked: (kid: string, failure?: unknown) => this.#keyRevoked(kid, failure, false, live()),
      stop: (reason: DiagCode, detail?: string) => this.#stop(reason, detail),
      suspend: (reason: DiagCode) => this.#suspend(reason),
    });
    const before = this.#suspensions;
    this.#recheckToken = token;
    try {
      const self = await admit(signing);
      this.#reconcile(self);
      if (this.#suspended !== null && this.#suspensions === before) {
        this.#suspended = null;
        this.#record("signing.resumed");
      }
      return self;
    } finally {
      this.#recheckToken = null;
    }
  }

  /**
   * Стадия 0 (допуск) одним ключом, без перебора (перебор маскировал бы сбитое время и неверный состав полей, а платформа
   * видела бы подписи незарегистрированными ключами). Ключ допуска — с самым поздним подтверждённым valid_from из
   * метаданных хранилища, а без метаданных — единственный рабочий ключ; несколько без метаданных — остановка.
   * AGENT_KEY_REVOKED — ключ отмечается отозванным и один переход на другой ключ, подтверждённый платформой в метаданных
   * (ACTIVE, valid_to в будущем) — один на попытку допуска; нет такого — остановка (SPEC §7а: «подписать действующим
   * новым ключом; нет — остановка»).
   * Неподтверждённые ключи не пробуются.
   * SIGNATURE_INVALID — повтор тем же ключом с новой подписью не больше maxRetries таблицы отказов (SPEC §7а: один), затем
   * остановка.
   * Прочие сбои (503, тайм-аут) — допуск не состоялся; можно ли повторить, решает место сборки по действию кода в реестре
   * (дополнение 2 к Р36: UNKNOWN, в т. ч. тайм-аут, — остановка); AGENT_UNKNOWN / AGENT_SUSPENDED — остановка (адаптер);
   * класс в реестре не BUYER — остановка AGENT_CLASS_MISMATCH (Р27, после проверки статуса).
   */
  async start(admit: Admit): Promise<AgentSelf> {
    if (this.#stopped !== null) throw new SignerStopped(this.#stopped);
    if (this.#admission !== "none") throw new Error("допуск уже идёт или пройден");
    const signing: RequestSigning = Object.freeze({
      current: () => this.#current(true),
      keyRevoked: (kid: string, failure?: unknown) => this.#keyRevoked(kid, failure, true),
      stop: (reason: DiagCode, detail?: string) => this.#stop(reason, detail),
      suspend: (reason: DiagCode) => this.#suspend(reason),
    });
    this.#admission = "admitting";
    try {
      if (this.#unlock === null) this.#lock();
      if (this.#held.size === 0) this.#loadAll();
      this.#currentKid = this.#admissionKey();
      const signatureRetries = ruleForFailure("SIGNATURE_INVALID").maxRetries ?? 0; // null — без повтора (fail-closed)
      for (let attempt = 1; ; attempt++) {
        let self: AgentSelf;
        try {
          self = await admit(signing);
        } catch (e) {
          if (!(e instanceof PlatformFailure) || this.#stopped !== null) throw e;
          this.#record("admission.failed", this.#currentKid, e.code);
          // Недостижимо при maxRetries ≥ 1 (дополнение 2 к Р36 п. 4 (в), тест): адаптер на каждом AGENT_KEY_REVOKED вызывает
          // keyRevoked, второй отказ — NO_ACTIVE_KEY. Станет достижимо (смена ключей) — по действию реестра (new_key).
          if (e.code === "AGENT_KEY_REVOKED") this.#halt("AGENT_KEY_REVOKED", e);
          if (e.code === "SIGNATURE_INVALID") {
            if (attempt > signatureRetries) this.#halt("SIGNATURE_INVALID", e);
            continue;
          }
          throw e;
        }
        this.#reconcile(self);
        this.#admission = "admitted";
        return self;
      }
    } catch (e) {
      if (this.#admission === "admitting") {
        this.#admission = "none";
        this.#admissionSwitched = false; // повторный start — новый допуск со своим одним переходом
        if (this.#stopped === null && !(e instanceof PlatformFailure)) this.#record("admission.failed", undefined, "KEY_REJECTED");
      }
      throw e;
    }
  }

  /** Пора ротировать: до valid_to действующего ключа (по данным платформы) осталось не больше key_overlap_days. */
  rotationDue(): boolean {
    const validTo = this.#held.get(this.#current(false).kid)!.info!.validTo!;
    return Date.parse(validTo) - this.#now().getTime() <= this.#o.params.key_overlap_days * DAY_MS;
  }

  /**
   * Плановая ротация (A2 п. 5.3): новый ключ регистрируется, подписываясь прежним; переход — только после
   * подтверждения платформы и сверки с GET /pao/v1/agent. Повторный вызов во время ротации ждёт ту же ротацию;
   * после сбоя связи регистрируется тот же ожидающий ключ с тем же Idempotency-Key (инвариант 9).
   * KEY_INVALID (Р31) — ключ отклонён, следующая ротация — новый ключ; подряд сверх maxRetries таблицы отказов — ротация
   * остановлена (инцидент в журнал, нужен человек), подпись прежним ключом — пока он действителен.
   */
  rotate(platform: Registrar): Promise<void> {
    this.#rotating ??= this.#doRotate(platform).finally(() => (this.#rotating = null));
    return this.#rotating;
  }

  async maintain(platform: Registrar): Promise<void> {
    if (this.rotationDue()) await this.rotate(platform);
  }

  async #doRotate(platform: Registrar): Promise<void> {
    this.#current(false); // остановленный или не допущенный агент не ротирует
    if (this.#rotationStopped) throw new SignerKeyRejected("ротация остановлена после KEY_INVALID подряд: нужен человек (Р31)");
    // В этом процессе: ожидающий регистрации или зарегистрированный без подтверждённого перехода — тот же ключ
    // и тот же Idempotency-Key (инвариант 9). Временные файлы прошлых запусков не используются (#loadAll).
    const pendingKid = [...this.#held.entries()].find(([, h]) => h.state !== "revoked" && (h.state === "pending" || h.awaiting))?.[0];
    let fresh: LoadedKey;
    if (pendingKid !== undefined) {
      fresh = this.#held.get(pendingKid)!.loaded;
    } else {
      fresh = generateKey(this.#o.dir, "pending");
      this.#held.set(fresh.descriptor.kid, { loaded: fresh, state: "pending", disk: "pending", info: null, awaiting: false });
      this.#record("key.created", fresh.descriptor.kid);
    }
    const { kid, alg, public_key } = fresh.descriptor;
    let reg: AgentKey;
    try {
      reg = await platform.registerKey({ alg, publicKey: public_key }, { idempotencyKey: `agent-key-${kid}` });
    } catch (e) {
      if (e instanceof PlatformFailure && e.code === "KEY_INVALID") this.#keyInvalid(kid);
      throw e; // прочие отказы: итог регистрации неизвестен — тот же ключ с тем же Idempotency-Key (инвариант 9)
    }
    if (reg.kid !== kid || reg.publicKey !== public_key) this.#halt("KEY_MISMATCH");
    if (reg.status !== "ACTIVE") {
      this.#mark(kid, "revoked", "KEY_NOT_ACTIVE"); // отклонённый ключ не повторяется: следующая ротация — новый ключ
      throw new SignerKeyRejected("платформа не подтвердила новый ключ как действующий");
    }
    this.#record("key.registered", kid);
    this.#keyInvalidStreak = 0;
    // Регистрация подтверждена платформой — постоянное имя <kid>.pem. Ключом допуска он станет, только когда сверка
    // запишет его valid_from в метаданные.
    const h = this.#held.get(kid)!;
    if (h.state === "revoked") throw new SignerKeyRejected("ключ отозван платформой: повторно не используется");
    h.awaiting = true;
    h.state = "active";
    this.#write(kid, "active");
    this.#reconcile(await platform.agentSelf());
    if (this.#currentKid !== kid) throw new SignerKeyRejected("после регистрации платформа не показала новый ключ действующим");
  }

  /** KEY_INVALID: ключ не принят — отклонён (повторно не регистрируется, инвариант 9); предел подряд — из таблицы отказов. */
  #keyInvalid(kid: string): void {
    this.#mark(kid, "revoked", "KEY_INVALID");
    this.#keyInvalidStreak++;
    if (this.#keyInvalidStreak > (ruleForFailure("KEY_INVALID").maxRetries ?? 0)) {
      this.#rotationStopped = true;
      this.#record("key.rotation_stopped", undefined, "KEY_INVALID");
    }
  }

  #current(admitting: boolean, rechecking = false): Signer {
    if (this.#stopped !== null) throw new SignerStopped(this.#stopped);
    if (this.#admission !== (admitting ? "admitting" : "admitted")) throw new SignerStopped("NOT_ADMITTED");
    if (this.#suspended !== null && !admitting && !rechecking) throw new SignerSuspended(this.#suspended);
    // После допуска — только подтверждённый платформой действующий ключ; срок мог истечь (A2 п. 5.3).
    if (!admitting && !this.#usable(this.#held.get(this.#currentKid!)!)) this.#switchTo(this.#pick());
    const h = this.#held.get(this.#currentKid!)!;
    const { kid, alg } = h.loaded.signer;
    const sign = (data: Buffer): Buffer => {
      const sig = h.loaded.signer.sign(data);
      this.#record("request.signed", kid);
      return sig;
    };
    return Object.freeze({ kid, alg, sign });
  }

  #keyRevoked(kid: string, failure: unknown, admitting: boolean, rechecking = false): Signer {
    if (this.#held.get(kid)?.state === "active") this.#mark(kid, "revoked", "AGENT_KEY_REVOKED");
    if (this.#stopped !== null) throw new SignerStopped(this.#stopped, { cause: failure });
    // При допуске — один переход на ключ, подтверждённый в метаданных; неподтверждённые не пробуются (без перебора).
    if (admitting) {
      const alt = this.#admissionSwitched ? undefined : this.#confirmedAlternative(kid);
      if (alt === undefined) this.#halt("NO_ACTIVE_KEY", failure);
      this.#admissionSwitched = true;
      this.#switchTo(alt);
      return this.#current(true);
    }
    try {
      if (kid === this.#currentKid) this.#switchTo(this.#pick());
    } catch (e) {
      if (e instanceof SignerStopped) throw new SignerStopped(e.reason, { cause: failure });
      throw e;
    }
    return this.#current(admitting, rechecking);
  }

  #suspend(reason: DiagCode): void {
    if (this.#stopped !== null || this.#admission !== "admitted" || this.#suspended !== null) return;
    this.#suspended = reason;
    this.#suspensions++;
    this.#record("signing.suspended", undefined, reason);
  }

  #stop(reason: SignerStopReason, detail?: string): void {
    if (this.#stopped !== null) return;
    this.#stopped = reason;
    // штатное закрытие — не код реестра (Р36 (в)): своя запись без причины (Р37 п. 3)
    if (reason === "CLOSED") this.#record("agent.closed");
    else this.#record("agent.stopped", undefined, reason, detail);
  }

  /** Завершение: подпись и запись в хранилище останавливаются (CLOSED), затем каталог освобождается. */
  close(): void {
    this.#closed = true;
    this.#stop("CLOSED");
    this.#unlock?.();
    this.#unlock = null;
  }

  /** Занят живым процессом — остановка KEYSTORE_LOCKED; прочий сбой ФС — допуск не начинается, start можно повторить. */
  #lock(): void {
    try {
      this.#unlock = lockDir(this.#o.dir);
    } catch (e) {
      if (e instanceof KeystoreLocked) this.#halt("KEYSTORE_LOCKED", e);
      throw e;
    }
  }

  /**
   * Рабочие ключи хранилища (<kid>.pem) — все или ни одного: отказ на любом ключе — допуск не начинается; при повторном
   * start загрузка повторяется (#held пуст). Временные файлы прошлых запусков (регистрация не подтверждена) не
   * используются: помечаются abandoned. Отозванные и брошенные не загружаются; лишние имена одного kid удаляются.
   */
  #loadAll(): void {
    const keys = listKeys(this.#o.dir);
    const loaded = new Map<string, Held>();
    for (const { kid, state } of keys) {
      if (state === "active") loaded.set(kid, { loaded: loadKey(this.#o.dir, kid), state, disk: state, info: null, awaiting: false });
    }
    for (const { kid, state } of keys) {
      try {
        pruneKey(this.#o.dir, kid, state);
        if (state === "pending") markKey(this.#o.dir, kid, "pending", "abandoned");
      } catch (e) {
        this.#halt("KEYSTORE_WRITE_FAILED", e);
      }
      if (state === "pending") this.#record("key.abandoned", kid);
      if (state === "pending" || state === "abandoned") this.#abandoned.add(kid);
    }
    for (const [kid] of loaded) {
      this.#held.set(kid, loaded.get(kid)!);
      this.#record("key.loaded", kid);
    }
    if (this.#held.size === 0) this.#halt("NO_KEY");
  }

  /** Ключ допуска: самый поздний подтверждённый valid_from из метаданных; без метаданных — единственный рабочий ключ. */
  #admissionKey(): string {
    const meta = (this.#meta = readMeta(this.#o.dir));
    // Только рабочие ключи: отозванный в этом процессе (например, на прошлой попытке допуска) не выбирается,
    // даже если метаданные ещё не перезаписаны сверкой.
    const working = [...this.#held.entries()].filter(([, h]) => h.state === "active").map(([k]) => k);
    const known = working.filter((k) => meta[k] !== undefined);
    if (known.length > 0) {
      known.sort((a, b) => Date.parse(meta[b]!.valid_from) - Date.parse(meta[a]!.valid_from) || (a < b ? -1 : 1));
      return known[0]!;
    }
    if (working.length === 1) return working[0]!;
    if (working.length === 0) return this.#halt("NO_ACTIVE_KEY");
    return this.#halt("KEY_AMBIGUOUS");
  }

  /**
   * Сверка с реестром: агент ACTIVE, затем класс BUYER (Р27); kid и открытый ключ совпадают с вычисленными (сначала проверяется весь ответ,
   * потом применяется); действующий — новейший ACTIVE в пределах срока по данным платформы.
   */
  #reconcile(self: AgentSelf): void {
    if (self.status !== "ACTIVE") this.#halt(`AGENT_${self.status}`);
    // Р27: причина остановки ядра, не код ПАО — в таблицу отказов не входит; повторов нет.
    if (self.agentClass !== "BUYER") this.#halt("AGENT_CLASS_MISMATCH", undefined, self.agentClass);
    const ours = self.keys.filter((k) => this.#held.has(k.kid));
    for (const k of ours) {
      const h = this.#held.get(k.kid)!;
      let kid: string;
      try {
        kid = kidOf(k.publicKey);
      } catch {
        this.#halt("KEY_MISMATCH");
      }
      if (k.publicKey !== h.loaded.descriptor.public_key || kid !== k.kid || k.alg !== h.loaded.descriptor.alg) this.#halt("KEY_MISMATCH");
    }
    // Действующий ключ реестра, которого нет среди рабочих: брошенный временный (регистрация прошла, ответ потерян)
    // или чужой — признак регистрации в обход агента (A2 п. 5).
    for (const k of self.keys) {
      if (this.#held.has(k.kid) || k.status !== "ACTIVE") continue;
      this.#record(this.#abandoned.has(k.kid) ? "key.abandoned_registered" : "key.foreign", k.kid);
    }
    for (const h of this.#held.values()) h.info = null; // ключ, которого нет в ответе, не подтверждён
    for (const k of ours) {
      this.#held.get(k.kid)!.info = k;
      if (k.status !== "ACTIVE") this.#mark(k.kid, "revoked", `KEY_${k.status}`);
    }
    this.#switchTo(this.#pick());
    this.#saveMeta();
  }

  #usable(h: Held): boolean {
    const i = h.info;
    const now = this.#now().getTime();
    return (
      h.state === "active" &&
      i !== null &&
      i.status === "ACTIVE" &&
      i.validFrom !== null &&
      i.validTo !== null &&
      Date.parse(i.validFrom) <= now &&
      Date.parse(i.validTo) > now
    );
  }

  /** Действующие подтверждённые ключи — от новейшего по validFrom платформы, при равенстве — по kid. */
  #candidates(): string[] {
    const list = [...this.#held.entries()].filter(([, h]) => this.#usable(h));
    const from = (h: Held): number => (h.info?.validFrom ? Date.parse(h.info.validFrom) : Number.NEGATIVE_INFINITY);
    list.sort(([ka, a], [kb, b]) => (from(b) > from(a) ? 1 : from(b) < from(a) ? -1 : ka < kb ? -1 : ka > kb ? 1 : 0));
    return list.map(([k]) => k);
  }

  #pick(): string {
    const next = this.#candidates()[0];
    if (next === undefined) this.#halt("NO_ACTIVE_KEY");
    return next;
  }

  #switchTo(kid: string): void {
    this.#held.get(kid)!.awaiting = false; // переход на ключ подтверждён сверкой
    if (kid === this.#currentKid) return;
    this.#currentKid = kid;
    this.#record("key.switched", kid);
  }

  /** Другой рабочий ключ, подтверждённый в метаданных действующим (срок идёт): самый поздний valid_from. */
  #confirmedAlternative(exclude: string): string | undefined {
    const now = this.#now().getTime();
    const ok = [...this.#held.entries()]
      .filter(([kid, h]) => {
        const m = this.#meta[kid];
        return kid !== exclude && h.state === "active" && m !== undefined && Date.parse(m.valid_from) <= now && Date.parse(m.valid_to) > now;
      })
      .map(([kid]) => kid);
    ok.sort((a, b) => Date.parse(this.#meta[b]!.valid_from) - Date.parse(this.#meta[a]!.valid_from) || (a < b ? -1 : 1));
    return ok[0];
  }

  /** Метаданные: сроки подтверждённых платформой действующих ключей; сбой записи — остановка. */
  #saveMeta(): void {
    if (this.#closed) throw new SignerStopped("CLOSED");
    const meta: Record<string, { valid_from: string; valid_to: string }> = {};
    for (const [kid, h] of this.#held) if (this.#usable(h)) meta[kid] = { valid_from: h.info!.validFrom!, valid_to: h.info!.validTo! };
    try {
      writeMeta(this.#o.dir, meta);
    } catch (e) {
      this.#halt("KEYSTORE_WRITE_FAILED", e);
    }
  }

  /** Состояние ключа: сначала в памяти, затем в хранилище; переход в revoked пишется в журнал с причиной. */
  #mark(kid: string, to: KeyState, reason?: DiagCode): void {
    const h = this.#held.get(kid)!;
    if (h.state === to) return;
    h.state = to;
    if (to === "revoked") {
      h.awaiting = false; // отозванный ключ не регистрируется повторно
      this.#record("key.revoked", kid, reason);
    }
    this.#write(kid, to);
  }

  /** Запись состояния в хранилище; сбой — расхождение памяти и хранилища: остановка (инвариант 4). */
  #write(kid: string, to: KeyState): void {
    if (this.#closed) throw new SignerStopped("CLOSED"); // каталог мог взять другой процесс
    const h = this.#held.get(kid)!;
    if (h.disk === to) return;
    try {
      markKey(this.#o.dir, kid, h.disk, to);
    } catch (e) {
      this.#halt("KEYSTORE_WRITE_FAILED", e);
    }
    h.disk = to;
  }

  #halt(reason: DiagCode, cause?: unknown, detail?: string): never {
    this.#stop(reason, detail);
    throw new SignerStopped(reason, cause === undefined ? undefined : { cause });
  }

  #record(kind: JournalKind, kid?: string, reason?: DiagCode, detail?: string): void {
    this.#o.journal.record({ at: this.#now().toISOString(), kind, ...(kid && { kid }), ...(reason && { reason }), ...(detail && { detail }) });
  }
}
