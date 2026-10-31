// Набор соответствия адаптеров платформы (AG-20, Р67): общие проверки порта PaymentPlatform, которые обязан пройти
// любой адаптер (ПАО, банк, песочница, НСПК — Р19, дополнение 11.10). Набор видит только порт и тестовую сторону цели;
// contour, adapters/* и compose не импортирует — Р67 п. 1, tests/unit/conformance-imports.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import type { PaymentPlatform, PlatformCapabilities } from "../../src/agent/ports/index.js";
import { PlatformFailure, type ConfirmationDraft, type DisputeDraft } from "../../src/shared/domain.js";

/** Открытая цель: настоящий адаптер за портом и тестовая сторона платформы (растёт по кирпичам AG-20). */
export interface ConformanceSession {
  readonly platform: PaymentPlatform;
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

export function describeConformance(target: ConformanceTarget): void {
  describe(`набор соответствия адаптеров (AG-20, Р67) — ${target.name}`, () => {
    let session: ConformanceSession | undefined;
    afterEach(async () => {
      await session?.close();
      session = undefined;
    });
    const open = async (): Promise<PaymentPlatform> => (session = await target.open()).platform;

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
  });
}
