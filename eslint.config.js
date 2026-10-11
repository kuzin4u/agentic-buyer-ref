import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Р19: ядро не видит платформу. Группы файлов не пересекаются: у каждой своё правило целиком.
const PAO_TYPES = "@kuzin4u/agentic-core/pao";
const COMPOSE = "src/agent/compose.ts";
const PAO_ADAPTER = "src/agent/adapters/pao/**";
const CORE = [
  "src/agent/pipeline/**",
  "src/agent/policy/**",
  "src/agent/mandates/**",
  "src/agent/declines/**",
  "src/agent/ports/**",
  "src/shared/**",
];

const noPaoTypes = { name: PAO_TYPES, message: "Р19: типы ПАО используются только в src/agent/adapters/pao." };
const noPaoAdapter = {
  group: ["**/adapters/pao", "**/adapters/pao/**"],
  message: "Р19: адаптер pao подключается только в src/agent/compose.ts.",
};
const noAdapters = {
  group: ["**/adapters", "**/adapters/**"],
  message: "Р19: ядро работает через порт «платёжная платформа», адаптеры ему не видны.",
};
const noDynamic = (pattern, message) => ({ selector: `ImportExpression[source.value=${pattern}]`, message });
const dynPao = noDynamic("/agentic-core\\u002Fpao/", noPaoTypes.message);
const dynAdapters = noDynamic("/adapters/", noAdapters.message);
const dynPaoAdapter = noDynamic("/adapters\\u002Fpao/", noPaoAdapter.message);

const boundary = (patterns, dynamic) => ({
  "no-restricted-imports": ["error", { paths: [noPaoTypes], patterns }],
  "no-restricted-syntax": ["error", ...dynamic],
});

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/", "docs/", ".claude/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Ядро: ни типов ПАО, ни адаптеров.
  { files: CORE, rules: boundary([noAdapters], [dynPao, dynAdapters]) },
  // Место сборки: адаптер pao можно, типы ПАО нельзя.
  { files: [COMPOSE], rules: boundary([], [dynPao]) },
  // Остальной src: ни типов ПАО, ни адаптера pao.
  {
    files: ["src/**/*.ts"],
    ignores: [...CORE, COMPOSE, PAO_ADAPTER],
    rules: boundary([noPaoAdapter], [dynPao, dynPaoAdapter]),
  },
);
