// Подмена транспорта клиента ПАО для целей набора соответствия (AG-20, Р67 нюансы К1.3): тестовая сторона, не набор —
// suite.ts этот модуль не импортирует. Обращение доходит до платформы (PaoStub или стенд), ответ теряется после обработки
// или заменяется 200 с телом не по схеме. Общий для целей на PaoStub и на стенде (К1.4, AG-20 ч. 2).
import { INTENT } from "../support/consents.js";
import type { FaultMethod } from "./suite.js";

/** Метод порта → обращение ПАО, ответ на которое подменяется, и тело «не по схеме»: по форме как настоящее, одно
 *  значение вне перечня ПАО — разбор полей его пропустил бы, отвергает только проверка схемы. */
export const PAO_FAULT_OPS: Readonly<Record<FaultMethod, readonly [string, RegExp, () => unknown]>> = {
  requestMandate: ["POST", /^\/pao\/v1\/mandates$/, () => ({})],
  issueCredential: ["POST", /^\/pao\/v1\/credentials$/, () => ({})],
  verifyMandate: [
    "GET",
    /^\/pao\/v1\/mandates\/[^/]+\/verify$/,
    () => ({ outcome: "PROBABLY_CONFIRMED", amount_left: 100, valid_to: INTENT.validTo, as_of: new Date().toISOString() }),
  ],
};

/** Транспорт с одноразовыми подменами по методу порта; `set` — подменить следующий ответ. */
export function faultyFetch(): { fetch: typeof fetch; set(method: FaultMethod, fault: "lose" | "garble"): void } {
  const faults = new Map<FaultMethod, "lose" | "garble">();
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const hit = [...faults.keys()].find((k) => PAO_FAULT_OPS[k][0] === method && PAO_FAULT_OPS[k][1].test(url.pathname));
    const fault = hit === undefined ? undefined : faults.get(hit);
    if (hit !== undefined) faults.delete(hit);
    if (fault === "garble") return new Response(JSON.stringify(PAO_FAULT_OPS[hit!][2]()), { status: 200, headers: { "content-type": "application/json" } });
    const r = await fetch(input, init);
    if (fault === "lose") throw new TypeError("fetch failed");
    return r;
  };
  return { fetch: transport, set: (m, f) => void faults.set(m, f) };
}
