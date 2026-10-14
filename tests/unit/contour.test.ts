// Тестовый контур AG-04 (Р26 агента): поднимается в обоих режимах, журнал обращений полный и без тел,
// запросы к витринам подписывает порт подписи агента, контуры изолированы (ревью #23 п. 2–5).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MERCHANT_FIXTURES } from "agentic-ps-platform/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { SignerStopped, listKeys } from "../../src/agent/signer/index.js";
import { createContour, type Contour, type ContourCall } from "../support/contour.js";

const open: Contour[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function contour(pao: "stub" | "stand"): Promise<Contour> {
  const c = await createContour({ pao });
  open.push(c);
  return c;
}

const SELF = "GET /pao/v1/agent";
const NORMAL = (() => {
  const f = MERCHANT_FIXTURES.find((x) => x.behaviour === "NORMAL");
  if (!f) throw new Error("в MERCHANT_FIXTURES нет витрины NORMAL");
  return f;
})();
/** Мандат корзины выдуман: только для проверки обёртки — эмулятор его не сверяет. В сценариях — CART из ПАО (AG-11). */
const CART = "m_cart_1";
const FIELDS = new Set<keyof ContourCall>(["target", "route", "status", "code", "kid", "nonce", "idempotencyKey"]);

describe("режим stub — ПАО на PaoStub, без витрин", () => {
  it("допуск: GET /pao/v1/agent — 200, ACTIVE; журнал обращений — одно обращение с x-nonce", async () => {
    const c = await contour("stub");
    expect(c.merchants).toBeUndefined();
    expect(await c.start()).toMatchObject({ agentCode: c.agentCode, status: "ACTIVE" });
    expect(c.calls()).toEqual([{ target: "pao", route: SELF, status: 200, nonce: expect.any(String), replayed: false }]);
    expect(c.violations()).toEqual([]);
  });
});

describe("режим stand — стенд Платформы и эмулятор продавцов", () => {
  it("допуск на стенде; каталог и заказ подписаны портом агента; журнал — все обращения по порядку", async () => {
    const c = await contour("stand");
    const self = await c.start();
    expect(self).toMatchObject({ agentCode: c.agentCode, status: "ACTIVE", agentClass: "BUYER" });
    const [kid] = listKeys(c.keysDir).map((k) => k.kid);

    const shops = await c.merchants!.request("GET", "/v1/shops", { signed: false });
    expect(shops.status).toBe(200);
    const catalog = await c.merchants!.request("GET", `/v1/shops/${NORMAL.id}/catalog`, { query: "limit=5" });
    expect(catalog.status).toBe(200);
    const order = await c.merchants!.request("POST", `/v1/shops/${NORMAL.id}/orders`, {
      body: { cart_mandate_id: CART, items: [{ sku: NORMAL.items[0]!.sku, qty: 1 }] },
    });
    expect(order).toMatchObject({ status: 201, body: { status: "CREATED", agent_code: c.agentCode } });

    const calls = c.calls();
    expect(calls.map(({ target, route, status }) => ({ target, route, status }))).toEqual([
      { target: "pao", route: SELF, status: 200 },
      { target: "merchants", route: "GET /v1/shops", status: 200 },
      { target: "merchants", route: `GET /v1/shops/${NORMAL.id}/catalog`, status: 200 },
      { target: "merchants", route: `POST /v1/shops/${NORMAL.id}/orders`, status: 201 },
    ]);
    // подпись — ключом агента, x-nonce у каждого подписанного обращения свой
    expect(calls.filter((x) => x.kid !== undefined).map((x) => x.kid)).toEqual([kid, kid, kid]);
    const nonces = calls.flatMap((x) => (x.nonce ? [x.nonce] : []));
    expect(new Set(nonces).size).toBe(3);
    expect(calls[1]).not.toHaveProperty("kid"); // запрос человека — без подписи
  });

  it("до допуска порт подписи закрыт: SignerStopped, обращения к витрине нет", async () => {
    const c = await contour("stand");
    await expect(c.merchants!.request("GET", `/v1/shops/${NORMAL.id}/catalog`)).rejects.toThrow(SignerStopped);
    expect(c.calls()).toEqual([]);
  });

  it("код отказа витрины — в журнале из поля code: заказ без подписи — 403 AGENT_UNIDENTIFIED", async () => {
    const c = await contour("stand");
    const r = await c.merchants!.request("POST", `/v1/shops/${NORMAL.id}/orders`, {
      signed: false,
      body: { cart_mandate_id: CART, items: [{ sku: NORMAL.items[0]!.sku, qty: 1 }] },
    });
    expect(r).toEqual({ status: 403, body: { code: "AGENT_UNIDENTIFIED" } });
    expect(c.calls()).toEqual([
      { target: "merchants", route: `POST /v1/shops/${NORMAL.id}/orders`, status: 403, code: "AGENT_UNIDENTIFIED" },
    ]);
  });
});

describe("изоляция и инвариант 1", () => {
  it("два контура параллельно — разные порты и папки ключей; close() удаляет папку", async () => {
    const [a, b] = await Promise.all([contour("stand"), contour("stand")]);
    expect(a.merchants!.baseUrl).not.toBe(b.merchants!.baseUrl);
    expect(a.keysDir).not.toBe(b.keysDir);
    await Promise.all([a.start(), b.start()]);
    await a.close();
    open.splice(open.indexOf(a), 1);
    expect(existsSync(a.keysDir)).toBe(false);
    expect(existsSync(b.keysDir)).toBe(true);
    expect((await b.merchants!.request("GET", `/v1/shops/${NORMAL.id}/catalog`)).status).toBe(200);
  });

  it("журнал обращений и журнал агента — без тел; сканер реквизитов и ключей — ноль находок (ревью #23 п. 3)", async () => {
    const c = await contour("stand");
    await c.start();
    await c.merchants!.request("GET", `/v1/shops/${NORMAL.id}/catalog`);
    await c.merchants!.request("POST", `/v1/shops/${NORMAL.id}/orders`, {
      body: { cart_mandate_id: CART, items: [{ sku: NORMAL.items[0]!.sku, qty: 2 }] },
    });
    const calls = c.calls();
    for (const x of calls) for (const k of Object.keys(x)) expect(FIELDS.has(k as keyof ContourCall), k).toBe(true);

    const out = mkdtempSync(join(tmpdir(), "buyref-scan-"));
    dirs.push(out);
    writeFileSync(join(out, "calls.jsonl"), calls.map((x) => JSON.stringify(x)).join("\n"));
    writeFileSync(join(out, "journal.jsonl"), c.journal.entries.map((x) => JSON.stringify(x)).join("\n"));
    const scan = spawnSync("python3", [join(process.cwd(), ".claude/hooks/scan_secrets.py"), out], { encoding: "utf8" });
    expect(scan.stdout).toContain("Находок: 0");
    expect(scan.status).toBe(0);
  });
});
