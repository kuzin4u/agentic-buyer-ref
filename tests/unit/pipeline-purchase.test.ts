// Конвейер стадий 0–6 на PaoStub (Р38 п. 2–5): допуск, INTENT с подписью, выдача в двух зонах с решениями каталога в
// журнале, ворота держимых мандатов. Ленты у PaoStub нет — элементы ленты задаёт тест (consents.feed).
import { afterEach, describe, expect, it } from "vitest";
import { PurchaseStopped, PurchaseTransitionForbidden } from "../../src/agent/pipeline/index.js";
import { MandateRefused } from "../../src/agent/mandates/index.js";
import { loadParams } from "../../src/shared/config.js";
import { Consents, INTENT, event } from "../support/consents.js";
import { coreOn } from "../support/core.js";
import { expectJournalClean } from "../support/journal.js";
import { AGENT, PaoStand } from "../support/pao-stand.js";
import { SHOP, purchaseOn, signedIntent, stages, type PurchaseSetup } from "../support/purchase.js";
import { BAKERY_FEED, bakery, feedOffers, liveOffers, payments, shopOrders } from "../support/shop.js";

let stand: PaoStand | undefined;
afterEach(async () => {
  // обращения вне контракта ПАО — дефект в любом тесте файла (ревью К2.2 № 7)
  expect(stand?.stub.violations ?? []).toEqual([]);
  await stand?.close();
  stand = undefined;
});

const setup = (o: PurchaseSetup = {}) => purchaseOn(o, (s) => (stand = s));

/** Фид без самовывоза: ни у магазина, ни у товаров (доставка — только по регионам магазина, у tartine-cheese её нет). */
const NO_PICKUP = BAKERY_FEED.replace(/<pickup-options>[\s\S]*?<\/pickup-options>/, "").replace("<pickup>true</pickup>", "");
const SKUS = ["tartine", "zavarnoy", "tartine-cheese", "borodinsky"];
const OPS = { post: "POST /pao/v1/mandates", verify: "GET /pao/v1/mandates/{id}/verify" } as const;

