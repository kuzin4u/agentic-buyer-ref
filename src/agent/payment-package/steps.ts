// Шаги стадий 4–6 профиля contour (Р45 п. 2, 6; Р47 п. 2–4; Р49 п. 3–6): реквизит по ПАО и пакет агентской оплаты
// продавцу, итог — из события operation.* и GET операции (модуль операций), ожидание подтверждения человеком, расчёт по
// operation.settled. Собирается в месте сборки из порта платформы, адаптера витрин и модулей подтверждений и операций.
// Ответ продавца — только в журнале адаптера витрин и повод ждать запрос подтверждения (инвариант 8).
import type { Journal } from "../journal/index.js";
import type { OperationOutcome, OperationWait, SettleOutcome } from "../operations/index.js";
import type { IssuedPackage } from "../ports/payment-platform.js";
import type { Mutation } from "../ports/mutation.js";
import { PaymentFailure, ShopFailure, type ConfirmationOutcome, type PaymentContext, type PaymentSteps, type ShopPaymentPort, type ShopPaymentReply } from "../ports/shop.js";
import type { StandParams } from "../../shared/config.js";
import type { CredentialDraft, Mandate, Operation } from "../../shared/domain.js";
import { SAFE_ID } from "../../shared/ids.js";
import { orderRefIssue } from "./order-ref.js";

export interface ContourPaymentOptions {
  platform: { issuePaymentPackage(draft: CredentialDraft, m: Mutation): Promise<IssuedPackage> };
  shop: ShopPaymentPort;
  journal: Journal;
  /** модуль подтверждений (Р47 п. 3–4): ожидание запроса ADP и решения человека; появление запроса — гонка стадии 5 */
  confirmations: {
    wait(o: { signal: AbortSignal; onPending?: () => void }): Promise<ConfirmationOutcome>;
    mark(): number;
    arrival(signal: AbortSignal, after: number): Promise<void>;
  };
  /** модуль операций (Р49 п. 3–6): итог по order_ref на стадии 5, расчёт по op_ref на стадии 6 */
  operations: {
    expect(orderRef: string, cart: Mandate): OperationWait;
    settle(authorized: Operation, signal: AbortSignal, deadline?: number): Promise<SettleOutcome>;
  };
  params: Pick<StandParams, "operation_outcome_max_delay_sec" | "confirmation_wait_ms" | "reservation_ttl_sec">;
  now?: () => Date;
}

export class ContourPayment implements PaymentSteps {
  private readonly now: () => Date;

  constructor(private readonly o: ContourPaymentOptions) {
    this.now = o.now ?? (() => new Date());
  }

  /** Стадия 4 (Р47 п. 3–4): ожидание — после DECLINED продавца, привязка и статус по GET — модуль подтверждений; сам агент
   *  ничего не подтверждает (инвариант 7). */
  confirm(_c: PaymentContext, notify: () => void, signal: AbortSignal): Promise<ConfirmationOutcome> {
    return this.o.confirmations.wait({ signal, onPending: notify });
  }

  /** Стадия 5 (Т8): номер заказа — до обращения к Платформе (второй рубеж после стадии 3); реквизит по CART под ключом
   *  вызывающего; пакет — продавцу. Покупка остановлена — ни реквизита, ни пакета. Реквизит не ISSUED (повтор под ключом
   *  после погашения или срока) — пакета нет, CREDENTIAL_INVALID. Итог — операция, привязанная по order_ref (Р49 п. 5):
   *  ожидание — до отправки пакета. Ответ продавца DECLINED — ещё и гонка с запросом подтверждения (ADP могла потребовать
   *  подтверждения, Р47 п. 4): пришёл раньше операции — CONFIRMATION_REQUIRED, стадия 4. Итога нет в срок —
   *  OPERATION_RESULT_UNCONFIRMED; операция не сходится с покупкой — OPERATION_REPLY_MISMATCH. */
  async authorize(c: PaymentContext, m: Mutation): Promise<Operation> {
    const orderRef = c.order.orderId;
    const issue = orderRefIssue(orderRef);
    if (issue !== null) {
      // значение номера не пишется нигде — только причина (Р45 п. 2.1)
      this.o.journal.record({ at: this.now().toISOString(), kind: "agent.refused", reason: "SHOP_ORDER_REF_INVALID", detail: issue, ...mandateRef(c.cart.id) });
      throw new PaymentFailure("SHOP_ORDER_REF_INVALID");
    }
    // корзина CART есть: без неё конвейер остановился до стадии 5 (MANDATE_REPLY_MISMATCH)
    const basket = c.cart.cart!;
    // покупку остановили (параллельный вызов, ворота) — обращений за реквизитом нет (Р45, Б2в (а))
    c.signal.throwIfAborted();
    const { credential, sealed } = await this.o.platform.issuePaymentPackage(
      {
        mandate: { id: c.cart.id, currency: basket.total.currency },
        orderRef,
        merchantId: basket.merchantId,
        amountMax: { ...basket.total },
        channel: "CARD",
      },
      m,
    );
    if (credential.status !== "ISSUED") throw new PaymentFailure("CREDENTIAL_INVALID");
    // остановили, пока выдавался реквизит, — пакет не уходит; реквизит истечёт неиспользованным. Проверка и отметка
    // «пакет уходит» — синхронно, без ожидания между ними (Р45, Б2в)
    c.signal.throwIfAborted();
    // ожидание итога — до отправки пакета: событие могут прочитать, пока продавец отвечает (Р49 п. 3); отметка запросов
    // подтверждения — тоже до отправки: в гонке стадии 5 — только пришедшие после (ревью КТ1 № 5)
    const wait = this.o.operations.expect(orderRef, c.cart);
    const mark = this.o.confirmations.mark();
    try {
      c.sending();
      let reply: ShopPaymentReply | null = null;
      try {
        reply = await this.o.shop.pay({ shopId: c.shopId, orderId: orderRef, cartMandateId: c.cart.id, package: sealed });
      } catch (e) {
        // пакет ушёл (или мог уйти): отказ витрины, нет ответа, ответ не по схеме — итог по событию, «деньги не
        // списывались» не говорим (Р45, Б1а; инвариант 8); код витрины — detail записи shop.call
        if (!(e instanceof ShopFailure)) throw e;
      }
      return await this.#outcome(wait, reply, mark, c.signal);
    } finally {
      wait.close();
    }
  }

