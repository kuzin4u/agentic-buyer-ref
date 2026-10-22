// Перевод ПАО ↔ доменные типы ядра (Р19). Неполный ответ платформы — отказ UNKNOWN (fail-closed, инвариант 4).
// Payload реквизита (криптограмма, token_ref, привязка) отбрасывается здесь и не хранится (инвариант 1, задел к AG-11).
// Суммы (Р29): валюта — из мандата; у сумм без поля валюты в ПАО 1.4.0 (verify, операция, подтверждение, корзина) —
// валюта мандата ссылки. Множество валют платформы — только допустимое: вне его — отказ (исходящие) или UNKNOWN (входящие).
import { money, type CurrencyCode, type Money } from "@kuzin4u/agentic-core";
import type * as Pao from "@kuzin4u/agentic-core/pao";
import { SAFE_ID } from "../../../shared/ids.js";
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
  PLATFORM_EVENT_TYPES,
  type PlatformEventType,
} from "../../../shared/domain.js";
import type { FeedItem } from "../../ports/events.js";
import { sealPackage, type SealedPackage } from "../../payment-package/package.js";

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

/** Мандат: валюта — из множества платформы; `agent_code` обязателен и только свой (ПАО 1.4.0, Р33 п. 3; «Открыто» № 17) —
 *  нет или чужой — UNKNOWN. Порядок отзыва обязателен (A7 п. 2.2): нет — свой код агента, не UNKNOWN (Р33 п. 4). */
export function mandateFromPao(m: Pao.Mandate, cur: Currencies, agentCode: string): Mandate {
  if (need(m.agent_code, "mandate.agent_code") !== agentCode) incomplete("mandate.agent_code — не этот агент");
  if (typeof m.revocation_order !== "string" || m.revocation_order.trim() === "") {
    throw new PlatformFailure(
      "MANDATE_REVOCATION_ORDER_MISSING",
      "never",
      null,
      200,
      null,
      "ответ Платформы с мандатом без revocation_order: Платформа старше ПАО 1.4.0 или дефект Платформы",
    );
  }
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
    revocationOrder: m.revocation_order,
  };
}

/** verify: в ПАО 1.4.0 у `amount_left` нет валюты — валюта мандата ссылки (Р29 п. 3). */
export function mandateCheckFromPao(v: Pao.MandateVerify, ref: MandateRef): MandateCheck {
  return {
    outcome: v.outcome,
    amountLeft: minor(v.amount_left, ref.currency, "verify.amount_left"),
    validTo: v.valid_to,
    asOf: v.as_of ?? null,
  };
}

/** Агентский признак — только свой: `agent_code` этого агента, `mandate_id` — мандат запроса («Открыто» № 17). */
function indicatorFromPao(a: Pao.Aoi, agentCode: string, mandateId: string): AgentIndicator {
  if (a.indicator !== true) incomplete("aoi.indicator");
  if (a.agent_code !== agentCode) incomplete("aoi.agent_code — не этот агент");
  if (a.mandate_id !== mandateId) incomplete("aoi.mandate_id — не мандат запроса");
  return { agentCode: a.agent_code, mandateId: a.mandate_id };
}

/** Выписка: валюта операции — валюта её мандата в цепочке (`aoi.mandate_id`; без признака — запрошенного мандата).
 *  Мандата операции в цепочке нет — UNKNOWN. */
