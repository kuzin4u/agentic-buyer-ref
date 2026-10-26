// Модуль подтверждений (Р47 п. 3–5, 8; уточнения В1–В3): событие — сигнал, статус — по GET; дубли по event_id;
// привязка — ровно одна ожидающая (4а), невостребованный запрос (В1а), в счёт — только ждущие запрос (В2); истечение —
// GET после expires_at + signature_skew_sec; link и confirmation_ref — нигде.
import { describe, expect, it } from "vitest";
import { Confirmations, type ConfirmationOutcome } from "../../src/agent/confirmations/index.js";
import type { FeedItem } from "../../src/agent/ports/events.js";
import { loadParams } from "../../src/shared/config.js";
import { PlatformFailure, type Confirmation, type PlatformEventType } from "../../src/shared/domain.js";
import { trackedSignal } from "../support/signal.js";

const ID1 = "cnf_11111111-1111-4111-8111-111111111111";
const ID2 = "cnf_22222222-2222-4222-8222-222222222222";
const LINK = "https://upk.stand/c/секретная-страница";
const REF = "cr_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const T0 = Date.parse("2026-10-22T12:00:00.000Z");
const HOLD_MS = 900_000;
const SKEW_SEC = 300;
const WAIT_MS = 30_000;
const SEEN_MAX = loadParams().event_seen_max;

/** Часы и таймеры теста: время двигает только advance; `early` — первый таймер длиннее `early` срабатывает раньше
 *  срока на столько мс (ранний таймер Node, нюанс Р46 К2а). */
function clock(early = 0) {
  let now = T0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    now: () => new Date(now),
    timer: (fn: () => void, ms: number) => {
      const shift = ms > early ? early : 0;
      early -= shift;
      const t = { at: now + ms - shift, fn, live: true };
      timers.push(t);
      return () => void (t.live = false);
    },
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.live = false;
        now = due.at;
        due.fn();
        await settle();
      }
      now = until;
    },
  };
}

const settle = () => new Promise<void>((r) => setImmediate(r));

function confirmation(status: Confirmation["status"], over: Partial<Confirmation> = {}): Confirmation {
  return {
    id: ID1,
    status,
    link: LINK,
    confirmationRef: status === "APPROVED" ? REF : null,
    expiresAt: new Date(T0 + HOLD_MS).toISOString(),
    ...over,
  };
}

function setup(early = 0, seenMax = SEEN_MAX) {
  const c = clock(early);
  const answers = new Map<string, Confirmation | Error>();
  const gets: string[] = [];
  const journal: Record<string, unknown>[] = [];
  const port = {
    getConfirmation: async (id: string) => {
      gets.push(id);
      const a = answers.get(id);
      if (a === undefined) throw new PlatformFailure("REQUEST_INVALID", "after_fix", "REQUEST_INVALID", 400, null);
      if (a instanceof Error) throw a;
      return structuredClone(a);
    },
  };
  const conf = new Confirmations({
    port,
    journal: { record: (e) => void journal.push(e) },
    params: { confirmation_wait_ms: WAIT_MS, signature_skew_sec: SKEW_SEC, event_seen_max: seenMax },
    now: c.now,
    timer: c.timer,
  });
  let seq = 0;
  const event = async (type: PlatformEventType, id: string, eventId = `evt_${++seq}`) => {
    const item: FeedItem = { kind: "event", event: { eventId, type, at: c.now().toISOString(), mandateId: null, opRef: null, confirmationId: id, declineReason: null } };
    await conf.listener(item);
    await settle();
  };
  const waiter = (onPending?: () => void) => {
    const ac = new AbortController();
    const pending: string[] = [];
    let outcome: ConfirmationOutcome | Error | undefined;
    conf
      .wait({ signal: ac.signal, onPending: onPending ?? (() => void pending.push("PENDING")) })
      .then((o) => (outcome = o), (e: Error) => (outcome = e));
    return { ac, pending, outcome: () => outcome };
  };
  return { c, answers, gets, journal, conf, event, waiter };
}

