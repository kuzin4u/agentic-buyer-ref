// Отказ от CART после остановки покупки и при оставлении CART (Т13; Р63 п. 7, дополнение 1; К3.2) на PaoStub: таблица
// причин, `cartRelease` и `cartReleased()`, фоновая цепочка — отчёт её не ждёт, ошибки не уходят необработанными.
import { afterEach, describe, expect, it } from "vitest";
import { PurchaseStopped, type Offer } from "../../src/agent/pipeline/index.js";
import { PaymentFailure, type PaymentContext } from "../../src/agent/ports/index.js";
import { PAO_RETRY_AFTER_MAX_SEC, loadParams } from "../../src/shared/config.js";
import type { JournalEntry } from "../../src/agent/journal/index.js";
import { event } from "../support/consents.js";
import type { PaoStand } from "../support/pao-stand.js";
import { one, purchaseOn, signedIntent, type PurchaseRun, type PurchaseSetup } from "../support/purchase.js";
import { payments } from "../support/shop.js";

let stand: PaoStand | undefined;
afterEach(async () => {
  expect(stand?.stub.violations ?? []).toEqual([]);
  await stand?.close();
  stand = undefined;
});

const setup = (o: PurchaseSetup = {}) => purchaseOn(o, (s) => (stand = s));
const RELINQUISH = "POST /pao/v1/mandates/{id}/relinquish" as const;
const of = (r: PurchaseRun, kind: string) => r.journal.entries.filter((e) => e.kind === kind);

async function tartine(r: PurchaseRun): Promise<Offer> {
  const zones = await r.purchase.search();
  return zones.contour.find((o) => o.sku === "tartine")!;
}

/** До CART_ACTIVE: INTENT и CART подписаны человеком по ленте. */
async function cartActive(r: PurchaseRun, key = "idem-cart-1") {
  await signedIntent(r);
  const cart = await r.purchase.cart(one(await tartine(r), 1), { idempotencyKey: key });
  r.setFeed({ kind: "event", event: r.consents.sign(cart.id) });
  await r.purchase.awaitCart();
  return cart;
}

/** До ORDERED и остановка в воротах стадии 5: остаток CART по verify меньше итога (до пакета). */
async function stoppedAtGate(r: PurchaseRun) {
  const cart = await cartActive(r);
  await r.purchase.placeOrder({ idempotencyKey: "idem-order-1" });
  r.consents.left.set(cart.id, cart.cart!.total.amount - 1);
  await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toBeInstanceOf(PurchaseStopped);
  return cart;
}

/** Медленный отказ: `relinquish` клиента мандатов ждёт `open()` теста; прочее — как есть. */
function gated(r: PurchaseRun): () => void {
  let open!: () => void;
  const gate = new Promise<void>((res) => (open = res));
  const original = r.core.mandates.relinquish.bind(r.core.mandates);
  r.core.mandates.relinquish = async (id, m) => {
    await gate;
    return original(id, m);
  };
  return open;
}