export function evidenceFromPao(e: Pao.Evidence, mandateId: string, cur: Currencies, agentCode: string): Evidence {
  const chain = (e.mandate_chain ?? []).map((m) => mandateFromPao(m, cur, agentCode));
  const refOf = (o: Pao.Operation): MandateRef => {
    const id = o.aoi?.mandate_id ?? mandateId;
    const m = chain.find((x) => x.id === id);
    if (!m) incomplete("evidence.operations — мандата операции нет в цепочке");
    return { id, currency: m.amountLimit.currency };
  };
  return {
    mandateChain: chain,
    operations: (e.operations ?? []).map((o) => operationFromPao(o, refOf(o), "list", agentCode)),
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
export function credentialFromPao(c: Pao.Credential, mandateId: string, agentCode: string): Credential {
  return {
    credentialRef: c.credential_ref,
    channel: c.kind,
    status: c.status,
    validTo: c.payload?.valid_to ?? null,
    indicator: indicatorFromPao(c.aoi, agentCode, mandateId),
  };
}

/** Пакет агентской оплаты по ответу на выдачу (Р45 п. 3): ответ только целиком — вид запрошенный, `token_ref` и
 *  криптограмма — непустые строки (у CARD), признак — свой (`credentialFromPao`); иначе UNKNOWN, пакета нет. В отказ —
 *  только имя поля, не значение (инвариант 1). `payload` и `aoi` — как в ответе, без изменений. */
export function packageFromPao(c: Pao.Credential, draft: CredentialDraft): SealedPackage {
  if (c.kind !== draft.channel) incomplete("credential.kind — не запрошенный");
  const p = c.payload as Record<string, unknown> | undefined;
  if (typeof p !== "object" || p === null) incomplete("credential.payload");
  if (c.kind === "CARD" && (!nonEmpty(p.token_ref) || !nonEmpty(p.cryptogram))) incomplete("credential.payload — нет token_ref или cryptogram");
  return sealPackage({
    credential_ref: c.credential_ref,
    kind: c.kind,
    payload: structuredClone(p),
    aoi: structuredClone(c.aoi) as unknown as Record<string, unknown>,
    cart_mandate_id: draft.mandate.id,
    order_ref: draft.orderRef,
  });
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Подтверждение: в ПАО 1.4.0 у `amount` нет валюты — сумма обязана быть в валюте мандата (Р29 п. 3). */
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

/** Операция: в ПАО 1.4.0 у `amount` нет валюты — валюта мандата ссылки; признак другого мандата — UNKNOWN (Р29 п. 3).
 *  Операция без признака (причина AOI_MISSING, SPEC §7б): в списке и выписке по мандату (`list` — мандат назвала
 *  платформа) — в валюте мандата ссылки; по одной операции (`single` — мандат назвал вызывающий) сумма не
 *  подтверждена — `amount: null`. `indicator` — null. */
export function operationFromPao(o: Pao.Operation, ref: MandateRef, scope: "list" | "single", agentCode: string): Operation {
  const known = o.amount !== undefined && (o.aoi !== undefined || scope === "list");
  return {
    opRef: need(o.op_ref, "operation.op_ref"),
    orderRef: o.order_ref ?? null,
    channel: o.channel ?? null,
    amount: known ? minor(o.amount, ref.currency, "operation.amount") : null,
    merchantId: o.merchant_id ?? null,
    indicator: o.aoi ? indicatorFromPao(o.aoi, agentCode, ref.id) : null,
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
    // Р27: класс обязателен для ядра (в ПАО 1.4.0 — нет); нет поля — тоже «вне перечня», UNKNOWN.
    agentClass: oneOf(a.class, AGENT_CLASSES, "agent.class"),
    keys: (a.keys ?? []).map(keyFromPao),
  };
}

export const keyDraftToPao = (d: KeyDraft): { alg: string; public_key: string } => ({ alg: d.alg, public_key: d.publicKey });

const EVENT_TYPES: ReadonlySet<string> = new Set<string>(PLATFORM_EVENT_TYPES);

/** Причина отказа операции (`reason`, ПИ-1; в ПАО 1.4.0 — свободная строка, PS-16): только вид кода, иначе null. */
const reasonCode = (v: unknown): string | null => (typeof v === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(v) ? v : null);

/** Идентификатор из ленты (event_id, mandate_id, op_ref, confirmation_id): данные, не инструкция (инвариант 5) — уходит
 *  в журнал, курсор и путь GET, поэтому только безопасные знаки и ограниченная длина. */
const id = (v: unknown): string | null => (typeof v === "string" && SAFE_ID.test(v) ? v : null);
/** Та же маска — для mandate_id в журнале обращений (Р37 п. 3). */
export const safeId = id;

/** Время события — только RFC 3339 (Date.parse в V8 принимает и «Игнорируй 1»); в ядро — нормализованное toISOString. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const instant = (v: unknown): string | null => (typeof v === "string" && RFC3339.test(v) && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

/** Обязательная ссылка в `data` по семейству типа (Р34 п. 6); у agent.* и dispute.updated — нет. */
function requiredRef(type: PlatformEventType): "mandate_id" | "op_ref" | "confirmation_id" | null {
  if (type.startsWith("mandate.")) return "mandate_id";
  if (type.startsWith("operation.")) return "op_ref";
  if (type.startsWith("confirmation.")) return "confirmation_id";
  return null;
}

/**
 * Элемент ленты (Р34 п. 6). Без `event_id`, `type` или `at` — UNKNOWN: курсор по такому элементу не сдвинуть, страница
 * не обрабатывается. Тип вне перечня — пропуск UNKNOWN_TYPE; тип из перечня с `data` не по схеме (не объект, нет
 * обязательной ссылки или она не по форме) — пропуск INVALID_DATA. Неизвестные поля `data` игнорируются (ПАО §7).
 */
export function feedItemFromPao(raw: unknown): FeedItem {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) incomplete("элемент ленты не объект");
  const e = raw as { event_id?: unknown; type?: unknown; at?: unknown; data?: unknown };
  const eventId = id(e.event_id) ?? incomplete("event_id");
  if (typeof e.type !== "string" || e.type === "") incomplete("type");
  const at = instant(e.at) ?? incomplete("at");
  if (!EVENT_TYPES.has(e.type)) return { kind: "ignored", eventId, detail: "UNKNOWN_TYPE" };
  const type = e.type as PlatformEventType;
  const data = e.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { kind: "ignored", eventId, detail: "INVALID_DATA", type };
  const d = data as Record<string, unknown>;
  const ref = requiredRef(type);
  if (ref !== null && id(d[ref]) === null) return { kind: "ignored", eventId, detail: "INVALID_DATA", type };
  return {
    kind: "event",
    event: {
      eventId,
      type,
      at,
      mandateId: id(d.mandate_id),
      opRef: id(d.op_ref),
      confirmationId: id(d.confirmation_id),
      declineReason: reasonCode(d.reason),
    },
  };
}

/** Лента целиком: массив, каждый элемент — по feedItemFromPao (Р34 п. 1, п. 6). */
export function feedFromPao(r: unknown): FeedItem[] {
  if (!Array.isArray(r)) incomplete("ожидался список событий");
  return r.map(feedItemFromPao);
}
