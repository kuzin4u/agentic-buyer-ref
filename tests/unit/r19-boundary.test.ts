import { beforeAll, describe, it, expect } from "vitest";
import { ESLint } from "eslint";

// Границы модулей в ESLint (Р19, инвариант 2, ревью AG-02 № 8, 10, 11, 15; ревью 3a № 6).
// Транзитивные связи — в import-graph.test.ts (Р24).
const eslint = new ESLint();

const BOUNDARY = new Set(["no-restricted-imports", "no-restricted-syntax"]);
async function violations(filePath: string, code: string): Promise<string[]> {
  const [r] = await eslint.lintText(code, { filePath });
  return r!.messages.filter((m) => m.severity === 2 && BOUNDARY.has(m.ruleId ?? "")).map((m) => m.message);
}

const PAO_TYPES = 'import { PAO_VERSION } from "@kuzin4u/agentic-core/pao";\nexport const v = PAO_VERSION;\n';
const PAO_DYNAMIC = 'export const load = () => import("@kuzin4u/agentic-core/pao");\n';
const PAO_TYPE_IMPORT = 'export type T = import("@kuzin4u/agentic-core/pao").AgentSelf;\n';
const adapter = (rel: string, name = "pao") => `import * as a from "${rel}/adapters/${name}/index.js";\nexport const x = a;\n`;
const signer = (rel: string) => `import { KeyRing } from "${rel}/signer/index.js";\nexport const K = KeyRing;\n`;

// Обходы границы (ревью AG-02 № 10) — запрещены во всём src
const BYPASSES: Record<string, string> = {
  "динамический import() шаблонной строкой": "const m = 'pao';\nexport const load = () => import(`../adapters/${m}/index.js`);\n",
  "динамический import() переменной": 'const p = "../adapters/pao/index.js";\nexport const load = () => import(p);\n',
  "require()": 'export const a = require("../adapters/pao/index.js");\n',
  "createRequire из node:module": 'import { createRequire } from "node:module";\nexport const r = createRequire(import.meta.url);\n',
  "createRequire из module": 'import { createRequire } from "module";\nexport const r = createRequire(import.meta.url);\n',
  "default-импорт node:module (ревью 3c № 3)": 'import m from "node:module";\nexport const r = m.createRequire(import.meta.url);\n',
  "import x = require()": 'import a = require("../shared/index.js");\nexport const x = a;\n',
  "import(\"node:module\")": 'export const m = () => import("node:module");\n',
  "псевдоним #core из package.json imports (повтор 3 № 2)": 'import { newEd25519Signer } from "#core";\nexport const n = newEd25519Signer;\n',
  "импорт из tests/ (повтор 2 № 3)": 'import { PaoStand } from "../../../tests/support/pao-stand.js";\nexport const s = PaoStand;\n',
  "путь в node_modules (повтор 2 № 2)": 'import * as c from "../../../node_modules/@kuzin4u/agentic-core/dist/src/signing.js";\nexport const x = c;\n',
  "process.getBuiltinModule (повтор № 3)": 'export const c = process.getBuiltinModule("node:crypto");\n',
  "импорт места сборки": 'import { createAgentCore } from "../compose.js";\nexport const c = createAgentCore;\n',
  "внутренний путь agentic-core/dist": 'import * as c from "@kuzin4u/agentic-core/dist/src/pao/client.js";\nexport const x = c;\n',
};

