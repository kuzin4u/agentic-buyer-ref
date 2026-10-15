// Клиент мандатов (SPEC §4, Т2, Т3, Т3а): проверка проекта до обращения (A7 п. 2.2), запрос INTENT и CART,
// ожидание подписи человека, проверка остатка через verify. Видит только порт мандатов (Р19, AG-К5).
// Остаток и счётчики агент не вычисляет — только переносит ответ verify (инвариант 6, A3 п. 4.3).
// По типу мандата нет закрытых перечней со switch/never: условие ставится только там, где тип что-то требует (CART).
import type { StandParams } from "../../shared/config.js";
import type { Cart, Mandate, MandateCheck, MandateDraft, MandateRef, PlatformEvent } from "../../shared/domain.js";
import type { MandatePort } from "../ports/mandates.js";
import type { Mutation } from "../ports/mutation.js";
import { MandateRefused } from "./errors.js";

export interface MandateClientOptions {
  port: MandatePort;
  params: Pick<StandParams, "registry_cache_ttl_sec" | "signature_skew_sec">;
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

  /** Запрос мандата. Проект без обязательного реквизита — отказ до обращения (A7 п. 2.2, П06). */
  async request(draft: MandateDraft, m: Mutation): Promise<Mandate> {
    const missing = missingTerms(draft, this.now());
    if (missing.length > 0) throw new MandateRefused("DRAFT_INVALID", `в проекте мандата нет: ${missing.join(", ")}`);
    const mandate = await this.o.port.requestMandate(draft, m);
    if (!sameTerms(draft, mandate)) throw new MandateRefused("REPLY_MISMATCH", "платформа вернула мандат с другими пределами");
    return mandate;
  }

  /** Ожидание подписи человека (SPEC §9, Р29 п. 5). Событие — только сигнал: до AG-06 подпись событий не проверяется.
   *  Мандат действует, когда платформа вернула его со статусом ACTIVE; событие при другом статусе — остановка.
   *  Сверку по getMandate не снимать и после AG-06: истина — у платформы, а не в событии. */
  async awaitSigned(mandate: Mandate, events: AsyncIterable<PlatformEvent>, signal?: AbortSignal): Promise<Mandate> {
    for await (const e of events) {
      if (signal?.aborted) break;
      if (e.mandateId !== mandate.id) continue;
      if (e.type === "mandate.signed") {
        const actual = await this.o.port.getMandate(mandate.id);
        if (actual.status !== "ACTIVE") {
          throw new MandateRefused("NOT_ACTIVE", `событие mandate.signed, а статус мандата у платформы — ${actual.status}`);
        }
        if (!sameTerms(mandate, actual)) throw new MandateRefused("REPLY_MISMATCH", "подписан мандат с другими пределами");
        return actual;
      }
      if (e.type === "mandate.rejected" || e.type === "mandate.revoked" || e.type === "mandate.exhausted") {
        throw new MandateRefused("NOT_ACTIVE", `мандат не действует: ${e.type}`);
      }
    }
    // Подписи нет — агент не продолжает (SPEC §7а PRINCIPAL_SIGNATURE_PENDING: ждать человека).
    throw new MandateRefused("SIGNATURE_PENDING", "мандат ещё не подписан человеком");
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
    if (!mandate) throw new MandateRefused("NO_MANDATE", "нет мандата: агент не действует от вашего имени без вашего поручения");
    if (mandate.status !== "ACTIVE") {
      throw new MandateRefused("NO_MANDATE", `мандат не действует (${mandate.status}): агент не действует от вашего имени`);
    }
    const c = await this.check(mandate);
    if (c.outcome !== "CONFIRMED") throw new MandateRefused("OUT_OF_SCOPE", `платформа не подтвердила мандат: ${c.outcome}`);
    return c;
  }
}
