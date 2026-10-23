// П23 (профиль contour, PaoStub): недоступность Платформы дольше registry_cache_ttl_sec. Т14, A2, A3 п. 4.5; инвариант 4;
// Р50 п. 2–3 и дополнение 1: лента не читается подряд не меньше registry_cache_ttl_sec — подпись приостановлена
// (EVENTS_UNAVAILABLE), шаг покупки отказан стадией 0 без обращения к Платформе; снятие — recheck(), серия не сброшена.
import { afterEach, describe, expect, it } from "vitest";
import { loadParams } from "../../src/shared/config.js";
import { PlatformFailure } from "../../src/shared/domain.js";
import { INTENT } from "../support/consents.js";
import { CREDENTIALS, coreOn } from "../support/core.js";
import { PaoStand } from "../support/pao-stand.js";
import { SHOP } from "../support/purchase.js";
import { feedOffers, liveOffers, payments, shopOrders } from "../support/shop.js";

let stand: PaoStand;
afterEach(() => stand?.close());

const { registry_cache_ttl_sec: TTL_SEC, event_poll_interval_ms: POLL } = loadParams();
const EVENTS = "GET /pao/v1/events" as const;

describe("П23 — недоступность Платформы дольше registry_cache_ttl_sec", () => {
  it("503 UPSTREAM_UNAVAILABLE дольше срока — агент приостановлен, покупка не начинается и не обращается к Платформе", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    const { core, journal } = await coreOn(stand);
    await core.start();
    stand.stub.fail(EVENTS, { code: "UPSTREAM_UNAVAILABLE" }, 1000);
    const advance = (ms: number) => (stand.clock = new Date(stand.clock.getTime() + ms));

    await expect(core.events.signal()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    advance(TTL_SEC * 1000 - 1);
    await expect(core.events.signal()).rejects.toBeInstanceOf(PlatformFailure);
    expect(journal.entries.filter((e) => e.kind === "signing.suspended")).toEqual([]);
    advance(1);
    await expect(core.events.signal()).rejects.toBeInstanceOf(PlatformFailure);
    expect(journal.entries.filter((e) => e.kind === "signing.suspended").map((e) => e.reason)).toEqual(["EVENTS_UNAVAILABLE"]);
    expect(journal.entries.filter((e) => e.kind === "events.unavailable").map((e) => [e.reason, e.detail])).toEqual([["EVENTS_UNAVAILABLE", "UPSTREAM_UNAVAILABLE"]]);

    // любое действие: покупка отказана стадией 0, к Платформе обращений нет (не действует по устаревшему состоянию)
    const before = stand.stub.calls.length;
    const purchase = core.purchase({ offers: feedOffers(SHOP), live: liveOffers(SHOP, () => stand.clock), shop: shopOrders(SHOP), payment: payments() });
    await expect(purchase.intent(INTENT, { idempotencyKey: "idem-p23" })).rejects.toMatchObject({ code: "EVENTS_UNAVAILABLE" });
    expect(purchase.state).toBe("STOPPED");
    expect(stand.stub.calls.length).toBe(before);

    // recheck() снимает приостановку; лента всё ещё недоступна — первое неудачное чтение приостанавливает снова
    await core.recheck();
    advance(POLL);
    await expect(core.events.signal()).rejects.toBeInstanceOf(PlatformFailure);
    expect(journal.entries.filter((e) => e.kind === "signing.suspended").map((e) => e.reason)).toEqual(["EVENTS_UNAVAILABLE", "EVENTS_UNAVAILABLE"]);
    expect(stand.stub.violations).toEqual([]);
  });
});
