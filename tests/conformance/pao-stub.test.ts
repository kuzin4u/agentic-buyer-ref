// Цель набора соответствия (AG-20, Р67 п. 1): адаптер ПАО напрямую против PaoStub agentic-core (ПАО 1.4.0). Мандаты —
// журнал согласий-обёртка tests/support/consents.ts (подпись человека — `sign`), агент мандата — тот, кто его запросил;
// выдача реквизита — обработчик ниже. Мандат чужого агента — 404 MANDATE_NOT_FOUND в каждом методе мандата (чтение,
// verify, отказ, выписка, выдача реквизита; КТ1 № 7). Из условий выдачи Платформы (ПАО §4, РП47 п. 4) эмулированы
// только два: мандат чужой и агент отказался — 409 MANDATE_REVOKED (П22); вид, срок, продавец, сумма и прочие условия
// §4 обработчик не сверяет — их проверяет настоящий код Платформы в цели на стенде (pao-stand.test.ts). Лента событий и
// запросы подтверждения — обработчики ниже (у PaoStub их нет): лента своя у каждого агента, подпись мандата — mandate.signed;
// запрос подтверждения создаёт тестовая сторона, решает человек (дополнение 1 к Р67 п. 4). Запросы и ответы PaoStub
// сверяет со схемой YAML 1.4.0; нарушение схемы — красный тест при закрытии сессии (КТ1 № 1).
import { randomUUID } from "node:crypto";
import { newEd25519Signer } from "@kuzin4u/agentic-core";
import type * as Pao from "@kuzin4u/agentic-core/pao";
import { PaoStub } from "@kuzin4u/agentic-core/pao";
import { expect } from "vitest";
import { Pace, PaoPlatform } from "../../src/agent/adapters/pao/index.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import type { RequestSigning } from "../../src/agent/ports/index.js";
import { loadParams } from "../../src/shared/config.js";
import type { Mandate, MandateDraft } from "../../src/shared/domain.js";
import { Consents, INTENT } from "../support/consents.js";
import { faultyFetch } from "./pao-faults.js";
import { ownCalls } from "./pao-stub-calls.js";
import { describeConformance, type FaultMethod, type PlatformCall } from "./suite.js";

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
    // Мандат чужого агента — 404 MANDATE_NOT_FOUND в каждом методе мандата (ПАО §4, как у Платформы; КТ1 № 7)
    const ownOnly =
      <K extends "GET /pao/v1/mandates/{id}" | "GET /pao/v1/mandates/{id}/verify" | "POST /pao/v1/mandates/{id}/relinquish" | "GET /pao/v1/mandates/{id}/evidence">(
        key: K,
      ): (typeof handlers)[K] =>
      ((req: { path: { id?: string }; agentCode: string }) => {
        const m = consents.mandates.get(req.path.id!);
        if (m !== undefined && m.agent_code !== req.agentCode) return { error: { code: "MANDATE_NOT_FOUND" } };
        return (handlers[key] as (r: typeof req) => unknown)(req);
      }) as (typeof handlers)[K];
    const secrets: string[] = [];
    let issued = 0;
    /** выданные реквизиты по credential_ref — для чтения статуса (дополнение 1 к Р69 п. 4) */
    const credentials = new Map<string, { agentCode: string; mandateId: string; kind: "CARD" | "SBP" }>();
    // Лента и подтверждения — тестовая сторона (у PaoStub их нет, Р34 п. 10): лента у каждого агента своя; чужой или
    // неизвестный курсор и запрос подтверждения — 400 REQUEST_INVALID, как у Платформы (стенд v0.34.0, ПАО §3)
    const feeds = new Map<string, Pao.Event[]>([
      [AGENT, []],
      [OTHER, []],
    ]);
    let eventSeq = 0;
    const confirmations = new Map<string, { agentCode: string; status: "PENDING" | "APPROVED" | "REJECTED" }>();
    const stub = new PaoStub({
      configuration: { versions: ["1.4.0"] },
      agents: [
        { agentCode: AGENT, keys: [own.key] },
        { agentCode: OTHER, keys: [other.key] },
      ],
      handlers: {
        ...handlers,
        "GET /pao/v1/mandates/{id}": ownOnly("GET /pao/v1/mandates/{id}"),
        "GET /pao/v1/mandates/{id}/verify": ownOnly("GET /pao/v1/mandates/{id}/verify"),
        "POST /pao/v1/mandates/{id}/relinquish": ownOnly("POST /pao/v1/mandates/{id}/relinquish"),
        "GET /pao/v1/mandates/{id}/evidence": ownOnly("GET /pao/v1/mandates/{id}/evidence"),
        "POST /pao/v1/mandates": (req) => {
          const r = handlers["POST /pao/v1/mandates"]!(req);
          // агент мандата — запросивший (у Consents он один на журнал)
          if ("body" in r && r.body !== undefined) consents.mandates.get(r.body.id!)!.agent_code = req.agentCode;
          return "body" in r && r.body !== undefined ? { ...r, body: { ...r.body, agent_code: req.agentCode } } : r;
        },
        "GET /pao/v1/events": ({ query, agentCode }) => {
          const feed = feeds.get(agentCode)!;
          if (query.after === undefined) return { body: [...feed] };
          const at = feed.findIndex((e) => e.event_id === query.after);
          return at < 0 ? { error: { code: "REQUEST_INVALID" } } : { body: feed.slice(at + 1) };
        },
        "GET /pao/v1/confirmations/{id}": ({ path, agentCode }) => {
          const c = confirmations.get(path.id!);
          if (c === undefined || c.agentCode !== agentCode) return { error: { code: "REQUEST_INVALID" } };
          return { body: { id: path.id!, status: c.status, expires_at: INTENT.validTo } };
        },
        // как у Платформы (ПАО §3): свой реквизит — тот же Credential, криптограмма пересчитана; чужой и неизвестный — 409
        "GET /pao/v1/credentials/{ref}": ({ path, agentCode }) => {
          const c = credentials.get(path.ref!);
          if (c === undefined || c.agentCode !== agentCode) return { error: { code: "CREDENTIAL_INVALID" } };
          const payload = { token_ref: `tok_${path.ref!}`, cryptogram: `CRYPTOGRAM_REREAD_${++issued}` };
          secrets.push(payload.token_ref, payload.cryptogram);
          return { body: { credential_ref: path.ref!, kind: c.kind, payload, aoi: { indicator: true, agent_code: agentCode, mandate_id: c.mandateId }, status: "ISSUED" as const } };
        },
        "POST /pao/v1/credentials": ({ body, agentCode }) => {
          const m = consents.mandates.get(body.mandate_id);
          if (m === undefined || m.agent_code !== agentCode) return { error: { code: "MANDATE_NOT_FOUND" } };
          if (m.status === "REVOKED") return { error: { code: "MANDATE_REVOKED" } };
          const n = ++issued;
          const payload = { token_ref: `tok_conformance_${n}`, cryptogram: `CRYPTOGRAM_CONFORMANCE_${n}` };
          secrets.push(payload.token_ref, payload.cryptogram);
          credentials.set(`cr_conformance_${n}`, { agentCode, mandateId: body.mandate_id, kind: body.kind });
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
    // Подмена транспорта своего агента (только тестовая сторона): обращение доходит до PaoStub, ответ теряется или
    // заменяется 200 не по схеме (pao-faults.ts — общий с целью на стенде).
    const faults = faultyFetch();
    const ownJournal = new MemoryJournal();
    const adapter = (agentCode: string, signing: RequestSigning, own: boolean) => {
      const journal = own ? ownJournal : new MemoryJournal();
      return new PaoPlatform({
        journal,
        baseUrl,
        agentCode,
        signing,
        params,
        sleep: async () => {},
        pace: new Pace({ fallbackPerMin: Infinity, journal, sleep: async () => {} }),
        ...(own && { fetch: faults.fetch }),
      });
    };
    return {
      platform: adapter(AGENT, own.signing, true),
      foreign: adapter(OTHER, other.signing, false),
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
      // подпись человека — ACTIVE и mandate.signed в ленте агента мандата
      signMandate: async (id: string) => {
        consents.sign(id);
        const owner = consents.mandates.get(id)!.agent_code!;
        feeds.get(owner)!.push({ event_id: `ev_conformance_${++eventSeq}`, type: "mandate.signed", at: new Date().toISOString(), data: { mandate_id: id } });
      },
      // запрос подтверждения по CART создаёт «ADP» (Р47 п. 2) для агента мандата; решает человек
      createConfirmation: async (cart: Mandate) => {
        const id = `cnf_${randomUUID()}`;
        confirmations.set(id, { agentCode: consents.mandates.get(cart.id)!.agent_code!, status: "PENDING" });
        return id;
      },
      decideConfirmation: async (id: string, decision: "APPROVED" | "REJECTED") => void (confirmations.get(id)!.status = decision),
      issuedSecrets: () => [...secrets, ...faults.secrets],
      callsCarryNonce: true,
      // PaoStub проверяет подпись до обработчика: свои обращения и подпись агента цели — по agentCode после проверки
      // подписи и kid (ядро v0.12.0, К24, agentic-core#44; pao-stub-calls.ts)
      calls: (): PlatformCall[] => ownCalls(stub.calls, { agentCode: AGENT, kid: own.key.kid }),
      loseNextResponse: (m: FaultMethod) => faults.set(m, "lose"),
      garbleNextResponse: (m: FaultMethod) => faults.set(m, "garble"),
      journalText: () => JSON.stringify(ownJournal.entries),
      // нарушения схемы YAML 1.4.0 в запросах адаптера и в ответах обработчиков — дефект (КТ1 № 1); заглушка
      // закрывается и при красной сверке
      close: async () => {
        try {
          expect(stub.violations, "PaoStub: обращения не по схеме ПАО 1.4.0").toEqual([]);
        } finally {
          await stub.close();
        }
      },
    };
  },
});
