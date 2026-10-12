// Ядро агента против тестового стенда ПАО (tests/support/pao-stand.ts).
import { createAgentCore } from "../../src/agent/compose.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import type { CredentialDraft } from "../../src/shared/domain.js";
import type { PaoStubOptions } from "@kuzin4u/agentic-core/pao";
import { AGENT, type PaoStand } from "./pao-stand.js";

export const DRAFT: CredentialDraft = {
  mandateId: "m_1",
  orderRef: "ord_1",
  merchantId: "shop_1",
  amountMax: 250000,
  currency: "RUB",
  channel: "CARD",
};

/** Ответ на POST /pao/v1/credentials — только для проверки повторов; payload адаптер отбрасывает (инвариант 1). */
export const CREDENTIALS: PaoStubOptions["handlers"] = {
  "POST /pao/v1/credentials": ({ body }) => ({
    status: 201,
    body: {
      credential_ref: "cr_1",
      kind: body.kind,
      payload: { token_ref: "tok_ref_1" },
      aoi: { indicator: true, agent_code: AGENT, mandate_id: body.mandate_id },
      status: "ISSUED",
    },
  }),
};

export async function coreOn(stand: PaoStand) {
  const baseUrl = await stand.stub.start();
  const journal = new MemoryJournal();
  const core = createAgentCore({
    keysDir: stand.dir,
    journal,
    now: () => stand.clock,
    pao: { baseUrl, agentCode: AGENT, sleep: async () => {} },
  });
  return { core, journal };
}
