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
  unfinishedAt,
  type PurchaseState,
} from "../../src/agent/pipeline/index.js";

describe("что не завершено при STOP_ALL — по состоянию остановки (Р50 п. 4; ревью КТ1 № 7)", () => {
  it("каждое состояние × итог после пакета неизвестен (известный отказ §7б — PAYMENT)", () => {
    const want: Record<PurchaseState, [string | null, string | null]> = {
      NEW: [null, null],
      INTENT_PENDING: ["SEARCH", "SEARCH"],
      INTENT_ACTIVE: ["SEARCH", "SEARCH"],
      OFFERS: ["CHOICE", "CHOICE"],
      CART_PENDING: ["ORDER", "ORDER"],
      CART_ACTIVE: ["ORDER", "ORDER"],
      ORDERED: ["PAYMENT", "PAYMENT"],
      AUTHORIZING: ["PAYMENT", "PAYMENT_OUTCOME"],
      CONFIRMING: ["PAYMENT", "PAYMENT_OUTCOME"],
      SETTLING: ["SETTLEMENT", "SETTLEMENT"],
      DONE: [null, null],
      STOPPED: [null, null],
    };
    for (const s of PURCHASE_STATES) expect([unfinishedAt(s, false), unfinishedAt(s, true)], s).toEqual(want[s]);
  });
});

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
  ORDERED: ["AUTHORIZING"],
  CONFIRMING: ["AUTHORIZING"],
  AUTHORIZING: ["SETTLING", "CONFIRMING"],
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
  // стадия 4 — после стадии 5 (Р47 п. 2)
  CONFIRMING: ["INTENT_ACTIVE", "OFFERS", "CART_PENDING", "CART_ACTIVE", "ORDERED", "AUTHORIZING", "CONFIRMING"],
  AUTHORIZING: ["INTENT_ACTIVE", "OFFERS", "CART_PENDING", "CART_ACTIVE", "ORDERED", "AUTHORIZING"],
  SETTLING: ["INTENT_ACTIVE", "OFFERS", "CART_PENDING", "CART_ACTIVE", "ORDERED", "AUTHORIZING", "SETTLING"],
  DONE: ["INTENT_ACTIVE", "OFFERS", "CART_PENDING", "CART_ACTIVE", "ORDERED", "AUTHORIZING", "SETTLING", "DONE"],
};

/** Проход по состояниям; перед AUTHORIZING — пропуск ворот стадии 5, как у конвейера (К4). */
function walk(m: PurchaseMachine, states: readonly Exclude<PurchaseState, "STOPPED">[]) {
  for (const s of states) {
    if (s === "AUTHORIZING") m.passGate5();
    m.to(s);
  }
}