  /** Итог стадии 5 (Р49 п. 5): первое из — привязанная операция или (только при DECLINED продавца) запрос подтверждения,
   *  пришедший после отправки пакета. */
  async #outcome(wait: OperationWait, reply: ShopPaymentReply | null, mark: number, signal: AbortSignal): Promise<Operation> {
    const delayMs = this.o.params.operation_outcome_max_delay_sec * 1000;
    let outcome: OperationOutcome | "CONFIRMATION";
    if (reply?.status === "DECLINED") {
      // слова продавца не итог (инвариант 8): DECLINED — повод ждать и запрос подтверждения; гонка снимается вместе.
      // Покупку остановили, пока продавец отвечал, — гонка не начинается (ревью КТ1 № 4)
      const race = new AbortController();
      const stop = () => race.abort(signal.reason);
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
      try {
        outcome = await Promise.race([
          wait.outcome(Math.max(delayMs, this.o.params.confirmation_wait_ms), race.signal),
          this.o.confirmations.arrival(race.signal, mark).then(() => "CONFIRMATION" as const),
        ]);
      } finally {
        signal.removeEventListener("abort", stop);
        race.abort(new Error("гонка стадии 5 решена"));
      }
    } else {
      outcome = await wait.outcome(delayMs, signal);
    }
    if (outcome === "CONFIRMATION") throw new PaymentFailure("CONFIRMATION_REQUIRED");
    if (outcome.kind === "MISMATCH") throw new PaymentFailure("OPERATION_REPLY_MISMATCH");
    if (outcome.kind === "NONE") throw new PaymentFailure("OPERATION_RESULT_UNCONFIRMED");
    return outcome.operation;
  }

  /** Стадия 6 (Р49 п. 6, Р51 п. 2): расчёт по событию и GET; без `signal` — ждёт до расчёта или границы reservation_ttl_sec
   *  от `authorizedAt` (нет — от начала ожидания). Прервано — SETTLEMENT_PENDING (ожидание, не остановка); операция не та —
   *  OPERATION_REPLY_MISMATCH; GET не подтверждён или граница прошла без итога — OPERATION_RESULT_UNCONFIRMED. */
  async settle(op: Operation, signal?: AbortSignal, authorizedAt?: Date): Promise<Operation> {
    const deadline = (authorizedAt ?? this.now()).getTime() + this.o.params.reservation_ttl_sec * 1000;
    // без сигнала ждёт до расчёта или границы; конвейер передаёт свой сигнал остановки покупки (ревью КТ1 № 7а)
    const r = await this.o.operations.settle(op, signal ?? new AbortController().signal, deadline);
    if (r.kind === "PENDING") throw new PaymentFailure("SETTLEMENT_PENDING");
    if (r.kind === "MISMATCH") throw new PaymentFailure("OPERATION_REPLY_MISMATCH");
    if (r.kind === "UNREAD" || r.kind === "EXPIRED") throw new PaymentFailure("OPERATION_RESULT_UNCONFIRMED");
    return r.operation;
  }
}

const mandateRef = (id: string): { mandate?: string } => (SAFE_ID.test(id) ? { mandate: id } : {});
