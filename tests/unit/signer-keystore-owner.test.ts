// Случаи, которые без подмены модулей не воспроизвести: тот же ключ дважды (флаг wx) и чужой владелец файла и каталога.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ fixedPair: undefined as unknown, foreign: "none" as "none" | "dir" | "file", fsCalls: 0 }));

vi.mock("node:crypto", async (orig) => {
  const m = await orig<typeof import("node:crypto")>();
  const generateKeyPairSync = ((...a: Parameters<typeof m.generateKeyPairSync>) =>
    fake.fixedPair ?? m.generateKeyPairSync(...(a as [never]))) as typeof m.generateKeyPairSync;
  return { ...m, generateKeyPairSync };
});

vi.mock("node:fs", async (orig) => {
  const m = await orig<typeof import("node:fs")>();
  const foreign = <T extends { uid: number }>(st: T, who: "dir" | "file"): T =>
    fake.foreign === who ? Object.assign(st, { uid: st.uid + 1 }) : st;
  const counted = <F extends (...a: never[]) => unknown>(f: F): F =>
    ((...a: Parameters<F>) => (fake.fsCalls++, f(...a))) as F;
  return {
    ...m,
    mkdirSync: counted(m.mkdirSync),
    openSync: counted(m.openSync),
    readFileSync: counted(m.readFileSync),
    lstatSync: ((...a: Parameters<typeof m.lstatSync>) => (fake.fsCalls++, foreign(m.lstatSync(...a) as never, "dir"))) as typeof m.lstatSync,
    fstatSync: ((...a: Parameters<typeof m.fstatSync>) => foreign(m.fstatSync(...a) as never, "file")) as typeof m.fstatSync,
  };
});

const { generateKeyPairSync } = await import("node:crypto");
const { SignerKeyRejected, generateKey, loadKey } = await import("../../src/agent/signer/index.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buyref-keys-"));
  fake.fixedPair = undefined;
  fake.foreign = "none";
  fake.fsCalls = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("хранилище ключей: существующий файл и владелец (инварианты 2, 4)", () => {
  it("тот же ключ второй раз — SignerKeyRejected, файл не перезаписан (флаг wx)", () => {
    fake.fixedPair = generateKeyPairSync("ed25519");
    const { descriptor } = generateKey(dir);
    const file = join(dir, `${descriptor.kid}.pem`);
    writeFileSync(file, "маркер", { mode: 0o600 }); // при флаге «w» маркер был бы затёрт тем же ключом
    expect(() => generateKey(dir)).toThrow(SignerKeyRejected);
    expect(() => generateKey(dir)).toThrow(expect.objectContaining({ cause: expect.objectContaining({ code: "EEXIST" }) }));
    expect(readFileSync(file, "utf8")).toBe("маркер");
  });

  it("владелец каталога — не процесс агента: SignerKeyRejected при загрузке и создании", () => {
    const { descriptor } = generateKey(dir);
    fake.foreign = "dir";
    expect(() => loadKey(dir, descriptor.kid)).toThrow(SignerKeyRejected);
    expect(() => loadKey(dir, descriptor.kid)).toThrow(/владелец/);
    expect(() => generateKey(dir)).toThrow(SignerKeyRejected);
  });

  it("владелец файла — не процесс агента (каталог свой): SignerKeyRejected", () => {
    const { descriptor } = generateKey(dir);
    fake.foreign = "file";
    expect(() => loadKey(dir, descriptor.kid)).toThrow(SignerKeyRejected);
  });

  it.each([
    ["«../»", "../" + "A".repeat(40)],
    ["«/»", "/" + "A".repeat(42)],
    ["пустой", ""],
    ["44 символа", "A".repeat(44)],
  ])("kid %s — SignerKeyRejected без единого обращения к файловой системе", (_name, kid) => {
    expect(() => loadKey(dir, kid)).toThrow(SignerKeyRejected);
    expect(fake.fsCalls).toBe(0);
  });
});
