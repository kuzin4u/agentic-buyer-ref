// Клиент мандатов на PaoStub через адаптер pao (AG-05 К2): Т2, Т3, Т3а; Р29 пп. 4–5.
import { afterEach, describe, expect, it } from "vitest";
import { EVIDENCE_BROKEN_TEXT, MandateRefused, REVOCATION_ORDER_MISSING_TEXT, missingTerms } from "../../src/agent/mandates/index.js";
import type { MandateDraft } from "../../src/shared/domain.js";
import { Consents, INTENT, RUB, event, feed } from "../support/consents.js";
import { coreOn } from "../support/core.js";
import { PaoStand, type StandOptions } from "../support/pao-stand.js";
import type { StandParams } from "../../src/shared/config.js";

let stand: PaoStand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

async function setup(configuration?: StandOptions["configuration"]) {
  const consents: Consents = new Consents(() => s.clock);
  const s = new PaoStand({ handlers: consents.handlers(), ...(configuration && { configuration }) });
  stand = s;
  const { core, journal } = await coreOn(s);
  await core.start();
  return { core, journal, consents, stand: s };
}

describe("проект мандата — A7 п. 2.2, Т3а", () => {
  const now = new Date("2026-10-12T09:00:00Z");
  it("полный проект INTENT — без замечаний", () => {
    expect(missingTerms(INTENT, now)).toEqual([]);
  });

  it.each([
    ["subject", { subject: " " }],
    ["amountLimit", { amountLimit: RUB(0) }],
    ["validTo", { validTo: "" }],
    ["validTo", { validTo: "2026-10-01T00:00:00Z" }],
    ["merchantScope", { merchantScope: [] }],
    ["principalRef", { principalRef: "" }],
    ["keyTermsShown", { keyTermsShown: false }],
    ["cart", { kind: "CART" as const, parentId: "m_1", cart: null }],
    ["cart", { kind: "CART" as const, parentId: null, cart: { merchantId: "shop_1", lines: [{ sku: "s", qty: 1, price: RUB(1) }], total: RUB(1) } }],
    ["cart", { kind: "CART" as const, parentId: "m_1", cart: { merchantId: "shop_1", lines: [{ sku: "s", qty: 2, price: RUB(1) }], total: RUB(1) } }],
    ["cart", { kind: "CART" as const, parentId: "m_1", cart: { merchantId: "shop_9", lines: [{ sku: "s", qty: 1, price: RUB(1) }], total: RUB(1) } }],
    ["cart", { kind: "CART" as const, parentId: "m_1", cart: { merchantId: "shop_1", lines: [{ sku: "s", qty: 1, price: RUB(600000) }], total: RUB(600000) } }],
    ["cart", { parentId: "m_1" }],
    ["confirmationMode", { confirmationMode: "LATER" as "IMMEDIATE" }],
  ])("нет %s — проект недействителен", (field, patch) => {
    expect(missingTerms({ ...INTENT, ...patch }, now)).toContain(field);
  });
});

