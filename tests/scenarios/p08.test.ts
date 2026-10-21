// П08 (профиль contour): витрина отказывает неопознанным. Т4; A2 п. 5.1, A5 п. 2; Р42 п. 1, 4. На стенде Платформы и
// витринах эмулятора: каждое обращение адаптера подписано действующим ключом агента; витрина REJECTS_UNIDENTIFIED
// обслуживает опознанного агента. Отказ витрины — магазин недоступен, без обходов: ни запроса без подписи, ни другим ключом
// или кодом агента, ни повтора не повторяемого кода; агент не останавливается.
// Отказ — настоящий ответ эмулятора: подпись ключом не из реестра стенда → код из MERCHANT_ERROR_CODES (ревью К1 Б2).
// ЭМУЛЯЦИЯ СВЕРХ ЭМУЛЯТОРА (ответ подменён в fetch адаптера, остальные обращения — настоящие) — только то, чего эмулятор не
// выдаёт: код вне перечня (MERCHANT_CODE_UNKNOWN) у одной витрины и 503 на список витрин (`GET /v1/shops` у эмулятора
// без отказов: опознания и лимита на нём нет — STATUS «Открыто», к платформе).
import { afterEach, describe, expect, it } from "vitest";
import { newEd25519Signer, signRequest } from "@kuzin4u/agentic-core";
import { MERCHANT_ERROR_CODES, MERCHANT_FIXTURES } from "agentic-ps-platform/fixtures";
import { shopBy, type Contour } from "../support/contour.js";
import { STAND_TIMEOUT_MS, standPurchase } from "../support/stand-purchase.js";

let c: Contour | undefined;
afterEach(async () => {
  expect(c?.violations() ?? []).toEqual([]);
  await c?.close();
  c = undefined;
});

const STRICT = shopBy("REJECTS_UNIDENTIFIED");
const catalogOf = (id: string) => `/v1/shops/${id}/catalog`;
const CODES = MERCHANT_ERROR_CODES.map((x) => x.code as string);
/** ключ не из каталога ключей реестра — KEY_UNKNOWN эмулятора (STATUS «Передача для AG-04…»: отказы витрины по подписи) */
const KEY_UNKNOWN = MERCHANT_ERROR_CODES.find((x) => x.code === "KEY_UNKNOWN")!;

/** Что ушло в сеть от адаптера; `answer` — подменённый ответ витрины `id` (эмуляция сверх эмулятора). */
function recording(answer?: { path: string; status: number; body: unknown }) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    if (answer && url.endsWith(answer.path)) return new Response(JSON.stringify(answer.body), { status: answer.status });
    return fetch(input, init);
  };
  return { f, seen };
}

