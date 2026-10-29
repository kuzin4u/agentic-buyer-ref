// Хранилище ключей подписи: закрытый ключ — PKCS8 в файле `<kid>.pem` с правами 0600 в каталоге 0700, владелец — процесс.
// Закрытый ключ не покидает модуль signer (инвариант 2): наружу — подписант (замыкание) и описатель без ключевого материала.
// Каталог задаёт вызывающий; в тестах — временный каталог, в репозиторий ключи не попадают.
// Модель угроз: родительские компоненты пути и сам каталог 0700 своего uid — доверенные; гонка «каталог подменён ссылкой
// между lstat и open» требует того же uid или root и вне модели (openat в Node нет). Обнуление ключа в памяти — по возможности:
// строку PEM при создании и промежуточные буферы чтения обнулить нельзя.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import type { Signer } from "@kuzin4u/agentic-core";
import { SignerKeyRejected } from "./errors.js";
import { assertKid, kidOf } from "./kid.js";
import { assertStrongEd25519 } from "./weak.js";

/** Описатель ключа: только открытые сведения — можно в журнал и в регистрацию ключа (POST /pao/v1/agent/keys). */
export interface SignerDescriptor {
  readonly kid: string;
  readonly alg: "ed25519";
  /** DER SPKI в обычном base64 — форма public_key ПАО */
  readonly public_key: string;
}

export interface LoadedKey {
  readonly signer: Signer;
  readonly descriptor: SignerDescriptor;
}

// DER SPKI Ed25519: 12 байт заголовка + 32 байта точки (RFC 8410).
const SPKI_HEADER = 12;
const MODE_BITS = 0o7777;

/** Ошибка файловой системы — SignerKeyRejected без пути в сообщении; исходная ошибка — в cause. */
function rejectFs(message: string, e: unknown): never {
  if (e instanceof SignerKeyRejected) throw e;
  throw new SignerKeyRejected(message, { cause: e });
}

/**
 * Состояние ключа хранится в имени файла и переживает перезапуск:
 *  active — `<kid>.pem`: регистрация подтверждена платформой (или ключ внесён оператором при допуске);
 *  pending — `<kid>.pending.pem`: временное имя нового ключа до подтверждения регистрации;
 *  abandoned — `<kid>.abandoned.pem`: временный файл, найденный при старте, — не используется;
 *  revoked — `<kid>.revoked.pem`: отозван или отклонён — не используется.
 * Ключевой материал не удаляется: переименование обратимо вручную.
 */
export type KeyState = "active" | "pending" | "abandoned" | "revoked";
const SUFFIX: Readonly<Record<KeyState, string>> = {
  active: ".pem",
  pending: ".pending.pem",
  abandoned: ".abandoned.pem",
  revoked: ".revoked.pem",
};
const KEY_FILE = /^([A-Za-z0-9_-]{43})(\.pending|\.abandoned|\.revoked)?\.pem$/;
const META_FILE = "keys.meta.json";

const pathOf = (dir: string, kid: string, state: KeyState = "active"): string => {
  assertKid(kid); // до сборки пути: kid вида «../x» или «/x» не должен дойти до файловой системы
  return join(dir, `${kid}${SUFFIX[state]}`);
};

/** Владелец — процесс, права ровно expected (без setuid/sticky и лишних битов); без POSIX-прав (нет getuid) — отказ. */
function assertOwnerOnly(st: Stats, expected: number, what: string): void {
  if (typeof process.getuid !== "function" || st.uid !== process.getuid()) throw new SignerKeyRejected(`${what}: владелец — не процесс агента`);
  if ((st.mode & MODE_BITS) !== expected) throw new SignerKeyRejected(`${what}: права не ${expected.toString(8)}`);
}

