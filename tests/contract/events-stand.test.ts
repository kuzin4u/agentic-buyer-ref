// Лента и подписка адаптера ПАО против стенда Платформы v0.11.0 (Р34 п. 1, 7, 8, 10; РП39, РП40; Р41 п. 2). Курсор — event_id
// последнего события; чужой курсор — 400 REQUEST_INVALID; приостановленному — 403 AGENT_SUSPENDED и приостановка (Р60 п. 1).
// Адрес подписки — хост из event_subscription_allow_hosts стенда, без литерала.
import { afterEach, describe, expect, it } from "vitest";
import { SignerSuspended } from "../../src/agent/signer/index.js";
import { PLATFORM_EVENT_TYPES, PlatformFailure } from "../../src/shared/domain.js";
import { INTENT } from "../support/consents.js";
import { createContour, type Contour } from "../support/contour.js";


/** Стенд в процессе теста под параллельной нагрузкой прогона бывает медленнее 5 с по умолчанию (нюанс К2.3). */
const STAND_TIMEOUT_MS = 20_000;
let c: Contour | undefined;
afterEach(async () => {
  await c?.close();
  c = undefined;
});

async function started() {
  c = await createContour({ pao: "stand" });
  await c.start();
  const stand = c.stand;
  if (!stand) throw new Error("нет стенда");
  return { c, stand };
}

const key = (k: string) => ({ idempotencyKey: `idem-${k}` });

describe("лента событий на стенде v0.11.0 (Р34 п. 1, РП39 п. 7)", { timeout: STAND_TIMEOUT_MS }, () => {
  it("без курсора — с начала; подпись человека даёт mandate.signed; после курсора — пусто", async () => {
    const { c, stand } = await started();
    expect(await c.platform.listEvents(null)).toEqual([]);
    const m = await c.platform.requestMandate(INTENT, key("m1"));
    expect((await stand.issuer.sign(m.id)).statusCode).toBe(200);

    const feed = await c.platform.listEvents(null);
    expect(feed).toHaveLength(1);
    const [item] = feed;
    if (item?.kind !== "event") throw new Error("ожидалось событие");
    expect(item.event).toMatchObject({ type: "mandate.signed", mandateId: m.id, opRef: null });
    // курсор — event_id последнего события; повторное чтение даёт то же событие с тем же event_id
    expect(await c.platform.listEvents(item.event.eventId)).toEqual([]);
    expect(await c.platform.listEvents(null)).toEqual(feed);
  });

  it("чужой или неизвестный курсор — 400 REQUEST_INVALID, без повтора (РП39 п. 7, доп. п. 4)", async () => {
    const { c } = await started();
    for (const after of ["evt_00000000-0000-8000-8000-000000000000", "not-a-cursor"]) {
      const err = await c.platform.listEvents(after).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlatformFailure);
      expect(err).toMatchObject({ code: "REQUEST_INVALID", httpStatus: 400 });
    }
    expect(c.calls().filter((x) => x.route.startsWith("GET /pao/v1/events"))).toHaveLength(2);
  });

  it("приостановленный агент: лента — 403 AGENT_SUSPENDED, подпись приостановлена до сверки (Р34 п. 7, РП40 п. 6, Р60 п. 1)", async () => {
    const { c, stand } = await started();
    await stand.registry.changeStatus(c.agentCode, { to: "SUSPENDED", ground: "INCIDENT_EVASION" });
    const err = await c.platform.listEvents(null).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "AGENT_SUSPENDED", httpStatus: 403 });
    await expect(c.platform.listEvents(null)).rejects.toBeInstanceOf(SignerSuspended);
    expect(c.admission()).toBe("AGENT_SUSPENDED");
  });
});

describe("подписка на стенде v0.11.0 (Р34 п. 8, РП40)", { timeout: STAND_TIMEOUT_MS }, () => {
  it("адрес из списка стенда принят; push доставлен эмулятору получателя с x-event-id", async () => {
    const { c, stand } = await started();
    const host = stand.params.event_subscription_allow_hosts[0];
    const url = `https://${host}/pao/events`;
    await c.platform.subscribe(url, PLATFORM_EVENT_TYPES, key("s1"));
    // повтор старта с той же подпиской и тем же ключом — прежний ответ, два обращения без повторов (инвариант 9)
    await c.platform.subscribe(url, PLATFORM_EVENT_TYPES, key("s1"));
    expect(c.calls().filter((x) => x.route === "PUT /pao/v1/subscription").map((x) => [x.status, x.idempotencyKey])).toEqual([
      [200, "idem-s1"],
      [200, "idem-s1"],
    ]);

    const m = await c.platform.requestMandate(INTENT, key("m1"));
    await stand.issuer.sign(m.id);
    const [signed] = await c.platform.listEvents(null);
    if (signed?.kind !== "event") throw new Error("ожидалось событие");
    expect(await stand.deliverEvents()).toBe(1);
    const [got] = stand.agentReceiver.received;
    expect(got).toMatchObject({ url, status: 200, event_id: signed.event.eventId, header_event_id: signed.event.eventId });
    expect(got?.event).toMatchObject({ event_id: signed.event.eventId, type: "mandate.signed", data: { mandate_id: m.id } });
  });

  it("хост не из списка — 400 REQUEST_INVALID: push нет, лента остаётся (РП40 п. 2)", async () => {
    const { c, stand } = await started();
    expect(stand.params.event_subscription_allow_hosts).not.toContain("agent.example.invalid");
    const err = await c.platform.subscribe("https://agent.example.invalid/pao/events", PLATFORM_EVENT_TYPES, key("s2")).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "REQUEST_INVALID", httpStatus: 400 });
    expect(await c.platform.listEvents(null)).toEqual([]);
  });
});
