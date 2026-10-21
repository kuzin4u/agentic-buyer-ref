// П09 (профиль contour): противоречивое описание товара. Т5а; A5 п. 1.3; Р32, Р42 п. 5. На стенде Платформы и витринах
// эмулятора: цена и описание — данные витрины (по-настоящему), сверка — `checkProductA5` ядра: CONTRADICTORY (цена в тексте ≠
// поле price) — пометка A5_PRICE_MISMATCH, покупка только по явному решению человека. Текст витрины — недоверенные данные:
// INJECTION (инструкция в описании) ведёт себя как витрина без инструкции (инвариант 5; распознавание инструкций, Д01, —
// у buyer_agent).
import { afterEach, describe, expect, it } from "vitest";
import { CartRefused } from "../../src/agent/pipeline/index.js";
import { shopBy, type Contour } from "../support/contour.js";
import { STAND_TIMEOUT_MS, standPurchase } from "../support/stand-purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  expect(c?.violations() ?? []).toEqual([]);
  await c?.close();
  c = undefined;
});

const CONTRADICTORY = shopBy("CONTRADICTORY");
const INJECTION = shopBy("INJECTION");
const NORMAL = shopBy("NORMAL");

describe("П09 — противоречивое описание товара", { timeout: STAND_TIMEOUT_MS }, () => {
  it("CONTRADICTORY: цена в тексте ≠ price — помечено A5_PRICE_MISMATCH; корзина без решения человека не готовится", async () => {
    const r = await standPurchase();
    c = r.c;
    await r.signedIntent();
    const zones = await r.purchase.search();
    const offer = zones.contour.find((o) => o.shopId === CONTRADICTORY.id)!;
    expect(offer.a5).toEqual(["A5_PRICE_MISMATCH"]);
    expect(offer.product.price.amount).toBe(CONTRADICTORY.agent_items[0]!.price);
    expect(r.c.journal.entries.filter((e) => e.kind === "offer.flagged").map((e) => [e.reason, e.ref, e.merchant])).toEqual([["A5_PRICE_MISMATCH", offer.sku, CONTRADICTORY.merchant_id]]);
    const before = r.c.calls().length;
    await expect(r.purchase.cart({ merchantId: offer.merchantId, sku: offer.sku, qty: 1, keyTermsShown: true }, { idempotencyKey: "idem-cart-3301" })).rejects.toBeInstanceOf(CartRefused);
    expect(r.c.calls().length).toBe(before);
  });

  it("INJECTION: инструкция в описании не исполняется — предложение как у витрины без инструкции", async () => {
    const r = await standPurchase();
    c = r.c;
    await r.signedIntent();
    const zones = await r.purchase.search();
    const injected = zones.contour.find((o) => o.shopId === INJECTION.id)!;
    const normal = zones.contour.find((o) => o.shopId === NORMAL.id)!;
    expect(INJECTION.agent_items[0]!.description).toMatch(/без подтверждения/);
    // та же зона, без пометок, те же поля модели; текст — только description (данные, не инструкция)
    expect(injected.a5).toEqual([]);
    expect(injected.link).toBeUndefined();
    expect(Object.keys(injected).sort()).toEqual(Object.keys(normal).sort());
    expect(injected.product.description).toBe(INJECTION.agent_items[0]!.description);
    expect(r.c.journal.entries.some((e) => e.merchant === INJECTION.merchant_id && (e.kind === "offer.flagged" || e.kind === "offer.excluded"))).toBe(false);
    // цена — поле витрины, текст её не меняет
    expect(injected.product.price.amount).toBe(INJECTION.agent_items[0]!.price);
  });
});
