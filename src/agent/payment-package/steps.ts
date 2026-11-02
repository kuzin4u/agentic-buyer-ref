// Шаги стадий 4–6 профиля contour (Р45 п. 2, 6; Р47 п. 2–4; Р49 п. 3–6): реквизит по ПАО и пакет агентской оплаты
// продавцу, итог — из события operation.* и GET операции (модуль операций), ожидание подтверждения человеком, расчёт по
// operation.settled. Собирается в месте сборки из порта платформы, адаптера витрин и модулей подтверждений и операций.
// Ответ продавца — только в журнале адаптера витрин и повод ждать запрос подтверждения (инвариант 8).
import type { Journal } from "../journal/index.js";
import type { OperationOutcome, OperationSkip, OperationWait, SettleOutcome, WatchAfter } from "../operations/index.js";
import type { IssuedPackage } from "../ports/payment-platform.js";
import type { Mutation } from "../ports/mutation.js";
import { PaymentFailure, ShopFailure, type ConfirmationOutcome, type LateNotice, type PaymentContext, type PaymentSteps, type ShopPaymentPort, type ShopPaymentReply } from "../ports/shop.js";
import type { StandParams } from "../../shared/config.js";
import { PlatformFailure, type Credential, type CredentialDraft, type Mandate, type Operation } from "../../shared/domain.js";
import { SAFE_ID } from "../../shared/ids.js";
import { orderRefIssue } from "./order-ref.js";

export interface ContourPaymentOptions {
  platform: {
    issuePaymentPackage(draft: CredentialDraft, m: Mutation): Promise<IssuedPackage>;
    /** статус реквизита перед повтором оплаты (дополнение 1 к Р69 п. 4) */
    credentialStatus(ref: string, mandateId: string): Promise<Credential>;
  };
  shop: ShopPaymentPort;
  journal: Journal;
  /** модуль подтверждений (Р47 п. 3–4): ожидание запроса ADP и решения человека; появление запроса — гонка стадии 5 */
  confirmations: {
    wait(o: { signal: AbortSignal; onPending?: (link?: string) => void; onApproved?: (ref: string, expiresAt: string) => void }): Promise<ConfirmationOutcome>;
    mark(): number;
    arrival(signal: AbortSignal, after: number): Promise<void>;
  };
  /** модуль операций (Р49 п. 3–6): итог по order_ref на стадии 5, расчёт по op_ref на стадии 6 */
  operations: {
    expect(orderRef: string, cart: Mandate): OperationWait;
    /** поиск операции по CART, когда итога по событию нет (Р51 п. 5): один раз на попытку оплаты — при повторе
     *  после обрыва (Р69 п. 4) их не больше двух на покупку */
    lookup(orderRef: string, cart: Mandate, notice?: LateNotice, skip?: OperationSkip): Promise<OperationOutcome>;
    /** `notice` — под наблюдение после итога ставит сам модуль, в момент итога (Р51 п. 4) */
    settle(authorized: Operation, signal: AbortSignal, deadline?: number, notice?: LateNotice): Promise<SettleOutcome>;
    /** наблюдение после итога покупки (Р51 п. 4) */
    watch(op: Operation, after: WatchAfter, notice: LateNotice): void;
  };
  params: Pick<StandParams, "operation_outcome_max_delay_sec" | "confirmation_wait_ms" | "reservation_ttl_sec">;
  now?: () => Date;
}

export class ContourPayment implements PaymentSteps {
  private readonly now: () => Date;
  /** Р70: одобренные запросы по номеру заказа — `confirmation_ref` и срок до `resume`; только в памяти шагов, не в
   *  контексте, журнале и исходе (инвариант 1). Берётся один раз. */
  readonly #approved = new Map<string, { ref: string; expiresAt: string }>();

  constructor(private readonly o: ContourPaymentOptions) {
    this.now = o.now ?? (() => new Date());
  }

