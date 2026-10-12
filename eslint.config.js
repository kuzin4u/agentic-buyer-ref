import js from "@eslint/js";
import tseslint from "typescript-eslint";
import boundaries from "./config/boundaries.json" with { type: "json" };

// Границы модулей (Р19, Р24, инвариант 2). Группы файлов не пересекаются: в плоской конфигурации правило из более
// поздней группы заменяет раннее целиком, поэтому у каждой группы — полный набор запретов.
// Транзитивные связи проверяет тест графа импортов на компиляторе TypeScript (tests/unit/import-graph.test.ts, Р24).
const PAO_TYPES = "@kuzin4u/agentic-core/pao";
const COMPOSE = "src/agent/compose.ts";
const SIGNER = "src/agent/signer/**";
const PAO_ADAPTER = "src/agent/adapters/pao/**";
const ADAPTERS = "src/agent/adapters/**";

/** Вне signer и compose из node:crypto — только список разрешённого (randomUUID для Idempotency-Key, Р21, и прочее
 *  неключевое); создание подписанта и подпись обращения в agentic-core — только в signer. Списки — config/boundaries.json. */
const CORE_SIGNING_APIS = boundaries.coreSigningApis;
const CRYPTO_ALLOWED = `/^(${boundaries.cryptoAllowedOutsideSigner.join("|")})$/`;
const SRC = "src/**/*.{ts,mts,cts,tsx}";

const KEYS_MSG = "Инвариант 2: ключи и подпись — только в src/agent/signer (создание — в compose).";

const msg = {
  pao: "Р19: типы ПАО используются только в src/agent/adapters/pao.",
  adapters: "Р19: адаптеры подключаются только в src/agent/compose.ts; остальным — порты.",
  paoAdapter: "Р19: адаптер pao подключается только в src/agent/compose.ts.",
  signer: "Инвариант 2: модуль signer подключается только в src/agent/compose.ts; остальным — порт подписи.",
  compose: "Р19: место сборки не импортируется — оно собирает ядро, а не наоборот.",
  dist: "Р19: внутренние пути agentic-core/dist — обход экспортов пакета.",
  bypass: "Р19 (ревью AG-02 № 10): обход границы — только статический импорт строковым литералом.",
};

const paths = (allowPao, allowKeys) => [
  ...(allowPao ? [] : [{ name: PAO_TYPES, message: msg.pao }]),
  ...(allowKeys
    ? []
    : [
        { name: "@kuzin4u/agentic-core", importNames: CORE_SIGNING_APIS, message: KEYS_MSG },
      ]),
  // node:module целиком: createRequire доступен и через default-импорт (ревью 3c № 3)
  { name: "node:module", message: msg.bypass },
  { name: "module", message: msg.bypass },
];

const groups = {
  adapters: { group: ["**/adapters", "**/adapters/**"], message: msg.adapters },
  paoAdapter: { group: ["**/adapters/pao", "**/adapters/pao/**", "../pao", "../pao/**"], message: msg.paoAdapter },
  signer: { group: ["**/signer", "**/signer/**"], message: msg.signer },
  compose: { group: ["**/compose", "**/compose.js", "**/compose.ts"], message: msg.compose },
  dist: { group: ["@kuzin4u/agentic-core/dist", "@kuzin4u/agentic-core/dist/**", "**/node_modules/**"], message: msg.dist },
  // из src — только src: tests/, scripts/ и прочее могут транзитивно вести к signer и compose (ревью 3c, повтор № 3)
  outside: { group: ["**/tests/**", "**/scripts/**", "**/config/**"], message: "Р19: из src импортируется только src (полная проверка — граф)." },
  // псевдонимы subpath imports (#…) из package.json подменяют модуль мимо проверки по спецификатору (ревью 3c, повтор 3 № 2)
  alias: { regex: "^#", message: "Р19 / инвариант 2: псевдонимы #… в src запрещены — только настоящий спецификатор модуля." },
};

