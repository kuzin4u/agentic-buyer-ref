// П12 (профиль contour, стенд Платформы v0.37.0): операция выше порога подтверждения. A5 п. 3, A1, Т7; инварианты 1, 7, 8,
// 9; Р47, Р69 п. 5, Р70, дополнение 1 к Р70. CART выше порога ADP стенда в пределах INTENT: ADP CONFIRMATION_REQUIRED —
// заказ AWAITING_CONFIRMATION, confirmation.required → GET → PENDING, человеку CONFIRMATION_PENDING со ссылкой https:;
// решение человека — в приложении банка или на странице УПК; APPROVED → ворота стадии 5 заново → одна ссылка продавцу →
// новая операция с прежним реквизитом → operation.authorized → GET → SETTLING.
// ОПКЦ и эмитент — заглушки стенда до PS-11 (асинхронный `decide`, `adpAsync`, #97 п. 6): решение ADP — ответ продавцу;
// ответ эмитента (ПИ-3, одобрение) шлёт тестовая поддержка. Запрос, событие, решение человека, ссылка, решение ADP и
// новая операция — настоящие. Проверка обхода: агент ничего не подтверждает сам, реквизит один, пакет один, ссылка одна,
// confirmation_ref и link — нигде наружу.
import { afterEach, describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { DIAG } from "../../src/agent/compose.js";
import { INTENT } from "../support/consents.js";
import { shopBy, type Contour } from "../support/contour.js";
import { one } from "../support/purchase.js";
import { STAND_TIMEOUT_MS, adpDecision, routesFrom, standPurchase } from "../support/stand-purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  expect(c?.violations() ?? []).toEqual([]);
  await c?.close();
  c = undefined;
});

const NORMAL = shopBy("NORMAL");
const QTY = 2;
/** Товар витрины, у которого QTY штук — выше порога ADP стенда и в пределах INTENT (проверка — ниже); из фикстур */
const ITEM = [...NORMAL.agent_items].sort((x, y) => (y.price ?? 0) - (x.price ?? 0))[0]!;

type Decide = "APP" | "UPK";

async function p12(path: Decide) {
  let notified: () => void = () => {};
  const pending = new Promise<void>((res) => (notified = res));
  const codes: string[] = [];
  const details: unknown[] = [];
  const r = await standPurchase({
    contourPayment: true,
    adpAsync: true,
    notify: (code, detail) => {
      codes.push(code);
      details.push(detail);
      notified();
    },
  });
  c = r.c;
  const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-p12" });
  await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
  const offer = (await r.purchase.search()).contour.find((x) => x.shopId === NORMAL.id && x.sku === ITEM.sku)!;
  const cart = await r.purchase.cart(one(offer, QTY), { idempotencyKey: "idem-cart-p12" });
  await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
  const order = await r.purchase.placeOrder({ idempotencyKey: "idem-order-p12" });
  expect(order.total.amount).toBeGreaterThan(r.c.stand!.params.confirm_above_kop);
  expect(order.total.amount).toBeLessThanOrEqual(INTENT.amountLimit.amount);

  const from = r.c.calls().length;
  const paying = r.purchase.authorize({ idempotencyKey: "idem-pay-p12" }).catch((e: unknown) => e);
  await pending;
  // ADP потребовала подтверждения; заказ продавца — AWAITING_CONFIRMATION (слова продавца — только в журнале)
  expect((await adpDecision(r.c, 1)).decision).toBe("CONFIRMATION_REQUIRED");
  expect(r.c.journal.entries.filter((e) => e.kind === "shop.call" && e.method?.endsWith("/payment")).map((e) => e.detail)).toEqual(["AWAITING_CONFIRMATION"]);
  expect(codes).toEqual(["CONFIRMATION_PENDING"]);
  const id = r.c.journal.entries.find((x) => x.kind === "confirmation.status" && x.detail === "PENDING")?.ref;
  expect(id).toMatch(/^cnf_/);
  const link = (details[0] as { link?: string } | undefined)?.link;
  expect(link).toBeDefined();
  const url = new URL(link!);
  expect(url.protocol).toBe("https:");
  // агент до решения человека сам ничего не подтверждает (инвариант 7): ссылки продавцу нет
  const confirmRoute = `POST /v1/shops/${NORMAL.id}/orders/${order.orderId}/confirmation`;
  const count = (route: string) => r.c.calls().filter((x) => `${x.target} ${x.route.split("?")[0]}` === route).length;
  expect(count(`merchants ${confirmRoute}`)).toBe(0);

  let secret: string;
  if (path === "APP") {
    const decided = await r.c.stand!.issuer.confirm(id!);
    expect(decided.statusCode).toBe(200);
    secret = (decided.body as { confirmation_ref: string }).confirmation_ref;
  } else {
    // код страницы человек получает в банке — вне ПАО, агенту недоступен (РП51 п. 15)
    secret = (await r.c.stand!.issuer.upkCode(id!))!;
    const page = await r.c.stand!.upk.app.inject({
      method: "POST",
      url: url.pathname,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ decision: "APPROVE", instrument: "CARD", code: secret }).toString(),
    });
    expect(page.statusCode).toBe(200);
  }
  const second = await adpDecision(r.c, 2);
  expect(second.decision).toBe("APPROVE");
  const op = await paying;
  return { r, op, order, cart, intent, from, id: id!, link: link!, url, secret, first: (await adpDecision(r.c, 1)).op_ref, second: second.op_ref, count, confirmRoute };
}

