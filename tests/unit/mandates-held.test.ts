// Держимые мандаты (Р37 п. 4, Р34 ответ (б)): ACTIVE по GET держится; событие о держимом мандате — GET этого мандата
// (и его держимых CART), пропуск INVALID_DATA мандатного типа — GET всех держимых; не ACTIVE — выход и запись; сбой
// GET — наружу. Событие во время GET перед удержанием — перечитать (ревью К2.3 № 1).
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryJournal } from "../../src/agent/journal/index.js";
import type { FeedItem } from "../../src/agent/ports/events.js";
import { loadParams } from "../../src/shared/config.js";
import type { MandateDraft } from "../../src/shared/domain.js";
import { Consents, INTENT, RUB, event, feed } from "../support/consents.js";
import { coreOn } from "../support/core.js";
import { expectJournalClean } from "../support/journal.js";
import { AGENT, PaoStand, type StandOptions } from "../support/pao-stand.js";

let stand: PaoStand | undefined;
let check: (() => void) | undefined;
afterEach(async () => {
  // в каждом тесте: ответы заглушки по схеме, журнал — коды реестра, без значений обращений
  check?.();
  check = undefined;
  await stand?.close();
  stand = undefined;
});

const GET = "GET /pao/v1/mandates/{id}";
const invalid = (type: "mandate.revoked" | "mandate.signed"): FeedItem => ({ kind: "ignored", eventId: "ev_bad", detail: "INVALID_DATA", type });
const on = (type: Parameters<typeof event>[0], id: string): FeedItem => ({ kind: "event", event: event(type, id) });

/** Агент с двумя держимыми мандатами (подписаны человеком, ACTIVE по GET). */
async function setup(handlers: (c: Consents) => StandOptions["handlers"] = () => ({})) {
  const consents: Consents = new Consents(() => s.clock);
  const s: PaoStand = (stand = new PaoStand({ handlers: { ...consents.handlers(), ...handlers(consents) }, configuration: { versions: ["1.4.0"] } }));
  const { core, journal } = await coreOn(s);
  await core.start();
  const hold = async (key: string) => {
    const m = await core.mandates.request({ ...INTENT, subject: key }, { idempotencyKey: key });
    return core.mandates.awaitSigned(m, feed(consents.sign(m.id)));
  };
  const a = await hold("idem_held_a");
  const b = await hold("idem_held_b");
  const gets = () => s.stub.calls.filter((c) => c.op === GET).length;
  const kinds = (j: MemoryJournal, kind: string) => j.entries.filter((e) => e.kind === kind);
  check = () => {
    expect(s.stub.violations).toEqual([]);
    expectJournalClean(journal.entries, AGENT, s.stub.calls);
  };
  return { core, journal, consents, stand: s, a, b, gets, kinds };
}

