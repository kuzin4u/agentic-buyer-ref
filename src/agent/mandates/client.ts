// Клиент мандатов (SPEC §4, Т2, Т3, Т3а): проверка проекта до обращения (A7 п. 2.2), запрос INTENT и CART,
// ожидание подписи человека, проверка остатка через verify. Видит только порт мандатов (Р19, AG-К5).
// Остаток и счётчики агент не вычисляет — только переносит ответ verify (инвариант 6, A3 п. 4.3).
// По типу мандата нет закрытых перечней со switch/never: условие ставится только там, где тип что-то требует (CART).
import type { StandParams } from "../../shared/config.js";
import { PlatformFailure, type Cart, type Mandate, type MandateCheck, type MandateDraft, type MandateRef } from "../../shared/domain.js";
import type { FeedItem } from "../ports/events.js";
import type { MandatePort } from "../ports/mandates.js";
import type { Mutation } from "../ports/mutation.js";
import { MandateRefused, REVOCATION_ORDER_MISSING_TEXT } from "./errors.js";

/** Часть журнала, которую видит клиент: только своё событие (граница импортов mandates — ревью К2 № 13; Journal подходит). */
export interface MandateJournal {
  record(entry: { at: string; kind: "mandate.revocation_order_missing"; reason: "MANDATE_REVOCATION_ORDER_MISSING" }): void;
}

export interface MandateClientOptions {
  port: MandatePort;
  params: Pick<StandParams, "registry_cache_ttl_sec" | "signature_skew_sec">;
  journal: MandateJournal;
  now?: () => Date;
}

/** Пустые реквизиты проекта мандата: A7 п. 2.2 — отсутствие любого делает мандат недействительным. */
export function missingTerms(d: MandateDraft, now: Date): string[] {
  const missing: string[] = [];
  const text = (v: unknown) => typeof v === "string" && v.trim() !== "";
  if (!text(d.subject)) missing.push("subject");
  if (!Number.isSafeInteger(d.amountLimit?.amount) || d.amountLimit.amount < 1 || !text(d.amountLimit.currency)) missing.push("amountLimit");
  const validTo = Date.parse(d.validTo);
  if (!text(d.validTo) || Number.isNaN(validTo) || validTo <= now.getTime()) missing.push("validTo");
  if (!Array.isArray(d.merchantScope) || d.merchantScope.length === 0 || !d.merchantScope.every(text)) missing.push("merchantScope");
  if (!text(d.principalRef)) missing.push("principalRef");
  // Т3а: ключевые параметры показаны отдельной карточкой до подписи — без этого мандат не запрашивается.
  if (d.keyTermsShown !== true) missing.push("keyTermsShown");
  if (d.confirmationMode !== "IMMEDIATE" && d.confirmationMode !== "AUTONOMOUS") missing.push("confirmationMode");
  // A7 п. 1.2: мандат корзины — состав и стоимость со ссылкой на мандат намерения; у прочих корзины нет.
  if (d.kind === "CART") {
    if (!text(d.parentId) || !d.cart || !cartConsistent(d.cart, d)) missing.push("cart");
  } else if (d.cart !== null || d.parentId !== null) missing.push("cart");
  return missing;
}

/** Корзина согласована сама с собой и с пределами проекта: позиции есть, итог — сумма позиций в валюте мандата,
 *  не больше предельной суммы, продавец — из получателей. Это проверка проекта, а не остатка (инвариант 6). */
function cartConsistent(c: Cart, d: MandateDraft): boolean {
  const cur = d.amountLimit.currency;
  if (c.lines.length === 0 || !d.merchantScope.includes(c.merchantId) || c.total.currency !== cur) return false;
  let sum = 0;
  for (const l of c.lines) {
    if (l.price.currency !== cur || !Number.isSafeInteger(l.qty) || l.qty < 1) return false;
    sum += l.qty * l.price.amount;
    if (!Number.isSafeInteger(sum)) return false;
  }
  return sum === c.total.amount && c.total.amount <= d.amountLimit.amount;
}

const sameMoney = (a: { amount: number; currency: string }, b: { amount: number; currency: string }) =>
  a.amount === b.amount && a.currency === b.currency;

function sameCart(a: Cart | null, b: Cart | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.merchantId === b.merchantId &&
    sameMoney(a.total, b.total) &&
    a.lines.length === b.lines.length &&
    a.lines.every((l, i) => l.sku === b.lines[i]!.sku && l.qty === b.lines[i]!.qty && sameMoney(l.price, b.lines[i]!.price))
  );
}

