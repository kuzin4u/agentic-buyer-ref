// П13 (профиль contour, стенд Платформы v0.37.0): обход подтверждения дроблением. A3 п. 4, Т7; инварианты 3, 7, 8;
// Р39 п. 3–4, дополнение 2 к Р70. Агент-нарушитель — то же ядро в тестовом режиме: окно дробления покупки подменено
// обёрткой, которая долю не видит (`BlindSplitWindow`, только tests/support; конвейер и policy/split.ts не меняются). Под
// одним INTENT — две покупки (доли), каждая не выше порога ADP стенда, сумма — выше: Платформа выявляет дробление — первая
// доля одобрена (в окно ADP стенда входят одобрения, split_min_ops), вторая — ADP CONFIRMATION_REQUIRED с признаком
// split_detected у запроса; человек отказывает — CONFIRMATION_REJECTED, второй операции нет. Честный агент (настоящее окно)
// ту же долю не отправляет: agent.refused SPLIT_WINDOW до стадии 5, без реквизита и пакета.
// Суммы — из фикстур эмулятора (уточнение решения владельца 02.11): 1 890 ₽ + 4 × 390 ₽ = 3 450 ₽ — ровно 1 700 ₽ на
// витрине NORMAL не собрать. ОПКЦ и эмитент — заглушки стенда до PS-11 (асинхронный `decide`, `adpAsync`, #97 п. 6).
// Расхождение с пулом («обе операции отклонены») — нюанс формы (дополнение 2 к Р70 п. 3), передача платформе.
import { afterEach, describe, expect, it } from "vitest";
import { PurchaseStopped } from "../../src/agent/pipeline/index.js";
import { INTENT } from "../support/consents.js";
import { shopBy, type Contour } from "../support/contour.js";
import { one } from "../support/purchase.js";
import { BlindSplitWindow, STAND_TIMEOUT_MS, adpDecision, pause, routesFrom, standPurchase } from "../support/stand-purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  expect(c?.violations() ?? []).toEqual([]);
  await c?.close();
  c = undefined;
});

const NORMAL = shopBy("NORMAL");
const ITEMS = [...NORMAL.agent_items].sort((x, y) => (y.price ?? 0) - (x.price ?? 0));
/** Доля 1 — дорогая позиция витрины, одна штука; доля 2 — дешёвая, QTY_B штук (решение владельца 02.11, вариант (а)) */
const A = ITEMS[0]!;
const B = ITEMS[ITEMS.length - 1]!;
const QTY_B = 4;
const INTENT_KEY = "idem-intent-p13";

