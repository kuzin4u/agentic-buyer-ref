// Сборка адаптера витрин в месте сборки (Р42 п. 1; ревью К1 № 3): AgentCore.shops — подпись действующим ключом агента
// (kid из реестра), код агента, журнал ядра; до допуска и после закрытия подписи — исключение, обращений нет.
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { SignerStopped } from "../../src/agent/signer/index.js";
import { openPackage } from "../../src/agent/payment-package/index.js";
import { ShopFailure, type PaymentContext } from "../../src/agent/ports/index.js";
import { loadParams } from "../../src/shared/config.js";
import type { Mandate } from "../../src/shared/domain.js";
import { luhnTail } from "../support/luhn.js";
import { coreOn } from "../support/core.js";
import { AGENT, PaoStand } from "../support/pao-stand.js";

let stand: PaoStand | undefined;
afterEach(async () => {
  // нарушений схемы ПАО нет (Р45 ревью К3 № 7; AG-12 ч. 3б)
  expect(stand?.stub.violations ?? []).toEqual([]);
  await stand?.close();
  stand = undefined;
});

const KEYID = /;keyid="([^"]+)"/;
/** Полный журнал обращений к PaoStub с номера `from`, без чтения ленты (Р45 ревью К3 № 7, Р49 ревью КТ1 № 14 (в)). */
const opsFrom = (s: PaoStand, from: number) => s.stub.calls.slice(from).map((c) => c.op).filter((op) => op !== "GET /pao/v1/events");

/** Витрина-заглушка: пустой список; `seen` — заголовки ушедших обращений. */
function vitrine() {
  const seen: Record<string, string>[] = [];
  const f: typeof fetch = async (_input, init) => {
    seen.push({ ...(init?.headers as Record<string, string>) });
    return new Response(JSON.stringify({ shops: [] }), { status: 200 });
  };
  return { f, seen };
}

describe("AgentCore.shops (Р42 п. 1)", () => {
  it("до start() — подпись закрыта: исключение, обращений нет; после — подписано действующим kid, запись shop.call с кодом агента", async () => {
    const s = new PaoStand();
    stand = s;
    const { core, journal } = await coreOn(s);
    const v = vitrine();
    const shops = core.shops({ baseUrl: "http://shops.test", fetch: v.f });
    await expect(shops.search()).rejects.toBeInstanceOf(SignerStopped);
    expect(v.seen).toEqual([]);

    const self = await core.start();
    expect(await shops.search()).toEqual([]);
    expect(v.seen).toHaveLength(1);
    const active = self.keys.filter((k) => k.status === "ACTIVE").map((k) => k.kid);
    expect(active).toContain(KEYID.exec(v.seen[0]!["signature-input"] ?? "")?.[1]);
    expect(v.seen[0]!["x-agent-code"]).toBe(AGENT);
    expect(journal.entries.filter((e) => e.kind === "shop.call").map((e) => [e.agent, e.method, e.result])).toEqual([[AGENT, "GET /v1/shops", "ok"]]);

    core.close();
    await expect(shops.search()).rejects.toBeInstanceOf(SignerStopped);
    expect(v.seen).toHaveLength(1);
  });
});

