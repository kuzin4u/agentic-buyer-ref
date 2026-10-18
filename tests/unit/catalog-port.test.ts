// Порт живого предложения (Р32 п. 3) совпадает по форме с LiveOfferSource ядра (К15): в обе стороны, на уровне типов.
// Сравнение типов выполняет `tsc --noEmit` (`npm run check`, CI; tsconfig включает tests), не vitest: без него тест пуст.
import { describe, expectTypeOf, it } from "vitest";
import type * as core from "@kuzin4u/agentic-core/catalog";
import type { LiveOffer, LiveOfferRequest, LiveOfferSource } from "../../src/agent/ports/index.js";

describe("порт LiveOfferSource (Р32)", () => {
  it("типы порта и ядра взаимно присваиваемы", () => {
    expectTypeOf<LiveOfferSource>().toEqualTypeOf<core.LiveOfferSource>();
    expectTypeOf<LiveOfferRequest>().toEqualTypeOf<core.LiveOfferRequest>();
    expectTypeOf<LiveOffer>().toEqualTypeOf<core.LiveOffer>();
  });
});
