// Конвейер стадии 2 с настоящим адаптером витрин на подменённом fetch (Р46 п. 2): сбой списка витрин —
// STOPPED SHOP_LIST_UNAVAILABLE; запись списка без id по маске — магазин недоступен без id в журнале и выдаче (Р42 К2 № 8);
// общий срок поиска при допустимой конфигурации — SHOP_SEARCH_DEADLINE в выдаче конвейера и журнале (Р44 К2 № 8).
import { newEd25519Signer } from "@kuzin4u/agentic-core";
import { afterEach, describe, expect, it } from "vitest";
import { ShopsAdapter } from "../../src/agent/adapters/shops/index.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { ShopFailure } from "../../src/agent/ports/index.js";
import { SignerStopped } from "../../src/agent/signer/index.js";
import { loadParams, parseParams } from "../../src/shared/config.js";
import { PaoStand } from "../support/pao-stand.js";
import { purchaseOn, signedIntent, stages } from "../support/purchase.js";

const { signer } = newEd25519Signer("kid_test");
let stand: PaoStand | undefined;
afterEach(async () => {
  expect(stand?.stub.violations ?? []).toEqual([]);
  await stand?.close();
  stand = undefined;
});

/** Факты магазина в записи списка (Р54 п. 4). */
const FACTS = {
  inn: "7705123452",
  mcc: "5462",
  payment_methods: ["card"],
  delivery_regions: ["RU-MOW"],
  returns: { days: 0, text: "Продовольственные товары надлежащего качества возврату не подлежат" },
};
const shop = (id: string) => ({ id, merchant_id: `MER-${id}`, zone: "CONTOUR", readiness_mark: true, ...FACTS });
const EMPTY = { status: 200, body: { shop: {}, items: [] } };

type Answer = { status: number; body?: unknown } | "hang" | { delayMs: number; status: number; body?: unknown };

/** Витрина-заглушка: ответ по пути; `seen` — пути ушедших обращений. */
function vitrine(routes: Record<string, Answer>) {
  const seen: string[] = [];
  const f: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    seen.push(path);
    const a = routes[`GET ${path}`] ?? { status: 404, body: { code: "SHOP_NOT_FOUND" } };
    const abort = () => new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    if (a === "hang") return abort();
    if ("delayMs" in a) await Promise.race([new Promise((r) => setTimeout(r, a.delayMs)), abort()]);
    return new Response(a.body === undefined ? "" : JSON.stringify(a.body), { status: a.status });
  };
  return { f, seen };
}

async function setup(routes: Record<string, Answer>, over: Partial<ReturnType<typeof loadParams>> = {}, sign?: () => void) {
  // допустимая конфигурация: та же схема, что при запуске (shop_search_deadline_ms ≥ shop_request_timeout_ms)
  const params = parseParams({ ...loadParams(), ...over });
  const v = vitrine(routes);
  const shopLog = new MemoryJournal();
  const offers = new ShopsAdapter({
    baseUrl: "http://shops.test",
    agentCode: "nspk:agent:test:v1",
    signing: { sign: (req) => (sign?.(), { ...req, headers: { ...req.headers, signature: "sig", "signature-input": "sig=()" } }) },
    // знак готовности по ПАО (Р53): здесь всегда ACTIVE — стадия 2 проверяется на витринах; знак — shops-adapter.test
    platform: {
      baseUrl: "http://pao.test",
      signing: { current: () => signer, protective: () => signer, keyRevoked: () => signer, stop: () => {}, suspend: () => {} },
      fetch: async (input) => {
        const id = /\/pao\/v1\/merchants\/([^/]+)\/readiness$/.exec(new URL(String(input)).pathname)?.[1];
        return new Response(JSON.stringify({ merchant_id: id, status: "ACTIVE", since: null }), { status: 200 });
      },
    },
    params,
    journal: shopLog,
    fetch: v.f,
  });
  const r = await purchaseOn({ offers, params: over }, (s) => (stand = s));
  await signedIntent(r);
  // обращения к контуру с начала поиска: ровно verify INTENT перед витринами (ревью reviewer К2 № 3)
  const from = r.stand.stub.calls.length;
  const pao = () => r.stand.stub.calls.slice(from).map((c) => c.op);
  return { r, seen: v.seen, shopLog, pao };
}

