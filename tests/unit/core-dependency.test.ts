import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { PAO_ERRORS, PAO_VERSION } from "@kuzin4u/agentic-core/pao";

// Каркас ядра (AG-01): зависимость от agentic-core v0.7.0 (Р33; прежде v0.6.0 — Р31, v0.3.0 — AG-05 К1.1) и структура src по CLAUDE.md.
describe("зависимость от agentic-core", () => {
  it("подключена по git+https с тегом v0.7.0", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.dependencies["@kuzin4u/agentic-core"]).toBe(
      "git+https://github.com/kuzin4u/agentic-core.git#v0.7.0",
    );
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const entry = lock.packages["node_modules/@kuzin4u/agentic-core"];
    expect(entry.version).toBe("0.7.0");
    expect(lock.packages[""].dependencies["@kuzin4u/agentic-core"]).toBe(pkg.dependencies["@kuzin4u/agentic-core"]);
    // 60fc4ce… — коммит тега v0.7.0 (лёгкий тег). Копия ядра одна: зависимость стенда v0.5.0 (#v0.5.0)
    // npm сводит к ней же — стенд в тестах работает на core v0.7.0: основной вход ядра (подпись, проверка запросов,
    // хранилища, SQL-миграции) в v0.5.0 → v0.7.0 не менялся (CHANGELOG ядра), из /pao стенд во время работы ничего не
    // использует; dist стенда собран против типов v0.5.0 — остаточный риск, ловят С0 и этот тест (Р33, К2а).
    expect(entry.resolved).toBe(
      "git+https://github.com/kuzin4u/agentic-core.git#60fc4ce255bbe4ec39953a4da2bd685de7ae39ba",
    );
  });

  it("стенд Платформы для С0 — dev-зависимость по git+https с тегом v0.5.0 (Р24, PS-12; К2а, Р33 п. 9; К1.2, Р34 п. 10)", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.devDependencies["agentic-ps-platform"]).toBe(
      "git+https://github.com/kuzin4u/agentic-ps-platform.git#v0.5.0",
    );
    expect(pkg.dependencies["agentic-ps-platform"]).toBeUndefined();
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const entry = lock.packages["node_modules/agentic-ps-platform"];
    expect(entry).toMatchObject({ version: "0.5.0", dev: true });
    // 96ced44… — коммит тега v0.5.0 (PS-08: лента и подписка, передача #28; ПАО 1.4.0 прежний, РП39 п. 8). npm install переписывает адрес на git+ssh — в lock только git+https.
    expect(entry.resolved).toBe(
      "git+https://github.com/kuzin4u/agentic-ps-platform.git#96ced448d1d324f8f521abd1f8c243f0ae312fc3",
    );
    expect(readFileSync("package-lock.json", "utf8")).not.toMatch(/git\+ssh:|"github:/);
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
    expect(JSON.parse(readFileSync(`${dir}/package.json`, "utf8")).version).toBe("0.7.0");
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
