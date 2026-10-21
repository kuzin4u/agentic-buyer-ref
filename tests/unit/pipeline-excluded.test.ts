// EXCLUDED от политики на стадии 3 (Р40 п. 6, Р38 поправка К5, Р-109): в конвейере недостижим — товар берётся только из
// contour своей выдачи, политике передаётся AVAILABLE. Путь проверяется подменой политики в этом файле: STOPPED UNKNOWN с
// уточнением CART_POLICY_EXCLUDED в записи остановки, без agent.refused и cart.refused, обращений нет.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PurchaseStopped } from "../../src/agent/pipeline/index.js";
import { expectJournalClean } from "../support/journal.js";
import { AGENT, type PaoStand } from "../support/pao-stand.js";
import { one, purchaseOn, signedIntent } from "../support/purchase.js";

vi.mock("../../src/agent/policy/catalog.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/agent/policy/catalog.js")>();
  return { ...original, mayDraftCart: () => ({ allow: false, code: "EXCLUDED" }) };
});

let stand: PaoStand | undefined;
afterEach(async () => {
  expect(stand?.stub.violations ?? []).toEqual([]);
  await stand?.close();
  stand = undefined;
});

describe("EXCLUDED на стадии 3 — STOPPED:CART_POLICY_EXCLUDED (Р40 п. 6)", () => {
  it("одна запись остановки с уточнением, reason UNKNOWN; agent.refused и cart.refused нет; обращений нет", async () => {
    const r = await purchaseOn({}, (s) => (stand = s));
    await signedIntent(r);
    const offer = (await r.purchase.search()).contour[0]!;
    const from = r.stand.stub.calls.length;
    const start = r.tail().length;
    await expect(
      r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-1" }),
    ).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.reason).toBe("UNKNOWN");
    expect(r.tail().slice(start).map((e) => [e.kind, e.detail, e.reason, e.mandate])).toEqual([
      ["purchase.stage", "STOPPED:CART_POLICY_EXCLUDED", "UNKNOWN", r.purchase.intentMandate!.id],
    ]);
    expect(r.stand.stub.calls.slice(from)).toEqual([]);
    expectJournalClean(r.journal.entries, AGENT, r.stand.stub.calls, ["idem-intent-1"]);
  });
});