describe("П12 — операция выше порога подтверждения", { timeout: STAND_TIMEOUT_MS * 2 }, () => {
  it.each(["APP", "UPK"] as Decide[])("решение человека (%s): ADP CONFIRMATION_REQUIRED → PENDING → APPROVED → одна ссылка продавцу → новая операция → SETTLING; исполнено один раз", async (path) => {
    const { r, op, order, cart, intent, from, id, link, url, secret, first, second, count, confirmRoute } = await p12(path);
    // полный журнал обращений агента от оплаты до SETTLING, без ленты (КТ сессии 60 № 4; как p15): ворота стадии 5, реквизит,
    // пакет, GET подтверждения, ворота заново, одна ссылка, GET новой операции — ничего лишнего (ни GET реквизита, ни
    // чтения заказов, ни второго POST)
    const ids = { intent: intent.id, cart: cart.id, shop: NORMAL.id, merchant: NORMAL.merchant_id, order: order.orderId, cnf: id, op: second };
    expect(routesFrom(r.c, from, "agent", ids)).toEqual([
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "pao GET /pao/v1/mandates/{cart}/verify 200",
      "pao GET /pao/v1/merchants/{merchant}/readiness 200",
      "pao POST /pao/v1/credentials 201",
      "merchants POST /v1/shops/{shop}/orders/{order}/payment 200",
      // PENDING по confirmation.required, APPROVED по confirmation.approved
      "pao GET /pao/v1/confirmations/{cnf} 200",
      "pao GET /pao/v1/confirmations/{cnf} 200",
      // ворота стадии 5 заново после решения человека (Р70)
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "pao GET /pao/v1/mandates/{cart}/verify 200",
      "pao GET /pao/v1/merchants/{merchant}/readiness 200",
      "merchants POST /v1/shops/{shop}/orders/{order}/confirmation 200",
      "pao GET /pao/v1/operations/{op} 200",
    ]);
    expect(op).toMatchObject({ opRef: second, orderRef: order.orderId, status: "AUTHORIZED", amount: cart.cart!.total, indicator: { mandateId: cart.id } });
    expect(second).not.toBe(first);
    expect(r.purchase.state).toBe("SETTLING");
    expect(r.purchase.reason).toBeNull();
    expect(r.c.journal.entries.filter((e) => e.kind === "purchase.stage").map((e) => e.detail).slice(-4)).toEqual(["AUTHORIZING", "CONFIRMING", "AUTHORIZING", "SETTLING"]);
    expect(r.c.journal.entries.filter((e) => e.kind === "confirmation.status").map((e) => [e.ref, e.detail])).toEqual([
      [id, "PENDING"],
      [id, "APPROVED"],
    ]);
    // операция исполнена один раз: реквизит один, пакет один, ссылка одна (инвариант 9; РП72 п. 2–3)
    expect(count("pao POST /pao/v1/credentials")).toBe(1);
    expect(count(`merchants POST /v1/shops/${NORMAL.id}/orders/${order.orderId}/payment`)).toBe(1);
    expect(count(`merchants ${confirmRoute}`)).toBe(1);
    expect(r.c.journal.entries.filter((e) => e.kind === "operation.status").map((e) => [e.ref, e.detail])).toEqual([[second, "AUTHORIZED"]]);
    // наружу — ни confirmation_ref или кода страницы, ни ссылки, ни реквизита (инвариант 1)
    const text = [
      JSON.stringify(r.c.journal.entries),
      JSON.stringify([r.purchase.state, r.purchase.cartMandate, r.purchase.order, r.purchase.operation]),
      inspect(op, { depth: 10, showHidden: true }),
      JSON.stringify(DIAG.CONFIRMATION_PENDING),
    ].join("\n");
    expect(text).not.toContain(secret);
    expect(text).not.toContain(link);
    expect(text).not.toContain(url.host);
    for (const s of r.c.issuedSecrets!()) expect(text.includes(s)).toBe(false);
    // повторной оплаты нет
    await expect(r.purchase.authorize({ idempotencyKey: "idem-pay-p12" })).rejects.toThrow();
    expect(count("pao POST /pao/v1/credentials")).toBe(1);
  });
});
