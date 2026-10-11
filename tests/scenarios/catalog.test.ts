import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Проверка каталога сценариев: JSON — источник истины, SCENARIOS.md должен совпадать по кодам.
const catalog = JSON.parse(readFileSync("tests/scenarios/scenarios.json", "utf8"));
const md = readFileSync("docs/core/SCENARIOS.md", "utf8");

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

  it("коды отказа в сценариях — из перечня контракта", () => {
    const yaml = readFileSync("docs/core/openapi.yaml", "utf8");
    for (const s of catalog.scenarios) for (const c of s.codes) expect(yaml).toContain(`- ${c}`);
  });

  // Р23: поле contour — сценарий против Платформы по ПАО; коды — из x-pao-errors копии ПАО.
  it("профиль contour: поле описано полностью, коды — из x-pao-errors ПАО", () => {
    const pao = readFileSync("docs/core/protocol/agent-protocol.v1.2.0.yaml", "utf8");
    const paoErrors = new Set([...pao.split("x-pao-errors:")[1]!.matchAll(/^ {2}- code: (\w+)$/gm)].map((m) => m[1]));
    const withContour = catalog.scenarios.filter((s: { contour?: unknown }) => s.contour !== undefined);
    expect(withContour.map((s: { id: string }) => s.id)).toEqual(["П01", "П02", "П03"]);
    for (const s of withContour) {
      expect(s.contour.action, `${s.id}.contour.action`).toBeTruthy();
      expect(s.contour.expected, `${s.id}.contour.expected`).toBeTruthy();
      expect(Array.isArray(s.contour.codes), `${s.id}.contour.codes`).toBe(true);
      for (const c of s.contour.codes) expect(paoErrors, `${s.id}: ${c}`).toContain(c);
    }
  });

  it("SCENARIOS.md описывает каждый сценарий с полем contour", () => {
    const section = md.split("## Профиль contour")[1] ?? "";
    for (const s of catalog.scenarios.filter((x: { contour?: unknown }) => x.contour !== undefined)) {
      expect(section).toContain(`**${s.id}**`);
    }
  });
});
