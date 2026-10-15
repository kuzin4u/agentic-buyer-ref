// Тестовая обёртка, не поведение Платформы: журнал согласий на обработчиках PaoStub до PS-06 (журнал согласий) и PS-07
// (подпись в эмуляторе эмитента, mandate.signed) — STATUS «Ждём от платформы», строки AG-05. После них те же тесты —
// против createStand платформы. POST /pao/v1/mandates → PENDING_SIGNATURE, подпись человека — sign(id),
// verify — остаток и as_of задаёт тест. Остаток здесь не вычисляется из операций:
// его ведёт платформа (инвариант 6), тест лишь назначает значение.
import type * as Pao from "@kuzin4u/agentic-core/pao";
import type { PaoStubOptions } from "@kuzin4u/agentic-core/pao";
import type { MandateDraft, Money, PlatformEvent, PlatformEventType } from "../../src/shared/domain.js";
import { AGENT } from "./pao-stand.js";

export const RUB = (amount: number): Money => ({ amount, currency: "RUB" });

/** Поручение П04: хлеб, до 5 000 ₽, 30 дней от часов стенда (2026-10-12). */
export const INTENT: MandateDraft = {
  kind: "INTENT",
  parentId: null,
  subject: "хлеб",
  amountLimit: RUB(500000),
  validTo: "2026-11-11T09:00:00Z",
  merchantScope: ["shop_1"],
  principalRef: "pr_1",
  confirmationMode: "IMMEDIATE",
  keyTermsShown: true,
  cart: null,
};

type Handlers = NonNullable<PaoStubOptions["handlers"]>;
type PaoMandate = Pao.Mandate;
type Verify = Pao.MandateVerify;

export class Consents {
  readonly mandates = new Map<string, PaoMandate>();
  /** остаток, который «ведёт платформа»; по умолчанию — amount_limit */
  readonly left = new Map<string, number>();
  /** as_of в ответе verify: "now" — часы стенда, null — поле не отдаётся, строка — как есть */
  asOf: "now" | null | string = "now";
  outcome: Verify["outcome"] = "CONFIRMED";
  /** подмена ответа на создание (проверка сверки ответа с проектом) */
  tamper?: (m: PaoMandate) => PaoMandate;
  private seq = 0;

  constructor(private readonly clock: () => Date) {}

  handlers(): Handlers {
    return {
      "POST /pao/v1/mandates": ({ body }) => {
        const id = `m_${++this.seq}`;
        const m: PaoMandate = { ...body, id, agent_code: AGENT, status: "PENDING_SIGNATURE", created_at: this.clock().toISOString() };
        this.mandates.set(id, m);
        return { status: 201, body: this.tamper ? this.tamper(m) : m };
      },
      "GET /pao/v1/mandates/{id}": ({ path }) => {
        const m = this.mandates.get(path.id!);
        return m ? { body: m } : { error: { code: "MANDATE_NOT_FOUND" } };
      },
      "GET /pao/v1/mandates/{id}/verify": ({ path }) => {
        const m = this.mandates.get(path.id!);
        if (!m) return { error: { code: "MANDATE_NOT_FOUND" } };
        const asOf = this.asOf === "now" ? this.clock().toISOString() : this.asOf;
        return {
          body: {
            outcome: this.outcome,
            amount_left: this.left.get(m.id!) ?? m.amount_limit,
            valid_to: m.valid_to,
            ...(asOf !== null && { as_of: asOf }),
          },
        };
      },
    };
  }

  /** Подпись человека в эмуляторе эмитента: статус ACTIVE и событие mandate.signed. */
  sign(id: string): PlatformEvent {
    this.mandates.get(id)!.status = "ACTIVE";
    return event("mandate.signed", id);
  }
}

let eventSeq = 0;
export function event(type: PlatformEventType, mandateId: string): PlatformEvent {
  return { eventId: `ev_${++eventSeq}`, type, at: "2026-10-12T09:00:00Z", mandateId, opRef: null, confirmationId: null, declineReason: null };
}

/** Источник событий для awaitSigned: до AG-06 — список, который задаёт тест. */
export async function* feed(...events: PlatformEvent[]): AsyncGenerator<PlatformEvent> {
  for (const e of events) yield e;
}
