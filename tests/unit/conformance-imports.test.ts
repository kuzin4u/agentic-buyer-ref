// Граница набора соответствия (AG-20, Р67 п. 1): tests/conformance/suite.ts и всё, что он подключает транзитивно, не
// доходит до тестового контура, адаптеров и места сборки — набор проверяет любой адаптер только через порт.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(".");
const SUITE = resolve(ROOT, "tests/conformance/suite.ts");
const rel = (f: string) => f.slice(ROOT.length + 1);
const FORBIDDEN: readonly [RegExp, string][] = [
  [/^tests\/support\/contour\.ts$/, "тестовый контур"],
  [/^src\/agent\/adapters\//, "адаптер"],
  [/^src\/agent\/compose\.ts$/, "место сборки"],
];

const opts = ts.parseJsonConfigFileContent(ts.readConfigFile(resolve(ROOT, "tsconfig.json"), ts.sys.readFile).config, ts.sys, ROOT).options;

/** Транзитивные файлы проекта, которые подключает `entry` (import / export from / import() строковым литералом). */
function closure(entry: string, read: (f: string) => string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of ts.preProcessFile(read(file), true, true).importedFiles.map((i) => i.fileName)) {
      const r = ts.resolveModuleName(spec, file, opts, ts.sys).resolvedModule;
      if (r === undefined || r.isExternalLibraryImport === true) continue;
      if (r.resolvedFileName.startsWith(ROOT + "/")) queue.push(r.resolvedFileName);
    }
  }
  return [...seen].map(rel).sort();
}

const violations = (files: readonly string[]) => files.flatMap((f) => FORBIDDEN.filter(([re]) => re.test(f)).map(([, what]) => `${f} — ${what}`));

describe("граница набора соответствия (Р67 п. 1)", () => {
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