describe("отказ от CART после остановки (Р63 п. 7, дополнение 1)", () => {
  it("до остановки cartReleased() сразу отдаёт NONE и итога не ждёт", async () => {
    const r = await setup();
    await cartActive(r);
    expect(r.purchase.cartRelease).toBe("NONE");
    expect(await r.purchase.cartReleased()).toBe("NONE");
    expect(r.stand.calls(RELINQUISH)).toEqual([]);
  });

  it("остановка до пакета: отчёт сразу (PENDING), затем RELINQUISHED; ключ cart-relinquish-<id>; CART у Платформы REVOKED", async () => {
    const r = await setup();
    const open = gated(r);
    const cart = await stoppedAtGate(r);
    // отчёт человеку ушёл (PurchaseStopped), итога отказа ещё нет
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.cartRelease).toBe("PENDING");
    open();
    expect(await r.purchase.cartReleased()).toBe("RELINQUISHED");
    expect(r.purchase.cartRelease).toBe("RELINQUISHED");
    expect(r.stand.calls(RELINQUISH)).toMatchObject([{ status: 200, idempotencyKey: `cart-relinquish-${cart.id}` }]);
    expect(r.consents.mandates.get(cart.id)!.status).toBe("REVOKED");
    expect(of(r, "cart.relinquished")).toEqual([expect.objectContaining({ mandate: cart.id })]);
    expect(of(r, "mandate.relinquished")).toEqual([expect.objectContaining({ mandate: cart.id, detail: "REVOKED" })]);
    expect(r.core.mandates.held().map((m) => m.id)).not.toContain(cart.id);
  });

  it("MANDATE_REVOKED (INTENT отозван) — NOT_NEEDED: отказа нет, запись cart.relinquish_skipped NOT_NEEDED", async () => {
    const r = await setup();
    const cart = await cartActive(r);
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-1" });
    const intentId = r.purchase.intentMandate!.id;
    r.consents.mandates.get(intentId)!.status = "REVOKED";
    await r.core.mandates.refreshHeld({ kind: "event", event: event("mandate.revoked", intentId) });
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "MANDATE_REVOKED" });
    expect(await r.purchase.cartReleased()).toBe("NOT_NEEDED");
    expect(r.stand.calls(RELINQUISH)).toEqual([]);
    expect(of(r, "cart.relinquish_skipped")).toEqual([expect.objectContaining({ mandate: cart.id, detail: "NOT_NEEDED" })]);
  });

  it("после отправки пакета — KEPT: CART оставлен намеренно, отказа нет", async () => {
    const r = await setup({
      payment: {
        ...payments(),
        authorize: async (c: PaymentContext) => {
          c.sending();
          throw new PaymentFailure("OPERATION_RESULT_UNCONFIRMED");
        },
      },
    });
    const cart = await cartActive(r);
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-1" });
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-1" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
    expect(await r.purchase.cartReleased()).toBe("KEPT");
    expect(r.stand.calls(RELINQUISH)).toEqual([]);
    expect(of(r, "cart.relinquish_skipped")).toEqual([expect.objectContaining({ mandate: cart.id, detail: "KEPT" })]);
  });

  it("подпись остановлена — SKIPPED STOPPED: отказ не пытается, обращения нет", async () => {
    const r = await setup({ signingStopped: () => true });
    const cart = await stoppedAtGate(r);
    expect(await r.purchase.cartReleased()).toBe("SKIPPED");
    expect(r.stand.calls(RELINQUISH)).toEqual([]);
    expect(of(r, "cart.relinquish_skipped")).toEqual([expect.objectContaining({ mandate: cart.id, detail: "STOPPED" })]);
  });

  it("CART создавался, ответ не разобран (BAD_RESPONSE) — CART не известен: SKIPPED UNKNOWN_CART, отказа нет", async () => {
    const r = await setup();
    await signedIntent(r);
    const offer = await tartine(r);
    r.consents.tamper = () => ({ broken: true }) as never; // ответ на создание CART не по схеме
    await expect(r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-1" })).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    expect(await r.purchase.cartReleased()).toBe("SKIPPED");
    expect(r.stand.calls(RELINQUISH)).toEqual([]);
    expect(of(r, "cart.relinquish_skipped")).toEqual([expect.objectContaining({ detail: "UNKNOWN_CART" })]);
    expect(of(r, "cart.relinquish_skipped")[0]).not.toHaveProperty("mandate");
    // нарушение схемы — подменённый тестом ответ, а не агент
    expect(r.stand.stub.violations.length).toBeGreaterThan(0);
    r.stand.stub.violations.splice(0);
  });

  it("отказ Платформы на отказе от CART — FAILED, cart.relinquish_failed с кодом", async () => {
    const r = await setup();
    r.stand.stub.fail(RELINQUISH, { code: "UPSTREAM_UNAVAILABLE" }, 10);
    const cart = await stoppedAtGate(r);
    expect(await r.purchase.cartReleased()).toBe("FAILED");
    expect(of(r, "cart.relinquish_failed")).toEqual([expect.objectContaining({ mandate: cart.id, reason: "UPSTREAM_UNAVAILABLE" })]);
  });

  it("цепочка отклонилась (сбой журнала на cart.relinquished) — FAILED, процесс жив, unhandledRejection нет", async () => {
    const unhandled: unknown[] = [];
    const listen = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", listen);
    try {
      const r = await setup({
        tap: (e: JournalEntry) => {
          if (e.kind === "cart.relinquished") throw new Error("журнал недоступен");
        },
      });
      await stoppedAtGate(r);
      expect(await r.purchase.cartReleased()).toBe("FAILED");
      await new Promise((res) => setTimeout(res, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listen);
    }
  });

  it("сбой журнала на mandate.relinquished (способ AG-12 ч. 4а) — отказ у Платформы состоялся, мандат снят с удержания; итог FAILED", async () => {
    const r = await setup();
    const record = r.journal.record.bind(r.journal);
    r.journal.record = (e) => {
      if (e.kind === "mandate.relinquished") throw new Error("журнал недоступен");
      record(e);
    };
    const cart = await stoppedAtGate(r);
    expect(await r.purchase.cartReleased()).toBe("FAILED");
    expect(r.consents.mandates.get(cart.id)!.status).toBe("REVOKED");
    expect(r.core.mandates.held().map((m) => m.id)).not.toContain(cart.id);
    expect(of(r, "cart.relinquish_failed")).toEqual([expect.objectContaining({ mandate: cart.id, reason: "UNKNOWN" })]);
  });

  it("предел времени отказа — формулой из параметров (дополнение 1 п. 3) и в окне ключа идемпотентности (повтор тем же ключом)", () => {
    const p = loadParams();
    const R = PAO_RETRY_AFTER_MAX_SEC * 1000;
    const I = 60_000 / p.pao_rate_limit_fallback_per_min;
    const bound = p.pao_max_attempts * (p.pao_request_timeout_ms + R + I) + R;
    expect(Number.isFinite(bound)).toBe(true);
    expect(bound).toBeLessThan(p.idempotency_ttl_sec * 1000);
  });
});

