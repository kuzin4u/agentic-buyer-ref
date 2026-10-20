// Политика до стадий 4–5 по Р39: порядок проверок как у ADP (verify, остаток, пределы), валюта, меньший из порогов, окно
// дробления по корневому INTENT. Чистые функции и окно без конвейера; встраивание — pipeline-stages.test.ts.
import { describe, expect, it } from "vitest";
import { SplitWindow, confirmThreshold, currencySupported, mandateRefusal, mayAuthorize, needsConfirmation } from "../../src/agent/policy/index.js";
import { loadParams } from "../../src/shared/config.js";
import type { Mandate, MandateCheck } from "../../src/shared/domain.js";
import { INTENT } from "../support/consents.js";

const { confirm_above_kop: THRESHOLD, split_window_sec: WINDOW, split_min_ops: MIN_OPS } = loadParams();
const rub = (amount: number) => ({ amount, currency: "RUB" });
const TOTAL = rub(45000);

const intent: Mandate = { ...INTENT, id: "mnd_intent", status: "ACTIVE", signatureLevel: null, revocationOrder: "ro" };
const cart: Mandate = {
  ...INTENT,
  kind: "CART",
  parentId: intent.id,
  amountLimit: TOTAL,
  cart: { merchantId: "shop_1", lines: [{ sku: "tartine", qty: 1, price: TOTAL }], total: TOTAL },
  id: "mnd_cart",
  status: "ACTIVE",
  signatureLevel: null,
  revocationOrder: "ro",
};
const facts = { intent, cart, merchantId: "shop_1", total: TOTAL };
const ok = (amount = 500000, currency = "RUB"): MandateCheck => ({ outcome: "CONFIRMED", amountLeft: { amount, currency }, validTo: INTENT.validTo, asOf: null });