// Синтаксические обходы: тип через import("…"), нелитеральный import(), require, ключевые API через crypto.* и WebCrypto.
const syntax = (forbiddenModules, allowKeys) => [
  { selector: "ImportExpression[source.type!='Literal']", message: msg.bypass },
  { selector: "CallExpression[callee.name='require']", message: msg.bypass },
  { selector: "TSImportEqualsDeclaration > TSExternalModuleReference", message: msg.bypass },
  // node:module и process.getBuiltinModule — доступ к любому модулю мимо статических импортов (ревью 3c № 3)
  { selector: "ImportExpression[source.value=/^(node:)?module$/]", message: msg.bypass },
  { selector: "MemberExpression[property.name='getBuiltinModule']", message: msg.bypass },
  { selector: "MemberExpression[property.value='getBuiltinModule']", message: msg.bypass },
  ...forbiddenModules.flatMap(({ re, message }) => [
    { selector: `ImportExpression[source.value=${re}]`, message },
    { selector: `TSImportType[argument.literal.value=${re}]`, message },
    { selector: `TSImportType > TSLiteralType > Literal[value=${re}]`, message },
  ]),
  ...(allowKeys
    ? []
    : [
        // Объекта crypto вне signer нет (ревью 3c, повтор № 1, 2): только именованный импорт неключевого (randomUUID).
        {
          selector: "ImportDeclaration[source.value=/^(node:)?crypto$/] > :matches(ImportNamespaceSpecifier, ImportDefaultSpecifier)",
          message: KEYS_MSG,
        },
        { selector: "ImportDeclaration[source.value='@kuzin4u/agentic-core'] > ImportNamespaceSpecifier", message: KEYS_MSG },
        // Из node:crypto — только разрешённые имена (ревью 3c, повтор № 1: subtle, webcrypto)
        { selector: `ImportDeclaration[source.value=/^(node:)?crypto$/] > ImportSpecifier[imported.name!=${CRYPTO_ALLOWED}]`, message: KEYS_MSG },
        // Реэкспорт: из crypto — никакой; из agentic-core — ни default, ни ключевых имён, ни export * (ревью 3c № 1)
        { selector: "ExportNamedDeclaration[source.value=/^(node:)?crypto$/]", message: KEYS_MSG },
        { selector: "ExportAllDeclaration[source.value=/^(node:)?crypto$/]", message: KEYS_MSG },
        { selector: `ExportNamedDeclaration[source.value='@kuzin4u/agentic-core'] > ExportSpecifier[local.name=/^(default|${CORE_SIGNING_APIS.join("|")})$/]`, message: KEYS_MSG },
        { selector: `ExportNamedDeclaration[source.value='@kuzin4u/agentic-core'] > ExportSpecifier[local.value=/^(default|${CORE_SIGNING_APIS.join("|")})$/]`, message: KEYS_MSG },
        { selector: "ExportAllDeclaration[source.value='@kuzin4u/agentic-core']", message: KEYS_MSG },
        { selector: "ImportExpression[source.value=/^((node:)?crypto|@kuzin4u\\u002Fagentic-core)$/]", message: KEYS_MSG },
        // Глобальный crypto (WebCrypto): только crypto.randomUUID / crypto.getRandomValues; ни псевдонимов, ни передачи
        { selector: "MemberExpression[object.name='crypto'][property.name!=/^(randomUUID|getRandomValues)$/]", message: KEYS_MSG },
        { selector: "MemberExpression[object.name=/^(globalThis|window|self|global)$/][property.name='crypto']", message: KEYS_MSG },
        { selector: "MemberExpression[object.name=/^(globalThis|window|self|global)$/][property.value='crypto']", message: KEYS_MSG },
        {
          selector:
            ":matches(VariableDeclarator[init.name='crypto'], AssignmentExpression[right.name='crypto'], ExportSpecifier[local.name='crypto'], ExportDefaultDeclaration[declaration.name='crypto'], ReturnStatement[argument.name='crypto'], Property[value.name='crypto'], SpreadElement[argument.name='crypto'], ArrayExpression > Identifier[name='crypto'], CallExpression > Identifier[name='crypto'])",
          message: KEYS_MSG,
        },
      ]),
];

const mod = {
  pao: { re: "/agentic-core\\u002Fpao/", message: msg.pao },
  adapters: { re: "/adapters/", message: msg.adapters },
  paoAdapter: { re: "/(adapters\\u002F|\\.\\.\\u002F)pao/", message: msg.paoAdapter },
  signer: { re: "/signer/", message: msg.signer },
  compose: { re: "/compose/", message: msg.compose },
  dist: { re: "/agentic-core\\u002Fdist/", message: msg.dist },
};

const boundary = ({ allowPao = false, allowKeys = false, patterns, modules }) => ({
  "no-restricted-imports": ["error", { paths: paths(allowPao, allowKeys), patterns: [...patterns, groups.compose, groups.dist, groups.outside, groups.alias] }],
  "no-restricted-syntax": ["error", ...syntax([...modules, mod.compose, mod.dist, ...(allowPao ? [] : [mod.pao])], allowKeys)],
});

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/", "docs/", ".claude/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Ядро и все модули без адаптеров (pipeline, policy, mandates, declines, ports, shared, journal, events,
  // payment-package, shell): ни адаптеров, ни типов ПАО, ни signer, ни ключевых API.
  {
    files: [SRC],
    ignores: [ADAPTERS, SIGNER, COMPOSE],
    rules: boundary({ patterns: [groups.adapters, groups.signer], modules: [mod.adapters, mod.signer] }),
  },
  // signer: ключевые API можно; адаптеров, типов ПАО и места сборки — нет.
  {
    files: [SIGNER],
    rules: boundary({ allowKeys: true, patterns: [groups.adapters], modules: [mod.adapters] }),
  },
  // Адаптер pao: типы ПАО можно; signer и ключевые API — нет (подпись — через порт).
  {
    files: [PAO_ADAPTER],
    rules: boundary({ allowPao: true, patterns: [groups.signer], modules: [mod.signer] }),
  },
  // Прочие адаптеры: ни адаптера pao, ни типов ПАО, ни signer.
  {
    files: [ADAPTERS],
    ignores: [PAO_ADAPTER],
    rules: boundary({ patterns: [groups.paoAdapter, groups.signer], modules: [mod.paoAdapter, mod.signer] }),
  },
  // Место сборки: адаптеры и signer можно; типы ПАО — нет.
  { files: [COMPOSE], rules: boundary({ allowKeys: true, patterns: [], modules: [] }) },
);