/**
 * Каталог ключей: последний компонент — настоящий каталог, не символическая ссылка (resolve снимает завершающий «/»,
 * иначе lstat пошёл бы по ссылке). При create — создаётся с правами 0700; при загрузке не создаётся.
 * Внутри signer — и для каталога ключа TLS (tls.ts); через index.ts наружу не выходит.
 */
export function privateDir(dir: string, create: boolean): string {
  const abs = resolve(dir);
  let st: Stats;
  try {
    if (create) mkdirSync(abs, { recursive: true, mode: 0o700 });
    st = lstatSync(abs);
  } catch (e) {
    rejectFs("каталог ключей недоступен", e);
  }
  if (!st.isDirectory()) throw new SignerKeyRejected("каталог ключей: не каталог или символическая ссылка");
  assertOwnerOnly(st, 0o700, "каталог ключей");
  return abs;
}

/** Описатель и подписант из закрытого ключа; ключ проверяется заново — на слабость и на совпадение kid. */
function fromPrivate(privateKey: KeyObject, expectedKid?: string): LoadedKey {
  if (privateKey.asymmetricKeyType !== "ed25519") throw new SignerKeyRejected("ключ не Ed25519");
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  assertStrongEd25519(der.subarray(SPKI_HEADER));
  const public_key = der.toString("base64");
  const kid = kidOf(public_key);
  if (expectedKid !== undefined && kid !== expectedKid) throw new SignerKeyRejected("kid ключа не совпадает с именем файла");
  const descriptor: SignerDescriptor = Object.freeze({ kid, alg: "ed25519", public_key });
  const signer: Signer = Object.freeze({ kid, alg: "ed25519", sign: (data: Buffer) => sign(null, data, privateKey) });
  return Object.freeze({ signer, descriptor });
}

/** Новая пара Ed25519; закрытый ключ записывается в каталог (O_EXCL: существующий файл или ссылка — отказ). */
export function generateKey(dir: string, state: "active" | "pending" = "active"): LoadedKey {
  const abs = privateDir(dir, true);
  const { privateKey } = generateKeyPairSync("ed25519");
  const loaded = fromPrivate(privateKey);
  const path = pathOf(abs, loaded.descriptor.kid, state);
  try {
    writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  } catch (e) {
    rejectFs("файл ключа не создан", e);
  }
  return loaded;
}

/** Чтение файла хранилища: обычный файл, владелец — процесс, права 0600; null — файла нет (если допустимо). */
export function readOwnerFile(path: string, what: string, missingOk = false): Buffer | null {
  let fd: number | undefined;
  try {
    // O_NOFOLLOW и проверка по дескриптору: между проверкой и чтением файл не подменить ссылкой;
    // O_NONBLOCK: FIFO на месте файла не подвешивает открытие, а отсекается проверкой «обычный файл».
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SignerKeyRejected(`${what}: не обычный файл`);
    assertOwnerOnly(st, 0o600, what);
    return readFileSync(fd);
  } catch (e) {
    if (missingOk && (e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return rejectFs(`${what} не читается`, e);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ошибка закрытия не перекрывает основную; успешное чтение уже в буфере
      }
    }
  }
}

/** Ключ из каталога по kid; не обычный файл, ссылка, чужой владелец, права не 0600, повреждённый PEM, чужой kid — отказ. */
export function loadKey(dir: string, kid: string, state: "active" | "pending" = "active"): LoadedKey {
  const path = pathOf(resolve(dir), kid, state);
  privateDir(dir, false);
  const pem = readOwnerFile(path, "файл ключа")!;
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
  } catch {
    throw new SignerKeyRejected("файл ключа не разбирается как PKCS8");
  } finally {
    pem.fill(0);
  }
  return fromPrivate(privateKey, kid);
}

// Порядок жизненного цикла: при нескольких файлах одного kid (сбой между link и unlink, восстановленная копия)
// берётся самое позднее состояние — отозванный ключ не воскресает.
const LIFECYCLE: readonly KeyState[] = ["pending", "abandoned", "active", "revoked"];

