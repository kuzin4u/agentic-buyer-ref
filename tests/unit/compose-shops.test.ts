// Сборка адаптера витрин в месте сборки (Р42 п. 1; ревью К1 № 3): AgentCore.shops — подпись действующим ключом агента
// (kid из реестра), код агента, журнал ядра; до допуска и после закрытия подписи — исключение, обращений нет.
import { afterEach, describe, expect, it } from "vitest";
import type { ShopProfile } from "../../src/agent/adapters/shops/index.js";
import { SignerStopped } from "../../src/agent/signer/index.js";
import { openPackage } from "../../src/agent/payment-package/index.js";
import type { PaymentContext } from "../../src/agent/ports/index.js";
import type { Mandate } from "../../src/shared/domain.js";
import { luhnTail } from "../support/luhn.js";
import { coreOn } from "../support/core.js";
import { AGENT, PaoStand } from "../support/pao-stand.js";

let stand: PaoStand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

const profile: ShopProfile = {
  shop: { inn: "7705123452", mcc: "5462", paymentMethods: ["card"], deliveryRegions: ["77"], returns: { days: 0, text: "Продовольственные товары надлежащего качества возврату не подлежат" } },
  item: () => null,
};
const KEYID = /;keyid="([^"]+)"/;

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
    const shops = core.shops({ baseUrl: "http://shops.test", profile: () => profile, fetch: v.f });
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
  it("реквизит — у платформы ядра под ключом вызывающего, пакет — порту витрины; итог не подтверждён", async () => {
    const s = new PaoStand({
      handlers: {
        "POST /pao/v1/credentials": ({ body }) => ({
          status: 201,
          body: { credential_ref: "cr_1", kind: body.kind, payload: { token_ref: "tok_ref_1", cryptogram: "cg_1" }, aoi: { indicator: true, agent_code: AGENT, mandate_id: body.mandate_id }, status: "ISSUED" },
        }),
      },
    });
    stand = s;
    const { core, journal } = await coreOn(s);
    await core.start();
    const sent: { shopId: string; orderId: string; cartMandateId: string; body: unknown }[] = [];
    const steps = core.payment({
      pay: async (req) => {
        sent.push({ shopId: req.shopId, orderId: req.orderId, cartMandateId: req.cartMandateId, body: JSON.parse(openPackage(req.package)) });
        return { status: "PAID" };
      },
    });
    const total = { amount: 250000, currency: "RUB" };
    const cart = { id: "m_cart", cart: { merchantId: "shop_1", lines: [], total } } as unknown as Mandate;
    const ctx: PaymentContext = { intent: { id: "m_intent" } as Mandate, cart, shopId: "SHOP-1", merchantId: "shop_1", order: { orderId: "ORD-1", total }, signal: new AbortController().signal, sending: () => {} };
    await expect(steps.authorize(ctx, { idempotencyKey: "idem-pay-compose" })).rejects.toMatchObject({ code: "OPERATION_RESULT_UNCONFIRMED" });
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
  });

  it("ответ продавца DECLINED — CONFIRMATION_REQUIRED, стадия 4 (Р47 п. 4); confirm ждёт модуль подтверждений ядра и прерывается остановкой", async () => {
    const s = new PaoStand({
      handlers: {
        "POST /pao/v1/credentials": ({ body }) => ({
          status: 201,
          body: { credential_ref: "cr_1", kind: body.kind, payload: { token_ref: "tok_ref_1", cryptogram: "cg_1" }, aoi: { indicator: true, agent_code: AGENT, mandate_id: body.mandate_id }, status: "ISSUED" },
        }),
      },
    });
    stand = s;
    const { core } = await coreOn(s);
    await core.start();
    const steps = core.payment({ pay: async () => ({ status: "DECLINED" }) });
    const total = { amount: 250000, currency: "RUB" };
    const cart = { id: "m_cart", cart: { merchantId: "shop_1", lines: [], total } } as unknown as Mandate;
    const ac = new AbortController();
    const ctx: PaymentContext = { intent: { id: "m_intent" } as Mandate, cart, shopId: "SHOP-1", merchantId: "shop_1", order: { orderId: "ORD-1", total }, signal: ac.signal, sending: () => {} };
    await expect(steps.authorize(ctx, { idempotencyKey: "idem-pay-declined" })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    const waiting = steps.confirm(ctx, () => {}, ac.signal);
    ac.abort(new Error("покупка остановлена"));
    await expect(waiting).rejects.toThrow("покупка остановлена");
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
    const ctx: PaymentContext = { intent: { id: "m_intent" } as Mandate, cart, shopId: "SHOP-1", merchantId: "shop_1", order: { orderId: "ORD-1", total }, signal: new AbortController().signal, sending: () => {} };
    const notified: string[] = [];
    await expect(steps.confirm(ctx, () => void notified.push("n"), new AbortController().signal)).resolves.toBe("REJECTED");
    expect(notified).toEqual([]);
    expect(journal.entries.filter((e) => e.kind === "confirmation.status").map((e) => [e.agent, e.ref, e.detail])).toEqual([[AGENT, id, "REJECTED"]]);
    expect(s.stub.calls.filter((c) => c.op === "GET /pao/v1/confirmations/{id}")).toHaveLength(1);
    expect(JSON.stringify(journal.entries)).not.toContain("upk.stand");
  });

  it("второй рубеж на стадии 5 (Р45 п. 2.1) и остановленная покупка (Б2в (а)): обращений за реквизитом и к витрине нет", async () => {
    const s2 = new PaoStand();
    stand = s2;
    const { core, journal } = await coreOn(s2);
    await core.start();
    let paid = 0;
    const steps = core.payment({ pay: async () => (paid++, { status: "PAID" }) });
    const total = { amount: 250000, currency: "RUB" };
    const cart = { id: "m_cart", cart: { merchantId: "shop_1", lines: [], total } } as unknown as Mandate;
    const ctx = (orderId: string, signal: AbortSignal): PaymentContext => ({ intent: { id: "m_intent" } as Mandate, cart, shopId: "SHOP-1", merchantId: "shop_1", order: { orderId, total }, signal, sending: () => {} });
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
    const ctx: PaymentContext = { intent: { id: "m_intent" } as Mandate, cart, shopId: "SHOP-1", merchantId: "shop_1", order: { orderId: "ORD-1", total }, signal: new AbortController().signal, sending: () => {} };
    await expect(steps.authorize(ctx, { idempotencyKey: "idem-k3" })).rejects.toMatchObject({ code });
    expect(paid).toBe(0);
    expect(s3.stub.calls.filter((c) => c.op === "POST /pao/v1/credentials")).toHaveLength(1);
  });
});
