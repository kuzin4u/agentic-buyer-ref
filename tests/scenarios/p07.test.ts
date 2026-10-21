// П07 (профиль contour): поиск по обеим зонам каталога. Т5; A5, A6 п. 3.1; Р3, Р42 п. 3. На стенде Платформы и витринах
// эмулятора через адаптер витрин: зона контура — только при зоне CONTOUR и знаке готовности; у зоны рынка — ссылка
// человеку, платежа нет (инвариант 10); пояснение различия в защите — код зоны и текст оболочки.
// Решения каталога по фактам ТЕСТОВОГО ПРОФИЛЯ (stand-shop.ts) доказательством не считаются; зона, знак, sku и цена — из витрины.
import { afterEach, describe, expect, it } from "vitest";
import { ZONE_TEXT } from "../../src/agent/shell/index.js";
import { shopBy, type Contour } from "../support/contour.js";
import { STAND_TIMEOUT_MS, standPurchase } from "../support/stand-purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  expect(c?.violations() ?? []).toEqual([]);
  await c?.close();
  c = undefined;
});

const NORMAL = shopBy("NORMAL");
const OUTSIDE = shopBy("READ_ONLY");

describe("П07 — поиск по обеим зонам каталога", { timeout: STAND_TIMEOUT_MS }, () => {
  it("NORMAL в контуре, READ_ONLY вне: две зоны, пояснение у каждой, ссылка у зоны рынка", async () => {
    const r = await standPurchase();
    c = r.c;
    await r.signedIntent();
    const zones = await r.purchase.search();

    expect(NORMAL.zone).toBe("CONTOUR");
    expect(OUTSIDE.zone).toBe("OUTSIDE");
    expect(zones.contour.filter((o) => o.shopId === NORMAL.id).map((o) => o.sku).sort()).toEqual(NORMAL.agent_items.map((i) => i.sku).sort());
    expect(zones.market.map((o) => [o.shopId, o.sku])).toEqual(OUTSIDE.agent_items.map((i) => [OUTSIDE.id, i.sku]));
    // ни одного товара вне контура в зоне контура и наоборот
    expect(zones.contour.some((o) => o.shopId === OUTSIDE.id)).toBe(false);
    expect(zones.market.some((o) => o.shopId === NORMAL.id)).toBe(false);
    // ссылка — только у зоны рынка; адрес — витрина эмулятора, не текст карточки
    expect(zones.market.every((o) => o.link === `${r.c.merchants!.baseUrl}/v1/shops/${OUTSIDE.id}/catalog`)).toBe(true);
    expect(zones.contour.every((o) => o.link === undefined)).toBe(true);
    // пояснение различия в защите (A6 п. 3.1): код у каждой зоны, тексты оболочки различаются
    expect(zones.disclosure).toEqual({ contour: "ZONE_CONTOUR", market: "ZONE_MARKET" });
    expect(ZONE_TEXT[zones.disclosure.contour].ru).toMatch(/гаранти/);
    expect(ZONE_TEXT[zones.disclosure.market].ru).toMatch(/вне контура гарантий/);
    expect(ZONE_TEXT[zones.disclosure.market].ru).toMatch(/не оплачивает/);
    expect(zones.unavailable).toEqual([]);
  });
});
