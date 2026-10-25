// П24 (профиль contour, стенд Платформы): повтор операции без ключа идемпотентности. A1, Т10; инварианты 8, 9; Р56 п. 1.
// Первая выдача по CART успешна и авторизована. Повтор — тот же POST /pao/v1/credentials (то же тело, подпись агента) без
// Idempotency-Key: 400 IDEMPOTENCY_REQUIRED до захвата ключа, второго реквизита нет, остаток по verify прежний. Клиент
// ПАО агента изменяющий запрос без ключа не отправляет (AGENT_REQUEST_DEFECT); обращение без ключа — только тестовая
// поддержка (tests/support/pao-unkeyed.ts, решение владельца к КТ1). ПОДМЕНА ДО PS-11 (`adpUntilPs11`).
import { afterEach, describe, expect, it } from "vitest";
import { credentialDraftToPao } from "../../src/agent/adapters/pao/map.js";
import type { CredentialDraft } from "../../src/shared/domain.js";
import { INTENT, RUB } from "../support/consents.js";
import { shopBy, type Contour } from "../support/contour.js";
import { unkeyedPost } from "../support/pao-unkeyed.js";
import { one } from "../support/purchase.js";
import { STAND_TIMEOUT_MS, adpDecision, processing, standPurchase } from "../support/stand-purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  await c?.close();
  c = undefined;
});

const NORMAL = shopBy("NORMAL");
const CREDENTIALS = "POST /pao/v1/credentials";

describe("П24 — повтор операции без ключа идемпотентности", { timeout: STAND_TIMEOUT_MS * 2 }, () => {
  it("после успешной выдачи и авторизации тот же запрос без Idempotency-Key — 400 IDEMPOTENCY_REQUIRED; второго реквизита нет, остаток прежний; клиент агента без ключа не отправляет", async () => {
    let draft: CredentialDraft | undefined;
    const r = await standPurchase({
      contourPayment: true,
      adpUntilPs11: true,
      issue: (real) => (d, m) => {
        draft = d;
        return real(d, m);
      },
    });
    c = r.c;
    const intent = await r.purchase.intent({ ...INTENT, merchantScope: [NORMAL.merchant_id] }, { idempotencyKey: "idem-intent-p24" });
    await r.signWhileWaiting(intent.id, () => r.purchase.awaitIntent());
    const offer = (await r.purchase.search()).contour.find((o) => o.shopId === NORMAL.id)!;
    const cart = await r.purchase.cart(one(offer, 1), { idempotencyKey: "idem-cart-p24" });
    await r.signWhileWaiting(cart.id, () => r.purchase.awaitCart());
    await r.purchase.placeOrder({ idempotencyKey: "idem-order-p24" });
    const authorizing = r.purchase.authorize({ idempotencyKey: "idem-pay-p24" });
    const d = await adpDecision(r.c);
    await processing(r.c, { op_ref: d.op_ref, msg_type: "ISSUER_RESPONSE", issuer_approved: true });
    expect(await authorizing).toMatchObject({ status: "AUTHORIZED", indicator: { mandateId: cart.id } });
    expect(draft).toMatchObject({ mandate: { id: cart.id } });

    const total = cart.cart!.total;
    const leftBefore = [await r.c.platform.verifyMandate({ id: cart.id, currency: "RUB" }), await r.c.platform.verifyMandate({ id: intent.id, currency: "RUB" })].map((v) => v.amountLeft);
    expect(leftBefore).toEqual([RUB(0), RUB(INTENT.amountLimit.amount - total.amount)]);
    const secrets = r.c.issuedSecrets!().length;
    const from = r.c.calls().length;

    // клиент ПАО агента: пустой ключ — дефект запроса агента, обращение не отправлено
    await expect(r.c.platform.issuePaymentPackage(draft!, { idempotencyKey: "" })).rejects.toMatchObject({ code: "AGENT_REQUEST_DEFECT" });
    expect(r.c.calls().slice(from)).toEqual([]);

    // повтор той же операции без ключа — Платформа отказывает до захвата ключа (РП30 п. 3)
    const res = await unkeyedPost(r.c, "/pao/v1/credentials", credentialDraftToPao(draft!, new Set(["RUB"])));
    expect(res).toMatchObject({ status: 400, body: { code: "IDEMPOTENCY_REQUIRED" } });
    expect(r.c.calls().slice(from).map((x) => `${x.route} ${x.status} ${x.code ?? ""}`)).toEqual([`${CREDENTIALS} 400 IDEMPOTENCY_REQUIRED`]);

    // двойного списания нет: второго реквизита нет, остаток CART и INTENT по verify прежний
    expect(r.c.issuedSecrets!().length).toBe(secrets);
    expect(r.c.calls().filter((x) => x.route === CREDENTIALS && x.status === 201)).toHaveLength(1);
    const leftAfter = [await r.c.platform.verifyMandate({ id: cart.id, currency: "RUB" }), await r.c.platform.verifyMandate({ id: intent.id, currency: "RUB" })].map((v) => v.amountLeft);
    expect(leftAfter).toEqual(leftBefore);
    expect(r.purchase.state).toBe("SETTLING");
  });
});
