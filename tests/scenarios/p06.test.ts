// П06 (профиль contour): мандат без обязательного реквизита. Т2; A7 п. 2.2 — отсутствие любого реквизита делает
// мандат недействительным. Агент такой проект не отправляет: отказ до обращения, мандат не создан
// (вместо ответа 400 мока /v1 — STATUS, расхождение № 24; после PS-06 — проверка, что стенд Платформы
// на такой запрос отвечает 400).
import { afterEach, describe, expect, it } from "vitest";
import { MandateRefused } from "../../src/agent/mandates/index.js";
import type { MandateDraft } from "../../src/shared/domain.js";
import { Consents, INTENT } from "../support/consents.js";
import { coreOn } from "../support/core.js";
import { PaoStand, CONFIGURATION } from "../support/pao-stand.js";

let stand: PaoStand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

describe("П06 — мандат без обязательного реквизита", () => {
  it.each<[string, Partial<MandateDraft>]>([
    ["пустой merchant_scope", { merchantScope: [] }],
    ["пустой valid_to", { validTo: "" }],
    ["merchant_scope отсутствует", { merchantScope: undefined as unknown as string[] }],
    ["valid_to отсутствует", { validTo: undefined as unknown as string }],
  ])("%s — отказ до обращения, мандат не создан", async (_, patch) => {
    const consents: Consents = new Consents(() => s.clock);
    const s = new PaoStand({ handlers: consents.handlers() });
    stand = s;
    const { core } = await coreOn(s);
    await core.start();
    const err = (await core.mandates.request({ ...INTENT, ...patch }, { idempotencyKey: "idem-p06" }).catch((e: unknown) => e)) as MandateRefused;
    expect(err).toBeInstanceOf(MandateRefused);
    expect(err.reason).toBe("DRAFT_INVALID");
    expect(consents.mandates.size).toBe(0);
    expect(s.log()).toEqual([CONFIGURATION, { op: "GET /pao/v1/agent", status: 200 }]);
    expect(s.stub.violations).toEqual([]);
  });
});
