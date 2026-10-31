// Граница набора соответствия (AG-20, Р67 п. 1): tests/conformance/suite.ts и всё, что он подключает транзитивно, не
// доходит до тестового контура, адаптеров и места сборки — набор проверяет любой адаптер только через порт.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(".");
const SUITE = resolve(ROOT, "tests/conformance/suite.ts");
const rel = (f: string) => f.slice(ROOT.length + 1);
/** Прямые импорты набора из проекта — ровно эти (нюансы К1.2, К1.3 к Р67 п. 1): порт, доменные типы, способы оплаты
 *  агента и словарь кодов отказа ядра (SPEC §7а). */
const ALLOWED = ["src/agent/declines/table.ts", "src/agent/policy/channels.ts", "src/agent/ports/index.ts", "src/shared/domain.ts"];
const FORBIDDEN: readonly [RegExp, string][] = [
  [/^tests\/support\/contour\.ts$/, "тестовый контур"],
  [/^src\/agent\/adapters\//, "адаптер"],
  [/^src\/agent\/compose\.ts$/, "место сборки"],
];

const opts = ts.parseJsonConfigFileContent(ts.readConfigFile(resolve(ROOT, "tsconfig.json"), ts.sys.readFile).config, ts.sys, ROOT).options;

/** Файлы проекта, которые `file` подключает напрямую (import / export from / import() строковым литералом). */
function direct(file: string, read: (f: string) => string): string[] {
  return ts
    .preProcessFile(read(file), true, true)
    .importedFiles.map((i) => ts.resolveModuleName(i.fileName, file, opts, ts.sys).resolvedModule)
    .filter((r) => r !== undefined && r.isExternalLibraryImport !== true && r.resolvedFileName.startsWith(ROOT + "/"))
    .map((r) => r!.resolvedFileName);
}

/** Транзитивные файлы проекта, которые подключает `entry`. */
function closure(entry: string, read: (f: string) => string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...direct(file, read));
  }
  return [...seen].map(rel).sort();
}

const violations = (files: readonly string[]) => files.flatMap((f) => FORBIDDEN.filter(([re]) => re.test(f)).map(([, what]) => `${f} — ${what}`));

describe("граница набора соответствия (Р67 п. 1)", () => {
  it("прямые импорты suite.ts из проекта — ровно порт, shared/domain, policy/channels и declines/table (нюансы К1.2, К1.3)", () => {
    expect([...new Set(direct(SUITE, (f) => readFileSync(f, "utf8")).map(rel))].sort()).toEqual(ALLOWED);
  });

  it("suite.ts транзитивно не подключает contour, adapters/* и compose", () => {
    const files = closure(SUITE, (f) => readFileSync(f, "utf8"));
    expect(files).toContain("src/agent/ports/payment-platform.ts");
    expect(violations(files)).toEqual([]);
  });

  it("проверка ловит запрещённое ребро и через промежуточный модуль", () => {
    const shared = resolve(ROOT, "src/shared/domain.ts");
    const read = (f: string) => {
      if (f === SUITE) return `import "../../src/shared/domain.js";`;
      if (f === shared) return `import "../agent/compose.js";`;
      return "";
    };
    expect(violations(closure(SUITE, read))).toEqual(["src/agent/compose.ts — место сборки"]);
  });
});
