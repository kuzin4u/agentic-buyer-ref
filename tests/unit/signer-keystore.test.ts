import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { ed25519Verifier } from "@kuzin4u/agentic-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignerKeyRejected, generateKey, kidOf, listKeys, loadKey } from "../../src/agent/signer/index.js";
import { markKey, readMeta, writeMeta } from "../../src/agent/signer/keystore.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buyref-keys-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mode = (p: string): number => statSync(p).mode & 0o777;
const fileOf = (kid: string): string => join(dir, `${kid}.pem`);

describe("хранилище ключей: создание и загрузка (Т1, инвариант 2)", () => {
  it("создание: файл <kid>.pem PKCS8 с правами 0600, каталог 0700, kid по RFC 7638", () => {
    const { descriptor } = generateKey(dir);
    expect(descriptor.kid).toBe(kidOf(descriptor.public_key));
    expect(descriptor.alg).toBe("ed25519");
    expect(readdirSync(dir)).toEqual([`${descriptor.kid}.pem`]);
    expect(mode(fileOf(descriptor.kid))).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    const key = createPrivateKey({ key: readFileSync(fileOf(descriptor.kid)), format: "pem", type: "pkcs8" });
    expect(key.asymmetricKeyType).toBe("ed25519");
  });

  it("подпись проверяется открытым ключом описателя; загруженный ключ подписывает тем же ключом", () => {
    const made = generateKey(dir);
    const loaded = loadKey(dir, made.descriptor.kid);
    expect(loaded.descriptor).toEqual(made.descriptor);
    expect(loaded.signer).toMatchObject({ kid: made.descriptor.kid, alg: "ed25519" });
    const data = Buffer.from("@method: GET");
    for (const s of [made.signer, loaded.signer]) {
      expect(ed25519Verifier.verify("ed25519", made.descriptor.public_key, data, s.sign(data))).toBe(true);
    }
  });

  it("описатель и подписант не содержат закрытого ключа (JSON, inspect)", () => {
    const { signer, descriptor } = generateKey(dir);
    const pem = readFileSync(fileOf(descriptor.kid), "utf8");
    const header = pem.split("\n")[0]!;
    const d = createPrivateKey(pem).export({ format: "jwk" }).d!;
    const body = pem.split("\n").slice(1, -2).join("");
    for (const shown of [JSON.stringify(descriptor), JSON.stringify(signer), inspect(signer, { depth: 5, showHidden: true }), inspect(descriptor)]) {
      expect(shown).not.toContain(d);
      expect(shown).not.toContain(body);
      expect(shown).not.toContain(header);
    }
    expect(Object.keys(descriptor).sort()).toEqual(["alg", "kid", "public_key"]);
    expect(Object.keys(signer).sort()).toEqual(["alg", "kid", "sign"]);
    expect(Object.isFrozen(descriptor) && Object.isFrozen(signer)).toBe(true);
  });
});

