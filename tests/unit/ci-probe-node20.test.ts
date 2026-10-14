// ВРЕМЕННО (AG-04 К3.1а, подставная поломка): падает только на Node 20.x — итоговая проверка test должна покраснеть.
// Удаляется git revert следующим коммитом.
import { expect, it } from "vitest";

it("подставная поломка: только Node 20", () => {
  expect(process.versions.node.startsWith("20.")).toBe(false);
});
