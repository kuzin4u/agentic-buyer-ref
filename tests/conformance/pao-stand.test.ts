// Цель набора соответствия на стенде Платформы v0.34.0 (AG-20 ч. 2, К1.4; Р67 п. 1, нюансы К1.2, К1.3): адаптер ПАО —
// `createContour(...).platform` (поверх связки ключей, как в контуре; сборку compose набор не проверяет — остаточный
// риск Р67). Условия выдачи реквизита, сверку агента мандата и схему ответов проверяет настоящий код Платформы, а не
// обработчик теста. Тестовая сторона: подпись мандата человеком — эмулятор эмитента стенда (`issuer.sign`); чужой
// мандат — второй агент фикстур (`secondAgent`, `nspk:agent:buyref-02:v1`); журнал обращений — `stand.calls()` (по сети,
// без участников стенда и второго агента); образцы платёжных данных — ответы стенда на выдачу; подмена ответа — `paoFetch`
// контура (pao-faults.ts). Продавец — витрина NORMAL из фикстур (справочник продавцов стенда с MCC), принципал — `pr_1`.
import { expect } from "vitest";
import type { Mandate, MandateDraft } from "../../src/shared/domain.js";
import { INTENT } from "../support/consents.js";
import { createContour, shopBy } from "../support/contour.js";
import { faultyFetch } from "./pao-faults.js";
import { describeConformance, type FaultMethod, type PlatformCall } from "./suite.js";

/** Стенд в процессе теста под параллельной нагрузкой прогона медленнее 5 с по умолчанию (как в tests/contract/*-stand). */
const STAND_TIMEOUT_MS = 20_000;
const MERCHANT = shopBy("NORMAL").merchant_id;

describeConformance({
  name: "адаптер ПАО на стенде Платформы v0.34.0",
  timeoutMs: STAND_TIMEOUT_MS,
  async open() {
    const faults = faultyFetch();
    const c = await createContour({ pao: "stand", paoFetch: faults.fetch, secondAgent: true });
    try {
      await c.start();
      await c.foreign!.start();
    } catch (e) {
      await c.close();
      throw e;
    }
    const stand = c.stand!;
    // ключ один (ротации в наборе нет): kid своего агента — после допуска
    const kid = c.paoAccess!.signing.current().kid;
    return {
      platform: c.platform,
      foreign: c.foreign!.platform,
      agentCode: c.agentCode,
      intent: (): MandateDraft => ({ ...INTENT, merchantScope: [MERCHANT] }),
      cart: (parent: Mandate): MandateDraft => {
        const price = { amount: 9900, currency: parent.amountLimit.currency };
        return {
          ...INTENT,
          kind: "CART",
          parentId: parent.id,
          amountLimit: price,
          merchantScope: [MERCHANT],
          cart: { merchantId: MERCHANT, lines: [{ sku: "sku_conformance_1", qty: 1, price }], total: price },
        };
      },
      signMandate: async (id: string) => {
        const r = await stand.issuer.sign(id);
        if (r.statusCode !== 200) throw new Error(`эмулятор эмитента не подписал мандат ${id}: ${r.statusCode}`);
      },
      issuedSecrets: () => c.issuedSecrets(),
      // по сети — клиент агента; участники стенда и тестовая поддержка — inject; второй агент — свой kid
      calls: (): PlatformCall[] =>
        stand
          .calls()
          .filter((x) => x.source === "network" && x.path.startsWith("/pao/") && (x.kid === undefined || x.kid === kid))
          .map((x) => ({
            mutating: x.method !== "GET",
            status: x.status,
            ...(x.code !== undefined && { code: x.code }),
            signed: x.kid === kid,
            ...(x.idempotency_key !== undefined && { idempotencyKey: x.idempotency_key }),
            ...(x.nonce !== undefined && { nonce: x.nonce }),
          })),
      loseNextResponse: (m: FaultMethod) => faults.set(m, "lose"),
      garbleNextResponse: (m: FaultMethod) => faults.set(m, "garble"),
      journalText: () => JSON.stringify(c.journal.entries),
      // агент не обращается к путям участников (ADP, ПИ-3) — иначе нарушение контура; контур закрывается и при красной сверке
      close: async () => {
        try {
          expect(c.violations(), "обращения агента к путям участников").toEqual([]);
        } finally {
          await c.close();
        }
      },
    };
  },
});
