// Перевод ПАО ↔ доменные типы ядра (Р19). Неполный ответ платформы — отказ UNKNOWN (fail-closed, инвариант 4).
// Payload реквизита (криптограмма, token_ref, привязка) отбрасывается здесь и не хранится (инвариант 1, задел к AG-11).
import type * as Pao from "@kuzin4u/agentic-core/pao";
import {
  PlatformFailure,
  isKopecks,
  type AgentIndicator,
  type AgentKey,
  type AgentSelf,
  type KeyDraft,
  type Cart,
  type Confirmation,
  type ConfirmationDraft,
  type Credential,
  type CredentialDraft,
  type Dispute,
  type DisputeDraft,
  type Evidence,
  type Kopecks,
  type Mandate,
  type MandateCheck,
  type MandateDraft,
  type Operation,
  type PlatformEvent,
  type PlatformEventType,
} from "../../../shared/domain.js";

function incomplete(what: string): never {
  throw new PlatformFailure("UNKNOWN", "never", null, 200, null, `ответ ПАО неполон: ${what}`);
}

function need<T>(v: T | null | undefined, what: string): T {
  if (v === undefined || v === null) incomplete(what);
  return v;
}

function kop(v: number | null | undefined, what: string): Kopecks {
  if (!isKopecks(v)) incomplete(`${what} — не целые копейки`);
  return v;
}

export function mandateDraftToPao(d: MandateDraft): Pao.MandateRequest {
  return {
    type: d.kind,
    parent_id: d.parentId,
    subject: d.subject,
    amount_limit: d.amountLimit,
    currency: d.currency,
    valid_to: d.validTo,
    merchant_scope: d.merchantScope,
    principal_ref: d.principalRef,
    mode: d.confirmationMode,
    key_terms_shown: d.keyTermsShown,
    cart: d.cart
      ? {
          merchant_id: d.cart.merchantId,
          items: d.cart.lines.map((l) => ({ sku: l.sku, qty: l.qty, price: l.price })),
          total: d.cart.total,
        }
      : null,
    settlement_mode: "DIRECT",
  };
}

function cartFromPao(c: Pao.MandateRequest["cart"]): Cart | null {
  if (!c) return null;
  return {
    merchantId: need(c.merchant_id, "cart.merchant_id"),
    lines: (c.items ?? []).map((i, n) => ({
      sku: need(i.sku, `cart.items[${n}].sku`),
      qty: need(i.qty, `cart.items[${n}].qty`),
      price: kop(i.price, `cart.items[${n}].price`),
    })),
    total: kop(c.total, "cart.total"),
  };
}

export function mandateFromPao(m: Pao.Mandate): Mandate {
  return {
    id: need(m.id, "mandate.id"),
    status: need(m.status, "mandate.status"),
    signatureLevel: m.signature_type ?? null,
    kind: m.type,
    parentId: m.parent_id ?? null,
    subject: m.subject,
    amountLimit: kop(m.amount_limit, "mandate.amount_limit"),
    currency: m.currency,
    validTo: m.valid_to,
    merchantScope: m.merchant_scope,
    principalRef: m.principal_ref,
    confirmationMode: m.mode,
    keyTermsShown: m.key_terms_shown ?? false,
    cart: cartFromPao(m.cart),
  };
}

export function mandateCheckFromPao(v: Pao.MandateVerify): MandateCheck {
  return {
    outcome: v.outcome,
    amountLeft: kop(v.amount_left, "verify.amount_left"),
    validTo: v.valid_to,
    asOf: v.as_of ?? null,
  };
}

function indicatorFromPao(a: Pao.Aoi): AgentIndicator {
  if (a.indicator !== true) incomplete("aoi.indicator");
  return { agentCode: a.agent_code, mandateId: a.mandate_id };
}

export function evidenceFromPao(e: Pao.Evidence): Evidence {
  return {
    mandateChain: (e.mandate_chain ?? []).map(mandateFromPao),
    operations: (e.operations ?? []).map(operationFromPao),
    integrity: need(e.integrity, "evidence.integrity"),
  };
}

export function credentialDraftToPao(d: CredentialDraft): Pao.CredentialRequest {
  return {
    mandate_id: d.mandateId,
    order_ref: d.orderRef,
    merchant_id: d.merchantId,
    amount_max: d.amountMax,
    currency: d.currency,
    kind: d.channel,
  };
}