describe("клиент мандатов на PaoStub", () => {
  it("запрос → PENDING_SIGNATURE; mandate.signed + ACTIVE у платформы → мандат действует; остаток — из verify", async () => {
    const { core, consents, stand } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_m1" });
    expect(m).toMatchObject({ status: "PENDING_SIGNATURE", amountLimit: RUB(500000) });
    const signed = await core.mandates.awaitSigned(m, feed(event("mandate.signed", "m_other"), consents.sign(m.id)));
    expect(signed.status).toBe("ACTIVE");
    consents.left.set(m.id, 123400); // остаток ведёт платформа; агент переносит, а не вычисляет (инвариант 6)
    expect(await core.mandates.check(signed)).toMatchObject({ outcome: "CONFIRMED", amountLeft: RUB(123400) });
    expect(stand.stub.violations).toEqual([]);
    const post = stand.calls("POST /pao/v1/mandates");
    expect(post).toHaveLength(1);
    expect(post[0]!.idempotencyKey).toBe("idem_m1");
  });

  it("CART со ссылкой на INTENT — корзина в валюте мандата, порядок отзыва — как у родителя (Р33 п. 4)", async () => {
    const { core } = await setup();
    const intent = await core.mandates.request(INTENT, { idempotencyKey: "idem_i1" });
    const cart: MandateDraft = {
      ...INTENT,
      kind: "CART",
      parentId: intent.id,
      cart: { merchantId: "shop_1", lines: [{ sku: "sku_1", qty: 2, price: RUB(1000) }], total: RUB(2000) },
    };
    const m = await core.mandates.request(cart, { idempotencyKey: "idem_c1" }, intent);
    expect(m).toMatchObject({ kind: "CART", parentId: intent.id, cart: { total: RUB(2000) }, revocationOrder: intent.revocationOrder });
  });

  it("CART без родителя или с чужим родителем — отказ до обращения", async () => {
    const { core, stand } = await setup();
    const intent = await core.mandates.request(INTENT, { idempotencyKey: "idem_i2" });
    const cart: MandateDraft = {
      ...INTENT,
      kind: "CART",
      parentId: "m_other",
      cart: { merchantId: "shop_1", lines: [{ sku: "sku_1", qty: 1, price: RUB(1000) }], total: RUB(1000) },
    };
    await expect(core.mandates.request(cart, { idempotencyKey: "idem_c4" })).rejects.toMatchObject({ reason: "MANDATE_DRAFT_INVALID" });
    await expect(core.mandates.request(cart, { idempotencyKey: "idem_c5" }, intent)).rejects.toMatchObject({ reason: "MANDATE_DRAFT_INVALID" });
    expect(stand.calls("POST /pao/v1/mandates")).toHaveLength(1);
  });

  it("проект без реквизита — отказ до обращения (П06)", async () => {
    const { core, stand } = await setup();
    const err = await core.mandates.request({ ...INTENT, merchantScope: [] }, { idempotencyKey: "idem_bad" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MandateRefused);
    expect(err).toMatchObject({ reason: "MANDATE_DRAFT_INVALID" });
    expect(stand.calls("POST /pao/v1/mandates")).toEqual([]);
  });

  it("платформа вернула другие пределы — MANDATE_REPLY_MISMATCH (ревью К1.2 № 5)", async () => {
    const { core, consents } = await setup();
    consents.tamper = (m) => ({ ...m, amount_limit: 900000 });
    await expect(core.mandates.request(INTENT, { idempotencyKey: "idem_t" })).rejects.toMatchObject({ reason: "MANDATE_REPLY_MISMATCH" });
  });

  it("корзина: другой состав в ответе — MANDATE_REPLY_MISMATCH; получатели в другом порядке — тот же мандат", async () => {
    const { core, consents } = await setup();
    const intent = await core.mandates.request({ ...INTENT, merchantScope: ["shop_1", "shop_2"] }, { idempotencyKey: "idem_i3" });
    const cart: MandateDraft = {
      ...INTENT,
      kind: "CART",
      parentId: intent.id,
      merchantScope: ["shop_1", "shop_2"],
      cart: { merchantId: "shop_1", lines: [{ sku: "sku_1", qty: 2, price: RUB(1000) }], total: RUB(2000) },
    };
    consents.tamper = (m) => ({ ...m, merchant_scope: ["shop_2", "shop_1"] });
    await expect(core.mandates.request(cart, { idempotencyKey: "idem_c2" }, intent)).resolves.toMatchObject({ kind: "CART" });
    consents.tamper = (m) => ({ ...m, cart: { ...m.cart!, items: [{ sku: "sku_1", qty: 3, price: 1000 }], total: 3000 } });
    await expect(core.mandates.request(cart, { idempotencyKey: "idem_c3" }, intent)).rejects.toMatchObject({ reason: "MANDATE_REPLY_MISMATCH" });
    // Р33 п. 4: порядок отзыва CART не как у родителя — MANDATE_REPLY_MISMATCH
    consents.tamper = (m) => ({ ...m, revocation_order: "bank:pr_1:revocation:v2" });
    await expect(core.mandates.request(cart, { idempotencyKey: "idem_c6" }, intent)).rejects.toMatchObject({ reason: "MANDATE_REPLY_MISMATCH" });
  });

  // Р33 п. 4: ответ с мандатом без порядка отзыва — свой код, журнал, текст человеку; покупки по мандату нет. Версия ПАО
  // Платформы подтверждена конфигурацией (Р33 п. 10); без подтверждения — PLATFORM_PROTOCOL_UNSUPPORTED (protocol-version).
  it("мандат без revocation_order — MANDATE_REVOCATION_ORDER_MISSING, событие в журнал, текст человеку", async () => {
    const { core, journal, consents, stand } = await setup({ versions: ["1.4.0"] });
    consents.tamper = (m) => {
      const r = { ...m };
      delete r.revocation_order;
      return r;
    };
    const err = (await core.mandates.request(INTENT, { idempotencyKey: "idem_ro" }).catch((e: unknown) => e)) as MandateRefused;
    expect(err).toBeInstanceOf(MandateRefused);
    expect(err.reason).toBe("MANDATE_REVOCATION_ORDER_MISSING");
    expect(err.message).toContain(REVOCATION_ORDER_MISSING_TEXT);
    expect(journal.entries.filter((e) => e.kind === "mandate.revocation_order_missing")).toEqual([
      expect.objectContaining({ reason: "MANDATE_REVOCATION_ORDER_MISSING" }),
    ]);
    // ответ без поля схеме 1.4.0 не противоречит (поле необязательно) — отказ ядра, а не схемы
    expect(stand.stub.violations).toEqual([]);
  });

  it("GET после mandate.signed без revocation_order — тот же отказ, мандат не действует", async () => {
    const { core, journal, consents } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_ro2" });
    const ev = consents.sign(m.id);
    delete consents.mandates.get(m.id)!.revocation_order;
    await expect(core.mandates.awaitSigned(m, feed(ev))).rejects.toMatchObject({ reason: "MANDATE_REVOCATION_ORDER_MISSING" });
    expect(journal.entries.filter((e) => e.kind === "mandate.revocation_order_missing")).toHaveLength(1);
  });

  // РП35: после 201 — статус; CART под отозванным или истёкшим INTENT приходит 201 со статусом REVOKED или EXPIRED.
  it.each(["REVOKED", "EXPIRED", "REJECTED"] as const)("201 со статусом %s — MANDATE_NOT_ACTIVE, нового мандата нет", async (status) => {
    const { core, consents, stand } = await setup();
    consents.tamper = (m) => ({ ...m, status });
    await expect(core.mandates.request(INTENT, { idempotencyKey: `idem_s_${status}` })).rejects.toMatchObject({ reason: "MANDATE_NOT_ACTIVE" });
    expect(stand.calls("POST /pao/v1/mandates")).toHaveLength(1);
    expect(stand.calls("GET /pao/v1/mandates/{id}")).toEqual([]);
  });

  // РП34: статус — только из GET. ACTIVE в 201 (повтор позже 24 ч) — сверка по GET; у платформы отозван — MANDATE_NOT_ACTIVE.
  it("201 со статусом ACTIVE — статус из GET; GET отдал REVOKED — MANDATE_NOT_ACTIVE", async () => {
    const { core, consents, stand } = await setup();
    consents.tamper = (m) => {
      consents.mandates.set(m.id!, { ...m, status: "REVOKED" });
      return { ...m, status: "ACTIVE" };
    };
    await expect(core.mandates.request(INTENT, { idempotencyKey: "idem_a1" })).rejects.toMatchObject({ reason: "MANDATE_NOT_ACTIVE" });
    expect(stand.calls("GET /pao/v1/mandates/{id}")).toHaveLength(1);
    consents.tamper = (m) => {
      consents.mandates.set(m.id!, { ...m, status: "ACTIVE" });
      return { ...m, status: "ACTIVE" };
    };
    await expect(core.mandates.request(INTENT, { idempotencyKey: "idem_a2" })).resolves.toMatchObject({ status: "ACTIVE" });
    expect(stand.calls("GET /pao/v1/mandates/{id}")).toHaveLength(2);
    // ACTIVE в 201, а GET отдал мандат без порядка отзыва — отказ с текстом человеку (ревью К2.2 № 9)
    consents.tamper = (m) => {
      const r = { ...m, status: "ACTIVE" as const };
      delete r.revocation_order;
      consents.mandates.set(m.id!, { ...r });
      return { ...m, status: "ACTIVE" };
    };
    await expect(core.mandates.request(INTENT, { idempotencyKey: "idem_a3" })).rejects.toMatchObject({ reason: "MANDATE_REVOCATION_ORDER_MISSING" });
  });

  it("GET вернул другой мандат — MANDATE_REPLY_MISMATCH (ревью К2.2 № 6)", async () => {
    const { core, consents } = await setup();
    consents.tamper = (m) => {
      consents.mandates.set(m.id!, { ...m, id: "m_other", status: "ACTIVE" });
      return { ...m, status: "ACTIVE" };
    };
    await expect(core.mandates.request(INTENT, { idempotencyKey: "idem_g1" })).rejects.toMatchObject({ reason: "MANDATE_REPLY_MISMATCH" });
  });

  it("INTENT с родителем — отказ до обращения (ревью К2.2 № 6)", async () => {
    const { core, stand } = await setup();
    const intent = await core.mandates.request(INTENT, { idempotencyKey: "idem_i4" });
    await expect(core.mandates.request(INTENT, { idempotencyKey: "idem_i5" }, intent)).rejects.toMatchObject({ reason: "MANDATE_DRAFT_INVALID" });
    expect(stand.calls("POST /pao/v1/mandates")).toHaveLength(1);
  });

  // Поправка 3 ревью плана: событие до ПАО 1.5.0 не подписано — истина у платформы (Р29 п. 5, Р34 п. 5).
  it("подделанное mandate.signed при статусе не ACTIVE — остановка", async () => {
    const { core } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_f" });
    const err = await core.mandates.awaitSigned(m, feed(event("mandate.signed", m.id))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MandateRefused);
    expect(err).toMatchObject({ reason: "MANDATE_NOT_ACTIVE" });
  });

  it("подписи нет — MANDATE_SIGNATURE_PENDING; rejected / revoked / exhausted при PENDING_SIGNATURE — MANDATE_NOT_ACTIVE (SPEC §9, Р29 п. 5)", async () => {
    const { core, stand } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_p" });
    await expect(core.mandates.awaitSigned(m, feed())).rejects.toMatchObject({ reason: "MANDATE_SIGNATURE_PENDING" });
    for (const t of ["mandate.rejected", "mandate.revoked", "mandate.exhausted"] as const) {
      await expect(core.mandates.awaitSigned(m, feed(event(t, m.id)))).rejects.toMatchObject({ reason: "MANDATE_NOT_ACTIVE" });
    }
    // каждое событие — GET (Р34 п. 5), плюс GET до ожидания
    expect(stand.calls("GET /pao/v1/mandates/{id}")).toHaveLength(4 + 3);
  });

  it("событие о смене статуса при ACTIVE у платформы — остановка, а не «действует» (ревью К2.4 № 2)", async () => {
    const { core, consents } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_r" });
    const err = await core.mandates
      .awaitSigned(m, {
        async *[Symbol.asyncIterator]() {
          yield* feed(event("mandate.signed", "m_other")); // итератор запущен до GET; GET до ожидания — PENDING
          consents.mandates.get(m.id)!.status = "ACTIVE";
          yield* feed(event("mandate.revoked", m.id));
        },
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: "MANDATE_NOT_ACTIVE" });
  });

  it("итератор ленты запускается до первого GET: событие, прочитанное во время GET, не теряется (ревью К2.4 № 1)", async () => {
    const { core, stand } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_it" });
    const gets = () => stand.calls("GET /pao/v1/mandates/{id}").length;
    const before = gets();
    let atFirstNext = -1;
    await core.mandates
      .awaitSigned(m, {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (atFirstNext < 0) atFirstNext = gets();
            return { done: true, value: undefined };
          },
        }),
      })
      .catch(() => undefined);
    expect(atFirstNext).toBe(before);
    expect(gets()).toBe(before + 1);
  });

  it.each(["REJECTED", "REVOKED", "EXPIRED"] as const)("статус %s у платформы — MANDATE_NOT_ACTIVE по событию и до ожидания", async (status) => {
    const { core, consents } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: `idem_n_${status}` });
    consents.mandates.get(m.id)!.status = status;
    await expect(core.mandates.awaitSigned(m, feed())).rejects.toMatchObject({ reason: "MANDATE_NOT_ACTIVE" });
  });

  it("ответ (б): mandate.* без читаемого mandate_id — GET ожидаемого мандата; не мандатный тип — без GET (Р34 п. 6)", async () => {
    const { core, consents, stand } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_b" });
    const gets = () => stand.calls("GET /pao/v1/mandates/{id}").length;
    const before = gets();
    // не мандатный пропуск и неизвестный тип — мандат не перечитывается
    await expect(
      core.mandates.awaitSigned(m, feed({ kind: "ignored", eventId: "e1", detail: "INVALID_DATA", type: "operation.settled" }, { kind: "ignored", eventId: "e2", detail: "UNKNOWN_TYPE" })),
    ).rejects.toMatchObject({ reason: "MANDATE_SIGNATURE_PENDING" });
    expect(gets() - before).toBe(1); // только GET до ожидания
    // человек подписал, а событие пришло без mandate_id — сигнал о мандате был: GET даёт ACTIVE
    const signal = { kind: "ignored", eventId: "e3", detail: "INVALID_DATA", type: "mandate.signed" } as const;
    const pending = core.mandates.awaitSigned(m, {
      async *[Symbol.asyncIterator]() {
        yield* feed({ kind: "ignored", eventId: "e0", detail: "UNKNOWN_TYPE" }); // итератор запущен до GET (PENDING)
        consents.mandates.get(m.id)!.status = "ACTIVE";
        yield* feed(signal);
      },
    });
    await expect(pending).resolves.toMatchObject({ id: m.id, status: "ACTIVE" });
  });

  it("событие о чужом мандате — без GET; подпись прочитана раньше ожидания — мандат действует без события", async () => {
    const { core, consents, stand } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_o" });
    await expect(core.mandates.awaitSigned(m, feed(event("mandate.signed", "m_other")))).rejects.toMatchObject({ reason: "MANDATE_SIGNATURE_PENDING" });
    expect(stand.calls("GET /pao/v1/mandates/{id}")).toHaveLength(1);
    consents.sign(m.id);
    await expect(core.mandates.awaitSigned(m, feed())).resolves.toMatchObject({ status: "ACTIVE" });
  });

  // Границы окна — от стендовых параметров и часов стенда, не литералами.
  const at = (stand: PaoStand, sec: number) => new Date(stand.clock.getTime() + sec * 1000).toISOString();
  it.each([
    ["нет as_of", () => null],
    ["as_of старше registry_cache_ttl_sec", (s: PaoStand, p: StandParams) => at(s, -p.registry_cache_ttl_sec - 1)],
    ["as_of из будущего дальше signature_skew_sec", (s: PaoStand, p: StandParams) => at(s, p.signature_skew_sec + 1)],
  ] as const)("%s — STATE_UNKNOWN (Р29 п. 4)", async (_, asOfOf) => {
    const { core, consents, stand } = await setup();
    const asOf = asOfOf(stand, core.params);
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_a" });
    const signed = await core.mandates.awaitSigned(m, feed(consents.sign(m.id)));
    consents.asOf = asOf;
    expect((await core.mandates.check(signed)).outcome).toBe("STATE_UNKNOWN");
    await expect(core.mandates.requireActive(signed)).rejects.toMatchObject({ reason: "MANDATE_OUT_OF_SCOPE" });
  });

  it("as_of не дата-время — ответ не по схеме ПАО: BAD_RESPONSE в адаптере («Открыто» № 4)", async () => {
    const { core, consents } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_s" });
    const signed = await core.mandates.awaitSigned(m, feed(consents.sign(m.id)));
    consents.asOf = "вчера";
    const err = (await core.mandates.check(signed).catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ code: "BAD_RESPONSE", retry: "never", httpStatus: 200 });
    expect(err.message).toMatch(/не по схеме/);
    expect(err.message).not.toContain("вчера"); // значения из тела в отказ не переносятся (инвариант 1)
  });

  it("as_of на границе registry_cache_ttl_sec — CONFIRMED", async () => {
    const { core, consents, stand } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_ok" });
    const signed = await core.mandates.awaitSigned(m, feed(consents.sign(m.id)));
    consents.asOf = at(stand, -core.params.registry_cache_ttl_sec);
    expect((await core.mandates.check(signed)).outcome).toBe("CONFIRMED");
  });

  it("без действующего мандата — отказ без обращений (Т2)", async () => {
    const { core, stand } = await setup();
    const before = stand.stub.calls.length;
    await expect(core.mandates.requireActive(null)).rejects.toMatchObject({ reason: "MANDATE_NONE" });
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_n" });
    const after = stand.stub.calls.length;
    await expect(core.mandates.requireActive(m)).rejects.toMatchObject({ reason: "MANDATE_NONE" });
    expect(stand.stub.calls.length).toBe(after);
    expect(after - before).toBe(1);
  });
});

