// Машина состояний покупки (Р38 п. 1, SPEC §4 `pipeline`): разрешённые переходы — одной таблицей TRANSITIONS, условия
// стадий (ворота) — у стадий (purchase.ts), не здесь. Таблица отвечает «можно ли вообще», ворота — «выполнены ли условия
// сейчас». Запрещённый переход — дефект вызывающего или конвейера: покупка остановлена, запись agent.refused.
// Состояние — только в памяти (Р38 п. 6): после перезапуска покупка не восстанавливается.
import type { DiagCode } from "../../shared/diag-codes.js";
import { SAFE_ID } from "../../shared/ids.js";
import { afterPayment } from "../declines/table.js";

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
  // стадия 4 — после отказа авторизации с требованием подтверждения: запрос создаёт ADP (Р47 п. 2); ORDERED → CONFIRMING нет
  ORDERED: ["AUTHORIZING"],
  // повтор после одобрения — AG-13 ч. 2; в ч. 1 этот переход не проходит ни один путь
  CONFIRMING: ["AUTHORIZING"],
  AUTHORIZING: ["SETTLING", "CONFIRMING"],
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

/** Уточнения остановки без своего кода реестра (Р40 п. 6) — закрытый перечень, с кодами реестра не пересекается (тест
 *  реестра): `CART_POLICY_EXCLUDED` — `EXCLUDED` от политики на стадии 3, внутреннее противоречие агента, остановка
 *  `UNKNOWN`. */
export const STOP_CAUSES = ["CART_POLICY_EXCLUDED"] as const;
export type StopCause = (typeof STOP_CAUSES)[number];

