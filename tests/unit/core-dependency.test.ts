import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { PAO_ERRORS, PAO_VERSION } from "@kuzin4u/agentic-core/pao";

// Каркас ядра (AG-01): зависимость от agentic-core v0.3.0 (AG-05 К1.1) и структура src по CLAUDE.md.
describe("зависимость от agentic-core", () => {
  it("подключена по git+https с тегом v0.3.0", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.dependencies["@kuzin4u/agentic-core"]).toBe(
      "git+https://github.com/kuzin4u/agentic-core.git#v0.3.0",
    );
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const entry = lock.packages["node_modules/@kuzin4u/agentic-core"];
    expect(entry.version).toBe("0.3.0");
    expect(lock.packages[""].dependencies["@kuzin4u/agentic-core"]).toBe(pkg.dependencies["@kuzin4u/agentic-core"]);
    // 545b949… — коммит тега v0.3.0 (лёгкий тег). Копия ядра одна: зависимость стенда #v0.2.1
    // npm сводит к ней же — стенд в тестах работает на core v0.3.0 (стенд берёт из ядра только /pao,
    // ed25519Verifier и verifyRequest — в v0.3.0 без изменений, CHANGELOG ядра «Переход с 0.2.x»).
    expect(entry.resolved).toBe(
      "git+https://github.com/kuzin4u/agentic-core.git#545b949ea6ae51b21fb3ba15ed0e6d4bfb1c6706",
    );
  });

  it("стенд Платформы для С0 — dev-зависимость по git+https с тегом v0.2.0 (Р24, PS-12)", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.devDependencies["agentic-ps-platform"]).toBe(
      "git+https://github.com/kuzin4u/agentic-ps-platform.git#v0.2.0",
    );
    expect(pkg.dependencies["agentic-ps-platform"]).toBeUndefined();
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const entry = lock.packages["node_modules/agentic-ps-platform"];
    expect(entry).toMatchObject({ version: "0.2.0", dev: true });
    // 0396fad… — коммит тега v0.2.0. npm install переписывает адрес на git+ssh — в lock только git+https.
    expect(entry.resolved).toBe(
      "git+https://github.com/kuzin4u/agentic-ps-platform.git#0396fad67ec9e1cc9dd02a8d3773e49c71762044",
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
    expect(JSON.parse(readFileSync(`${dir}/package.json`, "utf8")).version).toBe("0.3.0");
  });

  it("даёт ПАО 1.2.0 и таблицу ошибок с полем retry", () => {
    expect(PAO_VERSION).toBe("1.2.0");
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
