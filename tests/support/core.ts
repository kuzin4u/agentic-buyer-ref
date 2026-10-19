// Ядро агента против тестового стенда ПАО (tests/support/pao-stand.ts).
import { createAgentCore } from "../../src/agent/compose.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import type { CredentialDraft } from "../../src/shared/domain.js";
import type { PaoStubOptions } from "@kuzin4u/agentic-core/pao";
import { AGENT, type PaoStand } from "./pao-stand.js";

export const DRAFT: CredentialDraft = {
  mandate: { id: "m_1", currency: "RUB" },
  orderRef: "ord_1",
  merchantId: "shop_1",
  amountMax: { amount: 250000, currency: "RUB" },
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

/** fetch — подмена транспорта адаптера (ответы, которых PaoStub не отдаёт: битый JSON, тайм-аут); paramsPath — свои
 *  стендовые параметры. */
export async function coreOn(stand: PaoStand, o: { fetch?: typeof fetch; paramsPath?: string } = {}) {
  const baseUrl = await stand.stub.start();
  const journal = new MemoryJournal();
  const core = createAgentCore({
    keysDir: stand.dir,
    // каталог состояния создаётся только при первой записи курсора (события в этих тестах не читаются)
    stateDir: `${stand.dir}-state`,
    journal,
    now: () => stand.clock,
    ...(o.paramsPath && { paramsPath: o.paramsPath }),
    pao: { baseUrl, agentCode: AGENT, sleep: async () => {}, ...(o.fetch && { fetch: o.fetch }) },
  });
  return { core, journal };
}