  /** Стадия 4 (Р47 п. 3–4): ожидание — после ответа продавца на пакет, привязка и статус по GET — модуль подтверждений;
   *  сам агент ничего не подтверждает (инвариант 7). APPROVED — ссылка и срок запроса запоминаются для `resume` (Р70). */
  async confirm(c: PaymentContext, notify: (link?: string) => void, signal: AbortSignal): Promise<ConfirmationOutcome> {
    const order = c.order.orderId;
    this.#approved.delete(order);
    return this.o.confirmations.wait({ signal, onPending: notify, onApproved: (ref, expiresAt) => void this.#approved.set(order, { ref, expiresAt }) });
  }

  /** Стадия 5 после одобрения человеком (Р69 п. 0, Р70): ссылка продавцу — продавец повторяет авторизацию новой операцией
   *  с прежним реквизитом (нового реквизита нет). Срок запроса Платформы прошёл — POST нет, CONFIRMATION_EXPIRED (В3 (а)).
   *  Ожидание операции по order_ref — до отправки. Неизвестный исход POST (нет ответа, не по схеме, любой 5xx) — один
   *  повтор того же запроса; отказ витрины (4xx) — без повтора (В1 (а)). При любом ответе — итог по
   *  событию, затем один поиск по CART: 409 бывает, пока авторизация со ссылкой идёт. Операций нет после отказа витрины —
   *  CONFIRMATION_NOT_DELIVERED; иначе итога нет — OPERATION_RESULT_UNCONFIRMED. */
  async resume(c: PaymentContext): Promise<Operation> {
    const orderRef = c.order.orderId;
    const approved = this.#approved.get(orderRef);
    this.#approved.delete(orderRef);
    const confirm = this.o.shop.confirm?.bind(this.o.shop);
    if (approved === undefined || confirm === undefined) throw new PaymentFailure("CONFIRMATION_NOT_DELIVERED");
    // срок — Платформы: ссылка у неё истекает не позже заказа у продавца (РП72 п. 4); строго «позже сейчас»
    if (!(Date.parse(approved.expiresAt) > this.now().getTime())) throw new PaymentFailure("CONFIRMATION_EXPIRED");
    c.signal.throwIfAborted();
    const wait = this.o.operations.expect(orderRef, c.cart);
    // операции CONFIRMATION_REQUIRED (первой попытки и повторного требования) — не кандидаты итога (дополнение 2 к Р69
    // п. 4, правило по стенду v0.37.0: событий у них нет, видит их только поиск по CART)
    wait.skip(confirmationRequired);
    const req = { shopId: c.shopId, orderId: orderRef, cartMandateId: c.cart.id, confirmationRef: approved.ref };
    try {
      let refused = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        c.signal.throwIfAborted();
        c.sending();
        try {
          await confirm(req, attempt);
          break;
        } catch (e) {
          if (!(e instanceof ShopFailure)) throw e;
          if (e.code !== "SHOP_ORDER_STATE_UNKNOWN") {
            refused = true;
            break;
          }
        }
      }
      const looked: { r: OperationOutcome | null } = { r: null };
      let op: Operation;
      try {
        op = await this.#outcome(wait, null, 0, c.signal, async () => {
          const r = await this.o.operations.lookup(orderRef, c.cart, c.notice, confirmationRequired);
          looked.r = r;
          return r;
        });
      } catch (e) {
        const absent = looked.r?.kind === "ABSENT" ? looked.r.skipped : null;
        if (absent !== null && e instanceof PaymentFailure && e.code === "OPERATION_RESULT_UNCONFIRMED") {
          // других операций нет, CONFIRMATION_REQUIRED больше одной — первая и повторное требование (правило по стенду
          // v0.37.0); ровно одна — какая, не различить: op_ref первой агенту неизвестен — итога нет (fail-closed)
          if (absent > 1) throw new PaymentFailure("DECLINED_CONFIRMATION_REQUIRED");
          if (refused && absent === 0) throw new PaymentFailure("CONFIRMATION_NOT_DELIVERED");
        }
        throw e;
      }
      if (op.status === "REVERSED" && c.notice !== undefined) this.o.operations.watch(op, "REVERSED", c.notice);
      return op;
    } finally {
      wait.close();
    }
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
        channel: c.channel,
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
    const req = { shopId: c.shopId, orderId: orderRef, cartMandateId: c.cart.id };
    try {
      let op: Operation;
      for (let attempt = 1; ; attempt++) {
        const mark = this.o.confirmations.mark();
        c.sending();
        let reply: ShopPaymentReply | null = null;
        let unknown = false;
        try {
          reply = await this.o.shop.pay({ ...req, package: sealed }, attempt);
        } catch (e) {
          // пакет ушёл (или мог уйти): отказ витрины, нет ответа, ответ не по схеме — итог по событию, «деньги не
          // списывались» не говорим (Р45, Б1а; инвариант 8); код витрины — detail записи shop.call
          if (!(e instanceof ShopFailure)) throw e;
          unknown = e.code === "SHOP_ORDER_STATE_UNKNOWN";
        }
        const looked: { kind: OperationOutcome["kind"] | null } = { kind: null };
        // попытка 2: её отказ CREDENTIAL_INVALID — не кандидат итога (дополнение 2 к Р69 п. 3)
        const lookup = async () => {
          const r = await this.o.operations.lookup(orderRef, c.cart, c.notice, attempt > 1 ? credentialInvalid : undefined);
          looked.kind = r.kind;
          return r;
        };
        try {
          op = await this.#outcome(wait, reply, mark, c.signal, lookup);
          break;
        } catch (e) {
          // Р69 п. 4 с дополнением 1: один повтор тем же пакетом — только после неизвестного исхода первой попытки, когда
          // Платформа ответила «операций заказа нет», срок реквизита не наступил, реквизит у Платформы ISSUED и заказ у
          // витрины CREATED (пакет не дошёл); второй неизвестный исход — итог как есть, третьего POST нет
          const unconfirmed = e instanceof PaymentFailure && e.code === "OPERATION_RESULT_UNCONFIRMED";
          if (!unconfirmed || attempt > 1 || !unknown || looked.kind !== "ABSENT" || c.signal.aborted) throw e;
          if (!(await this.#retryable(credential, c.cart.id, req, c.signal))) throw e;
        }
        // покупку остановили, пока читали заказ, — повтора нет; повтор — запись до действия: решение без записи не
        // исполняется (инвариант 4); реквизита в записи нет, только мандат корзины и номер заказа
        c.signal.throwIfAborted();
        this.o.journal.record({ at: this.now().toISOString(), kind: "payment.retry", ref: orderRef, ...mandateRef(c.cart.id) });
        // дополнение 2 к Р69 п. 3: реквизит одобряет одна авторизация (гашение ISSUED → USED на APPROVE ADP) — отказ
        // повтора CREDENTIAL_INVALID значит «первая могла выиграть»: не итог, ожидание идёт до операции первой попытки
        wait.skip(credentialInvalid);
      }
      // оплата отменена — поздний клиринг или возврат сообщит наблюдение после итога (Р51 п. 4); итог поиска модуль уже
      // поставил под наблюдение сам, здесь — итог по событию (повторная постановка ничего не теряет)
      if (op.status === "REVERSED" && c.notice !== undefined) this.o.operations.watch(op, "REVERSED", c.notice);
      return op;
    } finally {
      wait.close();
    }
  }

  /** Условия повтора после «операций нет» (Р69 п. 4, дополнение 1 — порядок В1 (а)): срок реквизита не наступил (нет
   *  срока — повтора нет, fail-closed); реквизит у Платформы ISSUED — один GET (USED, EXPIRED, REVOKED, иное значение или
   *  отказ чтения — повтора нет: ISSUED лишь отсекает уже одобренные — безопасность повтора держится на атомарном гашении
   *  ISSUED → USED на APPROVE ADP, дополнение 2 к Р69 п. 1); затем заказ у витрины CREATED с этим номером и мандатом.
   *  Сначала Платформа (основание, инвариант 8), затем витрина. */
  async #retryable(credential: Credential, cartId: string, req: { shopId: string; orderId: string; cartMandateId: string }, signal: AbortSignal): Promise<boolean> {
    const until = credential.validTo === null ? Number.NaN : Date.parse(credential.validTo);
    if (!(until > this.now().getTime()) || this.o.shop.payable === undefined) return false;
    let now: Credential;
    try {
      now = await this.o.platform.credentialStatus(credential.credentialRef, cartId);
    } catch (e) {
      // отказ Платформы — повтора нет; код — в записи pao.call адаптера. Прочее (сбой журнала, дефект) — наружу
      if (e instanceof PlatformFailure) return false;
      throw e;
    }
    // срок — меньший из выданного и из ответа GET (в GET срока нет — повтора нет): пакет несёт прежнюю криптограмму;
    // перед повтором — ещё раз, после чтения заказа у витрины (ревью КТ2 № 1)
    const live = () => {
      const t = now.validTo === null ? Number.NaN : Date.parse(now.validTo);
      return Math.min(t, until) > this.now().getTime();
    };
    if (now.status !== "ISSUED" || !live() || signal.aborted) return false;
    return (await this.o.shop.payable(req)) && live();
  }

