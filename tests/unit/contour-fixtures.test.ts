// К1.2 AG-04: данные витрин — только из agentic-ps-platform/fixtures (Р26 п. 3; CONTOUR.md «Витрины-эмуляторы»).
// Эмулятор отдаёт ровно фикстуры, а тесты и ядро не держат копий: ни id, ни merchant_id, ни sku, ни названий витрин.
// Ограничение стража: ищется подстрока, собранная из частей строка ("SHOP-" + n) не видна — это проверяет ревью PR.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { MERCHANT_FIXTURES } from "agentic-ps-platform/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContour, shopBy, type Contour } from "../support/contour.js";

const ROOT = resolve(".");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : /\.([mc]?tsx?|[mc]?js)$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

describe("эмулятор продавцов отдаёт фикстуры Платформы", () => {
  let c: Contour;
  beforeAll(async () => {
    c = await createContour({ pao: "stand" });
    await c.start();
  });
  afterAll(() => c?.close());

  it("список витрин = MERCHANT_FIXTURES (порядок по id, зона и знак готовности — из фикстур)", async () => {
    const r = await c.merchants!.request("GET", "/v1/shops", { signed: false });
    const expected = [...MERCHANT_FIXTURES]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(({ id, merchant_id, name, category, zone, readiness_mark }) => ({ id, merchant_id, name, category, zone, readiness_mark }));
    expect(expected.length).toBeGreaterThan(0);
    expect(r).toEqual({ status: 200, body: { shops: expected } });
  });

  it.each(MERCHANT_FIXTURES.map((f) => [f.id, f] as const))("каталог %s: агенту — agent_items, человеку — items", async (_id, f) => {
    const agent = await c.merchants!.request("GET", `/v1/shops/${f.id}/catalog`);
    expect(agent.status).toBe(200);
    expect((agent.body as { items: unknown }).items).toEqual(f.agent_items);

    const human = await c.merchants!.request("GET", `/v1/shops/${f.id}/catalog`, { signed: false });
    if (f.behaviour === "REJECTS_UNIDENTIFIED") {
      expect(human.status).toBe(403);
    } else {
      expect(human.status).toBe(200);
      expect((human.body as { items: unknown }).items).toEqual(f.items);
    }
  });

  it("shopBy — одна витрина на поведение; неизвестное поведение — ошибка, не догадка", () => {
    for (const f of MERCHANT_FIXTURES) expect(shopBy(f.behaviour)).toBe(f);
    expect(() => shopBy("NO_SUCH" as never)).toThrow(/ждали одну/);
  });
});

describe("тесты и ядро не копируют данные витрин", () => {
  it("в src/ и tests/ (.ts, .js) нет id, merchant_id, sku и названий витрин литералами — только через фикстуры", () => {
    const values = new Set(
      MERCHANT_FIXTURES.flatMap((f) => [f.id, f.merchant_id, f.name, ...f.items.map((i) => i.sku), ...f.agent_items.map((i) => i.sku)]),
    );
    expect(values.size).toBeGreaterThan(MERCHANT_FIXTURES.length);
    const hits = [...sourceFiles(join(ROOT, "src")), ...sourceFiles(join(ROOT, "tests"))].flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return [...values].filter((v) => text.includes(v)).map((v) => `${relative(ROOT, file)}: ${v}`);
    });
    expect(hits).toEqual([]);
  });

  it("витрины, названные в сценариях (scenarios.json), есть в фикстурах — смена фикстур не расходится со сценариями молча", () => {
    const text = readFileSync(join(ROOT, "tests/scenarios/scenarios.json"), "utf8");
    const named = [...new Set(text.match(/\b(?:SHOP|MKT)-\d+\b/g) ?? [])];
    expect(named.length).toBeGreaterThan(0);
    const ids = new Set(MERCHANT_FIXTURES.map((f) => f.id));
    expect(named.filter((id) => !ids.has(id))).toEqual([]);
  });
});
