// Транзитивная граница импортов на компиляторе TypeScript (Р24 п. 3): Р19 и изоляция ключей (инвариант 2).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SOURCE_FILE, importGraphViolations, type Project } from "../support/import-graph.js";

const ROOT = resolve(".");

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

/** Виртуальный проект: файлы src задаются тестом, tsconfig и node_modules — настоящие. */
function virtual(files: Record<string, string>): Project {
  const root = join(ROOT, ".virtual-graph");
  const map = new Map(Object.entries(files).map(([rel, text]) => [join(root, rel), text]));
  return {
    root,
    files: [...map.keys()],
    read: (p) => map.get(p) ?? (p === join(root, "tsconfig.json") ? readFileSync(join(ROOT, "tsconfig.json"), "utf8") : undefined),
    exists: (p) => map.has(p),
  };
}

describe("граф импортов src (Р24)", { timeout: 60_000 }, () => {
  it("в src — только исходники TypeScript (без .js/.mjs/.cjs/.jsx и .d.ts)", () => {
    expect(allFiles(join(ROOT, "src")).filter((f) => !SOURCE_FILE.test(f))).toEqual([]);
  });

  it("настоящий src: транзитивных нарушений нет", () => {
    const files = allFiles(join(ROOT, "src"));
    expect(files.length).toBeGreaterThan(20);
    const p: Project = { root: ROOT, files, read: (f) => (existsSync(f) ? readFileSync(f, "utf8") : undefined), exists: existsSync };
    expect(importGraphViolations(p)).toEqual([]);
  });

  it("ядро → shared → адаптер pao: нарушение через промежуточный модуль", () => {
    const v = importGraphViolations(
      virtual({
        "src/agent/policy/index.ts": 'import { x } from "../../shared/util.js";\nexport const y = x;\n',
        "src/shared/util.ts": 'export { PaoPlatform as x } from "../agent/adapters/pao/index.js";\n',
        "src/agent/adapters/pao/index.ts": "export const PaoPlatform = 1;\n",
      }),
    );
    expect(v).toContain("src/agent/policy/index.ts → … → src/agent/adapters/pao/index.ts: адаптер (Р19)");
    expect(v).toContain("src/shared/util.ts → … → src/agent/adapters/pao/index.ts: адаптер (Р19)");
  });

  it("journal → ports → signer: нарушение инварианта 2 через порт", () => {
    const v = importGraphViolations(
      virtual({
        "src/agent/journal/index.ts": 'import type { P } from "../ports/index.js";\nexport type J = P;\n',
        "src/agent/ports/index.ts": 'export type { KeyRing as P } from "../signer/ring.js";\n',
        "src/agent/signer/ring.ts": "export class KeyRing {}\n",
      }),
    );
    expect(v).toContain("src/agent/journal/index.ts → … → src/agent/signer/ring.ts: signer (инвариант 2)");
  });

  it("тип через import(\"…\") и export * from — тоже рёбра графа", () => {
    const v = importGraphViolations(
      virtual({
        "src/agent/pipeline/index.ts": 'export type T = import("../../shared/re.js").X;\n',
        "src/shared/re.ts": 'export * from "./deep.js";\n',
        "src/shared/deep.ts": 'export type { AgentSelf as X } from "@kuzin4u/agentic-core/pao";\n',
      }),
    );
    expect(v).toContain("src/agent/pipeline/index.ts → … → src/shared/deep.ts: @kuzin4u/agentic-core/pao (Р19)");
  });

  it("прочий адаптер → адаптер pao транзитивно; любой модуль → место сборки", () => {
    const v = importGraphViolations(
      virtual({
        "src/agent/adapters/nsvr/index.ts": 'import "../../../shared/bridge.js";\n',
        "src/shared/bridge.ts": 'import "../agent/adapters/pao/index.js";\n',
        "src/agent/adapters/pao/index.ts": "export {};\n",
        "src/agent/shell/index.ts": 'import "../compose.js";\n',
        "src/agent/compose.ts": "export {};\n",
      }),
    );
    expect(v).toContain("src/agent/adapters/nsvr/index.ts → … → src/agent/adapters/pao/index.ts: адаптер pao (Р19)");
    expect(v).toContain("src/agent/shell/index.ts → … → src/agent/compose.ts: место сборки (Р19)");
  });

  it("node:crypto из ядра ради randomUUID — можно; ключевые API в любом виде — нарушение", () => {
    const ok = importGraphViolations(
      virtual({
        "src/agent/pipeline/a.ts": 'import { randomUUID } from "node:crypto";\nexport const id = randomUUID();\n',
        "src/agent/pipeline/b.ts": "export const id = crypto.randomUUID();\nexport const r = crypto.getRandomValues(new Uint8Array(4));\n",
      }),
    );
    expect(ok).toEqual([]);
    const v = importGraphViolations(
      virtual({
        "src/agent/pipeline/a.ts": 'import { generateKeyPairSync as g } from "node:crypto";\nexport const k = g;\n',
        "src/agent/pipeline/b.ts": 'import * as c from "crypto";\nexport const s = c.sign;\nexport const t = c["createPrivateKey"];\n',
        "src/agent/pipeline/c.ts": 'import crypto from "node:crypto";\nconst { privateDecrypt } = crypto;\nexport const d = privateDecrypt;\n',
        "src/agent/pipeline/d.ts": "export const s = globalThis.crypto.subtle;\n",
        "src/agent/pipeline/e.ts": 'import * as core from "@kuzin4u/agentic-core";\nexport const n = core.newEd25519Signer;\n',
        "src/agent/signer/ok.ts": 'import { generateKeyPairSync } from "node:crypto";\nexport const k = generateKeyPairSync;\n',
      }),
    );
    expect(v.filter((x) => x.includes("pipeline/a.ts"))).toHaveLength(1);
    expect(v.filter((x) => x.includes("pipeline/b.ts")).length).toBeGreaterThan(0);
    expect(v.filter((x) => x.includes("pipeline/c.ts")).length).toBeGreaterThan(0);
    expect(v.filter((x) => x.includes("pipeline/d.ts")).length).toBeGreaterThan(0);
    expect(v.filter((x) => x.includes("pipeline/e.ts")).length).toBeGreaterThan(0);
    expect(v.filter((x) => x.includes("signer/ok.ts"))).toEqual([]);
  });

  it("реэкспорт ключевых API, import() модулей с ключами, default-импорт node:module — нарушение (ревью 3c № 1–3)", () => {
    const v = importGraphViolations(
      virtual({
        "src/shared/k.ts": 'export { generateKeyPairSync, sign, randomUUID } from "node:crypto";\n',
        "src/shared/all.ts": 'export * from "crypto";\n',
        "src/shared/core.ts": 'export { newEd25519Signer } from "@kuzin4u/agentic-core";\nexport * from "@kuzin4u/agentic-core";\n',
        "src/agent/journal/a.ts": 'export const g = async () => (await import("node:crypto")).generateKeyPairSync;\n',
        "src/agent/journal/b.ts": 'export const n = async () => (await import("@kuzin4u/agentic-core")).newEd25519Signer;\n',
        "src/agent/policy/m.ts": 'import m from "node:module";\nexport const r = m.createRequire(import.meta.url);\n',
        "src/agent/signer/ok.ts": 'export { sign } from "node:crypto";\nexport const g = async () => (await import("node:crypto")).generateKeyPairSync;\n',
      }),
    );
    expect(v).toContain("src/shared/k.ts:1 ключевой API: реэкспорт из node:crypto");
    expect(v).toContain("src/shared/all.ts:1 ключевой API: реэкспорт из crypto");
    expect(v).toContain("src/shared/core.ts:1 ключевой API: реэкспорт @kuzin4u/agentic-core.newEd25519Signer");
    expect(v).toContain("src/shared/core.ts:2 ключевой API: export * from @kuzin4u/agentic-core");
    expect(v).toContain('src/agent/journal/a.ts:1 ключевой API: import("node:crypto")');
    expect(v).toContain('src/agent/journal/b.ts:1 ключевой API: import("@kuzin4u/agentic-core")');
    expect(v).toContain("src/agent/policy/m.ts:1 node:module — обход статических импортов");
    expect(v.filter((x) => x.includes("signer/ok.ts"))).toEqual([]);
  });

  it("объект crypto наружу и getBuiltinModule — нарушение (ревью 3c, повтор № 1–3)", () => {
    const v = importGraphViolations(
      virtual({
        "src/shared/a.ts": 'export { default as c } from "node:crypto";\n',
        "src/shared/b.ts": 'import * as crypto from "node:crypto";\nexport { crypto };\n',
        "src/shared/c.ts": 'import crypto from "node:crypto";\nexport default crypto;\n',
        "src/shared/d.ts": "export const w = crypto;\nexport const s = crypto.subtle;\nexport const g = globalThis.crypto;\n",
        "src/shared/e.ts": 'export { default } from "@kuzin4u/agentic-core";\nimport * as core from "@kuzin4u/agentic-core";\nexport { core };\n',
        "src/agent/policy/f.ts": 'declare const process: { getBuiltinModule(m: string): unknown };\nexport const c = process.getBuiltinModule("node:crypto");\n',
      }),
    );
    for (const f of ["a", "b", "c", "d", "e"]) expect(v.some((x) => x.startsWith(`src/shared/${f}.ts`)), f).toBe(true);
    for (const line of [1, 2, 3]) expect(v.some((x) => x.startsWith(`src/shared/d.ts:${line} `)), `d.ts:${line}`).toBe(true);
    expect(v).toContain("src/agent/policy/f.ts:2 getBuiltinModule — обход статических импортов");
  });

  it("subtle/webcrypto именованно, путь в node_modules, импорт вне src, .mts — нарушение (ревью 3c, повтор 2)", () => {
    const v = importGraphViolations(
      virtual({
        "src/agent/journal/a.ts": 'import { subtle, webcrypto, createHash, randomUUID } from "node:crypto";\nexport const x = [subtle, webcrypto, createHash, randomUUID];\n',
        "src/agent/journal/b.ts": 'import { newEd25519Signer } from "../../../node_modules/@kuzin4u/agentic-core/dist/src/signing.js";\nexport const n = newEd25519Signer;\n',
        "src/agent/journal/c.ts": 'import { PaoStand } from "../../../tests/support/pao-stand.js";\nexport const s = PaoStand;\n',
        "src/agent/journal/k.mts": 'import { generateKeyPairSync } from "node:crypto";\nexport const k = generateKeyPairSync;\n',
      }),
    );
    expect(v).toContain("src/agent/journal/a.ts:1 ключевой API node:crypto.subtle");
    expect(v).toContain("src/agent/journal/a.ts:1 ключевой API node:crypto.webcrypto");
    expect(v.some((x) => x.includes("createHash") || x.includes("randomUUID"))).toBe(false);
    expect(v.some((x) => x.startsWith("src/agent/journal/b.ts: импорт вне src"))).toBe(true);
    expect(v.some((x) => x.startsWith("src/agent/journal/c.ts: импорт вне src"))).toBe(true);
    expect(v).toContain("src/agent/journal/k.mts:1 ключевой API node:crypto.generateKeyPairSync");
  });

  it("JS с соседним .d.ts и псевдоним #core — нарушение (ревью 3c, повтор 3)", () => {
    const v = importGraphViolations(
      virtual({
        "src/agent/pipeline/a.ts": 'import { k } from "./k.js";\nexport const x = k;\n',
        "src/agent/pipeline/k.d.ts": "export declare const k: unknown;\n",
        "src/agent/pipeline/b.ts": 'import { newEd25519Signer } from "#core";\nexport const n = newEd25519Signer;\n',
      }),
    );
    expect(v.some((x) => x.startsWith("src/agent/pipeline/a.ts: импорт объявления src/agent/pipeline/k.d.ts"))).toBe(true);
    expect(v.some((x) => x.startsWith("src/agent/pipeline/b.ts: псевдоним «#core»"))).toBe(true);
    expect(SOURCE_FILE.test("src/agent/pipeline/k.js")).toBe(false);
    expect(SOURCE_FILE.test("src/agent/pipeline/k.d.ts")).toBe(false);
    expect(SOURCE_FILE.test("src/agent/pipeline/k.mts")).toBe(true);
  });

  it("нелитеральный import() и require() — нарушение", () => {
    const v = importGraphViolations(
      virtual({
        "src/agent/policy/a.ts": 'const p = "x";\nexport const m = () => import(p);\n',
        "src/agent/policy/b.ts": "declare const require: (s: string) => unknown;\nconst p = 'x';\nexport const m = require(p);\n",
        "src/agent/policy/c.ts": 'import { createRequire } from "node:module";\nexport const r = createRequire;\n',
      }),
    );
    expect(v).toEqual([
      "src/agent/policy/a.ts:2 import() не литералом",
      "src/agent/policy/b.ts:3 require() не литералом",
      "src/agent/policy/c.ts:1 node:module — обход статических импортов",
    ]);
  });
});