  /** Итог стадии 5 (Р49 п. 5): первое из — привязанная операция или (только при DECLINED продавца) запрос подтверждения,
   *  пришедший после отправки пакета. */
  async #outcome(wait: OperationWait, reply: ShopPaymentReply | null, mark: number, signal: AbortSignal, lookup: () => Promise<OperationOutcome>): Promise<Operation> {
    const delayMs = this.o.params.operation_outcome_max_delay_sec * 1000;
    let outcome: OperationOutcome | "CONFIRMATION";
    if (reply !== null && (reply.status === "DECLINED" || reply.status === "AWAITING_CONFIRMATION" || reply.confirmationRequired === true)) {
      // слова продавца не итог (инвариант 8): DECLINED, AWAITING_CONFIRMATION и признак confirmation_required (стенд
      // v0.37.0, РП72) — повод ждать и запрос подтверждения; сам запрос — только из confirmation.required Платформы:
      // признак без запроса — итога нет (OPERATION_RESULT_UNCONFIRMED), ответ продавца получен — повтора оплаты нет
      // (Р69 п. 4 — только при неизвестном исходе); гонка снимается вместе.
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
    // итога по событию нет — один поиск по CART (Р51 п. 5): реверсал до ответа эмитента событий не даёт вовсе. Покупку
    // остановили — поиска нет
    if (outcome.kind === "NONE" && !signal.aborted) outcome = await lookup();
    if (outcome.kind === "MISMATCH") throw new PaymentFailure("OPERATION_REPLY_MISMATCH");
    // неоднозначная привязка — итога нет, поиск её не снимает (Р49 п. 4–5; ревью КТ1 Р51 № 3)
    // операций заказа нет (ABSENT) — тоже итога нет; повтор после обрыва решает authorize (Р69 п. 4)
    if (outcome.kind === "NONE" || outcome.kind === "AMBIGUOUS" || outcome.kind === "ABSENT") throw new PaymentFailure("OPERATION_RESULT_UNCONFIRMED");
    return outcome.operation;
  }

