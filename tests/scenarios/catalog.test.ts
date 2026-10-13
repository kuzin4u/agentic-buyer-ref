import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PAO_ERRORS } from "@kuzin4u/agentic-core/pao";

// Проверка каталога сценариев: JSON — источник истины, SCENARIOS.md должен совпадать по кодам.
const catalog = JSON.parse(readFileSync("tests/scenarios/scenarios.json", "utf8"));
const md = readFileSync("docs/core/SCENARIOS.md", "utf8");

// Р26: источники кодов — x-pao-errors копии ПАО (SPEC §7а) и причины operation.declined (SPEC §7б).
// openapi.yaml заморожен и кодов не даёт; коды витрин — после экспорта перечня эмулятором Платформы.
function paoErrorCodes(yaml: string): string[] {
  // Раздел — до следующего ключа верхнего уровня (paths:, components: …).
  const tail = (yaml.split(/^x-pao-errors:$/m)[1] ?? "").split(/^\S/m)[0]!;
  return [...tail.matchAll(/^ {2}- code: (\w+)$/gm)].map((m) => m[1]!);
}
function declineReasons(spec: string): string[] {
  // Раздел — до следующего заголовка любого уровня (### 7в, ## 8 …).
  const section = spec.split(/^### 7б\./m)[1]?.split(/^#{2,3} /m)[0] ?? "";
  return [...section.matchAll(/^\| ([A-Z][A-Z_]+) \|/gm)].map((m) => m[1]!);
}
const paoErrors = paoErrorCodes(readFileSync("docs/core/protocol/agent-protocol.v1.2.0.yaml", "utf8"));
const reasons = declineReasons(readFileSync("docs/core/SPEC.md", "utf8"));

describe("каталог сценариев приёмки", () => {
  const ids: string[] = catalog.scenarios.map((s: { id: string }) => s.id);

  it("содержит 30 сценариев с уникальными кодами", () => {
    expect(ids.length).toBe(30);
    expect(new Set(ids).size).toBe(30);
  });

  it("каждый сценарий описан полностью", () => {
    for (const s of catalog.scenarios) {
      for (const f of ["id", "type", "stage", "title", "setup", "action", "expected", "norms", "requirements"]) {
        expect(s[f], `${s.id}.${f}`).toBeTruthy();
      }
      expect(["positive", "negative"]).toContain(s.type);
    }
  });

  it("SCENARIOS.md совпадает с JSON по составу кодов", () => {
    const mdIds = [...md.matchAll(/^\| ([ПД]\d\d) \|/gmu)].map((m) => m[1]);
    expect(mdIds).toEqual(ids);
  });

  // Сломанный разбор дал бы пустой перечень и пустую проверку ниже (ревью Р26 № 1).
  it("перечни кодов разобраны полностью: ПАО — 18 кодов, SPEC §7б — три причины", () => {
    expect(paoErrors).toHaveLength(18);
    // Независимый источник: таблица ошибок agentic-core по той же версии ПАО.
    expect([...paoErrors].sort()).toEqual(Object.keys(PAO_ERRORS).sort());
    expect(reasons).toEqual(["AOI_MISSING", "AOI_MISMATCH", "INSUFFICIENT_FUNDS"]);
  });

  it("коды отказа в сценариях — из x-pao-errors ПАО или причин SPEC §7б (Р26)", () => {
    const known = new Set([...paoErrors, ...reasons]);
    for (const s of catalog.scenarios) for (const c of s.codes) expect(known, `${s.id}: ${c}`).toContain(c);
  });

  // Р23: поле contour — сценарий против Платформы по ПАО; коды — из x-pao-errors копии ПАО.
  // Строже Р26 п. 5: contour.codes — только ПАО, без причин §7б (Р23).
  it("профиль contour: поле описано полностью, коды — из x-pao-errors ПАО", () => {
    const pao = new Set(paoErrors);
    const withContour = catalog.scenarios.filter((s: { contour?: unknown }) => s.contour !== undefined);
    expect(withContour.map((s: { id: string }) => s.id)).toEqual(["П01", "П02", "П03"]);
    for (const s of withContour) {
      expect(s.contour.action, `${s.id}.contour.action`).toBeTruthy();
      expect(s.contour.expected, `${s.id}.contour.expected`).toBeTruthy();
      expect(Array.isArray(s.contour.codes), `${s.id}.contour.codes`).toBe(true);
      for (const c of s.contour.codes) expect(pao, `${s.id}: ${c}`).toContain(c);
    }
  });

  it("SCENARIOS.md описывает каждый сценарий с полем contour", () => {
    const section = md.split("## Профиль contour")[1] ?? "";
    for (const s of catalog.scenarios.filter((x: { contour?: unknown }) => x.contour !== undefined)) {
      expect(section).toContain(`**${s.id}**`);
    }
  });
});
