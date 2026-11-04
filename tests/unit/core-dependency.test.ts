import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { PAO_ERRORS, PAO_VERSION } from "@kuzin4u/agentic-core/pao";

// Каркас ядра (AG-01): зависимость от agentic-core v0.13.0 (сессия 62, PR #99: передачи ядра #41, #44; дополнение к Р41 п. 2;
// прежде v0.11.0 — AG-09 ч. 1 К2, передачи #38 и #41, Р41 п. 1; прежде v0.9.0 — AG-07 К0, передача #34, Р37 п. 1; v0.8.0 — AG-ДГ К1, передача #29; v0.7.0 — Р33, v0.6.0 — Р31, v0.3.0 — AG-05 К1.1) и структура src по CLAUDE.md.
describe("зависимость от agentic-core", () => {
  it("подключена по git+https с тегом v0.13.0", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.dependencies["@kuzin4u/agentic-core"]).toBe(
      "git+https://github.com/kuzin4u/agentic-core.git#v0.13.0",
    );
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const entry = lock.packages["node_modules/@kuzin4u/agentic-core"];
    expect(entry.version).toBe("0.13.0");
    expect(lock.packages[""].dependencies["@kuzin4u/agentic-core"]).toBe(pkg.dependencies["@kuzin4u/agentic-core"]);
    // 8be77a3… — коммит тега v0.13.0 (К25, CO-4; v0.12.0 — К22–К24, ec36de6…; прежде v0.11.0 — e6406b3…, слияние PR #37
    // ядра, К20). Смена тега — без npm install (передача #41, РП46 доп. п. 1; Р45 п. 1): ссылка в package.json → version
    // и resolved в lock на git+https и полный хэш коммита тега → npm ci; npm install оставляет прежний коммит и переводит
    // адрес на git+ssh, а спецификатор — на github: (проверено в К0 сессии 62).
    expect(entry.resolved).toBe(
      "git+https://github.com/kuzin4u/agentic-core.git#8be77a36a7bbbf5db7cd76c5a728247b6bbcfca9",
    );
  });

  it("стенд Платформы для С0 — dev-зависимость по git+https с тегом v0.40.0 (Р24, PS-12; К2а, Р33 п. 9; К1.2, Р34 п. 10; Р41 п. 2; Р45 п. 1; Р47 п. 1; Р48 п. 1; Р49 п. 1; PR #65; Р52, PR #69; Р53 п. 8, PR #71; корневая запись lock — Р54 п. 2; Р57 п. 1, PR #79; Р61 п. 1, PR #85; Р64 п. 1, PR #89; Р68 п. 1, PR #94; К0 AG-13 ч. 2б, PR #98; К1 служебного PR #101; К1 служебного PR #104)", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.devDependencies["agentic-ps-platform"]).toBe(
      "git+https://github.com/kuzin4u/agentic-ps-platform.git#v0.40.0",
    );
    expect(pkg.dependencies["agentic-ps-platform"]).toBeUndefined();
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const entry = lock.packages["node_modules/agentic-ps-platform"];
    expect(entry).toMatchObject({ version: "0.40.0", dev: true });
    // корневая запись lock — те же адреса и теги, что package.json (Р54 п. 2, #72): npm ci ставит дерево по записям
    // node_modules/… и отставания корневой записи не замечает (с v0.24.0 до К1.2 ч. 2в там был #v0.23.0)
    expect(lock.packages[""].devDependencies).toEqual(pkg.devDependencies);
    expect(lock.packages[""].dependencies).toEqual(pkg.dependencies);
    // 1b95e8b… — коммит тега v0.40.0 (передача #102: стенд объявляет ядро #v0.13.0 — тот же тег, что агент; тело /pao
    // байтами — 400 REQUEST_INVALID на теле не в UTF-8, BOM не снимается — агента не затрагивает; ПАО 1.4.0, md и YAML
    // прежние; служебный PR #104); прежде 623579b… — коммит тега v0.39.0 (передача #100, К3.4 платформы: код витрин PACKAGE_AGENT_MISMATCH 409 в
    // MERCHANT_ERROR_CODES; v0.38.0 — лимит частоты API продавцов и ПИ-8, агенту обязательного нет; зависимости стенда
    // прежние, ядро #v0.11.0; ПАО 1.4.0, md и YAML прежние; служебный PR #101); прежде b3444d3… — коммит тега v0.37.0 (передача #97, РП72: подтверждение через продавца — заказ AWAITING_CONFIRMATION,
    // признак payment.confirmation_required, POST …/orders/{order_id}/confirmation; зависимости стенда прежние; ПАО 1.4.0,
    // md и YAML прежние; К0 AG-13 ч. 2б, PR #98; v0.35.0, v0.36.0 агент не брал); прежде v0.34.0 — ab7d847… (передача #86: createMerchants(stand, { paymentMethods }) — способы оплаты витрин
    // по merchant_id; с v0.33.0 — stand.calls(), stand.issuedCredentials(); зависимости стенда прежние; ПАО 1.4.0, md и
    // YAML прежние; служебный PR #94, Р68 п. 1; v0.33.0 агент не брал — Р-1012); прежде v0.32.1 — 762ffb6… (SEC-1-код
    // ч. 1–2б, передачи #86, #88: csr в заявлении, certificate в решении о допуске, stand.caCertificate; стенд без mTLS;
    // AG-SEC1, PR #89, Р64 п. 1); прежде v0.29.0 — 9db9baf…, PS-05в ч. 2б, передача #84: допуск, реестр и ключи стенда — Promise;
    // служебный PR #85, Р61 п. 1; v0.28.0 — c86d97d…, PS-05б ч. 4,
    // передачи #74, #77, #78, служебный PR #79, Р57 п. 1; v0.25.1 — 5708313…, MER-62-45, передача #70,
    // fastify закреплён 5.12.6, DEP-1 / РП59, AG-09 ч. 2б, PR #71, Р53 п. 8; v0.24.0 — 5762349…, PS-30 ч. 2, служебный PR #69, Р52; v0.23.0 — a5d496a…, PS-30 ч. 1, PR #65; v0.20.0 — dfa4328…, Р49 п. 1; v0.19.0 — 9454e9f…, Р48 п. 1; v0.17.0 — 57b357c…, Р47 п. 1; v0.15.0 — 9fda145…, Р45 п. 1; v0.11.0 — 693a388…, Р41 п. 2). npm install переписывает адрес на git+ssh — в lock только git+https.
    expect(entry.resolved).toBe(
      "git+https://github.com/kuzin4u/agentic-ps-platform.git#1b95e8b73c2363ce6b7ffeccb7ccc14216e7eeae",
    );
    expect(readFileSync("package-lock.json", "utf8")).not.toMatch(/git\+ssh:|"github:/);
    // Одна копия ядра (Р41 п. 2; дополнение 2 — сессия 64, PR #104): стенд объявляет тот же тег ядра, что агент, — сравнение
    // двух значений, без литерала; любое расхождение тегов роняет тест (npm ci его не замечает) и требует нового решения.
    // Отступление дополнения 1 (сессия 62, PR #99: стенд v0.37.0–v0.39.0 объявлял #v0.11.0) снято стендом v0.40.0.
    // Только npm ci, не npm install, — по Р-1044: npm install переписывает адрес на git+ssh, спецификатор — на github:.
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
    expect(JSON.parse(readFileSync(`${dir}/package.json`, "utf8")).version).toBe("0.13.0");
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
