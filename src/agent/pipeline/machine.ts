// Машина состояний покупки (Р38 п. 1, SPEC §4 `pipeline`): разрешённые переходы — одной таблицей TRANSITIONS, условия
// стадий (ворота) — у стадий (purchase.ts), не здесь. Таблица отвечает «можно ли вообще», ворота — «выполнены ли условия
// сейчас». Запрещённый переход — дефект вызывающего или конвейера: покупка остановлена, запись agent.refused.
// Состояние — только в памяти (Р38 п. 6): после перезапуска покупка не восстанавливается.
import type { DiagCode } from "../../shared/diag-codes.js";

export const PURCHASE_STATES = [
  /** стадия 0: покупка создана, допуск агента для неё не проверен */
  "NEW",
  /** стадия 1: INTENT запрошен, ждёт подписи человека */
  "INTENT_PENDING",
  /** стадия 1: INTENT ACTIVE по GET и держится (Р37 п. 4) */
  "INTENT_ACTIVE",
  /** стадия 2: выдача готова — две зоны, решения каталога записаны */
  "OFFERS",
  /** стадия 3: проект CART допущен политикой, мандат запрошен, ждёт подписи */
  "CART_PENDING",
  /** стадия 3: CART ACTIVE по GET и держится */
  "CART_ACTIVE",
  /** стадия 3: живая проверка ok, заказ у продавца создан, сумма заказа = сумма CART */
  "ORDERED",
  /** стадия 4: ждёт решения человека */
  "CONFIRMING",
  /** стадия 5: ворота пройдены, идёт авторизация */
  "AUTHORIZING",
  /** стадия 6: операция авторизована, ждёт итога расчёта */
  "SETTLING",
  /** стадия 6: итог получен (конечное) */
  "DONE",
  /** покупка остановлена с кодом реестра (конечное) */
  "STOPPED",
] as const;

export type PurchaseState = (typeof PURCHASE_STATES)[number];

/** Разрешённые переходы, кроме перехода в STOPPED: он разрешён из любого не конечного состояния. */
export const TRANSITIONS: Readonly<Record<PurchaseState, readonly PurchaseState[]>> = {
  // повтор тем же ключом позже 24 ч — мандат сразу ACTIVE (РП35)
  NEW: ["INTENT_PENDING", "INTENT_ACTIVE"],
  INTENT_PENDING: ["INTENT_ACTIVE"],
  INTENT_ACTIVE: ["OFFERS"],
  // новый поиск — снова OFFERS
  OFFERS: ["OFFERS", "CART_PENDING"],
  CART_PENDING: ["CART_ACTIVE"],
  // живая проверка не ok — к выдаче; изменение цены — новый CART только новым выбором человека (Т6, Р5)
  CART_ACTIVE: ["ORDERED", "OFFERS"],
  ORDERED: ["CONFIRMING", "AUTHORIZING"],
  CONFIRMING: ["AUTHORIZING"],
  AUTHORIZING: ["SETTLING"],
  SETTLING: ["DONE"],
  DONE: [],
  STOPPED: [],
};

const TERMINAL: ReadonlySet<PurchaseState> = new Set(["DONE", "STOPPED"]);

export function isTerminal(s: PurchaseState): boolean {
  return TERMINAL.has(s);
}

/** Переход разрешён таблицей: в STOPPED — из любого не конечного, иначе — по TRANSITIONS. */
export function allowed(from: PurchaseState, to: PurchaseState): boolean {
  if (isTerminal(from)) return false;
  return to === "STOPPED" || TRANSITIONS[from].includes(to);
}

/** Часть журнала, которую видит машина: только свои записи. */
export interface PurchaseJournal {
  record(
    entry:
      | { at: string; kind: "purchase.stage"; detail: PurchaseState; mandate?: string; reason?: DiagCode }
      /** detail — запрошенный переход «откуда->куда», оба из PURCHASE_STATES (ревью К2.1 № 4) */
      | { at: string; kind: "agent.refused"; reason: "PIPELINE_TRANSITION_FORBIDDEN"; detail: `${PurchaseState}->${PurchaseState}`; mandate?: string },
  ): void;
}

/** Запрещённый переход (Р38 п. 1): покупка уже в STOPPED. */
export class PurchaseTransitionForbidden extends Error {
  readonly code = "PIPELINE_TRANSITION_FORBIDDEN";
  constructor(
    readonly from: PurchaseState,
    readonly to: PurchaseState,
  ) {
    super(`Покупка: переход ${from} → ${to} не разрешён`);
    this.name = "PurchaseTransitionForbidden";
  }
}

/** mandate_id в журнале — только по маске идентификатора (как у клиента мандатов и адаптера, Р37 п. 3). */
const MANDATE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export interface PurchaseMachineOptions {
  journal: PurchaseJournal;
  now?: () => Date;
}

export class PurchaseMachine {
  #state: PurchaseState = "NEW";
  #reason: DiagCode | null = null;
  #mandate: string | undefined;
  private readonly now: () => Date;

  constructor(private readonly o: PurchaseMachineOptions) {
    this.now = o.now ?? (() => new Date());
  }

  get state(): PurchaseState {
    return this.#state;
  }

  /** Код остановки; до STOPPED — null. */
  get reason(): DiagCode | null {
    return this.#reason;
  }

  /** mandate_id INTENT для записей покупки — ставит стадия 1; не прошёл маску — записи без mandate. */
  bind(mandateId: string): void {
    this.#mandate = MANDATE_ID.test(mandateId) ? mandateId : undefined;
  }

  get mandate(): { mandate?: string } {
    return this.#mandate === undefined ? {} : { mandate: this.#mandate };
  }

  /** Переход по таблице с записью purchase.stage. Не разрешён — запись agent.refused (detail — «откуда->куда»), остановка (purchase.stage STOPPED) и PurchaseTransitionForbidden; из конечного состояния — только отказ,
   *  состояние не меняется. */
  to(next: Exclude<PurchaseState, "STOPPED">): void {
    const from = this.#state;
    // в STOPPED — только stop() с кодом: to("STOPPED") в обход типа — тоже запрещённый переход (ревью К2.1 № 3)
    if ((next as PurchaseState) === "STOPPED" || !allowed(from, next)) {
      this.o.journal.record({ at: this.#at(), kind: "agent.refused", reason: "PIPELINE_TRANSITION_FORBIDDEN", detail: `${from}->${next}`, ...this.mandate });
      if (!isTerminal(from)) this.stop("PIPELINE_TRANSITION_FORBIDDEN");
      throw new PurchaseTransitionForbidden(from, next);
    }
    this.#state = next;
    this.o.journal.record({ at: this.#at(), kind: "purchase.stage", detail: next, ...this.mandate });
  }

  /** Остановка с кодом реестра; из конечного состояния — без действия (первая причина остаётся). */
  stop(reason: DiagCode): void {
    if (isTerminal(this.#state)) return;
    this.#state = "STOPPED";
    this.#reason = reason;
    this.o.journal.record({ at: this.#at(), kind: "purchase.stage", detail: "STOPPED", reason, ...this.mandate });
  }

  #at(): string {
    return this.now().toISOString();
  }
}