// Ключевые API (инвариант 2) — вне signer и compose
const KEY_USES: Record<string, string> = {
  "generateKeyPairSync из node:crypto": 'import { generateKeyPairSync } from "node:crypto";\nexport const k = generateKeyPairSync;\n',
  "createPrivateKey из crypto": 'import { createPrivateKey } from "crypto";\nexport const k = createPrivateKey;\n',
  "sign из node:crypto": 'import { sign } from "node:crypto";\nexport const s = sign;\n',
  "createSecretKey": 'import { createSecretKey } from "node:crypto";\nexport const s = createSecretKey;\n',
  "KeyObject": 'import { KeyObject } from "node:crypto";\nexport const s = KeyObject;\n',
  "privateDecrypt": 'import { privateDecrypt } from "node:crypto";\nexport const s = privateDecrypt;\n',
  "crypto.sign через namespace": 'import * as crypto from "node:crypto";\nexport const s = crypto.sign;\n',
  "crypto[\"createSign\"]": 'import crypto from "node:crypto";\nexport const s = crypto["createSign"];\n',
  "деструктуризация из crypto": 'import * as crypto from "node:crypto";\nconst { generateKeyPair } = crypto;\nexport const g = generateKeyPair;\n',
  "namespace crypto под другим именем": 'import * as c from "node:crypto";\nexport const u = c.randomUUID;\n',
  "WebCrypto: globalThis.crypto.subtle": "export const s = globalThis.crypto.subtle;\n",
  "WebCrypto: crypto.subtle": "export const s = crypto.subtle;\n",
  "WebCrypto: crypto.webcrypto.subtle": 'import * as crypto from "node:crypto";\nexport const s = crypto.webcrypto.subtle;\n',
  "newEd25519Signer из agentic-core": 'import { newEd25519Signer } from "@kuzin4u/agentic-core";\nexport const n = newEd25519Signer;\n',
  "signRequest из agentic-core": 'import { signRequest } from "@kuzin4u/agentic-core";\nexport const n = signRequest;\n',
  "реэкспорт ключевого API (ревью 3c № 1)": 'export { generateKeyPairSync } from "node:crypto";\n',
  "export * from node:crypto": 'export * from "node:crypto";\n',
  "реэкспорт подписи agentic-core": 'export { newEd25519Signer } from "@kuzin4u/agentic-core";\n',
  "export * from agentic-core": 'export * from "@kuzin4u/agentic-core";\n',
  "import() node:crypto литералом (ревью 3c № 2)": 'export const g = async () => (await import("node:crypto")).generateKeyPairSync;\n',
  "import() agentic-core литералом": 'export const g = async () => (await import("@kuzin4u/agentic-core")).newEd25519Signer;\n',
  "реэкспорт default из node:crypto (повтор № 1)": 'export { default as c } from "node:crypto";\n',
  "namespace crypto под именем crypto и его экспорт (повтор № 2)": 'import * as crypto from "node:crypto";\nexport { crypto };\n',
  "default crypto и export default": 'import crypto from "node:crypto";\nexport default crypto;\n',
  "псевдоним глобального crypto": "const c = crypto;\nexport const s = c;\n",
  "globalThis.crypto": "export const c = globalThis.crypto;\n",
  "namespace agentic-core": 'import * as core from "@kuzin4u/agentic-core";\nexport { core };\n',
  "реэкспорт строковым именем": 'export { "sign" as s } from "node:crypto";\n',
};

// Модули без адаптеров: ядро и все прочие, кроме adapters/*, signer и compose (ревью AG-02 № 8)
const NON_ADAPTER = ["pipeline", "policy", "mandates", "declines", "ports", "journal", "events", "payment-package", "shell"];

// Первая загрузка ESLint и typescript-eslint при параллельном прогоне бывает дольше 5 с.
beforeAll(async () => {
  await eslint.lintText("export {};\n", { filePath: "src/shared/warmup.ts" });
}, 60_000);