describe("держимые мандаты (Р37 п. 4)", () => {
  it("ACTIVE по GET после подписи — держится; ожидающий подписи — нет", async () => {
    const { core, a, b } = await setup();
    expect(core.mandates.held().map((m) => m.id)).toEqual([a.id, b.id]);
    const pending = await core.mandates.request({ ...INTENT, subject: "ждёт" }, { idempotencyKey: "idem_held_p" });
    expect(pending.status).toBe("PENDING_SIGNATURE");
    expect(core.mandates.held().map((m) => m.id)).not.toContain(pending.id);
  });

  it("mandate.revoked держимого — GET только его; REVOKED — выход и mandate.revoked (Т15); повтор события — без GET и записи", async () => {
    const { core, journal, consents, stand: s, a, b, kinds } = await setup();
    const before = s.stub.calls.length;
    consents.mandates.get(a.id)!.status = "REVOKED";
    await core.mandates.refreshHeld(on("mandate.revoked", a.id));
    expect(s.stub.calls.slice(before).map((c) => [c.op, c.status])).toEqual([[GET, 200]]);
    expect(core.mandates.held().map((m) => m.id)).toEqual([b.id]);
    expect(kinds(journal, "mandate.revoked")).toEqual([{ at: s.clock.toISOString(), agent: AGENT, kind: "mandate.revoked", mandate: a.id }]);
    // снятый мандат: повтор события — ни обращения, ни записи (ревью К2.3 № 11 (а))
    await core.mandates.refreshHeld(on("mandate.revoked", a.id));
    expect(s.stub.calls).toHaveLength(before + 1);
    expect(kinds(journal, "mandate.revoked")).toHaveLength(1);
  });

  it("пропуск INVALID_DATA мандатного типа — GET всех держимых; EXHAUSTED — mandate.status_changed со статусом", async () => {
    const { core, journal, consents, stand: s, a, b, kinds } = await setup();
    const before = s.stub.calls.length;
    consents.mandates.get(b.id)!.status = "EXHAUSTED";
    await core.mandates.refreshHeld(invalid("mandate.revoked"));
    expect(s.stub.calls.slice(before).map((c) => c.op)).toEqual([GET, GET]);
    expect(core.mandates.held().map((m) => m.id)).toEqual([a.id]);
    expect(kinds(journal, "mandate.status_changed").map((e) => [e.mandate, e.detail])).toEqual([[b.id, "EXHAUSTED"]]);
  });

  it("событие о чужом мандате, mandate.signed не удержанного, событие не о мандате, неизвестный тип — без обращений", async () => {
    const { core, stand: s } = await setup();
    const before = s.stub.calls.length;
    await core.mandates.refreshHeld(on("mandate.revoked", "m_other"));
    await core.mandates.refreshHeld(on("mandate.signed", "m_other"));
    await core.mandates.refreshHeld({ kind: "event", event: { ...event("mandate.signed", "m_other"), type: "agent.suspended", mandateId: null } });
    await core.mandates.refreshHeld({ kind: "ignored", eventId: "ev_u", detail: "UNKNOWN_TYPE" });
    await core.mandates.refreshHeld({ kind: "ignored", eventId: "ev_o", detail: "INVALID_DATA", type: "operation.declined" });
    expect(s.stub.calls).toHaveLength(before);
    expect(core.mandates.held()).toHaveLength(2);
  });

  it("отзыв INTENT — перечитывается и его держимый CART (РП35, ревью К2.3 № 5)", async () => {
    const { core, journal, consents, stand: s, a, kinds } = await setup();
    const draft: MandateDraft = {
      ...INTENT,
      kind: "CART",
      parentId: a.id,
      cart: { merchantId: "shop_1", lines: [{ sku: "sku_1", qty: 2, price: RUB(1000) }], total: RUB(2000) },
    };
    const c = await core.mandates.request(draft, { idempotencyKey: "idem_held_c" }, a);
    await core.mandates.awaitSigned(c, feed(consents.sign(c.id)));
    consents.mandates.get(a.id)!.status = "REVOKED";
    consents.mandates.get(c.id)!.status = "REVOKED";
    const before = s.stub.calls.length;
    await core.mandates.refreshHeld(on("mandate.revoked", a.id));
    expect(s.stub.calls.slice(before).map((x) => x.op)).toEqual([GET, GET]);
    expect(kinds(journal, "mandate.revoked").map((e) => e.mandate)).toEqual([a.id, c.id]);
  });

  it("GET «мандата нет» (404 MANDATE_NOT_FOUND) — выход и mandate.status_changed с кодом (нюанс Р37, вопрос владельцу)", async () => {
    const { core, journal, stand: s, a, kinds } = await setup();
    s.stub.fail(GET, { code: "MANDATE_NOT_FOUND" });
    await core.mandates.refreshHeld(on("mandate.revoked", a.id));
    expect(core.mandates.held().map((m) => m.id)).not.toContain(a.id);
    expect(kinds(journal, "mandate.status_changed").map((e) => [e.mandate, e.reason])).toEqual([[a.id, "MANDATE_NOT_FOUND"]]);
  });

  it("ACTIVE с другими пределами или порядком отзыва — выход и agent.refused MANDATE_REPLY_MISMATCH", async () => {
    const { core, journal, consents, a, b, kinds } = await setup();
    consents.mandates.get(a.id)!.amount_limit += 1;
    consents.mandates.get(b.id)!.revocation_order = "bank:pr_1:revocation:v2";
    await core.mandates.refreshHeld(invalid("mandate.signed"));
    expect(core.mandates.held()).toEqual([]);
    expect(kinds(journal, "agent.refused").map((e) => [e.mandate, e.reason])).toEqual([
      [a.id, "MANDATE_REPLY_MISMATCH"],
      [b.id, "MANDATE_REPLY_MISMATCH"],
    ]);
  });

  it("GET вернул мандат без порядка отзыва — выход: mandate.revocation_order_missing и agent.refused", async () => {
    const { core, journal, consents, a, kinds } = await setup();
    delete consents.mandates.get(a.id)!.revocation_order;
    await core.mandates.refreshHeld(on("mandate.revoked", a.id));
    expect(core.mandates.held().map((m) => m.id)).not.toContain(a.id);
    expect(kinds(journal, "mandate.revocation_order_missing")).toHaveLength(1);
    expect(kinds(journal, "agent.refused").map((e) => [e.mandate, e.reason])).toEqual([[a.id, "MANDATE_REVOCATION_ORDER_MISSING"]]);
  });

  it("сбой GET (503 сверх попыток) — наружу, мандат держится", async () => {
    const { core, stand: s, a } = await setup();
    s.stub.fail(GET, { code: "STATE_UNAVAILABLE" }, loadParams().pao_max_attempts);
    await expect(core.mandates.refreshHeld(on("mandate.revoked", a.id))).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    expect(core.mandates.held()).toHaveLength(2);
  });

  it("INVALID_DATA при частичном сбое: первый снят, на втором 503 — наружу; повтор того же события — без второй записи", async () => {
    let failId: string | null = null;
    const { core, journal, consents, a, b, kinds } = await setup((c) => ({
      [GET]: (req) => (req.path.id === failId ? { error: { code: "STATE_UNAVAILABLE" } } : c.handlers()![GET]!(req)),
    }));
    consents.mandates.get(a.id)!.status = "REVOKED";
    failId = b.id;
    await expect(core.mandates.refreshHeld(invalid("mandate.revoked"))).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    expect(core.mandates.held().map((m) => m.id)).toEqual([b.id]);
    failId = null;
    await core.mandates.refreshHeld(invalid("mandate.revoked"));
    expect(kinds(journal, "mandate.revoked").map((e) => e.mandate)).toEqual([a.id]);
    expect(core.mandates.held().map((m) => m.id)).toEqual([b.id]);
  });
});