// Р45 п. 6 (ревью reviewer К2 № 8): шаги оплаты профиля contour собирает место сборки — порт платформы ядра, журнал ядра
// с кодом агента; пакет — витрине через переданный порт оплаты.
describe("AgentCore.payment (Р45 п. 6)", () => {
  it("реквизит — у платформы ядра под ключом вызывающего, пакет — порту витрины; итог — operation.authorized по ленте ядра → GET → операция по заказу (Р49 п. 3, 5)", async () => {
    let served = false;
    const s = new PaoStand({
      handlers: {
        "POST /pao/v1/credentials": ({ body }) => ({
          status: 201,
          body: { credential_ref: "cr_1", kind: body.kind, payload: { token_ref: "tok_ref_1", cryptogram: "cg_1" }, aoi: { indicator: true, agent_code: AGENT, mandate_id: body.mandate_id }, status: "ISSUED" },
        }),
        "GET /pao/v1/events": () => {
          if (served) return { status: 200, body: [] };
          served = true;
          return { status: 200, body: [{ event_id: "evt_op_1", type: "operation.authorized", at: "2026-10-23T12:00:00Z", data: { op_ref: "op_1" } }] };
        },
        "GET /pao/v1/operations/{op_ref}": () => ({
          status: 200,
          body: { op_ref: "op_1", order_ref: "ORD-1", channel: "CARD", amount: 250000, merchant_id: "shop_1", aoi: { indicator: true, agent_code: AGENT, mandate_id: "m_cart" }, status: "AUTHORIZED", reason: null, fulfilment: null, deal_ref: null },
        }),
      },
    });
    stand = s;
    const { core, journal } = await coreOn(s);
    await core.start();
    const from = s.stub.calls.length;
    const sent: { shopId: string; orderId: string; cartMandateId: string; body: unknown }[] = [];
    const steps = core.payment({
      pay: async (req) => {
        sent.push({ shopId: req.shopId, orderId: req.orderId, cartMandateId: req.cartMandateId, body: JSON.parse(openPackage(req.package)) });
        return { status: "PAID" };
      },
    });
    const total = { amount: 250000, currency: "RUB" };
    const cart = { id: "m_cart", cart: { merchantId: "shop_1", lines: [], total } } as unknown as Mandate;
    const ctx: PaymentContext = { intent: { id: "m_intent" } as Mandate, cart, shopId: "SHOP-1", merchantId: "shop_1", channel: "CARD", order: { orderId: "ORD-1", total }, signal: new AbortController().signal, sending: () => {} };
    await expect(steps.authorize(ctx, { idempotencyKey: "idem-pay-compose" })).resolves.toMatchObject({ opRef: "op_1", orderRef: "ORD-1", status: "AUTHORIZED", amount: total });
    expect(journal.entries.filter((e) => e.kind === "operation.status").map((e) => [e.agent, e.ref, e.detail])).toEqual([[AGENT, "op_1", "AUTHORIZED"]]);
    expect(s.stub.calls.filter((c) => c.op === "POST /pao/v1/credentials").map((c) => c.idempotencyKey)).toEqual(["idem-pay-compose"]);
    expect(sent).toEqual([
      {
        shopId: "SHOP-1",
        orderId: "ORD-1",
        cartMandateId: "m_cart",
        body: { credential_ref: "cr_1", kind: "CARD", payload: { token_ref: "tok_ref_1", cryptogram: "cg_1" }, aoi: { indicator: true, agent_code: AGENT, mandate_id: "m_cart" }, cart_mandate_id: "m_cart", order_ref: "ORD-1" },
      },
    ]);
    expect(journal.entries.filter((e) => e.kind === "pao.call" && e.method === "POST /pao/v1/credentials").map((e) => [e.agent, e.result, e.mandate])).toEqual([[AGENT, "ok", "m_cart"]]);
    expect(JSON.stringify(journal.entries)).not.toMatch(/tok_ref_1|cg_1/);
    // полный журнал: выдача и один GET операции по событию — без лишних GET /pao/v1/operations
    expect(opsFrom(s, from)).toEqual(["POST /pao/v1/credentials", "GET /pao/v1/operations/{op_ref}"]);
  });

  /** Покупка на PaoStub с обрывом ответа витрины на первой оплате и «операций нет» по CART (Р69 п. 4); `credential` —
   *  статус реквизита по GET перед повтором (дополнение 1). */
  async function retryOnStub(credential: "ISSUED" | "USED") {
    let paid = 0;
    let served = false;
    const VALID_TO = "2026-10-12T09:15:00Z";
    const issued = (kind: "CARD" | "SBP", mandateId: string, status: "ISSUED" | "USED") => ({
      credential_ref: "cr_1",
      kind,
      // GET пересчитывает криптограмму (ПАО §3) — адаптер её отбрасывает
      payload: { token_ref: "tok_ref_1", cryptogram: status === "ISSUED" && paid > 0 ? "cg_2" : "cg_1", valid_to: VALID_TO },
      aoi: { indicator: true, agent_code: AGENT, mandate_id: mandateId },
      status,
    });
    const s = new PaoStand({
      handlers: {
        "POST /pao/v1/credentials": ({ body }) => ({ status: 201, body: issued(body.kind, body.mandate_id, "ISSUED") }),
        "GET /pao/v1/credentials/{ref}": () => ({ status: 200, body: issued("CARD", "m_cart", credential) }),
        // событие — только после второй попытки: первая до продавца не дошла
        "GET /pao/v1/events": () => {
          if (paid < 2 || served) return { status: 200, body: [] };
          served = true;
          return { status: 200, body: [{ event_id: "evt_op_1", type: "operation.authorized", at: "2026-10-12T09:01:00Z", data: { op_ref: "op_1" } }] };
        },
        "GET /pao/v1/operations": () => ({ status: 200, body: [] }),
        "GET /pao/v1/operations/{op_ref}": () => ({
          status: 200,
          body: { op_ref: "op_1", order_ref: "ORD-1", channel: "CARD", amount: 250000, merchant_id: "shop_1", aoi: { indicator: true, agent_code: AGENT, mandate_id: "m_cart" }, status: "AUTHORIZED", reason: null, fulfilment: null, deal_ref: null },
        }),
      },
    });
    stand = s;
    // свой срок итога стадии 5 — тест не ждёт стендовых 30 с; не меньше трёх интервалов чтения ленты
    // (event_poll_interval_ms, ниже не задать — Р59): иначе чтение второго окна уходит до второй оплаты и событие опаздывает
    const params = loadParams();
    const paramsPath = `${s.dir}-params.json`;
    writeFileSync(paramsPath, JSON.stringify({ ...params, operation_outcome_max_delay_sec: Math.ceil((3 * params.event_poll_interval_ms) / 1000) }));
    const { core, journal } = await coreOn(s, { paramsPath });
    await core.start();
    const from = s.stub.calls.length;
    const packages: string[] = [];
    const steps = core.payment({
      pay: async (req) => {
        paid++;
        packages.push(openPackage(req.package));
        if (paid === 1) throw new ShopFailure("SHOP_ORDER_STATE_UNKNOWN");
        return { status: "PAID" };
      },
      payable: async () => true,
    });
    const total = { amount: 250000, currency: "RUB" };
    const cart = { id: "m_cart", cart: { merchantId: "shop_1", lines: [], total } } as unknown as Mandate;
    const ctx: PaymentContext = { intent: { id: "m_intent" } as Mandate, cart, shopId: "SHOP-1", merchantId: "shop_1", channel: "CARD", order: { orderId: "ORD-1", total }, signal: new AbortController().signal, sending: () => {} };
    const result = await steps.authorize(ctx, { idempotencyKey: "idem-pay-retry" }).then(
      (op) => op.status,
      (e: { code?: string }) => e.code,
    );
    return { s, from, journal, packages, result };
  }

  it("Р69 п. 4 (ревью КТ сессии 57 № 2; дополнение 1): обрыв ответа витрины, «операций нет», реквизит ISSUED — один повтор тем же пакетом; POST /pao/v1/credentials один, нарушений схемы нет", async () => {
    const { s, from, journal, packages, result } = await retryOnStub("ISSUED");
    expect(result).toBe("AUTHORIZED");
    // тот же пакет на обеих попытках (криптограмма из GET в пакет не попала); реквизит выдан один раз
    expect(packages).toHaveLength(2);
    expect(packages[1]).toBe(packages[0]);
    expect(packages[0]).toContain("cg_1");
    expect(s.stub.calls.filter((c) => c.op === "POST /pao/v1/credentials").map((c) => c.idempotencyKey)).toEqual(["idem-pay-retry"]);
    // порядок (В1 (а)): поиск по CART, затем статус реквизита — до повтора; GET реквизита — один
    expect(opsFrom(s, from)).toEqual(["POST /pao/v1/credentials", "GET /pao/v1/operations", "GET /pao/v1/credentials/{ref}", "GET /pao/v1/operations/{op_ref}"]);
    expect(journal.entries.filter((e) => e.kind === "pao.call" && e.method === "POST /pao/v1/credentials").map((e) => e.result)).toEqual(["ok"]);
    expect(journal.entries.filter((e) => e.kind === "pao.call" && e.method === "GET /pao/v1/credentials/{ref}").map((e) => [e.result, e.mandate])).toEqual([["ok", "m_cart"]]);
    expect(journal.entries.filter((e) => e.kind === "payment.retry").map((e) => [e.ref, e.mandate])).toEqual([["ORD-1", "m_cart"]]);
    expect(JSON.stringify(journal.entries)).not.toMatch(/tok_ref_1|cg_1|cg_2|cr_1/);
  });

  it("дополнение 1 к Р69 п. 4: реквизит USED (первая авторизация дошла до ADP без итога) — второго POST нет, OPERATION_RESULT_UNCONFIRMED", async () => {
    const { s, from, journal, packages, result } = await retryOnStub("USED");
    expect(result).toBe("OPERATION_RESULT_UNCONFIRMED");
    expect(packages).toHaveLength(1);
    expect(opsFrom(s, from)).toEqual(["POST /pao/v1/credentials", "GET /pao/v1/operations", "GET /pao/v1/credentials/{ref}"]);
    expect(journal.entries.some((e) => e.kind === "payment.retry")).toBe(false);
  });

  it("связка ядра (Р49 п. 4, 6): операция по заказу с чужим продавцом — OPERATION_REPLY_MISMATCH; расчёт — GET по op_ref, SETTLED с записью об исполнении", async () => {
    let served = false;
    let merchant = "shop_other";
    let status: "AUTHORIZED" | "SETTLED" = "AUTHORIZED";
    const ful = { fulfilment_ref: "ful_0123456789abcdef01234567", final_amount: 250000, scope_check: "WITHIN_LIMITS", spent_position: 250000, at: "2026-10-23T12:05:00Z" };
    const s = new PaoStand({
      handlers: {
        "POST /pao/v1/credentials": ({ body }) => ({
          status: 201,
          body: { credential_ref: "cr_1", kind: body.kind, payload: { token_ref: "tok_ref_1", cryptogram: "cg_1" }, aoi: { indicator: true, agent_code: AGENT, mandate_id: body.mandate_id }, status: "ISSUED" },
        }),
        "GET /pao/v1/events": () => {
          if (served) return { status: 200, body: [] };
          served = true;
          return { status: 200, body: [{ event_id: "evt_op_2", type: "operation.authorized", at: "2026-10-23T12:00:00Z", data: { op_ref: "op_2" } }] };
        },
        "GET /pao/v1/operations/{op_ref}": () => ({
          status: 200,
          body: { op_ref: "op_2", order_ref: "ORD-2", channel: "CARD", amount: 250000, merchant_id: merchant, aoi: { indicator: true, agent_code: AGENT, mandate_id: "m_cart" }, status, reason: null, fulfilment: status === "SETTLED" ? ful : null, deal_ref: null },
        }),
      },
    });
    stand = s;
    const { core, journal } = await coreOn(s);
    await core.start();
    const from = s.stub.calls.length;
    const steps = core.payment({ pay: async () => ({ status: "PAID" }) });
    const total = { amount: 250000, currency: "RUB" };
    const cart = { id: "m_cart", cart: { merchantId: "shop_1", lines: [], total } } as unknown as Mandate;
    const ctx: PaymentContext = { intent: { id: "m_intent" } as Mandate, cart, shopId: "SHOP-1", merchantId: "shop_1", channel: "CARD", order: { orderId: "ORD-2", total }, signal: new AbortController().signal, sending: () => {} };
    await expect(steps.authorize(ctx, { idempotencyKey: "idem-pay-mismatch" })).rejects.toMatchObject({ code: "OPERATION_REPLY_MISMATCH" });
    expect(journal.entries.filter((e) => e.kind === "operation.mismatch").map((e) => [e.ref, e.detail, e.mandate])).toEqual([["op_2", "MERCHANT", "m_cart"]]);

    merchant = "shop_1";
    status = "SETTLED";
    const authorized = { opRef: "op_2", orderRef: "ORD-2", channel: "CARD" as const, amount: total, merchantId: "shop_1", indicator: { agentCode: AGENT, mandateId: "m_cart" }, status: "AUTHORIZED" as const, declineReason: null, fulfilment: null };
    await expect(steps.settle(authorized)).resolves.toMatchObject({ status: "SETTLED", fulfilment: { finalAmount: total, spentPosition: total, scopeCheck: "WITHIN_LIMITS" } });
    expect(journal.entries.filter((e) => e.kind === "operation.settled").map((e) => [e.ref, e.detail])).toEqual([["op_2", "WITHIN_LIMITS"]]);
    // полный журнал: расхождение — без поиска по CART и без второй выдачи; расчёт — один GET (сразу SETTLED)
    expect(opsFrom(s, from)).toEqual(["POST /pao/v1/credentials", "GET /pao/v1/operations/{op_ref}", "GET /pao/v1/operations/{op_ref}"]);
  });

  it("ответ продавца DECLINED и запрос подтверждения раньше операции — CONFIRMATION_REQUIRED, стадия 4 (Р47 п. 4, Р49 п. 5); confirm ждёт модуль подтверждений ядра и прерывается остановкой", async () => {
    const id = "cnf_11111111-1111-4111-8111-111111111111";
    let served = false;
    const s = new PaoStand({
      handlers: {
        "POST /pao/v1/credentials": ({ body }) => ({
          status: 201,
          body: { credential_ref: "cr_1", kind: body.kind, payload: { token_ref: "tok_ref_1", cryptogram: "cg_1" }, aoi: { indicator: true, agent_code: AGENT, mandate_id: body.mandate_id }, status: "ISSUED" },
        }),
        "GET /pao/v1/events": () => {
          if (served) return { status: 200, body: [] };
          served = true;
          return { status: 200, body: [{ event_id: "evt_cnf_1", type: "confirmation.required", at: "2026-10-23T12:00:00Z", data: { confirmation_id: id } }] };
        },
        "GET /pao/v1/confirmations/{id}": () => ({
          status: 200,
          body: { id, status: "PENDING", link: "https://upk.stand/c/x", confirmation_ref: null, expires_at: "2099-10-23T12:15:00.000Z" },
        }),
      },
    });
    stand = s;
    const { core } = await coreOn(s);
    await core.start();
    const from = s.stub.calls.length;
    const steps = core.payment({ pay: async () => ({ status: "DECLINED" }) });
    const total = { amount: 250000, currency: "RUB" };
    const cart = { id: "m_cart", cart: { merchantId: "shop_1", lines: [], total } } as unknown as Mandate;
    const ac = new AbortController();
    const ctx: PaymentContext = { intent: { id: "m_intent" } as Mandate, cart, shopId: "SHOP-1", merchantId: "shop_1", channel: "CARD", order: { orderId: "ORD-1", total }, signal: ac.signal, sending: () => {} };
    await expect(steps.authorize(ctx, { idempotencyKey: "idem-pay-declined" })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    const waiting = steps.confirm(ctx, () => {}, ac.signal);
    ac.abort(new Error("покупка остановлена"));
    await expect(waiting).rejects.toThrow("покупка остановлена");
    // полный журнал: гонка решена запросом подтверждения — GET операций нет, поиска по CART нет
    expect(opsFrom(s, from)).toEqual(["POST /pao/v1/credentials", "GET /pao/v1/confirmations/{id}"]);
  });

  it("связка ядра (Р47 п. 3): confirmation.required по ленте ядра → GET → REJECTED — исход confirm; уведомления на REJECTED нет", async () => {
    const id = "cnf_11111111-1111-4111-8111-111111111111";
    let served = false;
    const s = new PaoStand({
      handlers: {
        "GET /pao/v1/events": () => {
          if (served) return { status: 200, body: [] };
          served = true;
          return { status: 200, body: [{ event_id: "evt_cnf_1", type: "confirmation.required", at: "2026-10-22T12:00:00Z", data: { confirmation_id: id } }] };
        },
        "GET /pao/v1/confirmations/{id}": () => ({
          status: 200,
          body: { id, status: "REJECTED", link: "https://upk.stand/c/x", confirmation_ref: null, expires_at: "2026-10-22T12:15:00.000Z" },
        }),
      },
    });
    stand = s;
    const { core, journal } = await coreOn(s);
    await core.start();
    const steps = core.payment({ pay: async () => ({ status: "DECLINED" }) });
    const total = { amount: 250000, currency: "RUB" };
    const cart = { id: "m_cart", cart: { merchantId: "shop_1", lines: [], total } } as unknown as Mandate;
    const ctx: PaymentContext = { intent: { id: "m_intent" } as Mandate, cart, shopId: "SHOP-1", merchantId: "shop_1", channel: "CARD", order: { orderId: "ORD-1", total }, signal: new AbortController().signal, sending: () => {} };
    const notified: string[] = [];
    await expect(steps.confirm(ctx, () => void notified.push("n"), new AbortController().signal)).resolves.toBe("REJECTED");
    expect(notified).toEqual([]);
    expect(journal.entries.filter((e) => e.kind === "confirmation.status").map((e) => [e.agent, e.ref, e.detail])).toEqual([[AGENT, id, "REJECTED"]]);
    expect(s.stub.calls.filter((c) => c.op === "GET /pao/v1/confirmations/{id}")).toHaveLength(1);
    expect(JSON.stringify(journal.entries)).not.toContain("upk.stand");
  });

  /** Р70 В1 и дополнение 2 к Р69 п. 4 на PaoStub: APPROVED → ссылка продавцу — отказ витрины (409) → события нет →
   *  поиск по CART отдаёт `listed`. Модуль операций и подтверждений — ядра. */
  async function refusedLinkOnStub(listed: object[]) {
    const id = "cnf_11111111-1111-4111-8111-111111111111";
    let served = false;
    const s = new PaoStand({
      handlers: {
        "GET /pao/v1/events": () => {
          if (served) return { status: 200, body: [] };
          served = true;
          return { status: 200, body: [{ event_id: "evt_cnf_1", type: "confirmation.required", at: "2026-10-22T12:00:00Z", data: { confirmation_id: id } }] };
        },
        "GET /pao/v1/confirmations/{id}": () => ({
          status: 200,
          body: { id, status: "APPROVED", link: "https://upk.stand/c/x", confirmation_ref: "cr_aaaaaaaaaaaaaaaaaaaaaaaaaa", expires_at: "2099-10-22T12:15:00.000Z" },
        }),
        "GET /pao/v1/operations": () => ({ status: 200, body: listed }),
      },
    });
    stand = s;
    // свой срок итога — тест не ждёт стендовых 30 с (как retryOnStub)
    const params = loadParams();
    const paramsPath = `${s.dir}-params.json`;
    writeFileSync(paramsPath, JSON.stringify({ ...params, operation_outcome_max_delay_sec: Math.ceil((3 * params.event_poll_interval_ms) / 1000) }));
    const { core, journal } = await coreOn(s, { paramsPath });
    await core.start();
    const confirms: number[] = [];
    const steps = core.payment({
      pay: async () => ({ status: "DECLINED" }),
      confirm: async (_req, attempt) => {
        confirms.push(attempt ?? 1);
        throw new ShopFailure("SHOP_ORDER_REFUSED");
      },
    });
    const total = { amount: 250000, currency: "RUB" };
    const cart = { id: "m_cart", cart: { merchantId: "shop_1", lines: [], total } } as unknown as Mandate;
    const ctx: PaymentContext = { intent: { id: "m_intent" } as Mandate, cart, shopId: "SHOP-1", merchantId: "shop_1", channel: "CARD", order: { orderId: "ORD-1", total }, signal: new AbortController().signal, sending: () => {} };
    await expect(steps.confirm(ctx, () => {}, new AbortController().signal)).resolves.toBe("APPROVED");
    const code = await steps.resume!(ctx).then(() => "RESOLVED", (e: { code?: string }) => e.code);
    return { s, journal, code, confirms };
  }

  it("Р70 В1, дополнение 2 к Р69 п. 4: отказ витрины на ссылку и операции первой попытки в поиске нет — CONFIRMATION_NOT_DELIVERED; ссылка одна, повтора нет", async () => {
    const r = await refusedLinkOnStub([]);
    expect(r.code).toBe("CONFIRMATION_NOT_DELIVERED");
    expect(r.confirms).toEqual([1]);
    expect(r.s.stub.calls.filter((c) => c.op === "GET /pao/v1/operations")).toHaveLength(1);
    expect(JSON.stringify(r.journal.entries)).not.toContain("cr_aaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("дополнение 2 к Р69 п. 4 (правило по стенду v0.37.0): поиск видит только операцию первой попытки CONFIRMATION_REQUIRED — OPERATION_RESULT_UNCONFIRMED, не CONFIRMATION_NOT_DELIVERED; и повторное требование — DECLINED_CONFIRMATION_REQUIRED", async () => {
    const op = (opRef: string) => ({ op_ref: opRef, order_ref: "ORD-1", channel: "CARD", amount: 250000, merchant_id: "shop_1", aoi: { indicator: true, agent_code: AGENT, mandate_id: "m_cart" }, status: "CONFIRMATION_REQUIRED", reason: "CONFIRMATION_REQUIRED", fulfilment: null, deal_ref: null });
    const one = await refusedLinkOnStub([op("op_1")]);
    expect(one.code).toBe("OPERATION_RESULT_UNCONFIRMED");
    await stand?.close();
    stand = undefined;
    const two = await refusedLinkOnStub([op("op_1"), op("op_2")]);
    expect(two.code).toBe("DECLINED_CONFIRMATION_REQUIRED");
    // два ожидания итога по operation_outcome_max_delay_sec (не меньше трёх интервалов чтения ленты) — больше 5 с по умолчанию
  }, 4 * Math.ceil((3 * loadParams().event_poll_interval_ms) / 1000) * 1000);

  it("второй рубеж на стадии 5 (Р45 п. 2.1) и остановленная покупка (Б2в (а)): обращений за реквизитом и к витрине нет", async () => {
    const s2 = new PaoStand();
    stand = s2;
    const { core, journal } = await coreOn(s2);
    await core.start();
    let paid = 0;
    const steps = core.payment({ pay: async () => (paid++, { status: "PAID" }) });
    const total = { amount: 250000, currency: "RUB" };
    const cart = { id: "m_cart", cart: { merchantId: "shop_1", lines: [], total } } as unknown as Mandate;
    const ctx = (orderId: string, signal: AbortSignal): PaymentContext => ({ intent: { id: "m_intent" } as Mandate, cart, shopId: "SHOP-1", merchantId: "shop_1", channel: "CARD", order: { orderId, total }, signal, sending: () => {} });
    const pan = luhnTail("900000000000000");
    await expect(steps.authorize(ctx(`ORD-${pan}`, new AbortController().signal), { idempotencyKey: "idem-pan" })).rejects.toMatchObject({ code: "SHOP_ORDER_REF_INVALID" });
    expect(journal.entries.filter((e) => e.kind === "agent.refused").map((e) => [e.reason, e.detail, e.mandate])).toEqual([["SHOP_ORDER_REF_INVALID", "PAN_LIKE", "m_cart"]]);
    expect(JSON.stringify(journal.entries).includes(pan)).toBe(false);
    const stopped = new AbortController();
    stopped.abort(new Error("покупка остановлена"));
    await expect(steps.authorize(ctx("ORD-1", stopped.signal), { idempotencyKey: "idem-stopped" })).rejects.toBe(stopped.signal.reason);
    expect(s2.stub.calls.filter((c) => c.op === "POST /pao/v1/credentials")).toEqual([]);
    expect(paid).toBe(0);
  });

  it.each([
    ["реквизит USED (повтор под ключом после погашения) — CREDENTIAL_INVALID", { status: 201, body: "USED" }, "CREDENTIAL_INVALID"],
    ["409 MANDATE_SCOPE — after_human, без повтора", { status: 409, body: "MANDATE_SCOPE" }, "MANDATE_SCOPE"],
  ] as const)("%s: пакет продавцу не уходит (Р45 п. 2.2–2.3)", async (_, reply, code) => {
    const s3 = new PaoStand({
      handlers: {
        "POST /pao/v1/credentials": ({ body }) =>
          reply.status === 201
            ? { status: 201, body: { credential_ref: "cr_1", kind: body.kind, payload: { token_ref: "tok_ref_1", cryptogram: "cg_1" }, aoi: { indicator: true, agent_code: AGENT, mandate_id: body.mandate_id }, status: reply.body } }
            : { error: { code: "MANDATE_SCOPE" as const } },
      },
    });
    stand = s3;
    const { core } = await coreOn(s3);
    await core.start();
    let paid = 0;
    const steps = core.payment({ pay: async () => (paid++, { status: "PAID" }) });
    const total = { amount: 250000, currency: "RUB" };
    const cart = { id: "m_cart", cart: { merchantId: "shop_1", lines: [], total } } as unknown as Mandate;
    const ctx: PaymentContext = { intent: { id: "m_intent" } as Mandate, cart, shopId: "SHOP-1", merchantId: "shop_1", channel: "CARD", order: { orderId: "ORD-1", total }, signal: new AbortController().signal, sending: () => {} };
    await expect(steps.authorize(ctx, { idempotencyKey: "idem-k3" })).rejects.toMatchObject({ code });
    expect(paid).toBe(0);
    expect(s3.stub.calls.filter((c) => c.op === "POST /pao/v1/credentials")).toHaveLength(1);
  });
});