describe("стадия 2 с адаптером витрин (Р46 п. 2)", () => {
  it("список витрин не получен (503, не по схеме, нет ответа) — STOPPED SHOP_LIST_UNAVAILABLE, к каталогам не обращаются", async () => {
    // сроки 200 / 300 мс — допустимая конфигурация (parseParams); код витрины — неповторяемый: отказ, а не срок поиска
    // (повторяемый 503 при сроке меньше shop_retry_default_ms не повторился бы из-за срока — ревью reviewer К2 № 4, 8)
    const cases: [Answer, string][] = [
      [{ status: 403, body: { code: "AGENT_UNIDENTIFIED" } }, "refused"],
      [{ status: 200, body: { shops: "нет" } }, "refused"],
      ["hang", "unknown"],
    ];
    for (const [answer, result] of cases) {
      const { r, seen, shopLog, pao } = await setup({ "GET /v1/shops": answer }, { shop_request_timeout_ms: 200, shop_search_deadline_ms: 300 });
      const err = await r.purchase.search().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ShopFailure);
      expect((err as ShopFailure).code).toBe("SHOP_LIST_UNAVAILABLE");
      expect(r.purchase.state).toBe("STOPPED");
      expect(r.purchase.reason).toBe("SHOP_LIST_UNAVAILABLE");
      expect(stages(r).at(-1)).toBe("STOPPED:SHOP_LIST_UNAVAILABLE");
      expect(seen).toEqual(["/v1/shops"]);
      expect(shopLog.entries.filter((e) => e.kind === "shop.call").map((e) => [e.method, e.result])).toEqual([["GET /v1/shops", result]]);
      expect(pao()).toEqual(["GET /pao/v1/mandates/{id}/verify"]);
      // стенды случаев внутри цикла — с той же проверкой, что afterEach (ревью reviewer К2 № 2)
      expect(stand?.stub.violations ?? []).toEqual([]);
      await stand?.close();
      stand = undefined;
    }
  });

  it("повтор по Т4 сделан (503 повторяемый, допустимый срок из конфигурации) и второй ответ — отказ: SHOP_LIST_UNAVAILABLE, два обращения, сверх Т4 нет (ревью reviewer К2 № 4)", async () => {
    const { r, seen, shopLog, pao } = await setup({ "GET /v1/shops": { status: 503, body: { code: "UPSTREAM_UNAVAILABLE" } } }, { shop_retry_default_ms: 1 });
    await expect(r.purchase.search()).rejects.toMatchObject({ name: "ShopFailure", code: "SHOP_LIST_UNAVAILABLE" });
    expect(r.purchase.reason).toBe("SHOP_LIST_UNAVAILABLE");
    expect(seen).toEqual(["/v1/shops", "/v1/shops"]);
    expect(shopLog.entries.filter((e) => e.kind === "shop.call").map((e) => [e.method, e.attempt, e.result])).toEqual([
      ["GET /v1/shops", 1, "refused"],
      ["GET /v1/shops", 2, "refused"],
    ]);
    expect(pao()).toEqual(["GET /pao/v1/mandates/{id}/verify"]);
  });

  it("подпись остановлена при обращении за списком — исходное исключение наружу, STOPPED UNKNOWN, а не SHOP_LIST_UNAVAILABLE (инвариант 4; ревью reviewer К2 № 5)", async () => {
    const stopped = new SignerStopped("NO_ACTIVE_KEY");
    let armed = false;
    const { r, seen } = await setup({ "GET /v1/shops": { status: 200, body: { shops: [] } } }, {}, () => {
      if (armed) throw stopped;
    });
    armed = true;
    await expect(r.purchase.search()).rejects.toBe(stopped);
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("UNKNOWN");
    expect(seen).toEqual([]);
  });

  it("запись списка без id по маске — магазин недоступен: shop.unavailable без merchant, zones.unavailable без shopId; поиск идёт дальше (Р42 К2 № 8)", async () => {
    const { r, seen, pao } = await setup({ "GET /v1/shops": { status: 200, body: { shops: [{ id: "../x", merchant_id: "MER-X" }, { id: "S1", merchant_id: "../m" }, shop("S2")] } }, "GET /v1/shops/S2/catalog": EMPTY });
    const zones = await r.purchase.search();
    expect(r.purchase.state).toBe("OFFERS");
    expect(zones.unavailable).toEqual([{ cause: { detail: "BAD_RESPONSE" } }, { cause: { detail: "BAD_RESPONSE" } }]);
    const gone = r.tail().filter((e) => e.kind === "shop.unavailable");
    expect(gone).toHaveLength(2);
    for (const e of gone) {
      expect(e).not.toHaveProperty("merchant");
      expect(e).toMatchObject({ detail: "BAD_RESPONSE" });
    }
    expect(JSON.stringify(r.tail())).not.toContain("../");
    expect(seen).toEqual(["/v1/shops", "/v1/shops/S2/catalog"]);
    expect(pao()).toEqual(["GET /pao/v1/mandates/{id}/verify"]);
  });

  it("срок поиска при допустимой конфигурации: обращение прервано, следующей витрине не обращаются — SHOP_SEARCH_DEADLINE в выдаче и журнале (Р44 К2 № 8)", async () => {
    // тайм-аут обращения 2 с, срок поиска 3 с (≥ тайм-аута — схема запуска); S1 отвечает за 1,5 с — S2 прерывается сроком
    // (≈ 3 с), а не своим тайм-аутом (≈ 3,5 с); к S3 срок истёк до обращения
    const { r, seen, pao } = await setup(
      { "GET /v1/shops": { status: 200, body: { shops: [shop("S1"), shop("S2"), shop("S3")] } }, "GET /v1/shops/S1/catalog": { delayMs: 1500, ...EMPTY }, "GET /v1/shops/S2/catalog": "hang", "GET /v1/shops/S3/catalog": EMPTY },
      { shop_request_timeout_ms: 2000, shop_search_deadline_ms: 3000 },
    );
    const zones = await r.purchase.search();
    expect(r.purchase.state).toBe("OFFERS");
    expect(zones.unavailable).toEqual([
      { shopId: "S2", merchantId: "MER-S2", cause: { reason: "SHOP_SEARCH_DEADLINE" } },
      { shopId: "S3", merchantId: "MER-S3", cause: { reason: "SHOP_SEARCH_DEADLINE" } },
    ]);
    expect(r.tail().filter((e) => e.kind === "shop.unavailable").map((e) => [e.merchant, e.reason])).toEqual([
      ["MER-S2", "SHOP_SEARCH_DEADLINE"],
      ["MER-S3", "SHOP_SEARCH_DEADLINE"],
    ]);
    expect(seen).toEqual(["/v1/shops", "/v1/shops/S1/catalog", "/v1/shops/S2/catalog"]);
    expect(pao()).toEqual(["GET /pao/v1/mandates/{id}/verify"]);
  }, 10_000);
});