/** Ключи каталога — по одной записи на kid; прочие файлы не рассматриваются. */
export function listKeys(dir: string): { kid: string; state: KeyState }[] {
  const abs = privateDir(dir, false);
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch (e) {
    rejectFs("каталог ключей не читается", e);
  }
  const byKid = new Map<string, KeyState>();
  for (const m of names.map((n) => KEY_FILE.exec(n))) {
    if (m === null) continue;
    const kid = m[1]!;
    assertKid(kid);
    const state: KeyState = m[2] === ".pending" ? "pending" : m[2] === ".abandoned" ? "abandoned" : m[2] === ".revoked" ? "revoked" : "active";
    const prev = byKid.get(kid);
    if (prev === undefined || LIFECYCLE.indexOf(state) > LIFECYCLE.indexOf(prev)) byKid.set(kid, state);
  }
  return [...byKid.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([kid, state]) => ({ kid, state }));
}

/**
 * Смена состояния ключа: жёсткая ссылка под новым именем (атомарно, EEXIST — без перезаписи), затем удаление старого
 * имени. Сбой между шагами оставляет оба файла — listKeys возьмёт более позднее состояние. Один процесс на каталог.
 */
export function markKey(dir: string, kid: string, from: KeyState, to: KeyState): void {
  const abs = privateDir(dir, false);
  const src = pathOf(abs, kid, from);
  const dst = pathOf(abs, kid, to);
  try {
    linkSync(src, dst);
    unlinkSync(src);
  } catch (e) {
    rejectFs("состояние ключа не записано", e);
  }
}

/**
 * Метаданные хранилища: сроки ключей, которые платформа подтвердила действующими (GET /pao/v1/agent). По ним при старте
 * выбирается ключ допуска (самый поздний valid_from) и ключ для одного перехода при AGENT_KEY_REVOKED на допуске.
 * Только открытые сведения; файл 0600 рядом с ключами.
 */
export type KeyMeta = Readonly<Record<string, { readonly valid_from: string; readonly valid_to: string }>>;

export function readMeta(dir: string): KeyMeta {
  const abs = privateDir(dir, false);
  const raw = readOwnerFile(join(abs, META_FILE), "метаданные ключей", true);
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new SignerKeyRejected("метаданные ключей не разбираются");
  }
  if (typeof parsed !== "object" || parsed === null) throw new SignerKeyRejected("метаданные ключей: не объект");
  const { version, confirmed } = parsed as { version?: unknown; confirmed?: unknown };
  if (version !== 1 || typeof confirmed !== "object" || confirmed === null) {
    throw new SignerKeyRejected("метаданные ключей: неизвестная схема");
  }
  const out: Record<string, { valid_from: string; valid_to: string }> = {};
  for (const [kid, v] of Object.entries(confirmed)) {
    assertKid(kid);
    const { valid_from: from, valid_to: to } = (v ?? {}) as { valid_from?: unknown; valid_to?: unknown };
    if (typeof from !== "string" || Number.isNaN(Date.parse(from))) throw new SignerKeyRejected("метаданные ключей: valid_from не дата");
    if (typeof to !== "string" || Number.isNaN(Date.parse(to))) throw new SignerKeyRejected("метаданные ключей: valid_to не дата");
    out[kid] = { valid_from: from, valid_to: to };
  }
  return out;
}

