import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { PAO_ERRORS, PAO_VERSION } from "@kuzin4u/agentic-core/pao";

// Каркас ядра (AG-01): зависимость от agentic-core v0.11.0 (AG-09 ч. 1 К2, передачи #38 и #41, Р41 п. 1; прежде v0.9.0 — AG-07 К0, передача #34, Р37 п. 1; v0.8.0 — AG-ДГ К1, передача #29; v0.7.0 — Р33, v0.6.0 — Р31, v0.3.0 — AG-05 К1.1) и структура src по CLAUDE.md.
describe("зависимость от agentic-core", () => {
  it("подключена по git+https с тегом v0.11.0", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.dependencies["@kuzin4u/agentic-core"]).toBe(
      "git+https://github.com/kuzin4u/agentic-core.git#v0.11.0",
    );
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const entry = lock.packages["node_modules/@kuzin4u/agentic-core"];
    expect(entry.version).toBe("0.11.0");
    expect(lock.packages[""].dependencies["@kuzin4u/agentic-core"]).toBe(pkg.dependencies["@kuzin4u/agentic-core"]);
    // e6406b3… — коммит тега v0.11.0 (слияние PR #37 ядра, К20). Копия ядра одна: стенд v0.11.0 сам зависит от #v0.11.0
    // (Р41 п. 2). Смена тега — без npm install (передача #41, РП46 доп. п. 1): ссылка в package.json → version и resolved
    // в lock на git+https и полный хэш коммита тега → npm ci; npm install оставляет прежний коммит и переводит адрес на git+ssh.
    expect(entry.resolved).toBe(
      "git+https://github.com/kuzin4u/agentic-core.git#e6406b3a75020de7a5786218aaf0ff7a260654c9",
    );
  });

  it("стенд Платформы для С0 — dev-зависимость по git+https с тегом v0.29.0 (Р24, PS-12; К2а, Р33 п. 9; К1.2, Р34 п. 10; Р41 п. 2; Р45 п. 1; Р47 п. 1; Р48 п. 1; Р49 п. 1; PR #65; Р52, PR #69; Р53 п. 8, PR #71; корневая запись lock — Р54 п. 2; Р57 п. 1, PR #79; Р61 п. 1, PR #85)", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.devDependencies["agentic-ps-platform"]).toBe(
      "git+https://github.com/kuzin4u/agentic-ps-platform.git#v0.29.0",
    );
    expect(pkg.dependencies["agentic-ps-platform"]).toBeUndefined();
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const entry = lock.packages["node_modules/agentic-ps-platform"];
    expect(entry).toMatchObject({ version: "0.29.0", dev: true });
    // корневая запись lock — те же адреса и теги, что package.json (Р54 п. 2, #72): npm ci ставит дерево по записям
    // node_modules/… и отставания корневой записи не замечает (с v0.24.0 до К1.2 ч. 2в там был #v0.23.0)
    expect(lock.packages[""].devDependencies).toEqual(pkg.devDependencies);
    expect(lock.packages[""].dependencies).toEqual(pkg.dependencies);
    // 9db9baf… — коммит тега v0.29.0 (PS-05в ч. 2б, передача #84: допуск, реестр и ключи стенда — Promise; зависимости
    // стенда прежние; ПАО 1.4.0, YAML прежний; служебный PR #85, Р61 п. 1; прежде v0.28.0 — c86d97d…, PS-05б ч. 4,
    // передачи #74, #77, #78, служебный PR #79, Р57 п. 1; v0.25.1 — 5708313…, MER-62-45, передача #70,
    // fastify закреплён 5.12.6, DEP-1 / РП59, AG-09 ч. 2б, PR #71, Р53 п. 8; v0.24.0 — 5762349…, PS-30 ч. 2, служебный PR #69, Р52; v0.23.0 — a5d496a…, PS-30 ч. 1, PR #65; v0.20.0 — dfa4328…, Р49 п. 1; v0.19.0 — 9454e9f…, Р48 п. 1; v0.17.0 — 57b357c…, Р47 п. 1; v0.15.0 — 9fda145…, Р45 п. 1; v0.11.0 — 693a388…, Р41 п. 2). npm install переписывает адрес на git+ssh — в lock только git+https.
    expect(entry.resolved).toBe(
      "git+https://github.com/kuzin4u/agentic-ps-platform.git#9db9baf90a12168e1bb35eb207325f7367308dcc",
    );
    expect(readFileSync("package-lock.json", "utf8")).not.toMatch(/git\+ssh:|"github:/);
    // стенд объявляет тот же тег ядра, что и агент: npm сводит их к одной копии (Р41 п. 2)
    expect(entry.dependencies["@kuzin4u/agentic-core"]).toBe(pkg.dependencies["@kuzin4u/agentic-core"]);
    expect(Object.keys(lock.packages).filter((k) => k.endsWith("node_modules/@kuzin4u/agentic-core"))).toEqual([
      "node_modules/@kuzin4u/agentic-core",
    ]);
  });

  it("стенд в рантайме загружает ту же копию ядра, что и агент", () => {
    const own = realpathSync(createRequire(import.meta.url).resolve("@kuzin4u/agentic-core"));
    const standPkg = createRequire(import.meta.url).resolve("agentic-ps-platform/package.json");
    const stand = realpathSync(createRequire(standPkg).resolve("@kuzin4u/agentic-core"));
    expect(stand).toBe(own);
    // корень пакета — вверх от точки входа до package.json ядра: раскладка dist ядра может смениться
    let dir = dirname(own);
    while (!existsSync(`${dir}/package.json`) || JSON.parse(readFileSync(`${dir}/package.json`, "utf8")).name !== "@kuzin4u/agentic-core") {
      expect(dirname(dir), "package.json ядра не найден").not.toBe(dir);
      dir = dirname(dir);
    }
    expect(JSON.parse(readFileSync(`${dir}/package.json`, "utf8")).version).toBe("0.11.0");
  });

  it("даёт ПАО 1.4.0 и таблицу ошибок с полем retry", () => {
    expect(PAO_VERSION).toBe("1.4.0");
    const codes = Object.keys(PAO_ERRORS);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) expect(PAO_ERRORS[code as keyof typeof PAO_ERRORS]).toHaveProperty("retry");
  });
});