/** Часть журнала, которую видит машина: только свои записи. */
export interface PurchaseJournal {
  record(
    entry:
      /** detail — новое состояние; у остановки с уточнением — «STOPPED:уточнение» (Р40 п. 6, единственное значение) */
      | { at: string; kind: "purchase.stage"; detail: PurchaseState | `STOPPED:${StopCause}`; mandate?: string; reason?: DiagCode }
      /** detail — запрошенный переход «откуда->куда», оба из PURCHASE_STATES (ревью К2.1 № 4) */
      | { at: string; kind: "agent.refused"; reason: "PIPELINE_TRANSITION_FORBIDDEN"; detail: `${PurchaseState}->${PurchaseState}`; mandate?: string }
      /** пакет ушёл продавцу, остановка по неитоговому коду (Р49 п. 2): reason — исходный код; остановка — с
       *  OPERATION_RESULT_UNCONFIRMED следующей записью purchase.stage */
      | { at: string; kind: "payment.unconfirmed"; reason: DiagCode; mandate?: string },
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

export interface PurchaseMachineOptions {
  journal: PurchaseJournal;
  now?: () => Date;
}

export class PurchaseMachine {
  #state: PurchaseState = "NEW";
  #reason: DiagCode | null = null;
  #mandate: string | undefined;
  /** ворота перед стадией 5 пройдены (Р38 п. 3, К4): без них переход в AUTHORIZING запрещён */
  #gate5 = false;
  /** покупка остановлена — сигнал шагам оплаты: после него обращений за реквизитом и к витрине нет (Р45, Б2в (а)) */
  readonly #stopped = new AbortController();
  /** пакет агентской оплаты уходит продавцу: до записи исхода стадии 5 запрещённый переход — отказ без остановки (Б2в (б)) */
  #sending = false;
  /** пакет хоть раз уходил продавцу: дальше остановка — только итоговым кодом (Р49 п. 2), до конца покупки */
  #paid = false;
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
    this.#mandate = SAFE_ID.test(mandateId) ? mandateId : undefined;
  }

  get mandate(): { mandate?: string } {
    return this.#mandate === undefined ? {} : { mandate: this.#mandate };
  }

  /** Переход по таблице с записью purchase.stage. Не разрешён — запись agent.refused (detail — «откуда->куда»), остановка (purchase.stage STOPPED) и PurchaseTransitionForbidden; из конечного состояния — только отказ,
   *  состояние не меняется. */
  to(next: Exclude<PurchaseState, "STOPPED">): void {
    const from = this.#state;
    // в STOPPED — только stop() с кодом: to("STOPPED") в обход типа — тоже запрещённый переход (ревью К2.1 № 3)
    if ((next as PurchaseState) === "STOPPED" || !allowed(from, next)) this.forbid(next);
    // к авторизации — только через ворота: таблица разрешает переход, условие стадии 5 — пропуск ворот (К4); пропуск
    // одноразовый и живёт до следующего перехода: от прежних ворот (до нового CART, до стадии 4) не остаётся
    if (next === "AUTHORIZING" && !this.#gate5) this.forbid(next);
    this.#gate5 = false;
    this.#sending = false;
    // операция одобрена — деньги в пути и без отметки «пакет уходит» (профиль без sending, ревью КТ1 № 2)
    if (next === "SETTLING") this.#paid = true;
    this.#state = next;
    this.o.journal.record({ at: this.#at(), kind: "purchase.stage", detail: next, ...this.mandate });
  }

  /** Запрещённый переход: таблица разрешает, но условие стадии не выполнено так, что это дефект вызывающего (стадия 4
   *  без надобности, авторизация без подтверждения, повторный вход в идущую стадию) — тот же отказ, что у таблицы. */
  forbid(next: PurchaseState): never {
    const from = this.#state;
    this.o.journal.record({ at: this.#at(), kind: "agent.refused", reason: "PIPELINE_TRANSITION_FORBIDDEN", detail: `${from}->${next}`, ...this.mandate });
    // исключение из Р38 (Р45, Б2в (б)): пакет уже уходит продавцу — отменять нечего, деньги, возможно, в пути; покупка
    // завершится исходом стадии 5, а не кодом параллельного вызова
    if (!isTerminal(from) && !(this.#sending && from === "AUTHORIZING")) this.stop("PIPELINE_TRANSITION_FORBIDDEN");
    throw new PurchaseTransitionForbidden(from, next);
  }

  /** Сигнал остановки покупки для шагов оплаты (Р45, Б2в (а)). */
  get stopped(): AbortSignal {
    return this.#stopped.signal;
  }

  /** Пакет агентской оплаты уходит продавцу (Р45, Б2в (б)): окно «пакет отправлен → исход стадии 5 записан» — только в
   *  AUTHORIZING и только пока покупка не остановлена; закрывается переходом из AUTHORIZING (исход записан). */
  sending(): void {
    if (this.#state !== "AUTHORIZING") this.forbid("AUTHORIZING");
    this.#sending = true;
    this.#paid = true;
  }

  /** Пакет уходил продавцу или операция уже одобрена (SETTLING): остановка — только итоговым кодом (Р49 п. 2). */
  get paid(): boolean {
    return this.#paid;
  }

  /** Код, с которым остановится покупка (Р49 п. 2): после отправки пакета неитоговый — OPERATION_RESULT_UNCONFIRMED. */
  outcome(reason: DiagCode): DiagCode {
    return this.#paid ? afterPayment(reason) : reason;
  }

  /** Ворота перед стадией 5 пройдены: оба мандата держатся и подтверждены verify (Р38 п. 3). Ставит только конвейер
   *  (purchase.ts) непосредственно перед переходом в AUTHORIZING; действует до ближайшего перехода (ревью К4 № 1). */
  passGate5(): void {
    this.#gate5 = true;
  }

  /** Остановка с кодом реестра; из конечного состояния — без действия (первая причина остаётся). `cause` — уточнение в
   *  detail записи (Р40 п. 6), отдельной записи нет. После отправки пакета неитоговый код заменяется (`outcome`), исходный —
   *  в записи payment.unconfirmed перед purchase.stage (Р49 п. 2). */
  stop(reason: DiagCode, cause?: StopCause): void {
    if (isTerminal(this.#state)) return;
    const code = this.outcome(reason);
    this.#state = "STOPPED";
    this.#reason = code;
    this.#sending = false;
    this.#stopped.abort(new Error(`покупка остановлена: ${code}`));
    if (code !== reason) this.o.journal.record({ at: this.#at(), kind: "payment.unconfirmed", reason, ...this.mandate });
    const detail = cause === undefined ? "STOPPED" : (`STOPPED:${cause}` as const);
    this.o.journal.record({ at: this.#at(), kind: "purchase.stage", detail, reason: code, ...this.mandate });
  }

  #at(): string {
    return this.now().toISOString();
  }
}
