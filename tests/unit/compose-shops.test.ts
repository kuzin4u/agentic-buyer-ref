// Сборка адаптера витрин в месте сборки (Р42 п. 1; ревью К1 № 3): AgentCore.shops — подпись действующим ключом агента
// (kid из реестра), код агента, журнал ядра; до допуска и после закрытия подписи — исключение, обращений нет.
import { afterEach, describe, expect, it } from "vitest";
import type { ShopProfile } from "../../src/agent/adapters/shops/index.js";
import { SignerStopped } from "../../src/agent/signer/index.js";
import { coreOn } from "../support/core.js";
import { AGENT, PaoStand } from "../support/pao-stand.js";

let stand: PaoStand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

const profile: ShopProfile = {
  shop: { inn: "7705123452", mcc: "5462", paymentMethods: ["card"], deliveryRegions: ["77"], returns: { days: 0, text: "Продовольственные товары надлежащего качества возврату не подлежат" } },
  item: () => null,
};
const KEYID = /;keyid="([^"]+)"/;

/** Витрина-заглушка: пустой список; `seen` — заголовки ушедших обращений. */
function vitrine() {
  const seen: Record<string, string>[] = [];
  const f: typeof fetch = async (_input, init) => {
    seen.push({ ...(init?.headers as Record<string, string>) });
    return new Response(JSON.stringify({ shops: [] }), { status: 200 });
  };
  return { f, seen };
}

describe("AgentCore.shops (Р42 п. 1)", () => {
  it("до start() — подпись закрыта: исключение, обращений нет; после — подписано действующим kid, запись shop.call с кодом агента", async () => {
    const s = new PaoStand();
    stand = s;
    const { core, journal } = await coreOn(s);
    const v = vitrine();
    const shops = core.shops({ baseUrl: "http://shops.test", profile: () => profile, fetch: v.f });
    await expect(shops.search()).rejects.toBeInstanceOf(SignerStopped);
    expect(v.seen).toEqual([]);

    const self = await core.start();
    expect(await shops.search()).toEqual([]);
    expect(v.seen).toHaveLength(1);
    const active = self.keys.filter((k) => k.status === "ACTIVE").map((k) => k.kid);
    expect(active).toContain(KEYID.exec(v.seen[0]!["signature-input"] ?? "")?.[1]);
    expect(v.seen[0]!["x-agent-code"]).toBe(AGENT);
    expect(journal.entries.filter((e) => e.kind === "shop.call").map((e) => [e.agent, e.method, e.result])).toEqual([[AGENT, "GET /v1/shops", "ok"]]);

    core.close();
    await expect(shops.search()).rejects.toBeInstanceOf(SignerStopped);
    expect(v.seen).toHaveLength(1);
  });
});
