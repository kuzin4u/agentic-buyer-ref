// Порт «платёжная платформа» (Р19). Ядро видит платформу только через него; адаптер (pao и следующие)
// переводит понятия платформы в доменные типы. Отказ — исключение PlatformFailure.
import type {
  AgentKey,
  AgentSelf,
  Confirmation,
  ConfirmationDraft,
  Credential,
  CredentialDraft,
  CurrencyCode,
  Dispute,
  DisputeDraft,
  KeyDraft,
  MandateRef,
  Operation,
  OperationRecord,
} from "../../shared/domain.js";
import type { EventsPort } from "./events.js";
import type { MandatePort } from "./mandates.js";
import type { Mutation } from "./mutation.js";
import type { SealedPackage } from "../payment-package/package.js";

export type { Mutation };

/** Заявление адаптера о возможностях и гарантиях платформы. По `guaranteeContour` ядро применяет Р3. */
export interface PlatformCapabilities {
  /** имя платформы для журнала */
  platform: string;
  /** версия протокола, по которой работает адаптер */
  protocolVersion: string;
  /** допустимое множество валют (Р29 п. 2); не источник валюты: валюта суммы — из мандата. Вне множества — отказ */
  currencies: readonly CurrencyCode[];
  /** мандат проверяется платформой (verify) и подписан человеком вне агента */
  verifiableMandate: boolean;
  /** спор о полномочиях разбирается по журналу согласий */
  disputeResolution: boolean;
  /** подтверждение человеком выше порога проходит через платформу */
  humanConfirmation: boolean;
  /** результат операции приходит подписанным событием платформы */
  signedEvents: boolean;
  /** операции идут в контуре гарантий (Р3) */
  guaranteeContour: boolean;
  /** условное исполнение (эскроу); пока не заявляется (Р17) */
  conditionalSettlement: boolean;
}

/** Версия протокола Платформы при подключении (Р33 п. 10). Несовместимая версия — не исход, а отказ
 *  PlatformFailure(PLATFORM_PROTOCOL_UNSUPPORTED) с остановкой агента. */
export type ProtocolCheck =
  | { status: "confirmed"; version: string }
  /** версия не определена: проверка — по первому ответу с мандатом; NO_VERSION — нет значений вида 1.x.y,
   *  BAD_RESPONSE — ответ не по схеме, NO_RESPONSE — адрес не отвечает или отказ */
  | { status: "unknown"; detail: "NO_VERSION" | "BAD_RESPONSE" | "NO_RESPONSE" };

/** Реквизит глазами ядра и пакет для продавца по нему (Р45 п. 3). */
export interface IssuedPackage {
  credential: Credential;
  sealed: SealedPackage;
}

/** Порт платформы целиком; части по составу AG-К5 выделяются по мере задач (мандаты — AG-05, MandatePort; события — AG-06, EventsPort). */
export interface PaymentPlatform extends MandatePort, EventsPort {
  capabilities(): PlatformCapabilities;
  /** Стадия 0, до допуска: версия протокола Платформы (Р33 п. 10); обращение без подписи. */
  checkProtocol(): Promise<ProtocolCheck>;
  /** Статус агента и ключи с их сроками — сроки задаёт платформа (РП23). */
  agentSelf(): Promise<AgentSelf>;
  /** Регистрация нового ключа до перехода на него (A2 п. 5.3); платформа сокращает сроки прежних ключей сама. */
  registerKey(draft: KeyDraft, m: Mutation): Promise<AgentKey>;

  issueCredential(draft: CredentialDraft, m: Mutation): Promise<Credential>;
  /** Реквизит и запечатанный пакет агентской оплаты по нему (Р45 п. 3): `payload` — только в пакете, ядру — `Credential`.
   *  Ответ не целиком (вид не тот, нет `token_ref` или криптограммы, признак не свой) — UNKNOWN, пакета нет. */
  issuePaymentPackage(draft: CredentialDraft, m: Mutation): Promise<IssuedPackage>;

  requestConfirmation(draft: ConfirmationDraft, m: Mutation): Promise<Confirmation>;
  getConfirmation(id: string): Promise<Confirmation>;

  /** Суммы операций — в валюте мандата ссылки; признак операции другого мандата — отказ UNKNOWN (Р29 п. 3). */
  listOperations(ref: MandateRef): Promise<Operation[]>;
  getOperation(opRef: string, ref: MandateRef): Promise<Operation>;
  /** Операция по `op_ref` из события, без привязки к мандату (Р49 п. 3): суммы — числом, признак — этого агента. */
  readOperation(opRef: string): Promise<OperationRecord>;

  openDispute(draft: DisputeDraft, m: Mutation): Promise<Dispute>;
  getDispute(id: string): Promise<Dispute>;
}
