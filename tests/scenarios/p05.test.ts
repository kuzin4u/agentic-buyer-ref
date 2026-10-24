// П05 (профиль contour): действие без действующего мандата. Т2; A7 п. 1. Полностью с AG-09 ч. 2 (Р42 п. 8, расхождение
// № 25): отказ клиента мандатов (без мандата агент не действует от имени человека и объясняет почему) и действие «найти
// товар» на конвейере с адаптером витрин — без действующего INTENT ни одного обращения к витринам эмулятора (К6).
import { afterEach, describe, expect, it } from "vitest";
import { MandateClient, MandateRefused } from "../../src/agent/mandates/index.js";
import { Consents, INTENT } from "../support/consents.js";
import { createContour, type Contour } from "../support/contour.js";
import { DIAG } from "../../src/agent/compose.js";
import { STAND_TIMEOUT_MS, standPurchase } from "../support/stand-purchase.js";
import { coreOn } from "../support/core.js";
import { PaoStand, CONFIGURATION } from "../support/pao-stand.js";

let stand: PaoStand | undefined;
let contour: Contour | undefined;
afterEach(async () => {
  await stand?.close();
  await contour?.close();
  stand = undefined;
  contour = undefined;
});

describe("П05 — действие без действующего мандата", () => {
  it("контур со стендом и витринами: мандата нет — отказ; к витринам (К6) ни одного обращения", async () => {
    contour = await createContour({ pao: "stand" });
    await contour.start();
    const mandates = new MandateClient({ port: contour.platform, params: contour.params, journal: contour.journal });
    await expect(mandates.requireActive(null)).rejects.toMatchObject({ reason: "MANDATE_NONE" });
    expect(contour.calls().filter((c) => c.target === "merchants")).toEqual([]);
    expect(contour.agentCalls().map((c) => c.route)).toEqual(["GET /pao/v1/agent"]);
    expect(contour.violations()).toEqual([]);
  });

  it("«найти товар» на конвейере: INTENT отказан (не ACTIVE) — поиска нет, к витринам ни одного обращения, причина объяснена", { timeout: STAND_TIMEOUT_MS }, async () => {
    const r = await standPurchase();
    contour = r.c;
    const intent = await r.signedIntent();
    await r.c.platform.relinquishMandate(intent.id, { idempotencyKey: "idem-p05-relinquish" });
    const before = r.c.calls().length;
    await expect(r.purchase.search()).rejects.toBeInstanceOf(MandateRefused);
    expect(r.purchase.state).toBe("STOPPED");
    // причина — код реестра с текстом для человека о поручении, а не техническая
    expect(r.purchase.reason).toMatch(/^MANDATE_/);
    expect(DIAG[r.purchase.reason!]!.human.ru).toMatch(/поручени/);
    // после отказа — только проверка мандата на стенде, к витринам (К6) ни одного обращения
    expect(r.c.calls().slice(before).every((c) => c.target === "pao")).toBe(true);
    expect(r.c.calls().filter((c) => c.target === "merchants")).toEqual([]);
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.call")).toEqual([]);
  });

  it("мандата нет — отказ с объяснением, обращений от имени принципала нет", async () => {
    const consents: Consents = new Consents(() => s.clock);
    const s = new PaoStand({ handlers: consents.handlers() });
    stand = s;
    const { core } = await coreOn(s);
    await core.start();

    const err = (await core.mandates.requireActive(null).catch((e: unknown) => e)) as MandateRefused;
    expect(err).toBeInstanceOf(MandateRefused);
    expect(err.reason).toBe("MANDATE_NONE");
    expect(err.message).toMatch(/не действует от вашего имени/);
    expect(s.log()).toEqual([CONFIGURATION, { op: "GET /pao/v1/agent", status: 200 }]);
    expect(s.stub.violations).toEqual([]);
  });

  it("мандат не подписан — тоже отказ, без verify и прочих обращений", async () => {
    const consents: Consents = new Consents(() => s.clock);
    const s = new PaoStand({ handlers: consents.handlers() });
    stand = s;
    const { core } = await coreOn(s);
    await core.start();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem-p05" });
    await expect(core.mandates.requireActive(m)).rejects.toMatchObject({ reason: "MANDATE_NONE" });
    expect(s.log()).toEqual([
      CONFIGURATION,
      { op: "GET /pao/v1/agent", status: 200 },
      { op: "POST /pao/v1/mandates", status: 201 },
    ]);
    expect(s.stub.violations).toEqual([]);
  });
});
