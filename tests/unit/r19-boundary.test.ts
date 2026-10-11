import { beforeAll, describe, it, expect } from "vitest";
import { ESLint } from "eslint";

// Р19: ядро не видит ни адаптер pao, ни agentic-core/pao; место сборки — единственное исключение.
const eslint = new ESLint();

async function errors(filePath: string, code: string): Promise<string[]> {
  const [r] = await eslint.lintText(code, { filePath });
  return r!.messages.filter((m) => m.severity === 2).map((m) => m.ruleId ?? "");
}

const PAO_TYPES = 'import { PAO_VERSION } from "@kuzin4u/agentic-core/pao";\nexport const v = PAO_VERSION;\n';
const PAO_DYNAMIC = 'export const load = () => import("@kuzin4u/agentic-core/pao");\n';
const adapter = (rel: string) => `import { PaoPlatform } from "${rel}/adapters/pao/index.js";\nexport const P = PaoPlatform;\n`;

// Первая загрузка ESLint и typescript-eslint при параллельном прогоне бывает дольше 5 с.
beforeAll(async () => {
  await eslint.lintText("export {};\n", { filePath: "src/shared/warmup.ts" });
}, 60_000);

describe("граница Р19", { timeout: 30_000 }, () => {
  it("весь src/ проходит границу", async () => {
    const results = await eslint.lintFiles(["src/**/*.ts"]);
    const bad = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === "no-restricted-imports" || m.ruleId === "no-restricted-syntax")
        .map((m) => `${r.filePath}:${m.line} ${m.message}`),
    );
    expect(bad).toEqual([]);
  });

  it.each(["pipeline", "policy", "mandates", "declines"])("ядро (%s) не видит agentic-core/pao", async (dir) => {
    expect(await errors(`src/agent/${dir}/probe.ts`, PAO_TYPES)).toContain("no-restricted-imports");
    expect(await errors(`src/agent/${dir}/probe.ts`, PAO_DYNAMIC)).toContain("no-restricted-syntax");
  });

  it.each(["pipeline", "policy", "mandates", "declines"])("ядро (%s) не видит адаптер pao", async (dir) => {
    expect(await errors(`src/agent/${dir}/probe.ts`, adapter(".."))).toContain("no-restricted-imports");
  });

  it("ядро не видит и другие адаптеры", async () => {
    const code = 'import * as a from "../adapters/platform/index.js";\nexport const x = a;\n';
    expect(await errors("src/agent/policy/probe.ts", code)).toContain("no-restricted-imports");
  });

  it("прочие модули (signer, journal, shell) не видят адаптер pao", async () => {
    expect(await errors("src/agent/shell/probe.ts", adapter(".."))).toContain("no-restricted-imports");
    expect(await errors("src/agent/journal/probe.ts", PAO_TYPES)).toContain("no-restricted-imports");
  });

  it("место сборки: адаптер pao можно, типы ПАО нельзя", async () => {
    expect(await errors("src/agent/compose.ts", adapter("."))).toEqual([]);
    expect(await errors("src/agent/compose.ts", PAO_TYPES)).toContain("no-restricted-imports");
  });

  it("адаптер pao: типы ПАО можно", async () => {
    expect(await errors("src/agent/adapters/pao/probe.ts", PAO_TYPES)).toEqual([]);
  });
});
