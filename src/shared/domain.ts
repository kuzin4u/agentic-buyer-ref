// Доменные типы ядра (Р19). Ядро работает только с ними; перевод из понятий платформы — в адаптерах.
// Сумма — Money agentic-core: целое число минимальных единиц и код валюты (Р29). Ограничения на валюту в типе нет:
// допустимое множество заявляет адаптер (PlatformCapabilities.currencies). Платёжных реквизитов здесь нет (инвариант 1).
import type { CurrencyCode, Money } from "@kuzin4u/agentic-core";

export type { CurrencyCode, Money };

/** Ссылка на мандат с его валютой (Р29 п. 3): валюта — из мандата платформы, по ней адаптер дополняет суммы,
 *  у которых в протоколе платформы нет поля валюты. */
export interface MandateRef {
  id: string;
  currency: CurrencyCode;
}

export type MandateKind = "INTENT" | "CART";
export type MandateStatus = "PENDING_SIGNATURE" | "ACTIVE" | "REJECTED" | "EXPIRED" | "REVOKED" | "EXHAUSTED";
export type ConfirmationMode = "IMMEDIATE" | "AUTONOMOUS";
export type SignatureLevel = "simple" | "qualified" | "gov_id";

export interface CartLine {
  sku: string;
  qty: number;
  price: Money;
}

export interface Cart {
  merchantId: string;
  lines: CartLine[];
  total: Money;
}

/** Что ядро просит у человека: пределы поручения. */
export interface MandateDraft {
  kind: MandateKind;
  parentId: string | null;
  subject: string;
  amountLimit: Money;
  validTo: string;
  merchantScope: string[];
  principalRef: string;
  confirmationMode: ConfirmationMode;
  /** ключевые параметры показаны отдельной карточкой (Т3а) */
  keyTermsShown: boolean;
  cart: Cart | null;
}

export interface Mandate extends MandateDraft {
  id: string;
  status: MandateStatus;
  signatureLevel: SignatureLevel | null;
  /** порядок отзыва — ссылка на соглашение банка с клиентом; задаёт Платформа, агент только показывает (A7 п. 2.2, Р33 п. 4) */
  revocationOrder: string;
}

/** Результат проверки мандата платформой. Остаток — только отсюда (инвариант 6). */
export interface MandateCheck {
  outcome: "CONFIRMED" | "OUT_OF_SCOPE" | "STATE_UNKNOWN";
  amountLeft: Money;
  validTo: string;
  asOf: string | null;
}

export interface Evidence {
  mandateChain: Mandate[];
  operations: Operation[];
  integrity: "OK" | "BROKEN";
}

/** Агентский признак операции. */
export interface AgentIndicator {
  agentCode: string;
  mandateId: string;
}

export type PaymentChannel = "CARD" | "SBP";

export interface CredentialDraft {
  mandate: MandateRef;
  orderRef: string;
  merchantId: string;
  amountMax: Money;
  channel: PaymentChannel;
}

/** Реквизит глазами ядра: только ссылка и состояние. Криптограмма и токен в ядро не попадают (инвариант 1). */
export interface Credential {
  credentialRef: string;
  channel: PaymentChannel;
  status: "ISSUED" | "USED" | "EXPIRED" | "REVOKED";
  validTo: string | null;
  indicator: AgentIndicator;
}

export interface ConfirmationDraft {
  mandate: MandateRef;
  merchantId: string;
  amount: Money;
  summary: string;
  channel: "UPK" | "ISSUER_APP";
}

export interface Confirmation {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  /** ссылка для человека (страница подтверждения) */
  link: string | null;
  confirmationRef: string | null;
  expiresAt: string | null;
}

export type OperationStatus = "AUTHORIZED" | "DECLINED" | "CONFIRMATION_REQUIRED" | "SETTLED" | "REVERSED" | "REFUNDED";

export interface Operation {
  opRef: string;
  orderRef: string | null;
  channel: PaymentChannel | null;
  amount: Money | null;
  merchantId: string | null;
  indicator: AgentIndicator | null;
  status: OperationStatus;
  /** причина отклонения как её прислала платформа (SPEC §7б) */
  declineReason: string | null;
}

export interface DisputeDraft {
  opRef: string;
  reason: "NOT_AUTHORIZED" | "QUALITY" | "NOT_DELIVERED";
  principalAck: string;
}

export interface Dispute {
  id: string;
  opRef: string;
  inScope: boolean | null;
  decision: "REFUND_NO_MERITS" | "ORDINARY_PROCEDURE" | "REJECTED" | "PENDING";
}

export interface AgentStatus {
  agentCode: string;
  status: "ACTIVE" | "SUSPENDED" | "EXCLUDED";
}

