// Граф импортов src на компиляторе TypeScript (Р24 п. 3): транзитивная граница Р19 и изоляция ключей (инвариант 2).
// Рёбра: import / export from / import type, import("…") в типах, import() и require() строковым литералом,
// import x = require(). Нелитеральный import()/require — нарушение сам по себе. Разрешение — ts.resolveModuleName
// с настройками tsconfig. Ключевые API node:crypto и подпись agentic-core ищутся по AST в каждом файле.
import ts from "typescript";
import boundaries from "../../config/boundaries.json" with { type: "json" };

export interface Project {
  /** корень проекта: относительно него — src/... */
  root: string;
  /** файлы src (абсолютные пути) */
  files: string[];
  read(path: string): string | undefined;
  exists(path: string): boolean;
}

type Zone = "compose" | "signer" | "pao-adapter" | "adapter" | "rest";

const PAO_TYPES = "@kuzin4u/agentic-core/pao";
const CORE = "@kuzin4u/agentic-core";
const STAND = /^agentic-ps-platform(\/|$)/i;
const KEY_API = new Set(boundaries.cryptoKeyApis);
/** Из node:crypto вне signer — только эти имена (список разрешённого) */
const CRYPTO_ALLOWED = new Set(boundaries.cryptoAllowedOutsideSigner);
const SIGNING_API = new Set(boundaries.coreSigningApis);
const isCrypto = (s: string) => s === "node:crypto" || s === "crypto";
/** node:module целиком: createRequire доступен и через default-импорт (ревью 3c № 3) */
const isModule = (s: string) => s === "node:module" || s === "module";

interface FileFacts {
  internal: string[];
  external: string[];
  problems: string[];
}

function zoneOf(root: string, file: string): Zone {
  const rel = file.slice(root.length + 1);
  if (rel === "src/agent/compose.ts") return "compose";
  if (rel.startsWith("src/agent/signer/")) return "signer";
  if (rel.startsWith("src/agent/adapters/pao/")) return "pao-adapter";
  if (rel.startsWith("src/agent/adapters/")) return "adapter";
  return "rest";
}

function options(root: string, p: Project): ts.CompilerOptions {
  const cfg = ts.readConfigFile(`${root}/tsconfig.json`, (f) => p.read(f) ?? ts.sys.readFile(f));
  return ts.parseJsonConfigFileContent(cfg.config ?? {}, ts.sys, root).options;
}

