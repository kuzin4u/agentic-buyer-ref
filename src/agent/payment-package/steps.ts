// Шаги стадий 4–6 профиля contour (Р45 п. 2, 5, 6): реквизит по ПАО и пакет агентской оплаты продавцу. Собирается в
// месте сборки из порта платформы и адаптера витрин. До событий операции (PS-16) итог не подтверждается: после передачи
// пакета — PaymentFailure OPERATION_RESULT_UNCONFIRMED, ответ продавца — только в журнале адаптера витрин (инвариант 8).
import type { Journal } from "../journal/index.js";
import type { IssuedPackage } from "../ports/payment-platform.js";
import type { Mutation } from "../ports/mutation.js";
import { PaymentFailure, ShopFailure, type PaymentContext, type PaymentSteps, type ShopPaymentPort } from "../ports/shop.js";
import type { CredentialDraft, Operation } from "../../shared/domain.js";
import { orderRefIssue } from "./order-ref.js";

export interface ContourPaymentOptions {
  platform: { issuePaymentPackage(draft: CredentialDraft, m: Mutation): Promise<IssuedPackage> };
  shop: ShopPaymentPort;
  journal: Journal;
  now?: () => Date;
}

/** mandate_id в журнале — по маске (Р37 п. 3). */
const MANDATE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export class ContourPayment implements PaymentSteps {
  private readonly now: () => Date;

  constructor(private readonly o: ContourPaymentOptions) {
    this.now = o.now ?? (() => new Date());
  }

  /** Стадия 4 до AG-13 (PS-19): канала подтверждения нет — отказ fail-closed, имитации нет (инвариант 7). */
  confirm(): Promise<never> {
    return Promise.reject(new PaymentFailure("CONFIRMATION_REQUIRED"));
  }

  /** Стадия 5 (Т8): номер заказа — до обращения к Платформе (второй рубеж после стадии 3); реквизит по CART под ключом
   *  вызывающего; пакет — продавцу. Покупка остановлена — ни реквизита, ни пакета. Реквизит не ISSUED (повтор под ключом
   *  после погашения или срока) — пакета нет, CREDENTIAL_INVALID. Пакет передан, отказ витрины или исход неизвестен —
   *  OPERATION_RESULT_UNCONFIRMED: итог — только из события Платформы (PS-16, AG-11 ч. 2). */
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
    c.sending();
    try {
      await this.o.shop.pay({ shopId: c.shopId, orderId: orderRef, cartMandateId: c.cart.id, package: sealed });
    } catch (e) {
      // пакет ушёл (или мог уйти): отказ витрины, нет ответа, ответ не по схеме — итог не подтверждён, «деньги не
      // списывались» не говорим (Р45, Б1а; инвариант 8); код витрины — detail записи shop.call
      if (e instanceof ShopFailure) throw new PaymentFailure("OPERATION_RESULT_UNCONFIRMED");
      throw e;
    }
    throw new PaymentFailure("OPERATION_RESULT_UNCONFIRMED");
  }

  /** Стадия 6 не наступает до событий операции (Р45 п. 5). */
  settle(): Promise<never> {
    return Promise.reject(new PaymentFailure("OPERATION_RESULT_UNCONFIRMED"));
  }
}

const mandateRef = (id: string): { mandate?: string } => (MANDATE_ID.test(id) ? { mandate: id } : {});
