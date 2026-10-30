// Тестовая обёртка, не поведение Платформы: журнал согласий на обработчиках PaoStub до PS-06 (журнал согласий) и PS-07
// (подпись в эмуляторе эмитента, mandate.signed) — STATUS «Ждём от платформы», строки AG-05. После них те же тесты —
// против createStand платформы. POST /pao/v1/mandates → PENDING_SIGNATURE, подпись человека — sign(id),
// verify — остаток и as_of задаёт тест; исход — как в копии ПАО 1.4.0: CONFIRMED только у ACTIVE, иначе OUT_OF_SCOPE
// (`outcome` и `outcomeOf` — подмена исхода для тестов отказа у ACTIVE). Остаток здесь не вычисляется из операций:
// его ведёт платформа (инвариант 6), тест лишь назначает значение. Порядок отзыва задаёт «Платформа» (ПАО 1.4.0, РП37):
// поле запроса не берётся, у CART — как у родителя (если родитель здесь есть). Стенд Платформы этого пока не проверяет:
// стенд (с v0.5.0, у агента — v0.11.0; ПАО 1.4.0; К2а, К1.2 AG-06) мандаты уже отдаёт; переход этих тестов на createStand — STATUS «Открыто».
// Выписка (`GET …/evidence`) — эмуляция сверх PaoStub (у него обработчика нет): цепочка и integrity задаёт тест; на стенде
// выписка проверяется настоящей — operation-stand.test.ts, после П15 (Р65, нюанс К1.1; ревью КТ1 сессии 51 № 8).
import type * as Pao from "@kuzin4u/agentic-core/pao";
import type { PaoStubOptions } from "@kuzin4u/agentic-core/pao";
import type { FeedItem } from "../../src/agent/ports/events.js";
import type { MandateDraft, Money, PlatformEvent, PlatformEventType } from "../../src/shared/domain.js";
import { AGENT } from "./pao-stand.js";

export const RUB = (amount: number): Money => ({ amount, currency: "RUB" });

/** Поручение П04: хлеб, до 5 000 ₽, срок — 15 дней от настоящих часов при загрузке модуля (меньше
 *  qualified_signature_above_days стенда). Не дата литералом: стенд и агент сравнивают validTo с настоящими часами —
 *  прежняя 2026-11-11 после этого дня роняла все тесты на стенде (Р52 К3, проверка сдвигом часов на 30 и 400 дней). */
export const INTENT: MandateDraft = {
  kind: "INTENT",
  parentId: null,
  subject: "хлеб",
  amountLimit: RUB(500000),
  validTo: new Date(Date.now() + 15 * 86_400_000).toISOString(),
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
  /** исход verify отдельного мандата — поверх `outcome` (ворота перед стадией 5 по CART, Р38 п. 3) */
  readonly outcomeOf = new Map<string, Verify["outcome"]>();
  /** порядок отзыва из соглашения участника — его отдаёт Платформа, не агент (РП37) */
  revocationOrder = "bank:pr_1:revocation:v1";
  /** подмена ответа на создание (проверка сверки ответа с проектом) */
  tamper?: (m: PaoMandate) => PaoMandate;
  /** integrity выписки: BROKEN — 200 с пустыми массивами, как у Платформы (ПАО 1.4.0, РП38 п. 7) */
  integrity: "OK" | "BROKEN" = "OK";
  /** BROKEN с непустой цепочкой — Платформа так не отвечает; проверка, что агент её не отдаёт (дополнение 1 к Р65 п. 4) */
  brokenWithChain = false;
  private seq = 0;

  constructor(
    private readonly clock: () => Date,
    private readonly agentCode: string = AGENT,
  ) {}

  handlers(): Handlers {
    return {
      "POST /pao/v1/mandates": ({ body }) => {
        const id = `m_${++this.seq}`;
        const parent = body.parent_id ? this.mandates.get(body.parent_id) : undefined;
        const m: PaoMandate = {
          ...body,
          id,
          agent_code: this.agentCode,
          revocation_order: parent?.revocation_order ?? this.revocationOrder,
          status: "PENDING_SIGNATURE",
          created_at: this.clock().toISOString(),
        };
        this.mandates.set(id, m);
        return { status: 201, body: this.tamper ? this.tamper(m) : m };
      },
      "GET /pao/v1/mandates/{id}": ({ path }) => {
        const m = this.mandates.get(path.id!);
        return m ? { body: m } : { error: { code: "MANDATE_NOT_FOUND" } };
      },
      // отказ агента от мандата (ПАО): REVOKED; уже конечный — 200 с текущим статусом без записи; подмена — как у создания
      "POST /pao/v1/mandates/{id}/relinquish": ({ path }) => {
        const m = this.mandates.get(path.id!);
        if (!m) return { error: { code: "MANDATE_NOT_FOUND" } };
        if (m.status === "PENDING_SIGNATURE" || m.status === "ACTIVE") m.status = "REVOKED";
        return { body: this.tamper ? this.tamper(m) : m };
      },
      // выписка (ПАО §3): цепочка — у CART родитель и CART; записей журнала и операций здесь нет; подмена — как у создания
      "GET /pao/v1/mandates/{id}/evidence": ({ path }) => {
        const m = this.mandates.get(path.id!);
        if (!m) return { error: { code: "MANDATE_NOT_FOUND" } };
        const parent = m.parent_id ? this.mandates.get(m.parent_id) : undefined;
        const chain = [...(parent ? [parent] : []), m].map((x) => (this.tamper ? this.tamper(x) : x));
        if (this.integrity === "BROKEN") {
          return { body: { mandate_chain: this.brokenWithChain ? chain : [], records: [], operations: [], integrity: "BROKEN" } };
        }
        return { body: { mandate_chain: chain, records: [], operations: [], integrity: "OK" } };
      },
      "GET /pao/v1/mandates/{id}/verify": ({ path }) => {
        const m = this.mandates.get(path.id!);
        if (!m) return { error: { code: "MANDATE_NOT_FOUND" } };
        const asOf = this.asOf === "now" ? this.clock().toISOString() : this.asOf;
        return {
          body: {
            outcome: this.outcomeOf.get(m.id!) ?? (m.status === "ACTIVE" ? this.outcome : "OUT_OF_SCOPE"),
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

/** Элементы ленты для awaitSigned на PaoStub (ленты у него нет, Р34 п. 10): список, который задаёт тест. */
export async function* feed(...items: (PlatformEvent | FeedItem)[]): AsyncGenerator<FeedItem> {
  for (const i of items) yield "kind" in i ? i : { kind: "event", event: i };
}