  /** Стадия 6 (Р49 п. 6, Р51 п. 2): расчёт по событию и GET; без `signal` — ждёт до расчёта или границы reservation_ttl_sec
   *  от `authorizedAt` (нет — от начала ожидания). Прервано — SETTLEMENT_PENDING (ожидание, не остановка); операция не та —
   *  OPERATION_REPLY_MISMATCH; GET не подтверждён или граница прошла без итога — OPERATION_RESULT_UNCONFIRMED. */
  async settle(op: Operation, signal?: AbortSignal, authorizedAt?: Date, notice?: LateNotice): Promise<Operation> {
    const deadline = (authorizedAt ?? this.now()).getTime() + this.o.params.reservation_ttl_sec * 1000;
    // без сигнала ждёт до расчёта или границы; конвейер передаёт свой сигнал остановки покупки (ревью КТ1 № 7а)
    // итог расчёта, REVERSED и граница (и при недоступном GET, правка 1) — под наблюдение ставит модуль в момент итога
    const r = await this.o.operations.settle(op, signal ?? new AbortController().signal, deadline, notice);
    if (r.kind === "PENDING") throw new PaymentFailure("SETTLEMENT_PENDING");
    if (r.kind === "MISMATCH") throw new PaymentFailure("OPERATION_REPLY_MISMATCH");
    if (r.kind === "UNREAD" || r.kind === "EXPIRED") throw new PaymentFailure("OPERATION_RESULT_UNCONFIRMED");
    return r.operation;
  }
}

const mandateRef = (id: string): { mandate?: string } => (SAFE_ID.test(id) ? { mandate: id } : {});

/** Отказ повтора оплаты по реквизиту, который одобрила (могла одобрить) первая попытка (дополнение 2 к Р69 п. 3). */
const credentialInvalid: OperationSkip = (r) => r.status === "DECLINED" && r.declineReason === "CREDENTIAL_INVALID";

/** Решение ADP «нужно подтверждение» без события (стенд v0.37.0; дополнение 2 к Р69 п. 4). */
const confirmationRequired: OperationSkip = (r) => r.status === "CONFIRMATION_REQUIRED";
