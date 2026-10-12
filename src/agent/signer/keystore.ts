// Хранилище ключей подписи: закрытый ключ — PKCS8 в файле `<kid>.pem` с правами 0600 в каталоге 0700, владелец — процесс.
// Закрытый ключ не покидает модуль signer (инвариант 2): наружу — подписант (замыкание) и описатель без ключевого материала.
// Каталог задаёт вызывающий; в тестах — временный каталог, в репозиторий ключи не попадают.
// Модель угроз: родительские компоненты пути и сам каталог 0700 своего uid — доверенные; гонка «каталог подменён ссылкой
// между lstat и open» требует того же uid или root и вне модели (openat в Node нет). Обнуление ключа в памяти — по возможности:
// строку PEM при создании и промежуточные буферы чтения обнулить нельзя.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync, type Stats } from "node:fs";
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

const pathOf = (dir: string, kid: string): string => {
  assertKid(kid); // до сборки пути: kid вида «../x» или «/x» не должен дойти до файловой системы
  return join(dir, `${kid}.pem`);
};

/** Владелец — процесс, права ровно expected (без setuid/sticky и лишних битов); без POSIX-прав (нет getuid) — отказ. */
function assertOwnerOnly(st: Stats, expected: number, what: string): void {
  if (typeof process.getuid !== "function" || st.uid !== process.getuid()) throw new SignerKeyRejected(`${what}: владелец — не процесс агента`);
  if ((st.mode & MODE_BITS) !== expected) throw new SignerKeyRejected(`${what}: права не ${expected.toString(8)}`);
}

/**
 * Каталог ключей: последний компонент — настоящий каталог, не символическая ссылка (resolve снимает завершающий «/»,
 * иначе lstat пошёл бы по ссылке). При create — создаётся с правами 0700; при загрузке не создаётся.
 */
function privateDir(dir: string, create: boolean): string {
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
export function generateKey(dir: string): LoadedKey {
  const abs = privateDir(dir, true);
  const { privateKey } = generateKeyPairSync("ed25519");
  const loaded = fromPrivate(privateKey);
  const path = pathOf(abs, loaded.descriptor.kid);
  try {
    writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  } catch (e) {
    rejectFs("файл ключа не создан", e);
  }
  return loaded;
}

/** Ключ из каталога по kid; не обычный файл, ссылка, чужой владелец, права не 0600, повреждённый PEM, чужой kid — отказ. */
export function loadKey(dir: string, kid: string): LoadedKey {
  const path = pathOf(resolve(dir), kid);
  privateDir(dir, false);
  let pem: Buffer;
  let fd: number | undefined;
  try {
    // O_NOFOLLOW и проверка по дескриптору: между проверкой и чтением файл не подменить ссылкой;
    // O_NONBLOCK: FIFO на месте файла не подвешивает открытие, а отсекается проверкой «обычный файл».
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SignerKeyRejected("файл ключа: не обычный файл");
    assertOwnerOnly(st, 0o600, "файл ключа");
    pem = readFileSync(fd);
  } catch (e) {
    rejectFs("файл ключа не читается", e);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ошибка закрытия не перекрывает основную; успешное чтение уже в буфере
      }
    }
  }
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
