import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/", "docs/", ".claude/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Р19: типы и клиент ПАО — только внутри адаптера pao; ядро работает со своими доменными типами.
    files: ["src/**/*.ts"],
    ignores: ["src/agent/adapters/pao/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@kuzin4u/agentic-core/pao",
              message: "Р19: типы ПАО используются только в src/agent/adapters/pao.",
            },
          ],
          patterns: [
            {
              group: ["**/adapters/pao", "**/adapters/pao/**"],
              message: "Р19: ядро работает через порт «платёжная платформа», а не через адаптер pao.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/agentic-core\\u002Fpao/]",
          message: "Р19: типы ПАО используются только в src/agent/adapters/pao.",
        },
      ],
    },
  },
);
