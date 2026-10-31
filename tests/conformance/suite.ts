// Набор соответствия адаптеров платформы (AG-20, Р67): общие проверки порта PaymentPlatform, которые обязан пройти
// любой адаптер (ПАО, банк, песочница, НСПК — Р19, дополнение 11.10). Набор видит только порт и тестовую сторону цели;
// contour, adapters/* и compose не импортирует — Р67 п. 1, tests/unit/conformance-imports.test.ts.
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_CHANNELS } from "../../src/agent/policy/channels.js";
import type { PaymentPlatform, PlatformCapabilities } from "../../src/agent/ports/index.js";
import { PlatformFailure, type ConfirmationDraft, type CredentialDraft, type DisputeDraft, type Mandate, type MandateDraft } from "../../src/shared/domain.js";

/** Открытая цель: настоящий адаптер за портом и тестовая сторона платформы (растёт по кирпичам AG-20). */
export interface ConformanceSession {
  readonly platform: PaymentPlatform;
  /** тот же адаптер от имени другого агента той же платформы: его мандаты для `platform` — чужие */
  readonly foreign: PaymentPlatform;
  /** код агента, под которым адаптер обращается к платформе (агентский признак реквизита) */
  readonly agentCode: string;
  /** проект INTENT, который платформа цели примет (продавец, срок, принципал — её) */
  intent(): MandateDraft;
  /** проект CART по подписанному INTENT `parent` — в его пределах */
  cart(parent: Mandate): MandateDraft;
  /** подпись мандата человеком вне агента (эмулятор эмитента цели) */
  signMandate(id: string): Promise<void>;
  /** образцы платёжных данных из ответов платформы на выдачу реквизита (`token_ref`, криптограмма) — для проверки утечки */
  issuedSecrets(): string[];
  close(): Promise<void>;
}