describe("событие во время GET перед удержанием (ревью К2.3 № 1)", () => {
  it("mandate.revoked пришёл, пока GET после mandate.signed в пути, — перечитать: REVOKED, не держится", async () => {
    let core: Awaited<ReturnType<typeof coreOn>>["core"] | undefined;
    let race: string | null = null;
    const consents: Consents = new Consents(() => s.clock);
    const base = consents.handlers()!;
    const s: PaoStand = (stand = new PaoStand({
      configuration: { versions: ["1.4.0"] },
      handlers: {
        ...base,
        // первый GET после подписи: ответ — ещё ACTIVE, а событие отзыва уже прочитано лентой
        [GET]: (req) => {
          const r = base[GET]!(req);
          if (race !== null && req.path.id === race) {
            void core!.mandates.refreshHeld(on("mandate.revoked", race));
            consents.mandates.get(race)!.status = "REVOKED";
            race = null;
          }
          return r;
        },
      },
    }));
    ({ core } = await coreOn(s));
    await core.start();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_held_race" });
    const ev = consents.sign(m.id);
    race = m.id;
    await expect(core.mandates.awaitSigned(m, feed(ev))).rejects.toMatchObject({ reason: "MANDATE_NOT_ACTIVE" });
    expect(core.mandates.held()).toEqual([]);
    // два GET: устаревший ACTIVE и перечитанный REVOKED
    expect(s.stub.calls.filter((c) => c.op === GET).slice(-2).map((c) => c.status)).toEqual([200, 200]);
  });
});