/** Ответ платформы на запрос — тот же мандат, что просили: иначе пределы не подтверждены (инвариант 4). */
function sameTerms(d: MandateDraft, m: Mandate): boolean {
  return (
    m.kind === d.kind &&
    m.parentId === d.parentId &&
    m.subject === d.subject &&
    sameMoney(m.amountLimit, d.amountLimit) &&
    Date.parse(m.validTo) === Date.parse(d.validTo) &&
    m.principalRef === d.principalRef &&
    m.confirmationMode === d.confirmationMode &&
    // получатели — множество: порядок у платформы не обязан совпадать
    new Set(m.merchantScope).size === new Set(d.merchantScope).size &&
    m.merchantScope.every((s) => d.merchantScope.includes(s)) &&
    sameCart(m.cart, d.cart)
  );
}

export const refOf = (m: Mandate): MandateRef => ({ id: m.id, currency: m.amountLimit.currency });

export class MandateClient {
  private readonly now: () => Date;

  constructor(private readonly o: MandateClientOptions) {
    this.now = o.now ?? (() => new Date());
  }

  /** Запрос мандата. Проект без обязательного реквизита — отказ до обращения (A7 п. 2.2, П06). У CART — родитель, которым
   *  агент располагает: порядок отзыва CART — как у родителя (Р33 п. 4).
   *  После 201 — статус (РП35): PENDING_SIGNATURE — ждать подписи; ACTIVE (повтор тем же ключом позже 24 ч) — статус
   *  только из GET (РП34); прочие — отказ, новый мандат молча не создаётся (новый ключ — после нового поручения человека). */
  async request(draft: MandateDraft, m: Mutation, parent: Mandate | null = null): Promise<Mandate> {
    const missing = missingTerms(draft, this.now());
    // родитель — только у CART и только тот, на который ссылается проект (ревью К2.2 № 6)
    if (draft.kind === "CART" ? parent?.id !== draft.parentId : parent !== null) missing.push("parent");
    if (missing.length > 0) throw new MandateRefused("MANDATE_DRAFT_INVALID", `в проекте мандата нет: ${missing.join(", ")}`);
    let mandate = await this.#mandate(() => this.o.port.requestMandate(draft, m));
    if (mandate.status === "ACTIVE") mandate = await this.#reread(mandate.id);
    if (mandate.status !== "PENDING_SIGNATURE" && mandate.status !== "ACTIVE") {
      throw new MandateRefused("MANDATE_NOT_ACTIVE", `мандат не действует (${mandate.status}): новое поручение — только по вашему решению`);
    }
    if (!sameTerms(draft, mandate)) throw new MandateRefused("MANDATE_REPLY_MISMATCH", "платформа вернула мандат с другими пределами");
    if (parent !== null && mandate.revocationOrder !== parent.revocationOrder) {
      throw new MandateRefused("MANDATE_REPLY_MISMATCH", "порядок отзыва мандата корзины не совпадает с мандатом намерения");
    }
    return mandate;
  }