describe("границы модулей в ESLint", { timeout: 60_000 }, () => {
  it("весь src/ проходит границы", async () => {
    const results = await eslint.lintFiles(["src/**/*.ts"]);
    const bad = results.flatMap((r) =>
      r.messages.filter((m) => BOUNDARY.has(m.ruleId ?? "")).map((m) => `${r.filePath}:${m.line} ${m.message}`),
    );
    expect(bad).toEqual([]);
  });

  describe.each([...NON_ADAPTER.map((d): [string, string] => [d, `src/agent/${d}/probe.ts`]), ["shared", "src/shared/probe.ts"]])(
    "%s",
    (_dir, file) => {
      const rel = file.startsWith("src/shared") ? "../agent" : "..";
      it("не видит типы ПАО — ни импортом, ни import() в типе, ни динамически", async () => {
        for (const code of [PAO_TYPES, PAO_DYNAMIC, PAO_TYPE_IMPORT]) expect(await violations(file, code)).not.toEqual([]);
      });
      it.each(["pao", "platform", "nsvr", "a2a"])("не видит адаптер %s", async (name) => {
        expect(await violations(file, adapter(rel, name))).not.toEqual([]);
      });
      it("не видит signer", async () => {
        expect(await violations(file, signer(rel))).not.toEqual([]);
      });
      it("randomUUID — можно (Idempotency-Key, Р21): именованный импорт или глобальный crypto.randomUUID", async () => {
        expect(await violations(file, 'import { randomUUID } from "node:crypto";\nexport const u = randomUUID;\n')).toEqual([]);
        expect(await violations(file, "export const u = crypto.randomUUID();\n")).toEqual([]);
      });
    },
  );

  it.each(Object.entries(BYPASSES))("обход границы — нарушение: %s", async (_name, code) => {
    for (const file of ["src/agent/policy/probe.ts", "src/agent/journal/probe.ts", "src/agent/signer/probe.ts", "src/agent/adapters/pao/probe.ts"]) {
      expect(await violations(file, code), file).not.toEqual([]);
    }
  });

  // Стенд Платформы — dev-зависимость для С0 (Р24), не контракт: во всём src, включая место сборки (ревью 3d № 3, 6)
  const STAND_USES: Record<string, string> = {
    "статический импорт": 'import { createStand } from "agentic-ps-platform/stand";\nexport const s = createStand;\n',
    "реэкспорт": 'export * from "agentic-ps-platform/stand";\n',
    "import()": 'export const s = () => import("agentic-ps-platform/stand");\n',
    "тип через import()": 'export type S = import("agentic-ps-platform/stand").Stand;\n',
    "import() в другом регистре": 'export const s = () => import("Agentic-PS-Platform/stand");\n',
    "тип через import() в другом регистре": 'export type S = import("AGENTIC-PS-PLATFORM/stand").Stand;\n',
    "статический импорт в другом регистре": 'import { createStand } from "Agentic-Ps-Platform/stand";\nexport const s = createStand;\n',
  };
  const STAND_FILES = [
    "src/agent/compose.ts",
    "src/agent/policy/probe.ts",
    "src/agent/journal/probe.ts",
    "src/agent/signer/probe.ts",
    "src/agent/adapters/pao/probe.ts",
    "src/agent/adapters/nsvr/probe.ts",
    "src/shared/probe.ts",
  ];
  it.each(Object.entries(STAND_USES))("стенд Платформы в src — нарушение Р24: %s", async (_name, code) => {
    for (const file of STAND_FILES) {
      expect(await violations(file, code), file).toContainEqual(expect.stringContaining("стенд Платформы"));
    }
  });

  it.each(Object.entries(KEY_USES))("ключевой API вне signer — нарушение: %s", async (_name, code) => {
    for (const file of ["src/agent/policy/probe.ts", "src/agent/journal/probe.ts", "src/shared/probe.ts", "src/agent/adapters/pao/probe.ts"]) {
      expect(await violations(file, code), file).not.toEqual([]);
    }
  });

  it("signer: ключевые API можно; адаптеры и типы ПАО — нет", async () => {
    for (const code of Object.values(KEY_USES)) {
      if (code.includes("c.randomUUID") || code.includes("getBuiltinModule")) continue;
      expect(await violations("src/agent/signer/probe.ts", code)).toEqual([]);
    }
    expect(await violations("src/agent/signer/probe.ts", adapter(".."))).not.toEqual([]);
    expect(await violations("src/agent/signer/probe.ts", PAO_TYPES)).not.toEqual([]);
  });

  it("адаптер pao: типы ПАО можно; signer и ключевые API — нет", async () => {
    expect(await violations("src/agent/adapters/pao/probe.ts", PAO_TYPES)).toEqual([]);
    expect(await violations("src/agent/adapters/pao/probe.ts", signer("../.."))).not.toEqual([]);
  });

  it("прочие адаптеры: ни адаптера pao, ни типов ПАО, ни signer", async () => {
    expect(await violations("src/agent/adapters/platform/probe.ts", 'import * as a from "../pao/index.js";\nexport const x = a;\n')).not.toEqual([]);
    expect(await violations("src/agent/adapters/nsvr/probe.ts", PAO_TYPES)).not.toEqual([]);
    expect(await violations("src/agent/adapters/a2a/probe.ts", signer("../.."))).not.toEqual([]);
  });

  it("место сборки: адаптер pao и signer можно, типы ПАО — нет", async () => {
    expect(await violations("src/agent/compose.ts", adapter("."))).toEqual([]);
    expect(await violations("src/agent/compose.ts", signer("."))).toEqual([]);
    expect(await violations("src/agent/compose.ts", PAO_TYPES)).not.toEqual([]);
  });
});