describe("mayAuthorize — порядок проверок ADP (Р39 п. 1.1–1.3)", () => {
  it("всё в пределах — разрешено; остаток ровно итог — разрешено (К4а)", () => {
    expect(mayAuthorize(facts, { intent: ok(), cart: ok() })).toEqual({ allow: true });
    expect(mayAuthorize(facts, { intent: ok(TOTAL.amount), cart: ok(TOTAL.amount) })).toEqual({ allow: true });
  });

  for (const outcome of ["OUT_OF_SCOPE", "STATE_UNKNOWN"] as const) {
    it(`verify ${outcome} — вне пределов (Р35, инвариант 4)`, () => {
      expect(mayAuthorize(facts, { intent: { ...ok(), outcome }, cart: ok() })).toMatchObject({ allow: false, code: "MANDATE_OUT_OF_SCOPE", mandate: intent });
      expect(mayAuthorize(facts, { intent: ok(), cart: { ...ok(), outcome } })).toMatchObject({ allow: false, code: "MANDATE_OUT_OF_SCOPE", mandate: cart });
    });
  }

  it("amount_left = 0 при CONFIRMED — вне пределов, а не «остатка не хватает» (ПАО §3)", () => {
    expect(mayAuthorize(facts, { intent: ok(0), cart: ok() })).toMatchObject({ code: "MANDATE_OUT_OF_SCOPE", mandate: intent });
    expect(mayAuthorize(facts, { intent: ok(), cart: ok(0) })).toMatchObject({ code: "MANDATE_OUT_OF_SCOPE", mandate: cart });
  });

  it("остаток меньше итога — MANDATE_AMOUNT_LEFT_INSUFFICIENT по тому мандату (К4а, #36)", () => {
    expect(mayAuthorize(facts, { intent: ok(TOTAL.amount - 1), cart: ok() })).toMatchObject({ code: "MANDATE_AMOUNT_LEFT_INSUFFICIENT", mandate: intent });
    expect(mayAuthorize(facts, { intent: ok(), cart: ok(TOTAL.amount - 1) })).toMatchObject({ code: "MANDATE_AMOUNT_LEFT_INSUFFICIENT", mandate: cart });
  });

  it("остаток в чужой валюте — вне пределов (MANDATE_OUT_OF_SCOPE), а не нехватка суммы, даже если сумма больше (решение владельца по В2)", () => {
    expect(mayAuthorize(facts, { intent: ok(), cart: ok(500000, "USD") })).toMatchObject({ code: "MANDATE_OUT_OF_SCOPE", mandate: cart });
    expect(mayAuthorize(facts, { intent: ok(1, "USD"), cart: ok() })).toMatchObject({ code: "MANDATE_OUT_OF_SCOPE", mandate: intent });
    expect(mandateRefusal(intent, ok(500000, "USD"), TOTAL)).toMatchObject({ code: "MANDATE_OUT_OF_SCOPE", mandate: intent });
  });

  it("продавец вне merchantScope или валюта предела не та — MANDATE_OUT_OF_SCOPE (как MANDATE_SCOPE у ADP)", () => {
    const checks = { intent: ok(), cart: ok() };
    expect(mayAuthorize({ ...facts, intent: { ...intent, merchantScope: ["shop_2"] } }, checks)).toMatchObject({ code: "MANDATE_OUT_OF_SCOPE", mandate: { id: intent.id } });
    expect(mayAuthorize({ ...facts, cart: { ...cart, merchantScope: ["shop_2"] } }, checks)).toMatchObject({ code: "MANDATE_OUT_OF_SCOPE", mandate: { id: cart.id } });
    expect(mayAuthorize({ ...facts, merchantId: "shop_2" }, checks)).toMatchObject({ code: "MANDATE_OUT_OF_SCOPE", mandate: { id: intent.id } });
    expect(mayAuthorize({ ...facts, intent: { ...intent, amountLimit: { amount: 500000, currency: "USD" } } }, checks)).toMatchObject({ code: "MANDATE_OUT_OF_SCOPE" });
  });

  it("порядок: по мандату — состояние раньше остатка, INTENT раньше CART (как verify в воротах); пределы — последними", () => {
    const outOfScope = { ...facts, merchantId: "shop_2" };
    expect(mayAuthorize(outOfScope, { intent: ok(), cart: ok(TOTAL.amount - 1) })).toMatchObject({ code: "MANDATE_AMOUNT_LEFT_INSUFFICIENT", mandate: cart });
    expect(mayAuthorize(facts, { intent: ok(TOTAL.amount - 1), cart: { ...ok(), outcome: "STATE_UNKNOWN" } })).toMatchObject({ code: "MANDATE_AMOUNT_LEFT_INSUFFICIENT", mandate: intent });
    expect(mayAuthorize(facts, { intent: { ...ok(), outcome: "STATE_UNKNOWN" }, cart: ok(1) })).toMatchObject({ code: "MANDATE_OUT_OF_SCOPE", mandate: intent });
  });

  it("по одному мандату (mandateRefusal) — только отказ или «дальше», разрешения нет (ревью К2 В3)", () => {
    expect(mandateRefusal(intent, ok(), TOTAL)).toBeNull();
    expect(mandateRefusal(intent, ok(0), TOTAL)).toMatchObject({ allow: false, code: "MANDATE_OUT_OF_SCOPE", mandate: intent });
    expect(mandateRefusal(cart, ok(TOTAL.amount - 1), TOTAL)).toMatchObject({ allow: false, code: "MANDATE_AMOUNT_LEFT_INSUFFICIENT", mandate: cart });
  });
});

describe("порог и валюта (Р39 п. 1.4–1.5, Т7)", () => {
  it("порог — меньшее из рыночного и клиентского; клиентского нет — рыночный (#37 п. 4)", () => {
    expect(confirmThreshold({ marketKop: THRESHOLD })).toBe(THRESHOLD);
    expect(confirmThreshold({ marketKop: THRESHOLD, clientKop: THRESHOLD - 1 })).toBe(THRESHOLD - 1);
    expect(confirmThreshold({ marketKop: THRESHOLD, clientKop: THRESHOLD + 1 })).toBe(THRESHOLD);
  });

  it("стадия 4 — итог строго выше порога", () => {
    expect(needsConfirmation(rub(THRESHOLD), { marketKop: THRESHOLD })).toBe(false);
    expect(needsConfirmation(rub(THRESHOLD + 1), { marketKop: THRESHOLD })).toBe(true);
    expect(needsConfirmation(rub(THRESHOLD), { marketKop: THRESHOLD, clientKop: THRESHOLD - 1 })).toBe(true);
  });

  it("оплата — только в RUB (CURRENCY_NOT_SUPPORTED)", () => {
    expect(currencySupported(rub(1))).toBe(true);
    expect(currencySupported({ amount: 1, currency: "USD" })).toBe(false);
  });
});