describe("хранилище ключей: fail-closed при загрузке (инвариант 4)", () => {
  it("права файла не ровно 0600 — SignerKeyRejected с причиной в сообщении", () => {
    const { descriptor } = generateKey(dir);
    for (const m of [0o644, 0o640, 0o604, 0o660, 0o700, 0o400, 0o4600]) {
      chmodSync(fileOf(descriptor.kid), m);
      expect(() => loadKey(dir, descriptor.kid)).toThrow(SignerKeyRejected);
      expect(() => loadKey(dir, descriptor.kid)).toThrow(/права не 600/);
    }
  });

  it("каталог доступен не только владельцу — SignerKeyRejected и при загрузке, и при создании", () => {
    const { descriptor } = generateKey(dir);
    chmodSync(dir, 0o755);
    expect(() => loadKey(dir, descriptor.kid)).toThrow(SignerKeyRejected);
    expect(() => generateKey(dir)).toThrow(SignerKeyRejected);
  });

  it("каталог — символическая ссылка (в том числе с завершающим «/») — SignerKeyRejected", () => {
    const real = join(dir, "real");
    const { descriptor } = generateKey(real);
    const link = join(dir, "link");
    symlinkSync(real, link);
    for (const d of [link, `${link}/`]) {
      expect(() => generateKey(d)).toThrow(SignerKeyRejected);
      expect(() => loadKey(d, descriptor.kid)).toThrow(SignerKeyRejected);
    }
    expect(readdirSync(real)).toHaveLength(1);
  });

  it("загрузка из отсутствующего каталога каталог не создаёт", () => {
    const missing = join(dir, "нет");
    expect(() => loadKey(missing, "A".repeat(43))).toThrow(SignerKeyRejected);
    expect(existsSync(missing)).toBe(false);
  });

  it("путь каталога — файл: SignerKeyRejected, а не ошибка файловой системы", () => {
    const file = join(dir, "file");
    writeFileSync(file, "");
    expect(() => generateKey(file)).toThrow(SignerKeyRejected);
    expect(() => loadKey(file, "A".repeat(43))).toThrow(SignerKeyRejected);
  });

  it("на месте файла — FIFO или каталог: SignerKeyRejected без зависания", () => {
    const fifo = generateKey(dir).descriptor.kid;
    rmSync(fileOf(fifo));
    execFileSync("mkfifo", ["-m", "600", fileOf(fifo)]);
    expect(() => loadKey(dir, fifo)).toThrow(SignerKeyRejected);

    const sub = generateKey(dir).descriptor.kid;
    rmSync(fileOf(sub));
    mkdirSync(fileOf(sub), { mode: 0o700 });
    expect(() => loadKey(dir, sub)).toThrow(SignerKeyRejected);
  });

  it("файл подменён другим ключом (kid не совпал) — SignerKeyRejected", () => {
    const a = generateKey(dir);
    const b = generateKey(dir);
    writeFileSync(fileOf(a.descriptor.kid), readFileSync(fileOf(b.descriptor.kid)), { mode: 0o600 });
    expect(() => loadKey(dir, a.descriptor.kid)).toThrow(SignerKeyRejected);
  });

  it("повреждённый файл, ключ не Ed25519, отсутствующий файл, символическая ссылка — SignerKeyRejected", () => {
    const { descriptor } = generateKey(dir);
    writeFileSync(fileOf(descriptor.kid), "не PEM");
    expect(() => loadKey(dir, descriptor.kid)).toThrow(SignerKeyRejected);

    writeFileSync(fileOf(descriptor.kid), generateKeyPairSync("x25519").privateKey.export({ type: "pkcs8", format: "pem" }));
    expect(() => loadKey(dir, descriptor.kid)).toThrow(SignerKeyRejected);

    const other = generateKey(dir).descriptor.kid;
    rmSync(fileOf(other));
    expect(() => loadKey(dir, other)).toThrow(SignerKeyRejected);

    const real = generateKey(dir).descriptor.kid;
    const target = join(dir, "target.pem");
    writeFileSync(target, readFileSync(fileOf(real)), { mode: 0o600 });
    rmSync(fileOf(real));
    symlinkSync(target, fileOf(real));
    expect(() => loadKey(dir, real)).toThrow(SignerKeyRejected);
    // исходная ошибка ФС — в cause, без пути в сообщении
    expect(() => loadKey(dir, real)).toThrow(expect.objectContaining({ cause: expect.objectContaining({ code: "ELOOP" }) }));
    expect(() => loadKey(dir, real)).not.toThrow(new RegExp(dir));
  });
});

