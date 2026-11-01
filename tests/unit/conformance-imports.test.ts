// Граница набора соответствия (AG-20, Р67 п. 1): tests/conformance/suite.ts и всё, что он подключает транзитивно, не
// доходит до тестового контура, адаптеров и места сборки — набор проверяет любой адаптер только через порт. Граф строится
// по строковым литералам; то, что он не видит, — красный (КТ1 № 12 (б, в)): нераспознанный модуль, import() не литералом,
// require и createRequire. Встроенные модули Node — не файлы проекта.
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
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

/** Нарушения, которые граф по литералам не видит (КТ1 № 12), копятся в `found`: модуль не распознан — ребро неизвестно;
 *  загрузка не литералом (`import()` с выражением, `require`, `createRequire`) — ребро не проверить. Обе — красный.
 *  Загрузки модулей, путь которых не строковый литерал, и `require` / `createRequire` в любом виде. */
function opaqueLoads(file: string, src: string): string[] {
  const out: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const arg = n.arguments[0];
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword && (arg === undefined || !ts.isStringLiteral(arg))) out.push(`${rel(file)} — import() не литералом`);
      if (ts.isIdentifier(n.expression) && n.expression.text === "require") out.push(`${rel(file)} — require`);
    }
    if (ts.isIdentifier(n) && n.text === "createRequire") out.push(`${rel(file)} — createRequire`);
    ts.forEachChild(n, walk);
  };
  walk(ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true));
  return [...new Set(out)];
}

/** Файлы проекта, которые `file` подключает напрямую (import / export from / import() строковым литералом); нераспознанный
 *  модуль и загрузка не литералом — в `problems`. */
function direct(file: string, read: (f: string) => string, found: string[]): string[] {
  const src = read(file);
  found.push(...opaqueLoads(file, src));
  const out: string[] = [];
  for (const i of ts.preProcessFile(src, true, true).importedFiles) {
    // встроенные модули Node (node:fs, node:util) — не файлы проекта; resolveModuleName их не распознаёт
    if (isBuiltin(i.fileName)) continue;
    const r = ts.resolveModuleName(i.fileName, file, opts, ts.sys).resolvedModule;
    if (r === undefined) found.push(`${rel(file)} — нераспознанный модуль ${i.fileName}`);
    else if (r.isExternalLibraryImport !== true && r.resolvedFileName.startsWith(ROOT + "/")) out.push(r.resolvedFileName);
  }
  return out;
}

/** Транзитивные файлы проекта, которые подключает `entry`. */
function closure(entry: string, read: (f: string) => string, found: string[]): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...direct(file, read, found));
  }
  return [...seen].map(rel).sort();
}

/** Внешние пакеты, которые `suite.ts` подключает напрямую (не относительные спецификаторы). */
const external = (file: string) =>
  [...new Set(ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles.map((i) => i.fileName).filter((n) => !n.startsWith(".")))].sort();

const violations = (files: readonly string[]) => files.flatMap((f) => FORBIDDEN.filter(([re]) => re.test(f)).map(([, what]) => `${f} — ${what}`));

describe("граница набора соответствия (Р67 п. 1)", () => {
  it("прямые импорты suite.ts из проекта — ровно порт, shared/domain, policy/channels и declines/table (нюансы К1.2, К1.3)", () => {
    expect([...new Set(direct(SUITE, (f) => readFileSync(f, "utf8"), []).map(rel))].sort()).toEqual(ALLOWED);
  });

  it("внешние пакеты suite.ts — ровно vitest и node:util (КТ1 № 12 (а)): ни agentic-core, ни PaoStub, ни клиента сети", () => {
    expect(external(SUITE)).toEqual(["node:util", "vitest"]);
  });

  it("suite.ts транзитивно не подключает contour, adapters/* и compose; все модули распознаны, загрузки — литералом", () => {
    const found: string[] = [];
    const files = closure(SUITE, (f) => readFileSync(f, "utf8"), found);
    expect(files).toContain("src/agent/ports/payment-platform.ts");
    expect(violations(files)).toEqual([]);
    expect(found).toEqual([]);
  });

  // КТ1 № 12 (б): модуль, который граф не распознал, — неизвестное ребро; красный, а не молчаливый пропуск
  it("нераспознанный модуль — нарушение", () => {
    const found: string[] = [];
    closure(SUITE, (f) => (f === SUITE ? `import "./conformance-absent.js";` : ""), found);
    expect(found).toEqual(["tests/conformance/suite.ts — нераспознанный модуль ./conformance-absent.js"]);
  });

  // КТ1 № 12 (в): путь не литералом граф проверить не может — import() шаблоном или выражением, require, createRequire
  it("загрузка не литералом — import() шаблоном, require и createRequire — нарушение", () => {
    const src = [
      "const where = 'compose';",
      "await import(`../../src/agent/${where}.js`);",
      "import { createRequire } from 'node:module';",
      "const req = createRequire(import.meta.url);",
      "require('../support/contour.js');",
    ].join("\n");
    const found: string[] = [];
    closure(SUITE, (f) => (f === SUITE ? src : ""), found);
    expect(found.sort()).toEqual(["tests/conformance/suite.ts — createRequire", "tests/conformance/suite.ts — import() не литералом", "tests/conformance/suite.ts — require"]);
  });

  it("проверка ловит запрещённое ребро и через промежуточный модуль", () => {
    const shared = resolve(ROOT, "src/shared/domain.ts");
    const read = (f: string) => {
      if (f === SUITE) return `import "../../src/shared/domain.js";`;
      if (f === shared) return `import "../agent/compose.js";`;
      return "";
    };
    expect(violations(closure(SUITE, read, []))).toEqual(["src/agent/compose.ts — место сборки"]);
  });
});