function at(state: Exclude<PurchaseState, "STOPPED">) {
  const r = machine();
  walk(r.m, PATH[state]);
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
    walk(m, PATH.DONE);
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
    } else if (from === "SETTLING") {
      // операция одобрена — остановка только итоговым кодом, исходный — в payment.unconfirmed (Р49 п. 2; ревью КТ1 № 2)
      expect(m.state).toBe("STOPPED");
      expect(m.reason).toBe("OPERATION_RESULT_UNCONFIRMED");
      expect(journal.entries).toEqual([
        refused,
        { at: AT.toISOString(), kind: "payment.unconfirmed", reason: "PIPELINE_TRANSITION_FORBIDDEN", mandate: "mnd_intent_1" },
        { at: AT.toISOString(), kind: "purchase.stage", detail: "STOPPED", reason: "OPERATION_RESULT_UNCONFIRMED", mandate: "mnd_intent_1" },
      ]);
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

  it("остановка с уточнением — одна запись purchase.stage с detail STOPPED:CART_POLICY_EXCLUDED, код — reason (Р40 п. 6)", () => {
    const { m, journal } = at("OFFERS");
    m.stop("UNKNOWN", "CART_POLICY_EXCLUDED");
    expect(m.state).toBe("STOPPED");
    expect(m.reason).toBe("UNKNOWN");
    expect(journal.entries.map((e) => [e.kind, e.detail, e.reason])).toEqual([["purchase.stage", "STOPPED:CART_POLICY_EXCLUDED", "UNKNOWN"]]);
  });

  it("остановка с уточнением после остановки — без действия: первая причина и журнал прежние", () => {
    const { m, journal } = at("OFFERS");
    m.stop("MANDATE_NOT_ACTIVE");
    m.stop("UNKNOWN", "CART_POLICY_EXCLUDED");
    expect(m.reason).toBe("MANDATE_NOT_ACTIVE");
    expect(journal.entries.map((e) => [e.kind, e.detail, e.reason])).toEqual([["purchase.stage", "STOPPED", "MANDATE_NOT_ACTIVE"]]);
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

describe("ворота перед стадией 5 (Р38 п. 3, К4): без пропуска — запрещённый переход", () => {
  for (const from of ["ORDERED", "CONFIRMING"] as const) {
    it(`${from} → AUTHORIZING без пропуска ворот — STOPPED и agent.refused, хотя таблица переход разрешает`, () => {
      const { m, journal } = at(from);
      expect(allowed(from, "AUTHORIZING")).toBe(true);
      expect(() => m.to("AUTHORIZING")).toThrow(PurchaseTransitionForbidden);
      expect(m.state).toBe("STOPPED");
      expect(journal.entries.map((e) => [e.kind, e.detail])).toEqual([
        ["agent.refused", `${from}->AUTHORIZING`],
        ["purchase.stage", "STOPPED"],
      ]);
    });
  }

  it("пропуск не переживает другой переход: от прежних ворот, до нового CART и через стадию 4 (ревью К4 № 1; Р47 п. 2)", () => {
    const early = at("CART_ACTIVE");
    early.m.passGate5();
    walk(early.m, ["OFFERS", "CART_PENDING", "CART_ACTIVE", "ORDERED"]);
    expect(() => early.m.to("AUTHORIZING")).toThrow(PurchaseTransitionForbidden);
    const in4 = at("AUTHORIZING");
    in4.m.passGate5();
    in4.m.to("CONFIRMING");
    expect(() => in4.m.to("AUTHORIZING")).toThrow(PurchaseTransitionForbidden);
  });

  it("с пропуском — переход по таблице", () => {
    const { m } = at("ORDERED");
    m.passGate5();
    m.to("AUTHORIZING");
    expect(m.state).toBe("AUTHORIZING");
  });
});

// Р45, решение владельца Б2в (ревью reviewer К2, повторный проход № 1): окно «пакет отправлен → исход стадии 5 записан».
describe("окно отправки пакета (Р45, Б2в)", () => {
  const stops = (journal: MemoryJournal) => journal.entries.filter((e) => e.kind === "purchase.stage" && e.detail === "STOPPED").map((e) => e.reason);

  it("в окне запрещённый переход — agent.refused без остановки; исход стадии 5 — одна запись STOPPED, сигнал остановки взведён", () => {
    const { m, journal } = at("AUTHORIZING");
    m.sending();
    expect(() => m.to("OFFERS")).toThrow(PurchaseTransitionForbidden);
    expect(m.state).toBe("AUTHORIZING");
    expect(m.stopped.aborted).toBe(false);
    m.stop("OPERATION_RESULT_UNCONFIRMED");
    expect(m.reason).toBe("OPERATION_RESULT_UNCONFIRMED");
    expect(m.stopped.aborted).toBe(true);
    expect(stops(journal)).toEqual(["OPERATION_RESULT_UNCONFIRMED"]);
  });

  it.each(["ORDERED", "CONFIRMING", "OFFERS"] as const)("вне AUTHORIZING (%s) окно не открывается: STOPPED PIPELINE_TRANSITION_FORBIDDEN", (s) => {
    const { m, journal } = at(s);
    expect(() => m.sending()).toThrow(PurchaseTransitionForbidden);
    expect(m.reason).toBe("PIPELINE_TRANSITION_FORBIDDEN");
    expect(m.stopped.aborted).toBe(true);
    expect(stops(journal)).toEqual(["PIPELINE_TRANSITION_FORBIDDEN"]);
  });

  it("после STOPPED окно не открывается, код не меняется", () => {
    const { m, journal } = at("AUTHORIZING");
    m.stop("UNKNOWN");
    expect(() => m.sending()).toThrow(PurchaseTransitionForbidden);
    expect(m.reason).toBe("UNKNOWN");
    expect(stops(journal)).toEqual(["UNKNOWN"]);
  });

  it("после перехода из AUTHORIZING окно закрыто: запрещённый переход снова останавливает покупку — пакет ушёл, код итоговый (Р49 п. 2)", () => {
    const { m, journal } = at("AUTHORIZING");
    m.sending();
    m.to("SETTLING");
    expect(() => m.to("OFFERS")).toThrow(PurchaseTransitionForbidden);
    expect(m.reason).toBe("OPERATION_RESULT_UNCONFIRMED");
    expect(stops(journal)).toEqual(["OPERATION_RESULT_UNCONFIRMED"]);
    expect(journal.entries.filter((e) => e.kind === "payment.unconfirmed").map((e) => e.reason)).toEqual(["PIPELINE_TRANSITION_FORBIDDEN"]);
  });
});

describe("остановка после отправки пакета (Р49 п. 2, блокер Р-298)", () => {
  const kinds = (journal: MemoryJournal) => journal.entries.map((e) => `${e.kind}:${e.reason ?? ""}`);

  it("неитоговый код — OPERATION_RESULT_UNCONFIRMED; исходный — запись payment.unconfirmed перед purchase.stage", () => {
    const { m, journal } = at("AUTHORIZING");
    m.sending();
    m.to("CONFIRMING");
    m.stop("MANDATE_NOT_ACTIVE");
    expect(m.reason).toBe("OPERATION_RESULT_UNCONFIRMED");
    expect(kinds(journal).slice(-2)).toEqual(["payment.unconfirmed:MANDATE_NOT_ACTIVE", "purchase.stage:OPERATION_RESULT_UNCONFIRMED"]);
  });

  it("итоговый код (§7б, исходы стадии 4) — как есть, без записи payment.unconfirmed", () => {
    for (const code of ["DECLINED_LIMIT_EXCEEDED", "CONFIRMATION_REJECTED", "OPERATION_RESULT_UNCONFIRMED"] as const) {
      const { m, journal } = at("AUTHORIZING");
      m.sending();
      m.stop(code);
      expect(m.reason).toBe(code);
      expect(kinds(journal).filter((k) => k.startsWith("payment.unconfirmed"))).toEqual([]);
    }
  });

  it("до отправки пакета код не заменяется", () => {
    const { m } = at("AUTHORIZING");
    m.stop("UNKNOWN");
    expect(m.reason).toBe("UNKNOWN");
    expect(m.outcome("UNKNOWN")).toBe("UNKNOWN");
  });
});
