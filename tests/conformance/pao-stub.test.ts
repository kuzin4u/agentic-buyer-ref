// Цель набора соответствия (AG-20, Р67 п. 1): адаптер ПАО напрямую против PaoStub agentic-core (ПАО 1.4.0). Мандаты —
// журнал согласий-обёртка tests/support/consents.ts (подпись человека — `sign`), агент мандата — тот, кто его запросил;
// выдача реквизита — обработчик ниже, условия — как у Платформы (ПАО §4, РП47 п. 4): мандат чужой — 404
// MANDATE_NOT_FOUND, агент отказался — 409 MANDATE_REVOKED (П22).
import { newEd25519Signer } from "@kuzin4u/agentic-core";
import { PaoStub } from "@kuzin4u/agentic-core/pao";
import { Pace, PaoPlatform } from "../../src/agent/adapters/pao/index.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import type { RequestSigning } from "../../src/agent/ports/index.js";
import { loadParams } from "../../src/shared/config.js";
import type { Mandate, MandateDraft } from "../../src/shared/domain.js";
import { Consents, INTENT } from "../support/consents.js";
import { describeConformance } from "./suite.js";

const AGENT = "nspk:agent:buyref-01:v1";
const OTHER = "nspk:agent:buyref-02:v1";
const params = loadParams();

/** Агент с одним ключом: допуск и ротация — не предмет набора (signer-ring, П01–П03). */
function agentKey(kid: string) {
  const { signer, publicKey } = newEd25519Signer(kid);
  const signing: RequestSigning = {
    current: () => signer,
    protective: () => signer,
    keyRevoked: () => {
      throw new Error("в наборе соответствия ключ не отзывается");
    },
    stop: () => {},
    suspend: () => {},
  };
  return { signing, key: { kid, alg: "ed25519" as const, publicKey, status: "ACTIVE" as const } };
}

describeConformance({
  name: "адаптер ПАО на PaoStub",
  async open() {
    const own = agentKey("kid_conformance");
    const other = agentKey("kid_conformance_other");
    const consents = new Consents(() => new Date(), AGENT);
    const handlers = consents.handlers();
    const secrets: string[] = [];
    let issued = 0;
    const stub = new PaoStub({
      configuration: { versions: ["1.4.0"] },
      agents: [
        { agentCode: AGENT, keys: [own.key] },
        { agentCode: OTHER, keys: [other.key] },
      ],
      handlers: {
        ...handlers,
        "POST /pao/v1/mandates": (req) => {
          const r = handlers["POST /pao/v1/mandates"]!(req);
          // агент мандата — запросивший (у Consents он один на журнал)
          if ("body" in r && r.body !== undefined) consents.mandates.get(r.body.id!)!.agent_code = req.agentCode;
          return "body" in r && r.body !== undefined ? { ...r, body: { ...r.body, agent_code: req.agentCode } } : r;
        },
        "POST /pao/v1/credentials": ({ body, agentCode }) => {
          const m = consents.mandates.get(body.mandate_id);
          if (m === undefined || m.agent_code !== agentCode) return { error: { code: "MANDATE_NOT_FOUND" } };
          if (m.status === "REVOKED") return { error: { code: "MANDATE_REVOKED" } };
          const n = ++issued;
          const payload = { token_ref: `tok_conformance_${n}`, cryptogram: `CRYPTOGRAM_CONFORMANCE_${n}` };
          secrets.push(payload.token_ref, payload.cryptogram);
          return {
            status: 201,
            body: {
              credential_ref: `cr_conformance_${n}`,
              kind: body.kind,
              payload,
              aoi: { indicator: true, agent_code: agentCode, mandate_id: body.mandate_id },
              status: "ISSUED" as const,
            },
          };
        },
      },
    });
    const baseUrl = await stub.start();
    const adapter = (agentCode: string, signing: RequestSigning) => {
      const journal = new MemoryJournal();
      return new PaoPlatform({
        journal,
        baseUrl,
        agentCode,
        signing,
        params,
        sleep: async () => {},
        pace: new Pace({ fallbackPerMin: Infinity, journal, sleep: async () => {} }),
      });
    };
    return {
      platform: adapter(AGENT, own.signing),
      foreign: adapter(OTHER, other.signing),
      agentCode: AGENT,
      intent: (): MandateDraft => ({ ...INTENT }),
      cart: (parent: Mandate): MandateDraft => {
        const merchantId = parent.merchantScope[0]!;
        const price = { amount: 9900, currency: parent.amountLimit.currency };
        return {
          ...INTENT,
          kind: "CART",
          parentId: parent.id,
          amountLimit: price,
          merchantScope: [merchantId],
          cart: { merchantId, lines: [{ sku: "sku_conformance_1", qty: 1, price }], total: price },
        };
      },
      signMandate: async (id: string) => void consents.sign(id),
      issuedSecrets: () => [...secrets],
      close: () => stub.close(),
    };
  },
});