describe("модуль подтверждений: сигнал → GET → статус (Р47 п. 3)", () => {
  it("required → PENDING и одно уведомление; approved → GET → APPROVED; link и confirmation_ref нигде", async () => {
    const s = setup();
    const w = s.waiter();
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1);
    expect(w.pending).toEqual(["PENDING"]);
    expect(w.outcome()).toBeUndefined();
    s.answers.set(ID1, confirmation("APPROVED"));
    await s.event("confirmation.approved", ID1);
    expect(w.outcome()).toBe("APPROVED");
    expect(s.gets).toEqual([ID1, ID1]);
    expect(s.journal.filter((e) => e.kind === "confirmation.status").map((e) => [e.ref, e.detail])).toEqual([
      [ID1, "PENDING"],
      [ID1, "APPROVED"],
    ]);
    const text = JSON.stringify(s.journal);
    expect(text).not.toContain(LINK);
    expect(text).not.toContain(REF);
    expect(text).not.toContain("upk.stand");
  });

  it("дубль события по event_id — ни второго GET, ни второго уведомления", async () => {
    const s = setup();
    const w = s.waiter();
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1, "evt_dup");
    await s.event("confirmation.required", ID1, "evt_dup");
    expect(s.gets).toEqual([ID1]);
    expect(w.pending).toEqual(["PENDING"]);
  });

  it("Р50 п. 1: окно event_seen_max — дубль в окне без GET; вытесненное событие — второй GET, но не второе уведомление", async () => {
    const s = setup(0, 2);
    const w = s.waiter();
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1, "evt_a");
    await s.event("confirmation.required", ID1, "evt_b");
    await s.event("confirmation.required", ID1, "evt_c");
    expect(s.gets).toHaveLength(3);
    await s.event("confirmation.required", ID1, "evt_c");
    await s.event("confirmation.required", ID1, "evt_b");
    expect(s.gets).toHaveLength(3);
    // evt_a вытеснено: читается снова (Р34 п. 3), уведомление по запросу уже было
    await s.event("confirmation.required", ID1, "evt_a");
    expect(s.gets).toHaveLength(4);
    expect(w.pending).toEqual(["PENDING"]);
  });

  it("событие без GET ничего не меняет: approved, а GET — PENDING — ждём дальше", async () => {
    const s = setup();
    const w = s.waiter();
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1);
    await s.event("confirmation.approved", ID1);
    expect(w.outcome()).toBeUndefined();
    expect(w.pending).toEqual(["PENDING"]);
  });

  it("rejected → REJECTED; expired → EXPIRED", async () => {
    for (const [type, status] of [
      ["confirmation.rejected", "REJECTED"],
      ["confirmation.expired", "EXPIRED"],
    ] as const) {
      const s = setup();
      const w = s.waiter();
      s.answers.set(ID1, confirmation("PENDING"));
      await s.event("confirmation.required", ID1);
      s.answers.set(ID1, confirmation(status));
      await s.event(type, ID1);
      expect(w.outcome()).toBe(status);
    }
  });

  it("решение уже есть к первому GET — исход сразу, без уведомления", async () => {
    const s = setup();
    const w = s.waiter();
    s.answers.set(ID1, confirmation("REJECTED"));
    await s.event("confirmation.required", ID1);
    expect(w.outcome()).toBe("REJECTED");
    expect(w.pending).toEqual([]);
  });

  it("истечение — GET после expires_at + signature_skew_sec: EXPIRED; до срока GET нет", async () => {
    const s = setup();
    const w = s.waiter();
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1);
    await s.c.advance(HOLD_MS + SKEW_SEC * 1000 - 1);
    expect(s.gets).toEqual([ID1]);
    s.answers.set(ID1, confirmation("EXPIRED"));
    await s.c.advance(1);
    expect(s.gets).toEqual([ID1, ID1]);
    expect(w.outcome()).toBe("EXPIRED");
  });

  it("после срока GET всё ещё PENDING — UNKNOWN (fail-closed)", async () => {
    const s = setup();
    const w = s.waiter();
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1);
    await s.c.advance(HOLD_MS + SKEW_SEC * 1000);
    expect(w.outcome()).toBe("UNKNOWN");
  });

  it("нет expires_at или он не RFC 3339 — UNKNOWN", async () => {
    for (const expiresAt of [null, "2026", "22.10.2026 12:15"]) {
      const s = setup();
      const w = s.waiter();
      s.answers.set(ID1, confirmation("PENDING", { expiresAt }));
      await s.event("confirmation.required", ID1);
      expect(w.outcome(), String(expiresAt)).toBe("UNKNOWN");
    }
  });

  it("ранний таймер: GET до срока дал PENDING — ожидание продлевается, по сроку — повторный GET", async () => {
    const s = setup(60_000);
    const w = s.waiter();
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1);
    // таймер сработал за минуту до срока: GET — PENDING, исхода нет
    await s.c.advance(HOLD_MS + SKEW_SEC * 1000 - 60_000);
    expect(s.gets).toEqual([ID1, ID1]);
    expect(w.outcome()).toBeUndefined();
    s.answers.set(ID1, confirmation("EXPIRED"));
    await s.c.advance(60_000);
    expect(s.gets.length).toBeGreaterThan(2);
    expect(w.outcome()).toBe("EXPIRED");
  });

  it("400 на GET — запрос не этого агента: запись, покупка ждёт дальше и без запроса — NONE", async () => {
    const s = setup();
    const w = s.waiter();
    await s.event("confirmation.required", ID1);
    expect(s.journal.filter((e) => e.kind === "confirmation.foreign").map((e) => e.ref)).toEqual([ID1]);
    expect(w.outcome()).toBeUndefined();
    await s.c.advance(WAIT_MS);
    expect(w.outcome()).toBe("NONE");
  });

  it("сбой GET (503 после повторов адаптера) у единственной ожидающей — UNKNOWN", async () => {
    const s = setup();
    const w = s.waiter();
    s.answers.set(ID1, new PlatformFailure("STATE_UNAVAILABLE", "same_key", "STATE_UNAVAILABLE", 503, null));
    await s.event("confirmation.required", ID1);
    expect(w.outcome()).toBe("UNKNOWN");
  });

  it("Р58 п. 1: REQUEST_INVALID ответа транспорта (404) — не «чужой запрос», а сбой GET: UNKNOWN, без confirmation.foreign", async () => {
    const s = setup();
    const w = s.waiter();
    s.answers.set(ID1, new PlatformFailure("REQUEST_INVALID", "after_fix", "REQUEST_INVALID", 404, null));
    await s.event("confirmation.required", ID1);
    expect(w.outcome()).toBe("UNKNOWN");
    expect(s.journal.filter((e) => e.kind === "confirmation.foreign")).toEqual([]);
  });

  it("ответ не по схеме — UNKNOWN: APPROVED без ссылки, PENDING со ссылкой, чужой id", async () => {
    for (const bad of [
      confirmation("APPROVED", { confirmationRef: null }),
      confirmation("PENDING", { confirmationRef: REF }),
      confirmation("PENDING", { id: ID2 }),
      confirmation("PENDING", { status: "USED" as Confirmation["status"] }),
    ]) {
      const s = setup();
      const w = s.waiter();
      s.answers.set(ID1, bad);
      await s.event("confirmation.required", ID1);
      expect(w.outcome()).toBe("UNKNOWN");
      expect(w.pending).toEqual([]);
    }
  });

  it("PENDING без onPending — ожидание идёт, исход по решению", async () => {
    const s = setup();
    const ac = new AbortController();
    const done = s.conf.wait({ signal: ac.signal });
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1);
    s.answers.set(ID1, confirmation("REJECTED"));
    await s.event("confirmation.rejected", ID1);
    await expect(done).resolves.toBe("REJECTED");
  });

  it("сбой журнала в слушателе — событие не отмечено обработанным и при повторе обрабатывается", async () => {
    const c = clock();
    let fail = true;
    const gets: string[] = [];
    const conf = new Confirmations({
      port: { getConfirmation: async (id) => (gets.push(id), confirmation("PENDING")) },
      journal: {
        record: () => {
          if (fail) throw new Error("журнал недоступен");
        },
      },
      params: { confirmation_wait_ms: WAIT_MS, signature_skew_sec: SKEW_SEC, event_seen_max: SEEN_MAX },
      now: c.now,
      timer: c.timer,
    });
    const item: FeedItem = { kind: "event", event: { eventId: "evt_x", type: "confirmation.required", at: c.now().toISOString(), mandateId: null, opRef: null, confirmationId: ID1, declineReason: null } };
    await expect(conf.listener(item)).rejects.toThrow("журнал недоступен");
    fail = false;
    await conf.listener(item);
    expect(gets).toEqual([ID1, ID1]);
  });

  it("КТ1 сессии 39 № 8: сбой журнала в таймере — истечение даёт UNKNOWN без необработанного отказа; discarded не роняет таймер", async () => {
    const c = clock();
    let failOn: string | null = null;
    let answer = confirmation("PENDING");
    const kinds: string[] = [];
    const conf = new Confirmations({
      port: { getConfirmation: async () => structuredClone(answer) },
      journal: {
        record: (e) => {
          kinds.push(e.kind);
          if (e.kind === failOn) throw new Error("журнал недоступен");
        },
      },
      params: { confirmation_wait_ms: WAIT_MS, signature_skew_sec: SKEW_SEC, event_seen_max: SEEN_MAX },
      now: c.now,
      timer: c.timer,
    });
    const item = (id: string, eventId: string): FeedItem => ({ kind: "event", event: { eventId, type: "confirmation.required", at: c.now().toISOString(), mandateId: null, opRef: null, confirmationId: id, declineReason: null } });
    let outcome: ConfirmationOutcome | undefined;
    void conf.wait({ signal: new AbortController().signal }).then((o) => (outcome = o));
    await conf.listener(item(ID1, "evt_1"));
    // срок: GET по таймеру даёт EXPIRED, но журнал не принимает confirmation.status — исход UNKNOWN, а не зависание
    answer = confirmation("EXPIRED");
    failOn = "confirmation.status";
    await c.advance(HOLD_MS + SKEW_SEC * 1000);
    expect(outcome).toBe("UNKNOWN");
    // невостребованный запрос: таймер выброса не бросает при сбое записи confirmation.discarded
    failOn = null;
    answer = confirmation("PENDING", { id: ID2, expiresAt: new Date(c.now().getTime() + HOLD_MS).toISOString() });
    await conf.listener(item(ID2, "evt_2"));
    failOn = "confirmation.discarded";
    await expect(c.advance(WAIT_MS)).resolves.toBeUndefined();
    expect(kinds).toContain("confirmation.discarded"); // таймер выброса действительно сработал
  });

  it("запроса нет за confirmation_wait_ms — NONE", async () => {
    const s = setup();
    const w = s.waiter();
    await s.c.advance(WAIT_MS - 1);
    expect(w.outcome()).toBeUndefined();
    await s.c.advance(1);
    expect(w.outcome()).toBe("NONE");
  });
});