/** Ключ агента в реестре платформы. Сроки — только из ответа платформы (РП23): агент их не вычисляет. */
export interface AgentKey {
  kid: string;
  alg: string;
  /** DER SPKI, base64 */
  publicKey: string;
  validFrom: string | null;
  validTo: string | null;
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
}

/** Класс агента в реестре (ПАО AgentSelf.class); ядро допускается только как BUYER (Р27). */
export type AgentClass = "BUYER" | "SELLER" | "SURFACE" | "SERVICE";

/** Сведения платформы об агенте: статус, класс и ключи (GET /pao/v1/agent). */
export interface AgentSelf extends AgentStatus {
  /** в ПАО 1.4.0 поле необязательно; для ядра обязательно — нет поля или значение вне перечня → UNKNOWN (Р27) */
  agentClass: AgentClass;
  keys: AgentKey[];
}

/** Регистрация нового ключа: только открытая часть (инвариант 2). */
export interface KeyDraft {
  alg: string;
  publicKey: string;
}

/** Перечень типов событий ПАО 1.4.0 (§5); вне перечня — пропуск с записью в журнал (ПАО §7, Р34 п. 6). */
export const PLATFORM_EVENT_TYPES = [
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
] as const;

/** События платформы в понятиях ядра; исходное тело в ядро не передаётся. */
export type PlatformEventType = (typeof PLATFORM_EVENT_TYPES)[number];

export interface PlatformEvent {
  eventId: string;
  type: PlatformEventType;
  at: string;
  mandateId: string | null;
  opRef: string | null;
  confirmationId: string | null;
  declineReason: string | null;
}

/** Класс повтора (SPEC §7а). `new_key` — новый ключ подписи агента, не ключ идемпотентности. */
export type RetryClass = "never" | "after_fix" | "same_key" | "new_key" | "after_human";

/** Коды отказа ядра: ошибки платформы (SPEC §7а) и неподтверждённое состояние. */
export type FailureCode =
  | "AGENT_UNKNOWN"
  | "AGENT_SUSPENDED"
  | "AGENT_KEY_REVOKED"
  | "SIGNATURE_INVALID"
  | "MANDATE_NOT_FOUND"
  | "MANDATE_EXPIRED"
  | "MANDATE_REVOKED"
  | "MANDATE_SCOPE"
  | "PRINCIPAL_SIGNATURE_PENDING"
  | "LIMIT_EXCEEDED"
  | "STATE_UNAVAILABLE"
  | "CONFIRMATION_REQUIRED"
  | "CREDENTIAL_INVALID"
  | "CREDENTIALS_FORBIDDEN"
  | "IDEMPOTENCY_REQUIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "REQUEST_INVALID"
  | "KEY_INVALID"
  /** код агента вне ПАО (Р33 п. 4): ответ с мандатом без порядка отзыва — мандат не подтверждён (A7 п. 2.2); стоп без
   *  повтора, событие в журнал. Только при подтверждённой версии ПАО Платформы; до подтверждения —
   *  PLATFORM_PROTOCOL_UNSUPPORTED (Р33 п. 10) */
  | "MANDATE_REVOCATION_ORDER_MISSING"
  /** код агента вне ПАО (Р33 п. 10): Платформа ниже ПАО 1.4.0 по конфигурации или, пока версия не определена, первый
   *  ответ с мандатом без порядка отзыва — останавливается агент целиком, событие в журнал */
  | "PLATFORM_PROTOCOL_UNSUPPORTED"
  /** отказ клиента ПАО ядра (К18, PAO_CLIENT_DIAG; Р37 п. 1): ответ 3xx — перенаправлению не следуем, запрос на другой
   *  адрес не уходил; отказ без повтора, агент не останавливается (адрес Платформы — настройка оператора) */
  | "PAO_CLIENT_REDIRECT"
  /** отказ клиента ПАО ядра (К18; Р37 п. 1): подписанная операция у клиента без подписанта — дефект агента, запрос в
   *  сеть не уходил */
  | "PAO_CLIENT_SIGNER_MISSING"
  /** код не опознан или ответа нет — fail-closed (инвариант 4) */
  | "UNKNOWN";

/** Отказ платформы в понятиях ядра. */
export class PlatformFailure extends Error {
  constructor(
    readonly code: FailureCode,
    readonly retry: RetryClass,
    /** код, как его прислала платформа; для журнала */
    readonly platformCode: string | null,
    readonly httpStatus: number,
    readonly idempotencyKey: string | null,
    /** только фиксированный текст адаптера; тело ответа и сообщения исключений сюда не попадают (инвариант 1) */
    detail?: string,
  ) {
    super(`Отказ платформы: ${code}, HTTP ${httpStatus}${detail ? `: ${detail}` : ""}`);
    this.name = "PlatformFailure";
  }
}
