// Перевод ПАО ↔ доменные типы ядра (Р19). Неполный ответ платформы — отказ UNKNOWN (fail-closed, инвариант 4).
// Payload реквизита (криптограмма, token_ref, привязка) отбрасывается здесь и не хранится (инвариант 1, задел к AG-11).
// Суммы (Р29): валюта — из мандата; у сумм без поля валюты в ПАО 1.2.0 (verify, операция, подтверждение, корзина) —
// валюта мандата ссылки. Множество валют платформы — только допустимое: вне его — отказ (исходящие) или UNKNOWN (входящие).
import { money, type CurrencyCode, type Money } from "@kuzin4u/agentic-core";
import type * as Pao from "@kuzin4u/agentic-core/pao";
import {
  PlatformFailure,
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
  type Mandate,
  type MandateCheck,
  type MandateDraft,
  type MandateRef,
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

/** Допустимое множество валют платформы (Р29 п. 2): по нему проверяют, но валюту из него не берут. */
export type Currencies = ReadonlySet<CurrencyCode>;

/** Отказ до обращения: обращение не отправлено (fail-closed). */
function refuse(detail: string): never {
  throw new PlatformFailure("UNKNOWN", "never", null, 0, null, `обращение не отправлено: ${detail}`);
}

/** Валюта входящего мандата — из множества платформы, иначе UNKNOWN. */
function allowed(c: unknown, cur: Currencies, what: string): CurrencyCode {
  if (typeof c !== "string" || !cur.has(c)) incomplete(`${what} — валюта вне возможностей платформы`);
  return c;
}

/** Ссылка на мандат перед обращением: валюта из множества платформы, иначе отказ до обращения. */
export function checkRef(ref: MandateRef, cur: Currencies): MandateRef {
  if (!cur.has(ref.currency)) refuse(`валюта мандата ${ref.currency} вне возможностей платформы`);
  return ref;
}

/** Входящая сумма: целое число минимальных единиц ≥ 0 в валюте мандата; иначе UNKNOWN. */
function minor(v: number | null | undefined, currency: CurrencyCode, what: string): Money {
  try {
    return money(v as number, currency);
  } catch {
    return incomplete(`${what} — не целое число минимальных единиц`);
  }
}

/** Исходящая сумма: в валюте мандата и в множестве платформы, целое ≥ min; иначе отказ до обращения (Р29 пп. 2–3). */
function outgoing(m: Money, currency: CurrencyCode, cur: Currencies, what: string, min = 0): number {
  if (m.currency !== currency) refuse(`${what} — валюта ${m.currency}, у мандата ${currency}`);
  if (!cur.has(m.currency)) refuse(`${what} — валюта ${m.currency} вне возможностей платформы`);
  try {
    const amount = money(m.amount, m.currency).amount;
    if (amount < min) refuse(`${what} — меньше ${min}`);
    return amount;
  } catch (e) {
    if (e instanceof PlatformFailure) throw e;
    return refuse(`${what} — не целое число минимальных единиц`);
  }
}

export function mandateDraftToPao(d: MandateDraft, cur: Currencies): Pao.MandateRequest {
  const currency = d.amountLimit.currency;
  return {
    type: d.kind,
    parent_id: d.parentId,
    subject: d.subject,
    amount_limit: outgoing(d.amountLimit, currency, cur, "amountLimit", 1), // ПАО: minimum 1
    currency,
    valid_to: d.validTo,
    merchant_scope: d.merchantScope,
    principal_ref: d.principalRef,
    mode: d.confirmationMode,
    key_terms_shown: d.keyTermsShown,
    cart: d.cart
      ? {
          merchant_id: d.cart.merchantId,
          items: d.cart.lines.map((l, n) => ({ sku: l.sku, qty: l.qty, price: outgoing(l.price, currency, cur, `cart.lines[${n}].price`) })),
          total: outgoing(d.cart.total, currency, cur, "cart.total"),
        }
      : null,
    settlement_mode: "DIRECT",
  };
}

function cartFromPao(c: Pao.MandateRequest["cart"], currency: CurrencyCode): Cart | null {
  if (!c) return null;
  return {
    merchantId: need(c.merchant_id, "cart.merchant_id"),
    lines: (c.items ?? []).map((i, n) => ({
      sku: need(i.sku, `cart.items[${n}].sku`),
      qty: need(i.qty, `cart.items[${n}].qty`),
      price: minor(i.price, currency, `cart.items[${n}].price`),
    })),
    total: minor(c.total, currency, "cart.total"),
  };
}

export function mandateFromPao(m: Pao.Mandate, cur: Currencies): Mandate {
  const currency = allowed(m.currency, cur, "mandate.currency");
  return {
    id: need(m.id, "mandate.id"),
    status: need(m.status, "mandate.status"),
    signatureLevel: m.signature_type ?? null,
    kind: m.type,
    parentId: m.parent_id ?? null,
    subject: m.subject,
    amountLimit: minor(m.amount_limit, currency, "mandate.amount_limit"),
    validTo: m.valid_to,
    merchantScope: m.merchant_scope,
    principalRef: m.principal_ref,
    confirmationMode: m.mode,
    keyTermsShown: m.key_terms_shown ?? false,
    cart: cartFromPao(m.cart, currency),
  };
}

/** verify: в ПАО 1.2.0 у `amount_left` нет валюты — валюта мандата ссылки (Р29 п. 3). */
export function mandateCheckFromPao(v: Pao.MandateVerify, ref: MandateRef): MandateCheck {
  return {
    outcome: v.outcome,
    amountLeft: minor(v.amount_left, ref.currency, "verify.amount_left"),
    validTo: v.valid_to,
    asOf: v.as_of ?? null,
  };
}

function indicatorFromPao(a: Pao.Aoi): AgentIndicator {
  if (a.indicator !== true) incomplete("aoi.indicator");
  return { agentCode: a.agent_code, mandateId: a.mandate_id };
}

/** Выписка: валюта операции — валюта её мандата в цепочке (`aoi.mandate_id`; без признака — запрошенного мандата).
 *  Мандата операции в цепочке нет — UNKNOWN. */
export function evidenceFromPao(e: Pao.Evidence, mandateId: string, cur: Currencies): Evidence {
  const chain = (e.mandate_chain ?? []).map((m) => mandateFromPao(m, cur));
  const refOf = (o: Pao.Operation): MandateRef => {
    const id = o.aoi?.mandate_id ?? mandateId;
    const m = chain.find((x) => x.id === id);
    if (!m) incomplete("evidence.operations — мандата операции нет в цепочке");
    return { id, currency: m.amountLimit.currency };
  };
  return {
    mandateChain: chain,
    operations: (e.operations ?? []).map((o) => operationFromPao(o, refOf(o), "list")),
    integrity: need(e.integrity, "evidence.integrity"),
  };
}

export function credentialDraftToPao(d: CredentialDraft, cur: Currencies): Pao.CredentialRequest {
  return {
    mandate_id: d.mandate.id,
    order_ref: d.orderRef,
    merchant_id: d.merchantId,
    amount_max: outgoing(d.amountMax, d.mandate.currency, cur, "amountMax"),
    currency: d.amountMax.currency,
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

/** Подтверждение: в ПАО 1.2.0 у `amount` нет валюты — сумма обязана быть в валюте мандата (Р29 п. 3). */
export function confirmationDraftToPao(d: ConfirmationDraft, cur: Currencies): Pao.ConfirmationRequest {
  return {
    mandate_id: d.mandate.id,
    merchant_id: d.merchantId,
    amount: outgoing(d.amount, d.mandate.currency, cur, "amount"),
    summary: d.summary,
    channel: d.channel,
  };
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

/** Операция: в ПАО 1.2.0 у `amount` нет валюты — валюта мандата ссылки; признак другого мандата — UNKNOWN (Р29 п. 3).
 *  Операция без признака (причина AOI_MISSING, SPEC §7б): в списке и выписке по мандату (`list` — мандат назвала
 *  платформа) — в валюте мандата ссылки; по одной операции (`single` — мандат назвал вызывающий) сумма не
 *  подтверждена — `amount: null`. `indicator` — null. */
export function operationFromPao(o: Pao.Operation, ref: MandateRef, scope: "list" | "single"): Operation {
  if (o.aoi && o.aoi.mandate_id !== ref.id) incomplete("operation.aoi.mandate_id — не мандат запроса");
  const known = o.amount !== undefined && (o.aoi !== undefined || scope === "list");
  return {
    opRef: need(o.op_ref, "operation.op_ref"),
    orderRef: o.order_ref ?? null,
    channel: o.channel ?? null,
    amount: known ? minor(o.amount, ref.currency, "operation.amount") : null,
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
const AGENT_CLASSES = ["BUYER", "SELLER", "SURFACE", "SERVICE"] as const;
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
    // Р27: класс обязателен для ядра (в ПАО 1.2.0 — нет); нет поля — тоже «вне перечня», UNKNOWN.
    agentClass: oneOf(a.class, AGENT_CLASSES, "agent.class"),
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
