// Адаптер ПАО к порту «платёжная платформа» (Р19). Единственное место ядра, где видны типы и клиент agentic-core/pao.
// Повторы клиента agentic-core отключены: клиент берёт retry из тела ответа при неизвестном коде (STATUS, ожидание CO-1).
// Повторяет адаптер — только по таблице ядра (RETRY_SAME_KEY), с прежним Idempotency-Key и новой подписью (Р21).
// AGENT_KEY_REVOKED (ROTATE_KEY): другой действующий ключ из порта подписи и один повтор тем же Idempotency-Key.
import { PAO_VERSION, PaoClient, type PaoCallArgs, type PaoOperationKey, type PaoOperations } from "@kuzin4u/agentic-core/pao";
import { PAO_RETRY_AFTER_MAX_SEC, type StandParams } from "../../../shared/config.js";
import { PlatformFailure } from "../../../shared/domain.js";
import type { PaymentPlatform, PlatformCapabilities, Mutation } from "../../ports/payment-platform.js";
import type { RequestSigning } from "../../ports/request-signing.js";
import { AGENT_STOP_CODES, ruleForFailure } from "../../declines/index.js";
import { toFailure } from "./errors.js";
import * as map from "./map.js";

/** Версия копии ПАО у агента (docs/core/protocol/SOURCE.md, Р20). */
export const PAO_COPY_VERSION = "1.2.0";

export function assertPaoVersion(actual: string = PAO_VERSION): void {
  if (actual !== PAO_COPY_VERSION) {
    throw new Error(`ПАО в agentic-core ${actual}, копия у агента ${PAO_COPY_VERSION}: переход — через /decision (Р20)`);
  }
}

export interface PaoPlatformOptions {
  baseUrl: string;
  agentCode: string;
  /** подпись из модуля signer через порт; ключ адаптеру не передаётся (инвариант 2) */
  signing: RequestSigning;
  params: StandParams;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  nonce?: () => string;
}

/** Retry-After в секундах; по копии ПАО — integer ≥ 0. Дату и мусор не принимаем: повтора не будет. */
function retryAfterSec(v: string | null): number | undefined {
  return v !== null && /^\d{1,6}$/.test(v.trim()) ? Number(v.trim()) : undefined;
}

function keyOf(m: Mutation): string {
  if (typeof m.idempotencyKey !== "string" || m.idempotencyKey.trim() === "") {
    throw new PlatformFailure("UNKNOWN", "never", null, 0, null, "пустой Idempotency-Key, обращение не отправлено");
  }
  return m.idempotencyKey;
}

export class PaoPlatform implements PaymentPlatform {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: PaoPlatformOptions) {
    assertPaoVersion();
    this.fetchImpl = o.fetch ?? globalThis.fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  capabilities(): PlatformCapabilities {
    return {
      platform: "pao",
      protocolVersion: PAO_COPY_VERSION,
      verifiableMandate: true,
      disputeResolution: true,
      humanConfirmation: true,
      // Подпись событий и ответов Платформы не проверяется до AG-06.
      signedEvents: false,
      guaranteeContour: true,
      conditionalSettlement: false,
    };
  }

  /** Одно обращение без повторов клиента; тайм-аут — pao_request_timeout_ms. Retry-After ответа — в last. */
  private client(last: { retryAfter?: number }, signer: ReturnType<RequestSigning["current"]>): PaoClient {
    const timeoutMs = this.o.params.pao_request_timeout_ms;
    const f = this.fetchImpl;
    return new PaoClient({
      baseUrl: this.o.baseUrl,
      agentCode: this.o.agentCode,
      signer,
      maxAttempts: 1,
      fetch: async (url, init) => {
        const res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        last.retryAfter = retryAfterSec(res.headers.get("retry-after"));
        return res;
      },
      ...(this.o.now && { now: this.o.now }),
      ...(this.o.nonce && { nonce: this.o.nonce }),
      idempotencyKey: () => {
        throw new Error("Idempotency-Key задаёт ядро (инвариант 9)");
      },
    });
  }

