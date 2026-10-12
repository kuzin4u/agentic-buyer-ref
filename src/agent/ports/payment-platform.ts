// Порт «платёжная платформа» (Р19). Ядро видит платформу только через него; адаптер (pao и следующие)
// переводит понятия платформы в доменные типы. Отказ — исключение PlatformFailure.
import type {
  AgentKey,
  AgentSelf,
  Confirmation,
  ConfirmationDraft,
  Credential,
  CredentialDraft,
  Dispute,
  DisputeDraft,
  Evidence,
  KeyDraft,
  Mandate,
  MandateCheck,
  MandateDraft,
  Operation,
} from "../../shared/domain.js";

/** Заявление адаптера о возможностях и гарантиях платформы. По `guaranteeContour` ядро применяет Р3. */
export interface PlatformCapabilities {
  /** имя платформы для журнала */
  platform: string;
  /** версия протокола, по которой работает адаптер */
  protocolVersion: string;
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

/** Ключ идемпотентности задаёт ядро: повтор — с прежним ключом (инвариант 9). */
export interface Mutation {
  idempotencyKey: string;
}

export interface PaymentPlatform {
  capabilities(): PlatformCapabilities;
  /** Статус агента и ключи с их сроками — сроки задаёт платформа (РП23). */
  agentSelf(): Promise<AgentSelf>;
  /** Регистрация нового ключа до перехода на него (A2 п. 5.3); платформа сокращает сроки прежних ключей сама. */
  registerKey(draft: KeyDraft, m: Mutation): Promise<AgentKey>;

  requestMandate(draft: MandateDraft, m: Mutation): Promise<Mandate>;
  getMandate(id: string): Promise<Mandate>;
  verifyMandate(id: string): Promise<MandateCheck>;
  relinquishMandate(id: string, m: Mutation): Promise<Mandate>;
  mandateEvidence(id: string): Promise<Evidence>;

  issueCredential(draft: CredentialDraft, m: Mutation): Promise<Credential>;

  requestConfirmation(draft: ConfirmationDraft, m: Mutation): Promise<Confirmation>;
  getConfirmation(id: string): Promise<Confirmation>;

  listOperations(mandateId: string): Promise<Operation[]>;
  getOperation(opRef: string): Promise<Operation>;

  openDispute(draft: DisputeDraft, m: Mutation): Promise<Dispute>;
  getDispute(id: string): Promise<Dispute>;
}
