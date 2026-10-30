// Способ оплаты агента у витрины (дополнение 1 к Р66 п. 3): зона контура — только при непустом пересечении
// `payment_methods` витрины со способами, которые агент исполняет. Строки витрины — данные (инвариант 5): соответствие
// точное, по строке, без нормализации регистра и пробелов; прочие строки способом не считаются.
import type { PaymentChannel } from "../../shared/domain.js";

/** Способы, которые агент исполняет в контуре: канал реквизита `POST /pao/v1/credentials` и сверка канала операции.
 *  Новый способ добавляется сюда вместе с его исполнением; правило зоны не меняется. */
export const AGENT_CHANNELS: readonly PaymentChannel[] = ["CARD"];

/** Строка `payment_methods` витрины → канал ПАО (`Credential.kind`). */
const SHOP_METHOD: Readonly<Record<string, PaymentChannel>> = { card: "CARD", sbp: "SBP" };

/** Канал реквизита у этой витрины: первый из способов агента (порядок агента), который витрина принимает; null —
 *  пересечение пусто (пустой список или только неизвестные строки). */
export function paymentChannel(shopMethods: readonly string[], agent: readonly PaymentChannel[] = AGENT_CHANNELS): PaymentChannel | null {
  const accepted = new Set(shopMethods.filter((m) => Object.hasOwn(SHOP_METHOD, m)).map((m) => SHOP_METHOD[m]));
  return agent.find((c) => accepted.has(c)) ?? null;
}