/** Запись метаданных: временный файл (wx, 0600), затем переименование поверх прежнего. */
export function writeMeta(dir: string, meta: KeyMeta): void {
  const abs = privateDir(dir, false);
  for (const kid of Object.keys(meta)) assertKid(kid);
  const tmp = join(abs, `${META_FILE}.${process.pid}.tmp`);
  try {
    try {
      unlinkSync(tmp); // остаток прерванной записи
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    writeFileSync(tmp, JSON.stringify({ version: 1, confirmed: meta }), { mode: 0o600, flag: "wx" });
    renameSync(tmp, join(abs, META_FILE));
  } catch (e) {
    rejectFs("метаданные ключей не записаны", e);
  }
}

/** Лишние имена одного kid (сбой между link и unlink, восстановленная копия): остаётся только имя состояния keep. */
export function pruneKey(dir: string, kid: string, keep: KeyState): void {
  const abs = privateDir(dir, false);
  for (const state of LIFECYCLE) {
    if (state === keep) continue;
    try {
      unlinkSync(pathOf(abs, kid, state));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") rejectFs("лишнее имя ключа не удалено", e);
    }
  }
}

const LOCK_FILE = ".lock";
/** Блокировки, взятые этим процессом: свой pid в чужом (не взятом здесь) файле — след прошлого запуска с тем же pid. */
const HELD_LOCKS = new Set<string>();

/** Каталог ключей занят живым процессом. */
export class KeystoreLocked extends SignerKeyRejected {
  override readonly name: string = "KeystoreLocked";
}

/**
 * Один процесс на каталог ключей. Блокировка ставится атомарно: файл с pid пишется под уникальным временным именем
 * и связывается жёсткой ссылкой в `.lock` (EEXIST — занято), поэтому `.lock` никогда не бывает пустым или недописанным.
 * Занят живым процессом — KeystoreLocked. Брошен упавшим процессом (pid мёртв или это свой pid прошлого запуска) —
 * перехватывается: `.lock` переименовывается в уникальное имя, pid перечитывается; если за это время блокировку
 * взял живой процесс — она возвращается на место и отказ. Пустой или нечисловой `.lock` — занято (снимается вручную).
 */
export function lockDir(dir: string): () => void {
  const abs = privateDir(dir, false);
  const path = join(abs, LOCK_FILE);
  const mine = String(process.pid);
  const unique = (tag: string) => join(abs, `${LOCK_FILE}.${tag}.${process.pid}.${randomUUID()}`);
  const tmp = unique("new");
  try {
    writeFileSync(tmp, mine, { mode: 0o600, flag: "wx" });
  } catch (e) {
    rejectFs("каталог ключей не заблокирован", e);
  }
  const holderOf = (p: string): string | undefined => readOwnerFile(p, "блокировка каталога ключей", true)?.toString("utf8");
  const stale = (holder: string | undefined): boolean => {
    if (holder === undefined) return true; // файл исчез — повторить
    const pid = Number(holder);
    if (!/^[1-9][0-9]*$/.test(holder)) return false;
    if (holder === mine) return !HELD_LOCKS.has(path);
    return !alive(pid);
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(tmp, path);
        HELD_LOCKS.add(path);
        return () => {
          HELD_LOCKS.delete(path);
          try {
            if (holderOf(path) === mine) unlinkSync(path);
          } catch {
            // освобождение не перекрывает основную ошибку
          }
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") rejectFs("каталог ключей не заблокирован", e);
      }
      if (!stale(holderOf(path))) throw new KeystoreLocked("каталог ключей занят другим процессом");
      const moved = unique("stale");
      try {
        renameSync(path, moved);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        rejectFs("брошенная блокировка не снята", e);
      }
      if (!stale(holderOf(moved))) {
        // между проверкой и переименованием блокировку взял живой процесс — вернуть её на место
        try {
          linkSync(moved, path);
        } catch {
          // место уже занято — тем более занято
        }
        try {
          dropFile(moved);
        } catch {
          // каталог занят в любом случае: причина отказа — блокировка, а не сбой удаления
        }
        throw new KeystoreLocked("каталог ключей занят другим процессом");
      }
      dropFile(moved);
    }
    throw new KeystoreLocked("каталог ключей не удалось заблокировать");
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // временное имя уже удалено
    }
  }
}

function dropFile(p: string): void {
  try {
    unlinkSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") rejectFs("брошенная блокировка не снята", e);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