describe("состояние ключа в хранилище: listKeys и markKey", () => {
  it("смена состояния: файл переходит под новое имя, права сохраняются; listKeys — по одной записи на kid", () => {
    const { descriptor } = generateKey(dir, "pending");
    expect(listKeys(dir)).toEqual([{ kid: descriptor.kid, state: "pending" }]);
    markKey(dir, descriptor.kid, "pending", "active");
    expect(readdirSync(dir)).toEqual([`${descriptor.kid}.pem`]);
    expect(mode(fileOf(descriptor.kid))).toBe(0o600);
    expect(() => loadKey(dir, descriptor.kid)).not.toThrow();
  });

  it("целевой файл уже есть — SignerKeyRejected, исходный не тронут", () => {
    const { descriptor } = generateKey(dir);
    writeFileSync(join(dir, `${descriptor.kid}.revoked.pem`), "занято", { mode: 0o600 });
    expect(() => markKey(dir, descriptor.kid, "active", "revoked")).toThrow(SignerKeyRejected);
    expect(existsSync(fileOf(descriptor.kid))).toBe(true);
    expect(readFileSync(join(dir, `${descriptor.kid}.revoked.pem`), "utf8")).toBe("занято");
  });

  it("исходного файла нет, kid вне формы, каталог-ссылка или с широкими правами — SignerKeyRejected", () => {
    const { descriptor } = generateKey(dir);
    expect(() => markKey(dir, descriptor.kid, "pending", "active")).toThrow(SignerKeyRejected);
    expect(() => markKey(dir, "../x", "active", "revoked")).toThrow(SignerKeyRejected);
    const link = join(dir, "..", `link-${descriptor.kid.slice(0, 8)}`);
    symlinkSync(dir, link);
    try {
      expect(() => markKey(link, descriptor.kid, "active", "revoked")).toThrow(SignerKeyRejected);
      expect(() => listKeys(link)).toThrow(SignerKeyRejected);
    } finally {
      rmSync(link);
    }
    chmodSync(dir, 0o755);
    expect(() => listKeys(dir)).toThrow(SignerKeyRejected);
    chmodSync(dir, 0o700);
  });

  it("два файла одного kid — берётся более позднее состояние жизненного цикла, а не порядок каталога", () => {
    const { descriptor } = generateKey(dir, "pending");
    copyFileSync(join(dir, `${descriptor.kid}.pending.pem`), fileOf(descriptor.kid)); // сбой между link и unlink
    expect(listKeys(dir)).toEqual([{ kid: descriptor.kid, state: "active" }]);
    copyFileSync(fileOf(descriptor.kid), join(dir, `${descriptor.kid}.revoked.pem`));
    expect(listKeys(dir)).toEqual([{ kid: descriptor.kid, state: "revoked" }]);
  });

  it("метаданные: запись и чтение; неизвестная схема, не дата, kid вне формы, права шире 0600 — SignerKeyRejected", () => {
    const kid = "A".repeat(43);
    expect(readMeta(dir)).toEqual({});
    const entry = { valid_from: "2026-10-01T00:00:00Z", valid_to: "2026-12-30T00:00:00Z" };
    writeMeta(dir, { [kid]: entry });
    expect(readMeta(dir)).toEqual({ [kid]: entry });
    expect(mode(join(dir, "keys.meta.json"))).toBe(0o600);
    const bad = (body: unknown) => {
      writeFileSync(join(dir, "keys.meta.json"), JSON.stringify(body), { mode: 0o600 });
      expect(() => readMeta(dir)).toThrow(SignerKeyRejected);
    };
    bad(null);
    bad({ version: 2, confirmed: {} });
    bad({ version: 1 });
    bad({ version: 1, confirmed: { [kid]: { valid_from: "не дата", valid_to: "2026-12-30T00:00:00Z" } } });
    bad({ version: 1, confirmed: { [kid]: { valid_from: "2026-10-01T00:00:00Z" } } });
    bad({ version: 1, confirmed: { [kid]: {} } });
    bad({ version: 1, confirmed: { "../x": entry } });
    writeMeta(dir, {});
    chmodSync(join(dir, "keys.meta.json"), 0o644);
    expect(() => readMeta(dir)).toThrow(SignerKeyRejected);
  });

  it("прочие файлы каталога не считаются ключами", () => {
    writeFileSync(join(dir, "readme.txt"), "");
    writeFileSync(join(dir, `${"A".repeat(43)}.old.pem`), "");
    expect(listKeys(dir)).toEqual([]);
  });
});