describe("отказ от прежнего CART при оставлении (Р63, дополнение 1 п. 1, 6)", () => {
  it("новый поиск из CART_ACTIVE — фоновый отказ; стадия 3 ждёт его итога перед новым CART; новый CART сбрасывает в NONE", async () => {
    const r = await setup();
    const old = await cartActive(r, "idem-cart-old");
    const open = gated(r);
    const offer = await tartine(r); // новый поиск: прежний CART оставлен
    expect(r.purchase.cartRelease).toBe("PENDING");
    const creates = () => r.stand.calls("POST /pao/v1/mandates").length;
    const before = creates();
    const next = r.purchase.cart(one(offer, 2), { idempotencyKey: "idem-cart-new" });
    await new Promise((res) => setTimeout(res, 50));
    expect(creates()).toBe(before); // новый CART не запрошен, пока отказ от прежнего идёт
    open();
    const fresh = await next;
    expect(creates()).toBe(before + 1);
    expect(r.consents.mandates.get(old.id)!.status).toBe("REVOKED");
    expect(r.purchase.cartRelease).toBe("NONE");
    expect(of(r, "cart.relinquished")).toEqual([expect.objectContaining({ mandate: old.id })]);
    expect(fresh.id).not.toBe(old.id);
  });

  it("итог прежнего отказа FAILED — новый CART всё равно запрашивается (решение за Платформой), запись в журнале", async () => {
    const r = await setup();
    const old = await cartActive(r, "idem-cart-old");
    r.stand.stub.fail(RELINQUISH, { code: "UPSTREAM_UNAVAILABLE" }, 10);
    const offer = await tartine(r);
    const fresh = await r.purchase.cart(one(offer, 2), { idempotencyKey: "idem-cart-new" });
    expect(fresh.id).not.toBe(old.id);
    expect(of(r, "cart.relinquish_failed")).toEqual([expect.objectContaining({ mandate: old.id, reason: "UPSTREAM_UNAVAILABLE" })]);
    expect(r.purchase.cartRelease).toBe("NONE");
  });

  it("успешный заказ отказа от CART не начинает (отказ живой проверки — pipeline-cart-lines, REFUSED_BEFORE_ORDER)", async () => {
    const r = await setup();
    await cartActive(r);
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-1" });
    expect(r.purchase.cartRelease).toBe("NONE");
    expect(r.stand.calls(RELINQUISH)).toEqual([]);
  });
});