describe("структура ядра", () => {
  const dirs = [
    "src/agent/pipeline",
    "src/agent/policy",
    "src/agent/mandates",
    "src/agent/declines",
    "src/agent/signer",
    "src/agent/adapters/pao",
    "src/agent/adapters/platform",
    "src/agent/adapters/nsvr",
    "src/agent/adapters/a2a",
    "src/agent/journal",
    "src/agent/ports",
    "src/agent/shell",
    "src/shared",
  ];
  it.each(dirs)("%s на месте", (d) => {
    expect(existsSync(`${d}/index.ts`)).toBe(true);
  });

  // Зона src/contour/ снята (Р26 агента п. 4; ревью 3c № 14, AG-04 К2.2): тестовый контур — только в tests/support/.
  // Каталог не возвращается ни кодом, ни правилами границ, ни деревом CLAUDE.md, ни указаниями reviewer.
  it("src/contour/ нет — ни каталога, ни упоминаний в границах, CLAUDE.md и reviewer", () => {
    // без учёта регистра: на Linux (CI) src/Contour — другой каталог, на macOS — тот же (ревью К2.2 № 5)
    expect(readdirSync("src").filter((d) => d.toLowerCase() === "contour")).toEqual([]);
    for (const f of ["eslint.config.js", "config/boundaries.json", "tests/support/import-graph.ts", "CLAUDE.md", ".claude/agents/reviewer.md"]) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/src\/contour|^\s*contour\/\s/m);
    }
  });
});
