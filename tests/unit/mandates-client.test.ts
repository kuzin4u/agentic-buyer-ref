// Клиент мандатов на PaoStub через адаптер pao (AG-05 К2): Т2, Т3, Т3а; Р29 пп. 4–5.
import { afterEach, describe, expect, it } from "vitest";
import { MandateRefused, missingTerms } from "../../src/agent/mandates/index.js";
import type { MandateDraft } from "../../src/shared/domain.js";
import { Consents, INTENT, RUB, event, feed } from "../support/consents.js";
import { coreOn } from "../support/core.js";
import { PaoStand } from "../support/pao-stand.js";
import type { StandParams } from "../../src/shared/config.js";

let stand: PaoStand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

async function setup() {
  const consents: Consents = new Consents(() => s.clock);
  const s = new PaoStand({ handlers: consents.handlers() });
  stand = s;
  const { core } = await coreOn(s);
  await core.start();
  return { core, consents, stand: s };
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

  it("CART со ссылкой на INTENT — корзина в валюте мандата", async () => {
    const { core } = await setup();
    const cart: MandateDraft = {
      ...INTENT,
      kind: "CART",
      parentId: "m_intent",
      cart: { merchantId: "shop_1", lines: [{ sku: "sku_1", qty: 2, price: RUB(1000) }], total: RUB(2000) },
    };
    const m = await core.mandates.request(cart, { idempotencyKey: "idem_c1" });
    expect(m).toMatchObject({ kind: "CART", parentId: "m_intent", cart: { total: RUB(2000) } });
  });

  it("проект без реквизита — отказ до обращения (П06)", async () => {
    const { core, stand } = await setup();
    const err = await core.mandates.request({ ...INTENT, merchantScope: [] }, { idempotencyKey: "idem_bad" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MandateRefused);
    expect(err).toMatchObject({ reason: "DRAFT_INVALID" });
    expect(stand.calls("POST /pao/v1/mandates")).toEqual([]);
  });

  it("платформа вернула другие пределы — REPLY_MISMATCH (ревью К1.2 № 5)", async () => {
    const { core, consents } = await setup();
    consents.tamper = (m) => ({ ...m, amount_limit: 900000 });
    await expect(core.mandates.request(INTENT, { idempotencyKey: "idem_t" })).rejects.toMatchObject({ reason: "REPLY_MISMATCH" });
  });

  it("корзина: другой состав в ответе — REPLY_MISMATCH; получатели в другом порядке — тот же мандат", async () => {
    const { core, consents } = await setup();
    const cart: MandateDraft = {
      ...INTENT,
      kind: "CART",
      parentId: "m_intent",
      merchantScope: ["shop_1", "shop_2"],
      cart: { merchantId: "shop_1", lines: [{ sku: "sku_1", qty: 2, price: RUB(1000) }], total: RUB(2000) },
    };
    consents.tamper = (m) => ({ ...m, merchant_scope: ["shop_2", "shop_1"] });
    await expect(core.mandates.request(cart, { idempotencyKey: "idem_c2" })).resolves.toMatchObject({ kind: "CART" });
    consents.tamper = (m) => ({ ...m, cart: { ...m.cart!, items: [{ sku: "sku_1", qty: 3, price: 1000 }], total: 3000 } });
    await expect(core.mandates.request(cart, { idempotencyKey: "idem_c3" })).rejects.toMatchObject({ reason: "REPLY_MISMATCH" });
  });

  // Поправка 3 ревью плана: событие до AG-06 не подписано — истина у платформы.
  it("подделанное mandate.signed при статусе не ACTIVE — остановка", async () => {
    const { core } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_f" });
    const err = await core.mandates.awaitSigned(m, feed(event("mandate.signed", m.id))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MandateRefused);
    expect(err).toMatchObject({ reason: "NOT_ACTIVE" });
  });

  it("подписи нет — SIGNATURE_PENDING; отклонение — NOT_ACTIVE", async () => {
    const { core } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_p" });
    await expect(core.mandates.awaitSigned(m, feed())).rejects.toMatchObject({ reason: "SIGNATURE_PENDING" });
    for (const t of ["mandate.rejected", "mandate.revoked", "mandate.exhausted"] as const) {
      await expect(core.mandates.awaitSigned(m, feed(event(t, m.id)))).rejects.toMatchObject({ reason: "NOT_ACTIVE" });
    }
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
    await expect(core.mandates.requireActive(signed)).rejects.toMatchObject({ reason: "OUT_OF_SCOPE" });
  });

  it("as_of не дата-время — ответ не по схеме ПАО: UNKNOWN в адаптере («Открыто» № 4)", async () => {
    const { core, consents } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_s" });
    const signed = await core.mandates.awaitSigned(m, feed(consents.sign(m.id)));
    consents.asOf = "вчера";
    const err = (await core.mandates.check(signed).catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ code: "UNKNOWN", retry: "never", httpStatus: 200 });
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
    await expect(core.mandates.requireActive(null)).rejects.toMatchObject({ reason: "NO_MANDATE" });
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem_n" });
    const after = stand.stub.calls.length;
    await expect(core.mandates.requireActive(m)).rejects.toMatchObject({ reason: "NO_MANDATE" });
    expect(stand.stub.calls.length).toBe(after);
    expect(after - before).toBe(1);
  });
});