  private async call<K extends PaoOperationKey, R>(
    op: K,
    args: PaoCallArgs<K>,
    to: (r: PaoOperations[K]["response"]) => R,
  ): Promise<R> {
    const key = args.idempotencyKey ?? null;
    let waitedSec = 0;
    let rotations = 0;
    for (let attempt = 1; ; ) {
      const last: { retryAfter?: number } = {};
      const signer = this.o.signing.current(); // остановлен — SignerStopped, обращения нет
      let failure: PlatformFailure;
      try {
        const r = await this.client(last, signer).call(op, args);
        return to(r);
      } catch (e) {
        failure = toFailure(e, key);
      }
      const rule = ruleForFailure(failure.code);
      // Отказ в допуске — остановка агента целиком (SPEC §7а, П03).
      if (AGENT_STOP_CODES.has(failure.code)) {
        this.o.signing.stop(failure.code);
        throw failure;
      }
      // Отозванный ключ: другой действующий (нет — SignerStopped); повтор не больше maxRetries за обращение.
      if (rule.action === "ROTATE_KEY") {
        this.o.signing.keyRevoked(signer.kid, failure);
        if (rotations >= (rule.maxRetries ?? 0)) throw failure;
        rotations++;
        continue;
      }
      // Повтор — только по таблице ядра, в пределах попыток и потолка ожидания (инвариант 4, Р20).
      if (rule.action !== "RETRY_SAME_KEY" || attempt >= this.o.params.pao_max_attempts) throw failure;
      attempt++;
      // Без Retry-After повтор не раньше срока невозможен — не повторяем (ПАО §6, инвариант 9).
      const waitSec = last.retryAfter;
      if (waitSec === undefined || waitedSec + waitSec > PAO_RETRY_AFTER_MAX_SEC) throw failure;
      waitedSec += waitSec;
      await this.sleep(waitSec * 1000);
    }
  }

  /** Агент не ACTIVE по ответу платформы (EXCLUDED — 200 по РП23 п. 6.3) — остановка подписи, кто бы ни спросил. */
  async agentSelf() {
    const self = await this.call("GET /pao/v1/agent", {}, map.agentSelfFromPao);
    if (self.status !== "ACTIVE") this.o.signing.stop(`AGENT_${self.status}`);
    return self;
  }

  async registerKey(draft: Parameters<PaymentPlatform["registerKey"]>[0], m: Mutation) {
    return this.call("POST /pao/v1/agent/keys", { body: map.keyDraftToPao(draft), idempotencyKey: keyOf(m) }, map.keyFromPao);
  }

  async requestMandate(draft: Parameters<PaymentPlatform["requestMandate"]>[0], m: Mutation) {
    return this.call("POST /pao/v1/mandates", { body: map.mandateDraftToPao(draft), idempotencyKey: keyOf(m) }, map.mandateFromPao);
  }

  getMandate(id: string) {
    return this.call("GET /pao/v1/mandates/{id}", { path: { id } }, map.mandateFromPao);
  }

  verifyMandate(id: string) {
    return this.call("GET /pao/v1/mandates/{id}/verify", { path: { id } }, map.mandateCheckFromPao);
  }

  async relinquishMandate(id: string, m: Mutation) {
    return this.call("POST /pao/v1/mandates/{id}/relinquish", { path: { id }, idempotencyKey: keyOf(m) }, map.mandateFromPao);
  }

  mandateEvidence(id: string) {
    return this.call("GET /pao/v1/mandates/{id}/evidence", { path: { id } }, map.evidenceFromPao);
  }

  async issueCredential(draft: Parameters<PaymentPlatform["issueCredential"]>[0], m: Mutation) {
    return this.call("POST /pao/v1/credentials", { body: map.credentialDraftToPao(draft), idempotencyKey: keyOf(m) }, map.credentialFromPao);
  }

  async requestConfirmation(draft: Parameters<PaymentPlatform["requestConfirmation"]>[0], m: Mutation) {
    return this.call(
      "POST /pao/v1/confirmations",
      { body: map.confirmationDraftToPao(draft), idempotencyKey: keyOf(m) },
      map.confirmationFromPao,
    );
  }

  getConfirmation(id: string) {
    return this.call("GET /pao/v1/confirmations/{id}", { path: { id } }, map.confirmationFromPao);
  }

  listOperations(mandateId: string) {
    return this.call("GET /pao/v1/operations", { query: { mandate_id: mandateId } }, (r) => need(r).map(map.operationFromPao));
  }

  getOperation(opRef: string) {
    return this.call("GET /pao/v1/operations/{op_ref}", { path: { op_ref: opRef } }, map.operationFromPao);
  }

  async openDispute(draft: Parameters<PaymentPlatform["openDispute"]>[0], m: Mutation) {
    return this.call("POST /pao/v1/disputes", { body: map.disputeDraftToPao(draft), idempotencyKey: keyOf(m) }, map.disputeFromPao);
  }

  getDispute(id: string) {
    return this.call("GET /pao/v1/disputes/{id}", { path: { id } }, map.disputeFromPao);
  }
}

function need<T>(r: T[] | undefined): T[] {
  if (!Array.isArray(r)) throw new PlatformFailure("UNKNOWN", "never", null, 200, null, "ответ ПАО неполон: ожидался список");
  return r;
}