describe("П13 — обход подтверждения дроблением", { timeout: STAND_TIMEOUT_MS * 3 }, () => {
  it("нарушитель делит покупку на две доли под одним INTENT: ADP одобряет первую, на второй — CONFIRMATION_REQUIRED с признаком дробления, человек отказывает; честный агент — SPLIT_WINDOW до стадии 5", async () => {
    const codes: string[] = [];
    let notified: () => void = () => {};
    const pending = new Promise<void>((res) => (notified = res));
    const r = await standPurchase({
      contourPayment: true,
      adpAsync: true,
      notify: (code) => {
        codes.push(code);
        notified();
      },
    });
    c = r.c;
    const T = r.c.stand!.params.confirm_above_kop;
    // две доли образуют дробление (ревью КТ сессии 61 № 7)
    expect(r.c.stand!.params.split_min_ops).toBeLessThanOrEqual(2);
    // каждая доля не выше порога, сумма — выше (дробление под порог, A3 п. 4)
    const shareA = A.price!;
    const shareB = B.price! * QTY_B;
    expect(shareA).toBeLessThanOrEqual(T);
    expect(shareB).toBeLessThanOrEqual(T);
    expect(shareA + shareB).toBeGreaterThan(T);
    expect(shareA + shareB).toBeLessThanOrEqual(INTENT.amountLimit.amount);

    const blind = new BlindSplitWindow(r.split, r.params);
    const draft = { ...INTENT, merchantScope: [NORMAL.merchant_id] };
    /** Покупка того же ядра под тем же INTENT: черновик и ключ прежние — Платформа отдаёт тот же мандат */
    async function share(p: ReturnType<typeof r.next>, sku: string, qty: number, n: number) {
      const intent = await p.intent(draft, { idempotencyKey: INTENT_KEY });
      if (n === 1) await r.signWhileWaiting(intent.id, () => p.awaitIntent());
      else if (p.state === "INTENT_PENDING") await p.awaitIntent();
      const offer = (await p.search()).contour.find((x) => x.shopId === NORMAL.id && x.sku === sku)!;
      const cart = await p.cart(one(offer, qty), { idempotencyKey: `idem-cart-p13-${n}` });
      await r.signWhileWaiting(cart.id, () => p.awaitCart());
      const order = await p.placeOrder({ idempotencyKey: `idem-order-p13-${n}` });
      return { intent, cart, order };
    }

    // доля 1 нарушителя: не выше порога — ADP одобряет, итог — SETTLING
    const p1 = r.next({ split: blind });
    const s1 = await share(p1, A.sku, 1, 1);
    expect(s1.order.total.amount).toBe(shareA);
    const from1 = r.c.calls().length;
    const op1 = await p1.authorize({ idempotencyKey: "idem-pay-p13-1" });
    expect((await adpDecision(r.c, 1)).decision).toBe("APPROVE");
    expect(op1).toMatchObject({ status: "AUTHORIZED", indicator: { mandateId: s1.cart.id } });
    expect(p1.state).toBe("SETTLING");
    const routes1 = routesFrom(r.c, from1, "agent", { intent: s1.intent.id, cart: s1.cart.id, shop: NORMAL.id, merchant: NORMAL.merchant_id, order: s1.order.orderId, op: op1.opRef });

    // честный агент — до доли 2 нарушителя (ревью КТ сессии 61 № 1): в настоящем окне только доля 1, отказ — именно по
    // ней (1 890 + 1 560 > 3 000 ₽, две операции); та же доля под тем же INTENT, пакет не уходит
    const p3 = r.next();
    const s3 = await share(p3, B.sku, QTY_B, 3);
    expect(s3.intent.id).toBe(s1.intent.id);
    const from3 = r.c.calls().length;
    // первое из: конец authorize или вход в стадию 5 (ушла бы на ADP и ждала человека) — красный по коду и журналу, не по сроку
    let ended = false;
    const refused = p3.authorize({ idempotencyKey: "idem-pay-p13-3" }).then(
      () => null,
      (e: unknown) => e,
    );
    void refused.then(() => (ended = true));
    for (let i = 0; i < 1000 && !ended && p3.state !== "AUTHORIZING"; i++) await pause(10);
    expect(p3.reason, "честный агент — отказ до стадии 5").toBe("SPLIT_WINDOW");
    expect(await refused).toBeInstanceOf(PurchaseStopped);
    expect(r.c.journal.entries.filter((e) => e.kind === "agent.refused" && e.reason === "SPLIT_WINDOW")).toHaveLength(1);
    // честный агент: отказ до стадии 5 — ни реквизита, ни пакета; CART после остановки отпущен (Р63, дополнение 1)
    await p3.cartReleased();
    const routes3 = routesFrom(r.c, from3, "agent", { intent: s3.intent.id, cart: s3.cart.id, shop: NORMAL.id, merchant: NORMAL.merchant_id, order: s3.order.orderId });

    // доля 2 нарушителя: тот же INTENT, окно агента подменено — пакет уходит; ADP выявляет дробление
    const p2 = r.next({ split: blind });
    const s2 = await share(p2, B.sku, QTY_B, 2);
    expect(s2.intent.id).toBe(s1.intent.id);
    expect(s2.order.total.amount).toBe(shareB);
    const from2 = r.c.calls().length;
    const paying = p2.authorize({ idempotencyKey: "idem-pay-p13-2" }).catch((e: unknown) => e);
    // первое из: человеку CONFIRMATION_PENDING или конец authorize; покупка остановлена раньше (окно агента увидело долю) —
    // красный по коду остановки, а не по сроку теста
    await Promise.race([pending, paying]);
    expect(p2.reason, "доля 2 нарушителя дошла до ADP").toBeNull();
    expect(p2.state).toBe("CONFIRMING");
    const second = await adpDecision(r.c, 2);
    expect(second.decision).toBe("CONFIRMATION_REQUIRED");
    expect(codes).toEqual(["CONFIRMATION_PENDING"]);
    const id = r.c.journal.entries.find((x) => x.kind === "confirmation.status" && x.detail === "PENDING")?.ref;
    expect(id).toMatch(/^cnf_/);
    // событие «дробление» — признак у запроса Платформы (агенту в ПАО 1.4.0 не отдаётся; чтение — тестовой стороной)
    expect(await r.c.stand!.confirmations.get(id!)).toMatchObject({ split_detected: true, mandate_id: s2.cart.id, amount: shareB });
    // агент сам не подтверждает (инвариант 7): решение — человека, отказ в приложении банка
    expect((await r.c.stand!.issuer.confirm(id!, { decision: "REJECT" })).statusCode).toBe(200);
    const stopped = await paying;
    expect(stopped).toBeInstanceOf(PurchaseStopped);
    expect(p2.state).toBe("STOPPED");
    expect(p2.reason).toBe("CONFIRMATION_REJECTED");
    expect(p2.operation).toBeNull();
    await p2.cartReleased();
    const routes2 = routesFrom(r.c, from2, "agent", { intent: s2.intent.id, cart: s2.cart.id, shop: NORMAL.id, merchant: NORMAL.merchant_id, order: s2.order.orderId, cnf: id! });

    // полный журнал обращений агента на каждой доле (без ленты)
    expect(routes1).toEqual([
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "pao GET /pao/v1/mandates/{cart}/verify 200",
      "pao GET /pao/v1/merchants/{merchant}/readiness 200",
      "pao POST /pao/v1/credentials 201",
      "merchants POST /v1/shops/{shop}/orders/{order}/payment 200",
      "pao GET /pao/v1/operations/{op} 200",
    ]);
    expect(routes2).toEqual([
      "pao GET /pao/v1/mandates/{intent}/verify 200",
      "pao GET /pao/v1/mandates/{cart}/verify 200",
      "pao GET /pao/v1/merchants/{merchant}/readiness 200",
      "pao POST /pao/v1/credentials 201",
      "merchants POST /v1/shops/{shop}/orders/{order}/payment 200",
      "pao GET /pao/v1/confirmations/{cnf} 200",
      "pao GET /pao/v1/confirmations/{cnf} 200",
    ]);
    expect(routes3).toEqual(["pao POST /pao/v1/mandates/{cart}/relinquish 200"]);

    // операции: одна одобренная (доля 1), по доле 2 одобрения нет; реквизиты — по одному на долю нарушителя
    const count = (route: string) => r.c.calls().filter((x) => `${x.target} ${x.route.split("?")[0]}` === route).length;
    expect(count("pao POST /pao/v1/credentials")).toBe(2);
    expect(r.c.journal.entries.filter((e) => e.kind === "operation.status").map((e) => e.detail)).toEqual(["AUTHORIZED"]);
  });
});