/** Реквизит глазами ядра: payload не переносится и не хранится (инвариант 1). */
export function credentialFromPao(c: Pao.Credential): Credential {
  return {
    credentialRef: c.credential_ref,
    channel: c.kind,
    status: c.status,
    validTo: c.payload?.valid_to ?? null,
    indicator: indicatorFromPao(c.aoi),
  };
}

export function confirmationDraftToPao(d: ConfirmationDraft): Pao.ConfirmationRequest {
  return { mandate_id: d.mandateId, merchant_id: d.merchantId, amount: d.amount, summary: d.summary, channel: d.channel };
}

export function confirmationFromPao(c: Pao.Confirmation): Confirmation {
  return {
    id: need(c.id, "confirmation.id"),
    status: need(c.status, "confirmation.status"),
    link: c.link ?? null,
    confirmationRef: c.confirmation_ref ?? null,
    expiresAt: c.expires_at ?? null,
  };
}

export function operationFromPao(o: Pao.Operation): Operation {
  return {
    opRef: need(o.op_ref, "operation.op_ref"),
    orderRef: o.order_ref ?? null,
    channel: o.channel ?? null,
    amount: o.amount === undefined ? null : kop(o.amount, "operation.amount"),
    merchantId: o.merchant_id ?? null,
    indicator: o.aoi ? indicatorFromPao(o.aoi) : null,
    status: need(o.status, "operation.status"),
    declineReason: o.reason ?? null,
  };
}

export function disputeDraftToPao(d: DisputeDraft): Pao.DisputeRequest {
  return { op_ref: d.opRef, reason: d.reason, principal_ack: d.principalAck };
}

export function disputeFromPao(d: Pao.Dispute): Dispute {
  return {
    id: need(d.id, "dispute.id"),
    opRef: need(d.op_ref, "dispute.op_ref"),
    inScope: d.in_scope ?? null,
    decision: need(d.decision, "dispute.decision"),
  };
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (!allowed.includes(v as T)) incomplete(`${what} — значение вне перечня ПАО`);
  return v as T;
}

const AGENT_STATUSES = ["ACTIVE", "SUSPENDED", "EXCLUDED"] as const;
const KEY_STATUSES = ["ACTIVE", "REVOKED", "EXPIRED"] as const;

/** Ключ ПАО → ключ ядра. Сроки переносятся как есть: их задаёт платформа (РП23). Статус вне перечня — UNKNOWN. */
export function keyFromPao(k: Pao.Key): AgentKey {
  return {
    kid: need(k.kid, "key.kid"),
    alg: need(k.alg, "key.alg"),
    publicKey: need(k.public_key, "key.public_key"),
    validFrom: k.valid_from ?? null,
    validTo: k.valid_to ?? null,
    status: oneOf(k.status, KEY_STATUSES, "key.status"),
  };
}

export function agentSelfFromPao(a: Pao.AgentSelf): AgentSelf {
  return {
    agentCode: need(a.agent_code, "agent.agent_code"),
    status: oneOf(a.status, AGENT_STATUSES, "agent.status"),
    keys: (a.keys ?? []).map(keyFromPao),
  };
}

export const keyDraftToPao = (d: KeyDraft): { alg: string; public_key: string } => ({ alg: d.alg, public_key: d.publicKey });

const EVENT_TYPES: ReadonlySet<string> = new Set<PlatformEventType>([
  "mandate.signed",
  "mandate.rejected",
  "mandate.revoked",
  "mandate.exhausted",
  "confirmation.required",
  "confirmation.approved",
  "confirmation.rejected",
  "confirmation.expired",
  "operation.authorized",
  "operation.declined",
  "operation.settled",
  "operation.refunded",
  "agent.key_revoked",
  "agent.suspended",
  "agent.reinstated",
  "dispute.updated",
]);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Событие ПАО → событие ядра. Неизвестный тип (и deal.* до решения по Р17) — null: ПАО §7 требует игнорировать. */
export function eventFromPao(e: Pao.Event): PlatformEvent | null {
  if (!EVENT_TYPES.has(e.type)) return null;
  return {
    eventId: e.event_id,
    type: e.type as PlatformEventType,
    at: e.at,
    mandateId: str(e.data.mandate_id),
    opRef: str(e.data.op_ref),
    confirmationId: str(e.data.confirmation_id),
    declineReason: str(e.data.reason),
  };
}