describe("отказ от мандата — MandateClient.relinquish (Р63, дополнение 1 п. 5; К3.1)", () => {
  it("держимый ACTIVE — REVOKED, запись mandate.relinquished со статусом, мандат снят с удержания", async () => {
    const { core, journal, consents, stand } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_rel_1" });
    const signed = await core.mandates.awaitSigned(m, feed(consents.sign(m.id)));
    expect(core.mandates.held().map((x) => x.id)).toEqual([signed.id]);
    await expect(core.mandates.relinquish(signed.id, { idempotencyKey: "idem_rel_r1" })).resolves.toMatchObject({ id: signed.id, status: "REVOKED" });
    expect(journal.entries.filter((e) => e.kind === "mandate.relinquished")).toEqual([expect.objectContaining({ mandate: signed.id, detail: "REVOKED" })]);
    expect(core.mandates.held()).toEqual([]);
    expect(stand.calls("POST /pao/v1/mandates/{id}/relinquish")).toMatchObject([{ status: 200, idempotencyKey: "idem_rel_r1" }]);
    expect(stand.stub.violations).toEqual([]);
  });

  it("уже конечный мандат — 200 с текущим статусом: запись со статусом ответа", async () => {
    const { core, journal, consents } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_rel_2" });
    consents.mandates.get(m.id)!.status = "EXPIRED";
    await expect(core.mandates.relinquish(m.id, { idempotencyKey: "idem_rel_r2" })).resolves.toMatchObject({ status: "EXPIRED" });
    expect(journal.entries.filter((e) => e.kind === "mandate.relinquished")).toEqual([expect.objectContaining({ mandate: m.id, detail: "EXPIRED" })]);
  });

  it("ответ без revocation_order при подтверждённой версии — mandate.revocation_order_missing и отказ (ревью К2.2 № 2–4 Р33)", async () => {
    const { core, journal, consents } = await setup({ versions: ["1.4.0"] });
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_rel_3" });
    consents.tamper = (x) => {
      const r = { ...x };
      delete r.revocation_order;
      return r;
    };
    await expect(core.mandates.relinquish(m.id, { idempotencyKey: "idem_rel_r3" })).rejects.toMatchObject({ name: "MandateRefused", reason: "MANDATE_REVOCATION_ORDER_MISSING" });
    expect(journal.entries.filter((e) => e.kind === "mandate.revocation_order_missing")).toHaveLength(1);
    expect(journal.entries.filter((e) => e.kind === "mandate.relinquished")).toEqual([]);
  });

  it("в ответе другой мандат — MANDATE_REPLY_MISMATCH, записи об отказе нет", async () => {
    const { core, journal, consents } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_rel_4" });
    consents.tamper = (x) => ({ ...x, id: "m_other" });
    await expect(core.mandates.relinquish(m.id, { idempotencyKey: "idem_rel_r4" })).rejects.toMatchObject({ reason: "MANDATE_REPLY_MISMATCH" });
    expect(journal.entries.filter((e) => e.kind === "mandate.relinquished")).toEqual([]);
  });
});