describe("П08 — витрина отказывает неопознанным", { timeout: STAND_TIMEOUT_MS }, () => {
  it("REJECTS_UNIDENTIFIED: подписанный запрос агента из реестра проходит; неподписанных обращений нет", async () => {
    const r = await standPurchase();
    c = r.c;
    await r.signedIntent();
    const zones = await r.purchase.search();
    expect(zones.contour.filter((o) => o.shopId === STRICT.id).map((o) => o.sku)).toEqual(STRICT.agent_items.map((i) => i.sku));
    const merchants = r.c.calls().filter((x) => x.target === "merchants");
    // список и каталог каждой витрины — по одному обращению, все подписаны ключом агента из реестра стенда
    expect(merchants.map((x) => `${x.route} ${x.status}`)).toEqual(["GET /v1/shops 200", ...MERCHANT_FIXTURES.map((f) => `GET ${catalogOf(f.id)} 200`)]);
    const kids = r.self.keys.map((k) => k.kid);
    expect(merchants.every((x) => x.kid !== undefined && kids.includes(x.kid) && typeof x.nonce === "string")).toBe(true);
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.unavailable")).toEqual([]);
  });

  it("витрины отказали по-настоящему (ключ не из реестра) — магазины недоступны; по одному подписанному обращению, без обхода; агент работает", async () => {
    const { f, seen } = recording();
    // ключ, которого нет в реестре стенда: витрины не опознают агента — настоящий отказ эмулятора
    const { signer } = newEd25519Signer("kid-not-in-registry");
    const r = await standPurchase({ fetch: f, signing: { sign: (req) => signRequest(req, signer) } });
    c = r.c;
    await r.signedIntent();
    const zones = await r.purchase.search();
    expect(r.purchase.state).toBe("OFFERS");
    expect(r.c.admission()).toBeNull();
    expect([...zones.contour, ...zones.market]).toEqual([]);
    // код отказа — из ответа эмулятора (журнал контура), из закрытого перечня витрин; у каждой витрины свой ответ
    const refusals = r.c.calls().filter((x) => x.target === "merchants" && x.route.endsWith("/catalog"));
    expect(refusals.map((x) => x.route)).toEqual(MERCHANT_FIXTURES.map((m) => `GET ${catalogOf(m.id)}`));
    expect(refusals.map((x) => [x.status, x.code])).toEqual(MERCHANT_FIXTURES.map(() => [KEY_UNKNOWN.http, KEY_UNKNOWN.code]));
    expect(zones.unavailable).toEqual(MERCHANT_FIXTURES.map((m, i) => ({ shopId: m.id, merchantId: m.merchant_id, cause: { detail: refusals[i]!.code } })));
    // по одному обращению к каждой витрине: ни повтора, ни запроса без подписи, ни другого кода агента
    for (const m of MERCHANT_FIXTURES) expect(seen.filter((s) => s.url.endsWith(catalogOf(m.id)))).toHaveLength(1);
    expect(seen.every((s) => typeof s.headers["signature"] === "string" && s.headers["x-agent-code"] === r.c.agentCode)).toBe(true);
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.unavailable").map((e) => e.merchant)).toEqual(MERCHANT_FIXTURES.map((m) => m.merchant_id));
    expect(r.c.journal.entries.filter((e) => e.kind === "shop.call" && e.ref === STRICT.id).map((e) => [e.attempt, e.result])).toEqual([[1, "refused"]]);
  });

  it("код вне перечня (эмуляция сверх эмулятора) — магазин недоступен (MERCHANT_CODE_UNKNOWN), сам код не в журнале; агент работает", async () => {
    const unknown = "PLEASE_RETRY_WITHOUT_SIGNATURE";
    expect(CODES).not.toContain(unknown);
    const { f } = recording({ path: catalogOf(STRICT.id), status: 403, body: { code: unknown } });
    const r = await standPurchase({ fetch: f });
    c = r.c;
    await r.signedIntent();
    const zones = await r.purchase.search();
    expect(r.purchase.state).toBe("OFFERS");
    expect(r.c.admission()).toBeNull();
    expect(zones.unavailable).toEqual([{ shopId: STRICT.id, merchantId: STRICT.merchant_id, cause: { reason: "MERCHANT_CODE_UNKNOWN" } }]);
    expect(zones.contour.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.c.journal.entries)).not.toContain(unknown);
  });

  it("списка витрин нет целиком (эмуляция сверх эмулятора: 503 на список) — отказ стадии 2, STOPPED сделки; к каталогам ни одного обращения (ревью К1 № 11)", async () => {
    const { f, seen } = recording({ path: "/v1/shops", status: 503, body: { code: "UPSTREAM_UNAVAILABLE" } });
    const r = await standPurchase({ fetch: f });
    c = r.c;
    await r.signedIntent();
    await expect(r.purchase.search()).rejects.toThrow();
    expect(r.purchase.state).toBe("STOPPED");
    expect(r.purchase.reason).toBe("UNKNOWN");
    expect(r.c.admission()).toBeNull();
    // один повтор списка по повторяемому коду (Р42 п. 4), каталогов нет
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual(["/v1/shops", "/v1/shops"]);
  });
});
