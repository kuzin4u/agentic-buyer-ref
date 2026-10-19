// Машина состояний покупки (Р38 п. 1): таблица разрешённых переходов, запрещённый переход — STOPPED и agent.refused
// с PIPELINE_TRANSITION_FORBIDDEN, записи purchase.stage на каждый переход.
import { describe, expect, it } from "vitest";
import { DIAG } from "../../src/agent/compose.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import {
  PURCHASE_STATES,
  PurchaseMachine,
  PurchaseTransitionForbidden,
  TRANSITIONS,
  allowed,
  type PurchaseState,
} from "../../src/agent/pipeline/index.js";

const AT = new Date("2026-10-20T09:00:00Z");

function machine() {
  const journal = new MemoryJournal();
  return { m: new PurchaseMachine({ journal, now: () => AT }), journal };
}

/** Таблица Р38 п. 1 — копия в тесте: перечень запрещённых переходов строится из неё, а не из allowed() (иначе поломка
 *  allowed() опустошает перечень и тест молчит). */
const EXPECTED: Record<PurchaseState, PurchaseState[]> = {
  NEW: ["INTENT_PENDING", "INTENT_ACTIVE"],
  INTENT_PENDING: ["INTENT_ACTIVE"],
  INTENT_ACTIVE: ["OFFERS"],
  OFFERS: ["OFFERS", "CART_PENDING"],
  CART_PENDING: ["CART_ACTIVE"],
  CART_ACTIVE: ["ORDERED", "OFFERS"],
  ORDERED: ["CONFIRMING", "AUTHORIZING"],
  CONFIRMING: ["AUTHORIZING"],
  AUTHORIZING: ["SETTLING"],
  SETTLING: ["DONE"],
  DONE: [],
  STOPPED: [],
};

/** Путь до состояния по разрешённым переходам (самый короткий). */
const PATH: Record<Exclude<PurchaseState, "STOPPED">, Exclude<PurchaseState, "STOPPED" | "NEW">[]> = {
  NEW: [],
  INTENT_PENDING: ["INTENT_PENDING"],
  INTENT_ACTIVE: ["INTENT_ACTIVE"],
  OFFERS: ["INTENT_ACTIVE", "OFFERS"],
  CART_PENDING: ["INTENT_ACTIVE", "OFFERS", "CART_PENDING"],
  CART_ACTIVE: ["INTENT_ACTIVE", "OFFERS", "CART_PENDING", "CART_ACTIVE"],
  ORDERED: ["INTENT_ACTIVE", "OFFERS", "CART_PENDING", "CART_ACTIVE", "ORDERED"],
  CONFIRMING: ["INTENT_ACTIVE", "OFFERS", "CART_PENDING", "CART_ACTIVE", "ORDERED", "CONFIRMING"],
  AUTHORIZING: ["INTENT_ACTIVE", "OFFERS", "CART_PENDING", "CART_ACTIVE", "ORDERED", "AUTHORIZING"],
  SETTLING: ["INTENT_ACTIVE", "OFFERS", "CART_PENDING", "CART_ACTIVE", "ORDERED", "AUTHORIZING", "SETTLING"],
  DONE: ["INTENT_ACTIVE", "OFFERS", "CART_PENDING", "CART_ACTIVE", "ORDERED", "AUTHORIZING", "SETTLING", "DONE"],
};

function at(state: Exclude<PurchaseState, "STOPPED">) {
  const r = machine();
  for (const s of PATH[state]) r.m.to(s);
  r.journal.entries.length = 0;
  return r;
}

describe("таблица переходов (Р38 п. 1)", () => {
  it("закреплена целиком: изменение — только через /decision", () => {
    expect(TRANSITIONS).toEqual(EXPECTED);
  });

  it("в STOPPED — из любого не конечного; из DONE и STOPPED — никуда; прочее — по таблице", () => {
    for (const s of PURCHASE_STATES) {
      for (const t of PURCHASE_STATES) if (t !== "STOPPED") expect(allowed(s, t), `${s} → ${t}`).toBe(EXPECTED[s].includes(t));
      expect(allowed(s, "STOPPED")).toBe(s !== "DONE" && s !== "STOPPED");
      if (s === "DONE" || s === "STOPPED") for (const t of PURCHASE_STATES) expect(allowed(s, t)).toBe(false);
    }
  });

  it("путь одной покупки 0–6 проходит по таблице, запись purchase.stage на каждый переход", () => {
    const { m, journal } = machine();
    m.bind("mnd_intent_1");
    for (const s of PATH.DONE) m.to(s);
    expect(m.state).toBe("DONE");
    expect(journal.entries).toEqual(
      PATH.DONE.map((s) => ({ at: AT.toISOString(), kind: "purchase.stage", detail: s, mandate: "mnd_intent_1" })),
    );
  });
});