describe("привязка запроса к покупке (Р47 п. 4, В1–В2)", () => {
  it("две ожидающие — ни одна не берёт запрос: обе UNBOUND, запись", async () => {
    const s = setup();
    const a = s.waiter();
    const b = s.waiter();
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1);
    expect([a.outcome(), b.outcome()]).toEqual(["UNBOUND", "UNBOUND"]);
    expect(a.pending).toEqual([]);
    expect(s.journal.filter((e) => e.kind === "confirmation.unbound").map((e) => e.ref)).toEqual([ID1]);
    // решение по нему потом — без действий
    s.answers.set(ID1, confirmation("APPROVED"));
    await s.event("confirmation.approved", ID1);
    expect(s.gets).toEqual([ID1]);
  });

  it("гонка (В1а): событие раньше ожидания — невостребованный, затем покупка его берёт", async () => {
    const s = setup();
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1);
    expect(s.journal.filter((e) => e.kind === "confirmation.unclaimed").map((e) => e.ref)).toEqual([ID1]);
    const w = s.waiter();
    await settle();
    expect(w.pending).toEqual(["PENDING"]);
    s.answers.set(ID1, confirmation("APPROVED"));
    await s.event("confirmation.approved", ID1);
    expect(w.outcome()).toBe("APPROVED");
    // невостребованный взят — выбрасывать нечего
    await s.c.advance(WAIT_MS);
    expect(s.journal.some((e) => e.kind === "confirmation.discarded")).toBe(false);
  });

  it("решение пришло, пока запрос невостребованный, — покупка берёт его с решением", async () => {
    const s = setup();
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1);
    s.answers.set(ID1, confirmation("REJECTED"));
    await s.event("confirmation.rejected", ID1);
    const w = s.waiter();
    await settle();
    expect(w.outcome()).toBe("REJECTED");
  });

  it("невостребованный дольше confirmation_wait_ms — выброшен с записью; позднее ожидание его не берёт", async () => {
    const s = setup();
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1);
    await s.c.advance(WAIT_MS);
    expect(s.journal.filter((e) => e.kind === "confirmation.discarded").map((e) => e.ref)).toEqual([ID1]);
    const w = s.waiter();
    await s.c.advance(WAIT_MS);
    expect(w.outcome()).toBe("NONE");
    expect(w.pending).toEqual([]);
  });

  it("сбой GET без ожидающих — запрос не хранится; покупка, начавшая ждать, — NONE", async () => {
    const s = setup();
    s.answers.set(ID1, new PlatformFailure("STATE_UNAVAILABLE", "same_key", "STATE_UNAVAILABLE", 503, null));
    await s.event("confirmation.required", ID1);
    expect(s.journal.some((e) => e.kind === "confirmation.unclaimed")).toBe(false);
    const w = s.waiter();
    await s.c.advance(WAIT_MS);
    expect(w.outcome()).toBe("NONE");
  });

  it("невостребованный: событие по нему — 400 (чужой) или сбой GET — запрос выброшен; покупка — NONE", async () => {
    for (const later of [undefined, new PlatformFailure("STATE_UNAVAILABLE", "same_key", "STATE_UNAVAILABLE", 503, null)]) {
      const s = setup();
      s.answers.set(ID1, confirmation("PENDING"));
      await s.event("confirmation.required", ID1);
      if (later === undefined) s.answers.delete(ID1);
      else s.answers.set(ID1, later);
      await s.event("confirmation.approved", ID1);
      expect(s.journal.filter((e) => e.kind === "confirmation.foreign").length).toBe(later === undefined ? 1 : 0);
      const w = s.waiter();
      await s.c.advance(WAIT_MS);
      expect(w.outcome()).toBe("NONE");
    }
  });

  it("гонка (ревью К2 № 1): покупка взяла невостребованный, пока шёл GET по его решению, — решение ей сразу", async () => {
    const s = setup();
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1);
    s.answers.set(ID1, confirmation("APPROVED"));
    const item: FeedItem = { kind: "event", event: { eventId: "evt_race", type: "confirmation.approved", at: s.c.now().toISOString(), mandateId: null, opRef: null, confirmationId: ID1, declineReason: null } };
    const handled = s.conf.listener(item); // GET начат
    const w = s.waiter(); // покупка берёт запрос, пока GET идёт
    await handled;
    await settle();
    expect(w.outcome()).toBe("APPROVED");
  });

  it("невостребованных два — покупка UNBOUND", async () => {
    const s = setup();
    s.answers.set(ID1, confirmation("PENDING"));
    s.answers.set(ID2, confirmation("PENDING", { id: ID2 }));
    await s.event("confirmation.required", ID1);
    await s.event("confirmation.required", ID2);
    const w = s.waiter();
    await settle();
    expect(w.outcome()).toBe("UNBOUND");
    expect(w.pending).toEqual([]);
  });

  it("В2: покупка с привязанным запросом в счёт не входит — второй запрос берёт вторая покупка", async () => {
    const s = setup();
    const a = s.waiter();
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1);
    const b = s.waiter();
    s.answers.set(ID2, confirmation("PENDING", { id: ID2 }));
    await s.event("confirmation.required", ID2);
    expect([a.pending, b.pending]).toEqual([["PENDING"], ["PENDING"]]);
    s.answers.set(ID2, confirmation("REJECTED", { id: ID2 }));
    await s.event("confirmation.rejected", ID2);
    s.answers.set(ID1, confirmation("APPROVED"));
    await s.event("confirmation.approved", ID1);
    expect([a.outcome(), b.outcome()]).toEqual(["APPROVED", "REJECTED"]);
  });

  it("решение по запросу, чей required не застал ожидающих позже срока, — без действий", async () => {
    const s = setup();
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1);
    await s.c.advance(WAIT_MS);
    s.answers.set(ID1, confirmation("APPROVED"));
    await s.event("confirmation.approved", ID1);
    expect(s.gets).toEqual([ID1]);
  });
});

