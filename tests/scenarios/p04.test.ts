// П04 (профиль contour, до PS-06/PS-07): мандат намерения с лимитом и сроком. Т2, Т3, Т3а; A7 п. 1–3; A3 п. 3.
// Журнал согласий — обёртка на PaoStub (tests/support/consents.ts); шаг «PUT limits» (К3) в ПАО отсутствует —
// STATUS, расхождение № 23, в сценарии не проверяется. Т3а здесь — только передача признака key_terms_shown
// и отказ без него; показ карточки человеку до подписи проверяет оболочка (AG-09, shell), не ядро.
import { afterEach, describe, expect, it } from "vitest";
import { MandateRefused } from "../../src/agent/mandates/index.js";
import { Consents, INTENT, RUB, feed } from "../support/consents.js";
import { coreOn } from "../support/core.js";
import { PaoStand, CONFIGURATION } from "../support/pao-stand.js";

let stand: PaoStand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

async function setup() {
  const consents: Consents = new Consents(() => s.clock);
  const s = new PaoStand({ handlers: consents.handlers() });
  stand = s;
  const { core, journal } = await coreOn(s);
  await core.start();
  return { core, journal, consents, stand: s };
}

describe("П04 — мандат намерения: хлеб, до 5 000 ₽, 30 дней", () => {
  it("201 PENDING_SIGNATURE; карточка показана до подписи; после подписи остаток — из verify", async () => {
    const { core, journal, consents, stand } = await setup();
    const m = await core.mandates.request(INTENT, { idempotencyKey: "idem-p04" });
    expect(m).toMatchObject({ kind: "INTENT", status: "PENDING_SIGNATURE", amountLimit: RUB(500000), validTo: INTENT.validTo });
    // Т3а: платформа получила признак «ключевые параметры показаны отдельной карточкой»
    expect(consents.mandates.get(m.id)!.key_terms_shown).toBe(true);

    const signed = await core.mandates.awaitSigned(m, feed(consents.sign(m.id)));
    consents.left.set(m.id, 487000); // остаток ведёт платформа (инвариант 6)
    const check = await core.mandates.check(signed);
    expect(check).toMatchObject({ outcome: "CONFIRMED", amountLeft: RUB(487000), validTo: INTENT.validTo });

    // полный журнал обращений: допуск, запрос мандата, сверка подписи, verify — и ничего больше
    expect(stand.log()).toEqual([
      CONFIGURATION,
      { op: "GET /pao/v1/agent", status: 200 },
      { op: "POST /pao/v1/mandates", status: 201 },
      { op: "GET /pao/v1/mandates/{id}", status: 200 },
      { op: "GET /pao/v1/mandates/{id}/verify", status: 200 },
    ]);
    expect(stand.calls("POST /pao/v1/mandates")[0]!.idempotencyKey).toBe("idem-p04");
    expect(stand.stub.violations).toEqual([]);
    expect(JSON.stringify(journal.entries)).not.toMatch(/хлеб|pr_1/); // предмет и принципал в журнал подписи не попадают
  });

  it("карточка не показана — мандат не запрашивается (Т3а)", async () => {
    const { core, stand } = await setup();
    const err = await core.mandates.request({ ...INTENT, keyTermsShown: false }, { idempotencyKey: "idem-p04b" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MandateRefused);
    expect(stand.log()).toEqual([CONFIGURATION, { op: "GET /pao/v1/agent", status: 200 }]);
    expect(stand.stub.violations).toEqual([]);
  });
});