describe("выписка — MandateClient.evidence (Т12, стадия 7; Р65 п. 1–3; К1.1)", () => {
  const evidenceOf = (j: { entries: { kind: string }[] }) => j.entries.filter((e) => e.kind === "mandate.evidence");

  it("integrity OK — цепочка с запрошенным мандатом, запись mandate.evidence с признаком, держимые не меняются", async () => {
    const { core, journal, consents, stand } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_ev_1" });
    await core.mandates.awaitSigned(m, feed(consents.sign(m.id)));
    const ev = await core.mandates.evidence(m.id);
    expect(ev).toMatchObject({ integrity: "OK", operations: [] });
    expect(ev.mandateChain.map((x) => x.id)).toEqual([m.id]);
    expect(evidenceOf(journal)).toEqual([expect.objectContaining({ mandate: m.id, detail: "OK" })]);
    // тела выписки в журнале нет (инвариант 1): ни предмета, ни порядка отзыва
    expect(JSON.stringify(evidenceOf(journal))).not.toContain(INTENT.subject);
    expect(JSON.stringify(evidenceOf(journal))).not.toContain(consents.revocationOrder);
    expect(core.mandates.held().map((x) => x.id)).toEqual([m.id]);
    expect(stand.calls("GET /pao/v1/mandates/{id}/evidence")).toHaveLength(1);
    expect(stand.stub.violations).toEqual([]);
  });

  it("integrity BROKEN — не отказ: выписка с признаком, запись BROKEN, отказа агента нет; текст человеку — EVIDENCE_BROKEN_TEXT", async () => {
    const { core, journal, consents } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_ev_2" });
    consents.integrity = "BROKEN";
    await expect(core.mandates.evidence(m.id)).resolves.toEqual({ mandateChain: [], operations: [], integrity: "BROKEN" });
    expect(evidenceOf(journal)).toEqual([expect.objectContaining({ mandate: m.id, detail: "BROKEN" })]);
    expect(journal.entries.filter((e) => e.kind === "agent.refused")).toEqual([]);
    expect(EVIDENCE_BROKEN_TEXT).toMatch(/доказательством/);
  });

  it("integrity BROKEN с непустой цепочкой — агент отдаёт пустые массивы: нарушенная цепочка не служит данными (дополнение 1 к Р65 п. 4)", async () => {
    const { core, consents } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_ev_2b" });
    consents.integrity = "BROKEN";
    consents.brokenWithChain = true;
    await expect(core.mandates.evidence(m.id)).resolves.toEqual({ mandateChain: [], operations: [], integrity: "BROKEN" });
  });

  it("integrity OK, а запрошенного мандата в цепочке нет — MANDATE_REPLY_MISMATCH, записи выписки нет (инвариант 4)", async () => {
    const { core, journal, consents } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_ev_3" });
    consents.tamper = (x) => ({ ...x, id: "m_other" });
    await expect(core.mandates.evidence(m.id)).rejects.toMatchObject({ name: "MandateRefused", reason: "MANDATE_REPLY_MISMATCH" });
    expect(evidenceOf(journal)).toEqual([]);
    expect(journal.entries.filter((e) => e.kind === "agent.refused")).toEqual([expect.objectContaining({ reason: "MANDATE_REPLY_MISMATCH", mandate: m.id })]);
  });

  it("мандат без revocation_order при подтверждённой версии — mandate.revocation_order_missing и отказ (ревью К2.2 № 2–4 Р33)", async () => {
    const { core, journal, consents } = await setup({ versions: ["1.4.0"] });
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_ev_4" });
    consents.tamper = (x) => {
      const r = { ...x };
      delete r.revocation_order;
      return r;
    };
    const err = await core.mandates.evidence(m.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MandateRefused);
    expect(err).toMatchObject({ reason: "MANDATE_REVOCATION_ORDER_MISSING", message: `Мандат: ${REVOCATION_ORDER_MISSING_TEXT}` });
    expect(journal.entries.filter((e) => e.kind === "mandate.revocation_order_missing")).toHaveLength(1);
    expect(evidenceOf(journal)).toEqual([]);
  });

  it("мандата нет у Платформы — отказ платформы наружу как есть, записи выписки нет", async () => {
    const { core, journal } = await setup();
    await expect(core.mandates.evidence("m_404")).rejects.toMatchObject({ code: "MANDATE_NOT_FOUND" });
    expect(evidenceOf(journal)).toEqual([]);
  });
});

describe("проект мандата — своей копией до обращения (ревью К1а)", () => {
  it("геттер предела отдаёт 5 000 ₽, затем 50 000 ₽ — проверен, отправлен и сверен один предел; мандат с ним", async () => {
    const { core, consents, stand } = await setup();
    let reads = 0;
    const draft = { ...INTENT, get amountLimit() { return ++reads === 1 ? RUB(500000) : RUB(5000000); } };
    const m = await core.mandates.request(draft, { idempotencyKey: "idem_once" });
    expect(reads).toBe(1);
    expect(m.amountLimit).toEqual(RUB(500000));
    // у Платформы (журнал согласий заглушки) — тот же предел, что проверен
    expect(consents.mandates.get(m.id)).toMatchObject({ amount_limit: 500000 });
    expect(stand.stub.violations).toEqual([]);
  });

  it("бросающий геттер проекта — отказ промиса, обращения нет", async () => {
    const { core, stand } = await setup();
    const boom = new Error("геттер");
    const draft = { ...INTENT, get subject(): string { throw boom; } };
    const before = stand.stub.calls.length;
    await expect(core.mandates.request(draft, { idempotencyKey: "idem_boom" })).rejects.toBe(boom);
    expect(stand.stub.calls.length).toBe(before);
  });
});