  /** Мандат по GET — тот, что спросили: другой id — пределы не подтверждены (инвариант 4, ревью К2.2 № 6). */
  async #reread(id: string): Promise<Mandate> {
    const got = await this.#mandate(() => this.o.port.getMandate(id));
    if (got.id !== id) throw new MandateRefused("MANDATE_REPLY_MISMATCH", "платформа вернула другой мандат");
    return got;
  }

  /** Ответ с мандатом без порядка отзыва: версия ПАО Платформы подтверждена — событие в журнал и отказ с текстом человеку
   *  (Р33 п. 4); не подтверждена — порт уже записал событие и остановил агента (PLATFORM_PROTOCOL_UNSUPPORTED), отказ
   *  платформы — дальше как есть (Р33 п. 10). */
  async #mandate(call: () => Promise<Mandate>): Promise<Mandate> {
    try {
      return await call();
    } catch (e) {
      if (e instanceof PlatformFailure && e.code === "MANDATE_REVOCATION_ORDER_MISSING") {
        this.o.journal.record({ at: this.now().toISOString(), kind: "mandate.revocation_order_missing", reason: e.code });
        throw new MandateRefused("MANDATE_REVOCATION_ORDER_MISSING", REVOCATION_ORDER_MISSING_TEXT);
      }
      throw e;
    }
  }

  /**
   * Ожидание подписи человека (SPEC §9, Р29 п. 5, Р34 п. 5). Источник — лента событий (`EventFeed.items()`); событие —
   * только сигнал перечитать мандат по GET, мандат действует только по GET ACTIVE с пределами запроса:
   *  - итератор ленты запускается до первого GET — слушатель ленты зарегистрирован, событие, прочитанное во время GET,
   *    попадает в очередь (ревью К2.4 № 1); GET до ожидания: ACTIVE — действует, PENDING_SIGNATURE — ждать;
   *  - mandate.signed этого мандата — GET: ACTIVE — действует, иной статус — остановка (Р29 п. 5);
   *  - mandate.rejected / revoked / exhausted этого мандата — остановка при любом статусе по GET: событие о смене статуса
   *    и иной статус у платформы — неподтверждённое состояние (SPEC §9, инвариант 4);
   *  - пропуск INVALID_DATA мандатного типа (mandate_id не читается — ответ (б) владельца) — GET ожидаемого мандата, как
   *    до ожидания: ACTIVE — действует, PENDING_SIGNATURE — ждать, иной — остановка.
   * Лента кончилась или ожидание прервано без подписи — MANDATE_SIGNATURE_PENDING (SPEC §7а: ждать человека).
   */
  async awaitSigned(mandate: Mandate, events: AsyncIterable<FeedItem>, signal?: AbortSignal): Promise<Mandate> {
    /** mode: "wait" — PENDING_SIGNATURE допустим; "signed" — нужен ACTIVE; "changed" — остановка при любом статусе */
    const settle = async (mode: "wait" | "signed" | "changed"): Promise<Mandate | null> => {
      const actual = await this.#reread(mandate.id);
      if (actual.status === "ACTIVE" && mode !== "changed") {
        if (!sameTerms(mandate, actual)) throw new MandateRefused("MANDATE_REPLY_MISMATCH", "подписан мандат с другими пределами");
        return actual;
      }
      if (actual.status === "PENDING_SIGNATURE" && mode === "wait") return null;
      throw new MandateRefused("MANDATE_NOT_ACTIVE", `событие о мандате и статус у платформы — ${actual.status}`);
    };
    const it = events[Symbol.asyncIterator]();
    let next = it.next(); // запуск итератора: слушатель ленты — до GET
    next.catch(() => undefined); // отказ ленты — при ожидании ниже; если GET упал раньше — не «необработанный»
    try {
      const ready = await settle("wait");
      if (ready) return ready;
      for (let r = await next; !r.done; r = await (next = it.next())) {
        if (signal?.aborted) break;
        const item = r.value;
        if (item.kind === "event") {
          if (!item.event.type.startsWith("mandate.") || item.event.mandateId !== mandate.id) continue;
          const done = await settle(item.event.type === "mandate.signed" ? "signed" : "changed");
          if (done) return done;
        } else if (item.detail === "INVALID_DATA" && item.type.startsWith("mandate.")) {
          const done = await settle("wait");
          if (done) return done;
        }
      }
    } finally {
      // итератор ленты освобождается (отписка слушателя) и при раннем выходе; ждать его не нужно
      void it.return?.()?.catch(() => undefined);
    }
    // Подписи нет — агент не продолжает (SPEC §7а PRINCIPAL_SIGNATURE_PENDING: ждать человека).
    throw new MandateRefused("MANDATE_SIGNATURE_PENDING", "мандат ещё не подписан человеком");
  }

  /** Остаток и срок — из verify (Т3, инвариант 6). Нет `as_of`, он не разбирается, старше `registry_cache_ttl_sec`
   *  или впереди больше `signature_skew_sec` — состояние не подтверждено: STATE_UNKNOWN (Р29 п. 4, A7 п. 8.6). */
  async check(mandate: Mandate): Promise<MandateCheck> {
    const c = await this.o.port.verifyMandate(refOf(mandate));
    const asOf = c.asOf === null ? Number.NaN : Date.parse(c.asOf);
    const now = this.now().getTime();
    const fresh =
      !Number.isNaN(asOf) &&
      now - asOf <= this.o.params.registry_cache_ttl_sec * 1000 &&
      asOf - now <= this.o.params.signature_skew_sec * 1000;
    return fresh ? c : { ...c, outcome: "STATE_UNKNOWN" };
  }

  /** Действие от имени человека — только по действующему мандату, подтверждённому verify (Т2, П05).
   *  Мандата нет или он не ACTIVE — отказ без обращений к платформе; объяснение — для человека. */
  async requireActive(mandate: Mandate | null): Promise<MandateCheck> {
    if (!mandate) throw new MandateRefused("MANDATE_NONE", "нет мандата: агент не действует от вашего имени без вашего поручения");
    if (mandate.status !== "ACTIVE") {
      throw new MandateRefused("MANDATE_NONE", `мандат не действует (${mandate.status}): агент не действует от вашего имени`);
    }
    const c = await this.check(mandate);
    if (c.outcome !== "CONFIRMED") throw new MandateRefused("MANDATE_OUT_OF_SCOPE", `платформа не подтвердила мандат: ${c.outcome}`);
    return c;
  }
}