describe("окно дробления по корневому INTENT (Р39 п. 4, #37 п. 1)", () => {
  const at = (sec: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, sec));
  const make = () => {
    let now = at(0);
    const w = new SplitWindow({ split_window_sec: WINDOW, split_min_ops: MIN_OPS }, () => now);
    return { w, move: (sec: number) => (now = at(sec)) };
  };
  /** доля целыми копейками: split_min_ops таких — выше порога (параметры — из конфигурации, не литералом) */
  const part = rub(Math.floor(THRESHOLD / MIN_OPS) + 1);
  /** в окне на одну операцию меньше split_min_ops: следующая — доля */
  const fill = (w: SplitWindow, root = "mnd_intent") => Array.from({ length: MIN_OPS - 1 }, () => w.open(root, part));

  it(`пусто — не доля; в окне split_min_ops − 1 операций (${MIN_OPS - 1}), с этой сумма выше порога — доля`, () => {
    // окно из одной операции — не дробление: тесты окна требуют split_min_ops > 1 (ревью К2 П5)
    expect(MIN_OPS).toBeGreaterThan(1);
    const { w } = make();
    expect(w.isShare("mnd_intent", part, THRESHOLD)).toBe(false);
    const slots = fill(w);
    expect(w.isShare("mnd_intent", part, THRESHOLD)).toBe(true);
    // на одну меньше — не доля, если split_min_ops > 1
    if (MIN_OPS > 1) {
      slots[0]!.settle("REFUSED");
      expect(w.isShare("mnd_intent", part, THRESHOLD)).toBe(false);
    }
  });

  it("сумма в окне ровно порог — не доля; итог выше порога — не доля, его ведёт стадия 4", () => {
    const { w } = make();
    const each = Math.floor((THRESHOLD - 100) / Math.max(MIN_OPS - 1, 1));
    for (let i = 0; i < MIN_OPS - 1; i++) w.open("mnd_intent", rub(each));
    expect(w.isShare("mnd_intent", rub(THRESHOLD - each * (MIN_OPS - 1)), THRESHOLD)).toBe(false);
    expect(w.isShare("mnd_intent", rub(THRESHOLD + 1), THRESHOLD)).toBe(false);
  });

  it("другой корень — своё окно", () => {
    const { w } = make();
    fill(w, "mnd_other");
    expect(w.isShare("mnd_intent", part, THRESHOLD)).toBe(false);
  });

  it("исход: отказ не занимает окно; одобрение, «в работе» и неизвестный исход — занимают (fail-closed)", () => {
    for (const [outcome, counts] of [["REFUSED", false], ["APPROVED", true], ["UNKNOWN", true], [null, true]] as const) {
      const { w } = make();
      const slots = fill(w);
      if (outcome !== null) for (const x of slots) x.settle(outcome);
      expect(w.isShare("mnd_intent", part, THRESHOLD)).toBe(counts);
    }
  });

  it("исход устанавливается один раз: поздний REFUSED не освобождает одобренную операцию", () => {
    const { w } = make();
    for (const x of fill(w)) {
      x.settle("APPROVED");
      x.settle("REFUSED");
    }
    expect(w.isShare("mnd_intent", part, THRESHOLD)).toBe(true);
  });

  it(`окно — split_window_sec (${WINDOW} с): на границе ещё в окне, на секунду позже — нет`, () => {
    const { w, move } = make();
    fill(w);
    move(WINDOW);
    expect(w.isShare("mnd_intent", part, THRESHOLD)).toBe(true);
    move(WINDOW + 1);
    expect(w.isShare("mnd_intent", part, THRESHOLD)).toBe(false);
  });
});