/** Цель набора: как поднять платформу и адаптер к ней. Каждый тест открывает свою сессию. */
export interface ConformanceTarget {
  /** имя цели в названии набора */
  readonly name: string;
  open(): Promise<ConformanceSession>;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const ISO_4217 = /^[A-Z]{3}$/;
/** Закрытый состав заявления (SPEC §4): новое поле — правка порта и набора вместе. */
const FIELDS = [
  "conditionalSettlement",
  "currencies",
  "disputeResolution",
  "guaranteeContour",
  "humanConfirmation",
  "platform",
  "protocolVersion",
  "signedEvents",
  "verifiableMandate",
] as const satisfies readonly (keyof PlatformCapabilities)[];
const FLAGS = ["verifiableMandate", "disputeResolution", "humanConfirmation", "signedEvents", "guaranteeContour", "conditionalSettlement"] as const;

const triple = (v: string): [number, number, number] => {
  const m = SEMVER.exec(v);
  if (m === null) throw new Error(`версия не вида x.y.z: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const notBelow = (a: [number, number, number], b: [number, number, number]) => a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])));

// Проекты для заявленного отказа: платформа без возможности не должна принимать запрос ни при каком содержимом.
const CONFIRMATION: ConfirmationDraft = { mandate: { id: "mnd_conformance", currency: "RUB" }, merchantId: "shop_conformance", amount: { amount: 100, currency: "RUB" }, summary: "набор соответствия", channel: "UPK" };
const DISPUTE: DisputeDraft = { opRef: "op_conformance", reason: "NOT_AUTHORIZED", principalAck: "ack_conformance" };

/** Поля реквизита глазами ядра (SPEC §4, инвариант 1): только ссылка, вид, состояние, срок и признак. */
const CREDENTIAL_FIELDS = ["channel", "credentialRef", "indicator", "status", "validTo"];
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Ни один образец платёжных данных не виден в сериализации и в `inspect` значения (инвариант 1, Р45 п. 3). */
function expectNoSecrets(value: unknown, secrets: readonly string[]): void {
  expect(secrets.length, "цель не отдала образцов — проверка была бы пустой").toBeGreaterThan(0);
  const shown = `${JSON.stringify(value)}\n${inspect(value, { depth: 10, showHidden: true })}\n${String(value)}`;
  for (const s of secrets) expect(shown.includes(s), "платёжные данные видны ядру").toBe(false);
}

export function describeConformance(target: ConformanceTarget): void {
  describe(`набор соответствия адаптеров (AG-20, Р67) — ${target.name}`, () => {
    let session: ConformanceSession | undefined;
    afterEach(async () => {
      await session?.close();
      session = undefined;
    });
    const open = async (): Promise<PaymentPlatform> => (session = await target.open()).platform;
    const begin = async (): Promise<ConformanceSession> => (session = await target.open());

    /** INTENT подписан человеком, CART по нему — тоже: исходное состояние для реквизита. `via` — чей адаптер просит. */
    async function signedCart(s: ConformanceSession, via: PaymentPlatform = s.platform): Promise<Mandate> {
      const intent = await via.requestMandate(s.intent(), { idempotencyKey: "conformance-intent" });
      await s.signMandate(intent.id);
      const cart = await via.requestMandate(s.cart(await via.getMandate(intent.id)), { idempotencyKey: "conformance-cart" });
      await s.signMandate(cart.id);
      return via.getMandate(cart.id);
    }
    const credentialDraft = (cart: Mandate, orderRef: string): CredentialDraft => ({
      mandate: { id: cart.id, currency: cart.amountLimit.currency },
      orderRef,
      merchantId: cart.cart!.merchantId,
      amountMax: cart.amountLimit,
      channel: AGENT_CHANNELS[0]!,
    });

    describe("заявление возможностей и гарантий (Р19, SPEC §4)", () => {
      it("поля по схеме: состав закрыт, имя, версия x.y.z, валюты ISO 4217 — непустое множество без повторов, признаки — boolean", async () => {
        const c = (await open()).capabilities();
        expect(Object.keys(c).sort()).toEqual([...FIELDS]);
        expect(c.platform).toMatch(/\S/);
        expect(c.protocolVersion).toMatch(SEMVER);
        expect(c.currencies.length).toBeGreaterThan(0);
        for (const cur of c.currencies) expect(cur).toMatch(ISO_4217);
        expect(new Set(c.currencies).size).toBe(c.currencies.length);
        for (const f of FLAGS) expect(typeof c[f], f).toBe("boolean");
      });

      it("заявление неизменно: повторный вызов — то же, правка возвращённого не меняет следующее", async () => {
        const platform = await open();
        const first = platform.capabilities();
        const snapshot = structuredClone(first);
        (first.currencies as string[]).push("XXX");
        (first as { guaranteeContour: boolean }).guaranteeContour = !first.guaranteeContour;
        expect(platform.capabilities()).toEqual(snapshot);
      });

      it("версия протокола: подтверждённая checkProtocol — того же старшего номера и не ниже заявленной; не определена — причина из перечня (Р33 п. 10)", async () => {
        const platform = await open();
        const declared = triple(platform.capabilities().protocolVersion);
        const check = await platform.checkProtocol();
        if (check.status === "confirmed") {
          const v = triple(check.version);
          expect(v[0]).toBe(declared[0]);
          expect(notBelow(v, declared), `${check.version} ниже ${platform.capabilities().protocolVersion}`).toBe(true);
        } else {
          expect(["NO_VERSION", "BAD_RESPONSE", "NO_RESPONSE"]).toContain(check.detail);
        }
      });

      // Заявлено «есть» — поведение проверяет ч. 2 (подтверждение, спор); здесь — только согласованность заявления «нет».
      it("humanConfirmation = false — запрос подтверждения отклоняется PlatformFailure", async (ctx) => {
        const platform = await open();
        if (platform.capabilities().humanConfirmation) return ctx.skip("заявлено подтверждение человеком — проверка в ч. 2");
        await expect(platform.requestConfirmation(CONFIRMATION, { idempotencyKey: "conformance-confirmation" })).rejects.toBeInstanceOf(PlatformFailure);
      });

      it("disputeResolution = false — открытие спора отклоняется PlatformFailure", async (ctx) => {
        const platform = await open();
        if (platform.capabilities().disputeResolution) return ctx.skip("заявлен разбор спора — проверка в ч. 2");
        await expect(platform.openDispute(DISPUTE, { idempotencyKey: "conformance-dispute" })).rejects.toBeInstanceOf(PlatformFailure);
      });
    });

    describe("мандат (SPEC §9, Р29, инвариант 6)", () => {
      it("запрос — PENDING_SIGNATURE с пределами проекта; порядок отзыва задаёт платформа; валюта — из множества заявления", async () => {
        const s = await begin();
        const draft = s.intent();
        const m = await s.platform.requestMandate(draft, { idempotencyKey: "conformance-intent" });
        expect(m.id).toMatch(/\S/);
        expect(m.status).toBe("PENDING_SIGNATURE");
        expect(m).toMatchObject({ kind: draft.kind, amountLimit: draft.amountLimit, merchantScope: draft.merchantScope });
        expect(Date.parse(m.validTo)).toBe(Date.parse(draft.validTo));
        expect(m.revocationOrder).toMatch(/\S/);
        expect(s.platform.capabilities().currencies).toContain(m.amountLimit.currency);
        expect(await s.platform.getMandate(m.id)).toMatchObject({ id: m.id, status: "PENDING_SIGNATURE" });
      });

      it("до подписи человека verify не CONFIRMED; после — ACTIVE, CONFIRMED, остаток в валюте мандата и в пределах, as_of — время", async () => {
        const s = await begin();
        const m = await s.platform.requestMandate(s.intent(), { idempotencyKey: "conformance-intent" });
        const ref = { id: m.id, currency: m.amountLimit.currency };
        expect((await s.platform.verifyMandate(ref)).outcome).not.toBe("CONFIRMED");
        await s.signMandate(m.id);
        expect((await s.platform.getMandate(m.id)).status).toBe("ACTIVE");
        const v = await s.platform.verifyMandate(ref);
        expect(v.outcome).toBe("CONFIRMED");
        expect(v.amountLeft.currency).toBe(m.amountLimit.currency);
        expect(v.amountLeft.amount).toBeGreaterThanOrEqual(0);
        expect(v.amountLeft.amount).toBeLessThanOrEqual(m.amountLimit.amount);
        expect(v.asOf).toMatch(ISO_TIME);
      });

      it("отказ агента от мандата — REVOKED, verify больше не CONFIRMED; выписка — цепочка с этим мандатом", async () => {
        const s = await begin();
        const m = await s.platform.requestMandate(s.intent(), { idempotencyKey: "conformance-intent" });
        await s.signMandate(m.id);
        expect((await s.platform.relinquishMandate(m.id, { idempotencyKey: "conformance-relinquish" })).status).toBe("REVOKED");
        expect((await s.platform.verifyMandate({ id: m.id, currency: m.amountLimit.currency })).outcome).not.toBe("CONFIRMED");
        const e = await s.platform.mandateEvidence(m.id);
        expect(["OK", "BROKEN"]).toContain(e.integrity);
        if (e.integrity === "OK") expect(e.mandateChain.map((x) => x.id)).toContain(m.id);
      });
    });

    describe("реквизит (инвариант 1, Р45 п. 3)", () => {
      it("по подписанному CART: ядру — только ссылка, вид, состояние и свой признак; платёжных данных нет", async () => {
        const s = await begin();
        const cart = await signedCart(s);
        const draft = credentialDraft(cart, "ord_conformance_1");
        const c = await s.platform.issueCredential(draft, { idempotencyKey: "conformance-credential" });
        expect(Object.keys(c).sort()).toEqual(CREDENTIAL_FIELDS);
        expect(c.credentialRef).toMatch(/\S/);
        expect(c.channel).toBe(draft.channel);
        expect(c.indicator).toEqual({ agentCode: s.agentCode, mandateId: cart.id });
        expectNoSecrets(c, s.issuedSecrets());
      });

      it("пакет агентской оплаты: реквизит — тот же вид и признак; пакет запечатан — платёжных данных не видно", async () => {
        const s = await begin();
        const cart = await signedCart(s);
        const draft = credentialDraft(cart, "ord_conformance_2");
        const { credential, sealed } = await s.platform.issuePaymentPackage(draft, { idempotencyKey: "conformance-package" });
        expect(credential.channel).toBe(draft.channel);
        expect(credential.indicator).toEqual({ agentCode: s.agentCode, mandateId: cart.id });
        expectNoSecrets(credential, s.issuedSecrets());
        expectNoSecrets(sealed, s.issuedSecrets());
      });

      it("по мандату, от которого агент отказался, — отказ PlatformFailure, реквизита нет", async () => {
        const s = await begin();
        const cart = await signedCart(s);
        await s.platform.relinquishMandate(cart.id, { idempotencyKey: "conformance-relinquish" });
        const before = s.issuedSecrets().length;
        await expect(s.platform.issueCredential(credentialDraft(cart, "ord_conformance_3"), { idempotencyKey: "conformance-credential" })).rejects.toBeInstanceOf(PlatformFailure);
        expect(s.issuedSecrets()).toHaveLength(before);
      });

      it("по действующему CART другого агента — отказ PlatformFailure, реквизита нет", async () => {
        const s = await begin();
        const cart = await signedCart(s, s.foreign);
        const before = s.issuedSecrets().length;
        await expect(s.platform.issueCredential(credentialDraft(cart, "ord_conformance_4"), { idempotencyKey: "conformance-credential" })).rejects.toBeInstanceOf(PlatformFailure);
        expect(s.issuedSecrets()).toHaveLength(before);
      });
    });
  });
}