function facts(p: Project, file: string, opts: ts.CompilerOptions): FileFacts {
  const text = p.read(file) ?? "";
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const host: ts.ModuleResolutionHost = {
    fileExists: (f) => p.exists(f) || ts.sys.fileExists(f),
    readFile: (f) => p.read(f) ?? ts.sys.readFile(f),
  };
  const out: FileFacts = { internal: [], external: [], problems: [] };
  const where = (n: ts.Node) => `${file.slice(p.root.length + 1)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const cryptoNames = new Set<string>(); // локальные имена namespace/default-импорта crypto
  const coreNames = new Set<string>(); // локальные имена namespace-импорта agentic-core

  const edge = (spec: string) => {
    const r = ts.resolveModuleName(spec, file, opts, host).resolvedModule;
    const relative = spec.startsWith(".") || spec.startsWith("/");
    // Стенд и фикстуры Платформы — dev-зависимость тестового контура (tests/support), не для src и не для места сборки
    // (Р24, Р26 п. 3; AG-04 К1.3). Спецификатор — без учёта регистра: так же, как правило ESLint.
    if (STAND.test(spec)) out.problems.push(`${file.slice(p.root.length + 1)}: стенд Платформы «${spec}» — только tests/support (Р24, Р26)`);
    if (spec.startsWith("#")) out.problems.push(`${file.slice(p.root.length + 1)}: псевдоним «${spec}» (subpath imports) — обход проверки по спецификатору`);
    // Ребро в объявление .d.ts внутри src: реализация (.js) рядом не проверяется (ревью 3c, повтор 3 № 1)
    if (r && r.resolvedFileName.startsWith(`${p.root}/src/`) && /\.d\.[mc]?ts$/.test(r.resolvedFileName)) {
      out.problems.push(`${file.slice(p.root.length + 1)}: импорт объявления ${r.resolvedFileName.slice(p.root.length + 1)} — в src только исходники TypeScript`);
    }
    // Относительный путь — только внутрь src и не в node_modules (ревью 3c, повтор № 2, 3); неразрешённый — тоже нарушение.
    if (relative && (spec.includes("node_modules") || !r || !r.resolvedFileName.startsWith(`${p.root}/src/`))) {
      out.problems.push(`${file.slice(p.root.length + 1)}: импорт вне src или неразрешённый путь «${spec}»`);
    }
    if (r && !r.isExternalLibraryImport && r.resolvedFileName.startsWith(`${p.root}/src/`)) out.internal.push(r.resolvedFileName);
    else out.external.push(spec);
  };
  const literal = (e: ts.Node | undefined): string | undefined =>
    e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined;

  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) {
      const spec = literal(n.moduleSpecifier)!;
      edge(spec);
      if (isModule(spec)) out.problems.push(`${where(n)} ${spec} — обход статических импортов`);
      // Реэкспорт (ревью 3c № 1): из crypto — никакой; из agentic-core — ни default, ни ключевых имён, ни export *
      if (ts.isExportDeclaration(n) && isCrypto(spec)) out.problems.push(`${where(n)} ключевой API: реэкспорт из ${spec}`);
      if (ts.isExportDeclaration(n) && spec === CORE) {
        const names = n.exportClause && ts.isNamedExports(n.exportClause) ? n.exportClause.elements.map((el) => (el.propertyName ?? el.name).text) : null;
        if (names === null) out.problems.push(`${where(n)} ключевой API: export * from ${spec}`);
        else for (const name of names) if (SIGNING_API.has(name) || name === "default") out.problems.push(`${where(n)} ключевой API: реэкспорт ${spec}.${name}`);
      }
      // Объекта crypto и namespace agentic-core вне signer нет (ревью 3c, повтор № 1, 2)
      if (ts.isImportDeclaration(n) && n.importClause) {
        const { name, namedBindings } = n.importClause;
        const whole = !!name || (!!namedBindings && ts.isNamespaceImport(namedBindings));
        if (isCrypto(spec) && whole) out.problems.push(`${where(n)} ключевой API: импорт объекта ${spec}`);
        if (spec === CORE && namedBindings && ts.isNamespaceImport(namedBindings)) out.problems.push(`${where(n)} ключевой API: namespace-импорт ${spec}`);
      }
      if (ts.isImportDeclaration(n) && n.importClause) {
        const { name, namedBindings } = n.importClause;
        if (isCrypto(spec) && name) cryptoNames.add(name.text);
        if (namedBindings && ts.isNamespaceImport(namedBindings)) {
          if (isCrypto(spec)) cryptoNames.add(namedBindings.name.text);
          if (spec === CORE) coreNames.add(namedBindings.name.text);
        }
        if (namedBindings && ts.isNamedImports(namedBindings)) {
          for (const el of namedBindings.elements) {
            const imported = (el.propertyName ?? el.name).text;
            if (isCrypto(spec) && !CRYPTO_ALLOWED.has(imported)) out.problems.push(`${where(el)} ключевой API ${spec}.${imported}`);
            if (spec === CORE && SIGNING_API.has(imported)) out.problems.push(`${where(el)} подпись agentic-core: ${imported}`);
          }
        }
      }
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const spec = literal(n.moduleReference.expression);
      if (spec === undefined) out.problems.push(`${where(n)} import = require не литералом`);
      else {
        edge(spec);
        if (isCrypto(spec) || spec === CORE) out.problems.push(`${where(n)} ключевой API: import = require("${spec}")`);
      }
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) {
      const spec = literal(n.argument.literal);
      if (spec !== undefined) edge(spec);
    } else if (ts.isCallExpression(n)) {
      const isImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === "require";
      if (isImport || isRequire) {
        const spec = literal(n.arguments[0]);
        if (spec === undefined) out.problems.push(`${where(n)} ${isImport ? "import()" : "require()"} не литералом`);
        else {
          edge(spec);
          // import() модуля с ключами — доступ мимо проверки имён (ревью 3c № 2)
          if (isCrypto(spec) || spec === CORE) out.problems.push(`${where(n)} ключевой API: ${isImport ? "import" : "require"}("${spec}")`);
          if (isModule(spec)) out.problems.push(`${where(n)} ${spec} — обход статических импортов`);
        }
      }
    } else if (ts.isIdentifier(n) && n.text === "crypto") {
      // Глобальный crypto (WebCrypto): только crypto.randomUUID / crypto.getRandomValues; ни псевдонимов, ни передачи.
      const parent = n.parent;
      const isPropName =
        (ts.isPropertyAccessExpression(parent) && parent.name === n) ||
        (ts.isPropertyAssignment(parent) && parent.name === n) ||
        ts.isNamespaceImport(parent) ||
        ts.isImportClause(parent) ||
        ts.isImportSpecifier(parent); // привязка импорта — учтена правилом импорта объекта crypto
      const allowed = ts.isPropertyAccessExpression(parent) && parent.expression === n && ["randomUUID", "getRandomValues"].includes(parent.name.text);
      if (!isPropName && !allowed) out.problems.push(`${where(n)} ключевой API: глобальный crypto вне randomUUID/getRandomValues`);
    }
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const obj = n.expression;
      const prop = ts.isPropertyAccessExpression(n) ? n.name.text : literal(n.argumentExpression);
      if (prop === "getBuiltinModule") out.problems.push(`${where(n)} getBuiltinModule — обход статических импортов`);
      if (prop === "crypto" && ts.isIdentifier(obj) && ["globalThis", "window", "self", "global"].includes(obj.text)) {
        out.problems.push(`${where(n)} ключевой API: ${obj.text}.crypto`);
      }
      if (ts.isIdentifier(obj) && prop !== undefined) {
        if (cryptoNames.has(obj.text) && KEY_API.has(prop)) out.problems.push(`${where(n)} ключевой API ${obj.text}.${prop}`);
        if (coreNames.has(obj.text) && SIGNING_API.has(prop)) out.problems.push(`${where(n)} подпись agentic-core: ${prop}`);
      }
      // WebCrypto: crypto.subtle, globalThis.crypto.subtle, crypto.webcrypto.subtle
      if (prop === "subtle" && ((ts.isIdentifier(obj) && obj.text === "crypto") || (ts.isPropertyAccessExpression(obj) && (obj.name.text === "crypto" || obj.name.text === "webcrypto")))) {
        out.problems.push(`${where(n)} WebCrypto subtle`);
      }
    } else if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.initializer) && cryptoNames.has(n.initializer.text) && ts.isObjectBindingPattern(n.name)) {
      for (const el of n.name.elements) {
        const key = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : "";
        if (KEY_API.has(key)) out.problems.push(`${where(el)} ключевой API ${n.initializer.text}.${key}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Нарушения границ с учётом транзитивных связей; пустой список — границы соблюдены. */
/** В src — только исходники TypeScript: .js/.mjs/.cjs/.jsx и .d.ts не проверяются ни ESLint, ни графом. */
export const SOURCE_FILE = /(?<!\.d)\.(ts|mts|cts|tsx)$/;

export function importGraphViolations(p: Project): string[] {
  const opts = options(p.root, p);
  const all = new Map<string, FileFacts>();
  const factsOf = (f: string): FileFacts => {
    let x = all.get(f);
    if (!x) all.set(f, (x = facts(p, f, opts)));
    return x;
  };
  const closure = (start: string): Set<string> => {
    const seen = new Set<string>([start]);
    const stack = [start];
    while (stack.length) {
      for (const next of factsOf(stack.pop()!).internal) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    return seen;
  };
  const rel = (f: string) => f.slice(p.root.length + 1);
  const out: string[] = [];
  for (const file of p.files) {
    const zone = zoneOf(p.root, file);
    for (const problem of factsOf(file).problems) {
      // ключевые API и подпись agentic-core — только в signer и compose; обходы — нигде
      const keyUse = / ключевой API[ :]| подпись agentic-core| WebCrypto/.test(problem);
      if (!keyUse || (zone !== "signer" && zone !== "compose")) out.push(problem);
    }
    if (zone === "compose") continue;
    const reach = closure(file);
    const chain = (target: string) => `${rel(file)} → … → ${rel(target)}`;
    for (const f of reach) {
      if (f === file) continue;
      const z = zoneOf(p.root, f);
      if ((zone === "rest" || zone === "signer") && (z === "adapter" || z === "pao-adapter")) out.push(`${chain(f)}: адаптер (Р19)`);
      if (zone === "adapter" && z === "pao-adapter") out.push(`${chain(f)}: адаптер pao (Р19)`);
      if (zone !== "signer" && z === "signer") out.push(`${chain(f)}: signer (инвариант 2)`);
      if (z === "compose") out.push(`${chain(f)}: место сборки (Р19)`);
    }
    if (zone !== "pao-adapter") {
      for (const f of reach) {
        if (zoneOf(p.root, f) === "pao-adapter") continue; // уже учтено выше
        if (factsOf(f).external.includes(PAO_TYPES)) out.push(`${rel(file)} → … → ${rel(f)}: ${PAO_TYPES} (Р19)`);
      }
    }
  }
  return [...new Set(out)].sort();
}