describe("вход вызывающего и прерывание (Р47 п. 8, В3)", () => {
  it("снимок входа до первого await (Р-205): замена onPending после вызова не действует", async () => {
    const s = setup();
    const calls: string[] = [];
    const opts = { signal: new AbortController().signal, onPending: () => void calls.push("first") };
    void s.conf.wait(opts);
    opts.onPending = () => void calls.push("second");
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1);
    expect(calls).toEqual(["first"]);
  });

  it("сбой уведомления — запись notify.failed, исход не меняется: исключение и отказ обещания", async () => {
    for (const onPending of [
      () => {
        throw new Error("оболочка упала");
      },
      () => Promise.reject(new Error("оболочка отказала")),
    ]) {
      const s = setup();
      const w = s.waiter(onPending);
      s.answers.set(ID1, confirmation("PENDING"));
      await s.event("confirmation.required", ID1);
      expect(s.journal.filter((e) => e.kind === "notify.failed").map((e) => e.reason)).toEqual(["CONFIRMATION_PENDING"]);
      s.answers.set(ID1, confirmation("APPROVED"));
      await s.event("confirmation.approved", ID1);
      expect(w.outcome()).toBe("APPROVED");
    }
  });

  it("уведомление не ждётся: висящее обещание оболочки исход не задерживает", async () => {
    const s = setup();
    const w = s.waiter(() => new Promise<void>(() => undefined));
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1);
    s.answers.set(ID1, confirmation("REJECTED"));
    await s.event("confirmation.rejected", ID1);
    expect(w.outcome()).toBe("REJECTED");
  });

  it("снимок signal (Р-205): замена signal во входе после вызова не действует, прерывание исходного — действует", async () => {
    const s = setup();
    const first = new AbortController();
    const opts = { signal: first.signal };
    const done = s.conf.wait(opts);
    opts.signal = new AbortController().signal;
    first.abort(new Error("исходный"));
    await expect(done).rejects.toThrow("исходный");
  });

  it("прерванная привязанная покупка: события по её запросу — без GET и действий", async () => {
    const s = setup();
    const w = s.waiter();
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1);
    w.ac.abort(new Error("стоп"));
    await settle();
    s.answers.set(ID1, confirmation("APPROVED"));
    await s.event("confirmation.approved", ID1);
    expect(s.gets).toEqual([ID1]);
  });

  it("прерывание — отказ с причиной; прерванная покупка больше не ожидающая", async () => {
    const s = setup();
    const w = s.waiter();
    const reason = new Error("покупка остановлена");
    w.ac.abort(reason);
    await settle();
    expect(w.outcome()).toBe(reason);
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1);
    expect(s.journal.filter((e) => e.kind === "confirmation.unclaimed").map((e) => e.ref)).toEqual([ID1]);
  });

  it("уже прерванный сигнал — отказ без регистрации", async () => {
    const s = setup();
    const ac = new AbortController();
    ac.abort(new Error("стоп"));
    await expect(s.conf.wait({ signal: ac.signal })).rejects.toThrow("стоп");
  });

  it("ожидание будит ленту, пока не решится", async () => {
    const c = clock();
    let wakes = 0;
    const conf = new Confirmations({
      port: { getConfirmation: async () => confirmation("PENDING") },
      journal: { record: () => undefined },
      params: { confirmation_wait_ms: WAIT_MS, signature_skew_sec: SKEW_SEC, event_seen_max: SEEN_MAX },
      now: c.now,
      timer: c.timer,
      wake: async () => {
        wakes++;
        await settle();
      },
    });
    const done = conf.wait({ signal: new AbortController().signal });
    await settle();
    await settle();
    expect(wakes).toBeGreaterThan(0);
    await c.advance(WAIT_MS);
    await expect(done).resolves.toBe("NONE");
    const after = wakes;
    for (let i = 0; i < 5; i++) await settle();
    expect(wakes).toBeLessThanOrEqual(after + 1);
  });

  it("лента без своей паузы (wake сразу возвращает) — таймер исхода срабатывает, процессор не занят", async () => {
    let wakes = 0;
    const conf = new Confirmations({
      port: { getConfirmation: async () => confirmation("PENDING") },
      journal: { record: () => undefined },
      params: { confirmation_wait_ms: 20, signature_skew_sec: SKEW_SEC, event_seen_max: SEEN_MAX },
      wake: async () => void wakes++,
    });
    await expect(conf.wait({ signal: new AbortController().signal })).resolves.toBe("NONE");
    expect(wakes).toBeGreaterThan(0);
  });

  it("отказ ленты прекращает опрос; исход — по таймеру", async () => {
    const c = clock();
    let wakes = 0;
    const conf = new Confirmations({
      port: { getConfirmation: async () => confirmation("PENDING") },
      journal: { record: () => undefined },
      params: { confirmation_wait_ms: WAIT_MS, signature_skew_sec: SKEW_SEC, event_seen_max: SEEN_MAX },
      now: c.now,
      timer: c.timer,
      wake: async () => {
        wakes++;
        throw new Error("лента остановлена");
      },
    });
    const done = conf.wait({ signal: new AbortController().signal });
    for (let i = 0; i < 5; i++) await settle();
    expect(wakes).toBe(1);
    await c.advance(WAIT_MS);
    await expect(done).resolves.toBe("NONE");
  });
});