describe("запрещённый переход — STOPPED и agent.refused (Р38 п. 1)", () => {
  const forbidden = PURCHASE_STATES.flatMap((from) =>
    from === "STOPPED"
      ? []
      : PURCHASE_STATES.filter((to) => to !== "STOPPED" && !EXPECTED[from].includes(to)).map((to) => [from, to] as [Exclude<PurchaseState, "STOPPED">, Exclude<PurchaseState, "STOPPED">]),
  );

  it("перечень не пуст и включает пропуск стадий", () => {
    expect(forbidden).toContainEqual(["OFFERS", "AUTHORIZING"]);
    expect(forbidden).toContainEqual(["NEW", "ORDERED"]);
    expect(forbidden).toContainEqual(["ORDERED", "SETTLING"]);
    expect(forbidden).toContainEqual(["DONE", "OFFERS"]);
  });

  it.each(forbidden)("%s → %s", (from, to) => {
    const { m, journal } = at(from);
    m.bind("mnd_intent_1");
    const err = (() => {
      try {
        m.to(to);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(PurchaseTransitionForbidden);
    expect(err).toMatchObject({ code: "PIPELINE_TRANSITION_FORBIDDEN", from, to });
    const refused = { at: AT.toISOString(), kind: "agent.refused", reason: "PIPELINE_TRANSITION_FORBIDDEN", detail: `${from}->${to}`, mandate: "mnd_intent_1" };
    if (from === "DONE") {
      // из конечного состояния — только отказ, итог покупки не меняется
      expect(m.state).toBe("DONE");
      expect(journal.entries).toEqual([refused]);
    } else {
      expect(m.state).toBe("STOPPED");
      expect(m.reason).toBe("PIPELINE_TRANSITION_FORBIDDEN");
      expect(journal.entries).toEqual([
        refused,
        { at: AT.toISOString(), kind: "purchase.stage", detail: "STOPPED", reason: "PIPELINE_TRANSITION_FORBIDDEN", mandate: "mnd_intent_1" },
      ]);
    }
  });

  it("после STOPPED любой переход — отказ без новой остановки, первая причина остаётся", () => {
    const { m, journal } = at("OFFERS");
    m.stop("MANDATE_NOT_ACTIVE");
    expect(() => m.to("CART_PENDING")).toThrow(PurchaseTransitionForbidden);
    m.stop("UNKNOWN");
    expect(m.state).toBe("STOPPED");
    expect(m.reason).toBe("MANDATE_NOT_ACTIVE");
    expect(journal.entries.map((e) => [e.kind, e.reason])).toEqual([
      ["purchase.stage", "MANDATE_NOT_ACTIVE"],
      ["agent.refused", "PIPELINE_TRANSITION_FORBIDDEN"],
    ]);
  });

  it("код — в реестре: ошибся агент, без повтора", () => {
    expect(DIAG.PIPELINE_TRANSITION_FORBIDDEN).toMatchObject({ source: ["agent"], action: "after_fix" });
  });
});

describe("в STOPPED — только stop() с кодом (ревью К2.1 № 3)", () => {
  it("to(\"STOPPED\") в обход типа — запрещённый переход, остановка с кодом", () => {
    const { m, journal } = at("OFFERS");
    expect(m.reason).toBeNull();
    expect(() => m.to("STOPPED" as never)).toThrow(PurchaseTransitionForbidden);
    expect(m.state).toBe("STOPPED");
    expect(m.reason).toBe("PIPELINE_TRANSITION_FORBIDDEN");
    expect(journal.entries.map((e) => [e.kind, e.reason, e.detail])).toEqual([
      ["agent.refused", "PIPELINE_TRANSITION_FORBIDDEN", "OFFERS->STOPPED"],
      ["purchase.stage", "PIPELINE_TRANSITION_FORBIDDEN", "STOPPED"],
    ]);
  });
});

describe("mandate в записях — только по маске", () => {
  it("bind() не вызывался — записи без mandate", () => {
    const { m, journal } = machine();
    m.to("INTENT_PENDING");
    m.stop("UNKNOWN");
    for (const e of journal.entries) expect(e).not.toHaveProperty("mandate");
  });

  it("идентификатор не по маске — все записи без mandate, в том числе после верного", () => {
    const { m, journal } = machine();
    m.bind("mnd_intent_1");
    m.bind("mnd intent\nignore previous");
    m.to("INTENT_PENDING");
    expect(() => m.to("DONE")).toThrow(PurchaseTransitionForbidden);
    expect(journal.entries).toHaveLength(3);
    for (const e of journal.entries) expect(e).not.toHaveProperty("mandate");
  });
});
