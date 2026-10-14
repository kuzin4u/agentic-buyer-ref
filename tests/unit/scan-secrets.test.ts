// Сканер ключей и реквизитов (.claude/hooks/scan_secrets.py, шаг CI «Поиск ключей и реквизитов») видит все расширения
// исходников, которые допускают границы src — .ts/.mts/.cts/.tsx и .js/.mjs/.cjs (AG-04 К2.1б, ревью К2.1 № 1).
// Закрытый ключ создаётся при прогоне во временном каталоге и в репозиторий не попадает (раздел «Секреты» CLAUDE.md).
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCANNER = join(process.cwd(), ".claude/hooks/scan_secrets.py");
const EXTS = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs"];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("сканер ключей и реквизитов", () => {
  it.each(EXTS)("файл %s проверяется: закрытый ключ находится", (ext) => {
    const dir = mkdtempSync(join(tmpdir(), "buyref-scan-ext-"));
    dirs.push(dir);
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(join(dir, `probe${ext}`), `export const k = \`${privateKey.export({ type: "pkcs8", format: "pem" }).toString()}\`;\n`);
    const r = spawnSync("python3", [SCANNER, dir], { encoding: "utf8" });
    expect(r.stdout).toContain(`probe${ext}: приватный ключ`);
    expect(r.status).toBe(1);
  });
});