describe("появление запроса для гонки стадии 5 (Р49 п. 5; ревью КТ1 AG-11 ч. 2 № 5)", () => {
  it("в счёт — только запрос, невостребованный после отметки; прежний чужой запрос гонку не решает; прерывание — отказ", async () => {
    const s = setup();
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1);
    // запрос лежит до отправки пакета этой покупки — отметка его не считает
    const mark = s.conf.mark();
    const ac = new AbortController();
    let arrived = false;
    const waiting = s.conf.arrival(ac.signal, mark).then(() => (arrived = true));
    await settle();
    expect(arrived).toBe(false);
    s.answers.set(ID2, confirmation("PENDING", { id: ID2 }));
    await s.event("confirmation.required", ID2);
    await waiting;
    expect(arrived).toBe(true);
    // уже пришедший после отметки — сразу; прерывание до появления — отказ с причиной
    await expect(s.conf.arrival(new AbortController().signal, mark)).resolves.toBeUndefined();
    const stop = new AbortController();
    const later = s.conf.arrival(stop.signal, s.conf.mark());
    stop.abort(new Error("стоп"));
    await expect(later).rejects.toThrow("стоп");
  });

  it("AG-12 ч. 3б (ревью КТ1 Р49 № 14 (в)): появление решено — запросом или прерыванием — слушателя abort на сигнале не остаётся", async () => {
    const s = setup();
    const t = trackedSignal();
    const waiting = s.conf.arrival(t.signal, s.conf.mark());
    expect(t.live()).toBe(1);
    s.answers.set(ID1, confirmation("PENDING"));
    await s.event("confirmation.required", ID1);
    await waiting;
    expect(t.live()).toBe(0);
    // проигравшая сторона гонки: снята прерыванием сигнала гонки
    const u = trackedSignal();
    const lost = s.conf.arrival(u.signal, s.conf.mark()).catch(() => "ABORTED");
    expect(u.live()).toBe(1);
    u.ac.abort(new Error("гонка стадии 5 решена"));
    expect(await lost).toBe("ABORTED");
    expect(u.live()).toBe(0);
  });
});