describe("стадия 0 — допуск (Р38 п. 2)", () => {
  it("без допуска — STOPPED NOT_ADMITTED, обращений к Платформе нет", async () => {
    const r = await setup({ admission: "NOT_ADMITTED" });
    const before = r.stand.log().length;
    await expect(r.purchase.intent(INTENT, { idempotencyKey: "idem-0" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("NOT_ADMITTED");
    expect(r.stand.log().length).toBe(before);
    expect(stages(r)).toEqual(["STOPPED:NOT_ADMITTED"]);
  });

  it("код допуска — код остановки покупки; конвейер agent.refused не пишет", async () => {
    const r = await setup({ admission: "KEYSTORE_WRITE_FAILED" });
    const before = r.stand.log().length;
    await expect(r.purchase.intent(INTENT, { idempotencyKey: "idem-0" })).rejects.toMatchObject({ code: "KEYSTORE_WRITE_FAILED" });
    expect(r.stand.log().length).toBe(before);
    expect(r.tail().map((e) => e.kind)).toEqual(["purchase.stage"]);
  });
});

describe("стадия 0 через место сборки — core.purchase() (Р38 п. 2, ревью К2.2 № 4, № 9)", () => {
  const ports = (s: PaoStand) => ({ offers: feedOffers(SHOP), live: liveOffers(SHOP, () => s.clock), shop: shopOrders(SHOP), payment: payments() });

  async function bare() {
    const consents: Consents = new Consents(() => s.clock);
    const s = new PaoStand({ handlers: consents.handlers() });
    stand = s;
    return { s, ...(await coreOn(s)) };
  }

  it("start() не вызывался — NOT_ADMITTED, обращений нет", async () => {
    const { s, core } = await bare();
    const p = core.purchase(ports(s));
    const before = s.log().length;
    await expect(p.intent(INTENT, { idempotencyKey: "idem-0" })).rejects.toMatchObject({ code: "NOT_ADMITTED" });
    expect(s.log().length).toBe(before);
  });

  it("start() не дал допуска (агент исключён) — STOPPED с кодом остановки подписи, обращений нет", async () => {
    const { s, core } = await bare();
    s.exclude([]);
    await core.start().catch(() => undefined);
    const p = core.purchase(ports(s));
    const before = s.log().length;
    await expect(p.intent(INTENT, { idempotencyKey: "idem-0" })).rejects.toMatchObject({ code: "AGENT_EXCLUDED" });
    expect(s.log().length).toBe(before);
  });

  it("допуск был, ядро закрыто (подпись остановлена) — STOPPED, обращений нет", async () => {
    const { s, core } = await bare();
    await core.start();
    core.close();
    const p = core.purchase(ports(s));
    const before = s.log().length;
    await expect(p.intent(INTENT, { idempotencyKey: "idem-0" })).rejects.toBeInstanceOf(PurchaseStopped);
    expect(p.state).toBe("STOPPED");
    expect(p.reason).toBe("UNKNOWN");
    expect(s.log().length).toBe(before);
  });

  it("допуск есть — покупка идёт на клиенте мандатов ядра", async () => {
    const { s, core } = await bare();
    await core.start();
    const p = core.purchase(ports(s));
    await p.intent(INTENT, { idempotencyKey: "idem-intent-1" });
    expect(p.state).toBe("INTENT_PENDING");
    expect(s.log().filter((c) => c.op === OPS.post)).toHaveLength(1);
  });
});

describe("стадии 1–2 — INTENT и выдача (Р38 п. 2, п. 5)", () => {
  it("путь NEW → INTENT_PENDING → INTENT_ACTIVE → OFFERS, purchase.stage с INTENT на каждый переход", async () => {
    const r = await setup();
    const intent = await signedIntent(r);
    expect(intent.status).toBe("ACTIVE");
    const zones = await r.purchase.search();
    expect(zones.contour.map((o) => o.sku)).toEqual(SKUS);
    expect(zones.market).toEqual([]);
    expect(r.tail().filter((e) => e.kind === "purchase.stage")).toEqual(
      ["INTENT_PENDING", "INTENT_ACTIVE", "OFFERS"].map((detail) => expect.objectContaining({ detail, mandate: intent.id })),
    );
    // после допуска — только запрос INTENT и verify перед поиском (Т2); лишнее обращение видно
    const afterStart = r.stand.log().slice(r.stand.log().findIndex((c) => c.op === OPS.post));
    // GET мандата — один, сверка подписи по getMandate (Р29 п. 5)
    expect(afterStart.map((c) => c.op)).toEqual([OPS.post, "GET /pao/v1/mandates/{id}", OPS.verify]);
    expectJournalClean(r.journal.entries, AGENT, r.stand.stub.calls, ["idem-intent-1"]);
  });

  it("подписи нет — ждать человека: MANDATE_SIGNATURE_PENDING наружу, покупка в INTENT_PENDING", async () => {
    const r = await setup();
    await r.purchase.intent(INTENT, { idempotencyKey: "idem-intent-1" });
    r.setFeed();
    const err = await r.purchase.awaitIntent().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MandateRefused);
    expect(err).toMatchObject({ reason: "MANDATE_SIGNATURE_PENDING" });
    expect(r.purchase.state).toBe("INTENT_PENDING");
  });

  it("запрос сразу вернул ACTIVE (РП35) — INTENT_ACTIVE без ожидания подписи, дальше поиск", async () => {
    const r = await setup();
    r.consents.tamper = (m) => Object.assign(m, { status: "ACTIVE" });
    const m = await r.purchase.intent(INTENT, { idempotencyKey: "idem-intent-1" });
    expect(m.status).toBe("ACTIVE");
    expect(r.purchase.state).toBe("INTENT_ACTIVE");
    await r.purchase.search();
    expect(stages(r)).toEqual(["INTENT_ACTIVE", "OFFERS"]);
  });

  it("зоны (Р3): магазин вне контура — в market", async () => {
    const r = await setup({ shops: [SHOP, { ...SHOP, merchantId: "shop_2", inContour: false }] });
    await signedIntent(r);
    const zones = await r.purchase.search();
    expect(zones.contour).toHaveLength(4);
    expect(zones.market.map((o) => o.merchantId)).toEqual(["shop_2", "shop_2", "shop_2", "shop_2"]);
  });

  it("решения каталога пишет конвейер: ошибка модели — reason, нет доставки — detail REGION, A5 — offer.flagged", async () => {
    const badInn = { ...SHOP, profile: bakery({ inn: "7705123453" }), merchantId: "shop_2" };
    const a5 = { ...SHOP, profile: bakery({ returns: { days: 0, text: "Возврат в течение 14 дней" } }), merchantId: "shop_3" };
    const r = await setup({ shops: [badInn, a5] });
    const intent = await signedIntent(r);
    const zones = await r.purchase.search();
    const decisions = r.tail().filter((e) => e.kind.startsWith("offer."));
    expect(decisions.filter((e) => e.kind === "offer.excluded")).toEqual(
      SKUS.map((ref) =>
        expect.objectContaining({ kind: "offer.excluded", reason: "BAD_INN", ref, mandate: intent.id, merchant: "shop_2" }),
      ),
    );
    expect(decisions.filter((e) => e.kind === "offer.flagged").map((e) => [e.reason, e.ref, e.merchant])).toEqual(
      SKUS.map((s) => ["A5_RETURNS_MISMATCH", s, "shop_3"]),
    );
    expect(zones.contour.every((o) => o.a5.includes("A5_RETURNS_MISMATCH"))).toBe(true);
    expectJournalClean(r.journal.entries, AGENT, r.stand.stub.calls, ["idem-intent-1"]);
  });

  it("регион человека неизвестен — без самовывоза товары исключены с detail REGION, без reason (Т5а)", async () => {
    const r = await setup({ region: null, shops: [{ ...SHOP, feed: NO_PICKUP }] });
    await signedIntent(r);
    const zones = await r.purchase.search();
    expect(zones.contour).toEqual([]);
    const excluded = r.tail().filter((e) => e.kind === "offer.excluded");
    // tartine-cheese без доставки и самовывоза — ошибка модели (REQUIRED), не регион
    expect(excluded.map((e) => [e.ref, e.detail ?? e.reason])).toEqual([
      ["tartine", "REGION"],
      ["zavarnoy", "REGION"],
      ["tartine-cheese", "REQUIRED"],
      ["borodinsky", "REGION"],
    ]);
    expect(excluded.filter((e) => e.detail === "REGION" && "reason" in e)).toEqual([]);
  });

  it("регион человека известен — товары с доставкой в него в выдаче; чужой регион — исключены по REGION", async () => {
    const own = await setup({ region: "77", shops: [{ ...SHOP, feed: NO_PICKUP }] });
    await signedIntent(own);
    expect((await own.purchase.search()).contour.map((o) => o.sku)).toEqual(["tartine", "zavarnoy", "borodinsky"]);
    expect(own.tail().filter((e) => e.kind === "offer.excluded" && e.detail === "REGION")).toEqual([]);
    expect(own.stand.stub.violations).toEqual([]);
    await stand?.close();
    const other = await setup({ region: "99", shops: [{ ...SHOP, feed: NO_PICKUP }] });
    await signedIntent(other);
    expect((await other.purchase.search()).contour).toEqual([]);
    expect(other.tail().filter((e) => e.detail === "REGION").map((e) => e.ref)).toEqual(["tartine", "zavarnoy", "borodinsky"]);
  });

  it("фид не разобран — запись на код магазина без ref, зоны пусты", async () => {
    const r = await setup({ shops: [{ ...SHOP, feed: "<yml_catalog>" }] });
    await signedIntent(r);
    const zones = await r.purchase.search();
    expect(zones).toEqual({ contour: [], market: [] });
    expect(r.tail().filter((e) => e.kind === "offer.excluded")).toEqual([expect.objectContaining({ reason: "XML_SYNTAX" })]);
    expect(r.tail().filter((e) => e.kind === "offer.excluded" && e.ref !== undefined)).toEqual([]);
  });

  it("предложение коннектор не перевёл (dropped) — offer.excluded с кодом без ref", async () => {
    const r = await setup({ shops: [{ ...SHOP, feed: BAKERY_FEED.replace("<price>390.00</price>", "") }] });
    await signedIntent(r);
    const zones = await r.purchase.search();
    expect(zones.contour).toHaveLength(3);
    expect(r.tail().filter((e) => e.kind === "offer.excluded")).toEqual([expect.objectContaining({ reason: "REQUIRED" })]);
    expect(r.tail().find((e) => e.kind === "offer.excluded")).not.toHaveProperty("ref");
  });

  it("решение каталога несёт продавца (Р38 п. 5, поправка К5): записи магазина без товара — тоже; код не по маске — без merchant", async () => {
    const r = await setup({ shops: [{ ...SHOP, feed: "<yml_catalog>", merchantId: "shop_9" }, { ...SHOP, profile: bakery({ inn: "7705123453" }), merchantId: "продавец 1" }] });
    await signedIntent(r);
    await r.purchase.search();
    const excluded = r.tail().filter((e) => e.kind === "offer.excluded");
    expect(excluded[0]).toMatchObject({ reason: "XML_SYNTAX", merchant: "shop_9" });
    expect(excluded.slice(1)).toHaveLength(4);
    expect(excluded.slice(1).every((e) => !("merchant" in e))).toBe(true);
    expect(JSON.stringify(r.journal.entries)).not.toContain("продавец");
    expectJournalClean(r.journal.entries, AGENT, r.stand.stub.calls, ["idem-intent-1"]);
  });

  it("sku не по маске — запись без ref (Р38 п. 5, инвариант 5)", async () => {
    const odd = { ...SHOP, feed: BAKERY_FEED.replace('offer id="tartine"', 'offer id="хлеб тартин"') };
    const r = await setup({ shops: [{ ...odd, profile: bakery({ inn: "7705123453" }) }] });
    await signedIntent(r);
    await r.purchase.search();
    const excluded = r.tail().filter((e) => e.kind === "offer.excluded");
    expect(excluded).toHaveLength(4);
    expect(excluded.filter((e) => e.ref === undefined)).toHaveLength(1);
    expect(JSON.stringify(r.journal.entries)).not.toContain("тартин");
  });
});

describe("ворота держимых мандатов перед поиском (Р38 п. 3)", () => {
  it("INTENT отозван по ленте — agent.refused MANDATE_NOT_ACTIVE, STOPPED, ни verify, ни выдачи", async () => {
    const r = await setup();
    const intent = await signedIntent(r);
    r.consents.mandates.get(intent.id)!.status = "REVOKED";
    await r.core.mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", intent.id) });
    const before = r.stand.log().length;
    await expect(r.purchase.search()).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.offers.calls).toBe(0);
    expect(r.stand.log().length).toBe(before);
    expect(r.tail().slice(-3).map((e) => [e.kind, e.reason ?? e.detail])).toEqual([
      ["mandate.revoked", undefined],
      ["agent.refused", "MANDATE_NOT_ACTIVE"],
      ["purchase.stage", "MANDATE_NOT_ACTIVE"],
    ]);
  });

  it("INTENT отозван, пока шёл поиск — STOPPED MANDATE_NOT_ACTIVE, выдачи нет (ревью К2.2 № 15)", async () => {
    const inner = feedOffers(SHOP);
    let during: (m: { id: string }) => Promise<void> = async () => {};
    const r = await setup({ offers: { search: async (m) => (await during(m), inner.search(m)) } });
    await signedIntent(r);
    during = async (m) => {
      r.consents.mandates.get(m.id)!.status = "REVOKED";
      await r.core.mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", m.id) });
    };
    await expect(r.purchase.search()).rejects.toBeInstanceOf(PurchaseStopped);
    expect(r.purchase.reason).toBe("MANDATE_NOT_ACTIVE");
    expect(r.purchase.offers).toBeNull();
    expect(stages(r).at(-1)).toBe("STOPPED:MANDATE_NOT_ACTIVE");
  });

  it("verify не CONFIRMED — STOPPED MANDATE_OUT_OF_SCOPE (запись agent.refused — клиента мандатов, одна)", async () => {
    const r = await setup();
    await signedIntent(r);
    r.consents.outcome = "OUT_OF_SCOPE";
    await expect(r.purchase.search()).rejects.toBeInstanceOf(MandateRefused);
    expect(r.purchase.reason).toBe("MANDATE_OUT_OF_SCOPE");
    expect(r.tail().filter((e) => e.kind === "agent.refused").map((e) => e.reason)).toEqual(["MANDATE_OUT_OF_SCOPE"]);
    expect(r.offers.calls).toBe(0);
  });
});

describe("сбой шага — STOPPED с кодом (Р38 п. 4, инвариант 4)", () => {
  it("запрос INTENT не прошёл — STOPPED с кодом Платформы", async () => {
    const r = await setup();
    r.stand.stub.fail(OPS.post, { code: "STATE_UNAVAILABLE" }, loadParams().pao_max_attempts);
    await expect(r.purchase.intent(INTENT, { idempotencyKey: "idem-intent-1" })).rejects.toThrow();
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("STATE_UNAVAILABLE");
    // сбой Платформы — не отказ действовать: agent.refused не пишется (Р38 п. 4)
    expect(r.tail().filter((e) => e.kind === "agent.refused")).toEqual([]);
  });

  it("источник выдачи упал — STOPPED UNKNOWN, исходная ошибка наружу", async () => {
    const boom = new Error("витрина недоступна");
    const r = await setup({ offers: { search: () => Promise.reject(boom) } });
    await signedIntent(r);
    await expect(r.purchase.search()).rejects.toBe(boom);
    expect(r.purchase.reason).toBe("UNKNOWN");
  });

  it("выдача не той формы — STOPPED UNKNOWN, а не покупка в прежнем состоянии (ревью К2.2 № 2)", async () => {
    const r = await setup({ offers: { search: async () => [{ merchantId: "shop_1", inContour: true } as never] } });
    await signedIntent(r);
    await expect(r.purchase.search()).rejects.toBeInstanceOf(TypeError);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("UNKNOWN");
  });
});

describe("запрещённый переход до работы стадии (Р38 п. 1)", () => {
  it("поиск без INTENT — отказ машины, обращений нет", async () => {
    const r = await setup();
    const before = r.stand.log().length;
    await expect(r.purchase.search()).rejects.toBeInstanceOf(PurchaseTransitionForbidden);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.stand.log().length).toBe(before);
    expect(r.tail().map((e) => [e.kind, e.reason])).toEqual([
      ["agent.refused", "PIPELINE_TRANSITION_FORBIDDEN"],
      ["purchase.stage", "PIPELINE_TRANSITION_FORBIDDEN"],
    ]);
  });
});
