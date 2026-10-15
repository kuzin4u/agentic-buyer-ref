// Слабые открытые ключи Ed25519: неканоническая запись точки, точка не на кривой или малого порядка ([8]A = O).
// С ключом малого порядка подпись «R = нейтраль, S = 0» верна для любого сообщения — подписать может любой (A2 п. 5.1).
// Проверка — функция ядра agentic-core v0.3.0 (К10, векторы ed25519_weak_keys); своей копии арифметики кривой нет (AG-05 К1.3).
import { isWeakEd25519 } from "@kuzin4u/agentic-core";
import { SignerKeyRejected } from "./errors.js";

export { isWeakEd25519 };

/** Ключ слабый — SignerKeyRejected (fail-closed, инвариант 4). */
export function assertStrongEd25519(x: Buffer): void {
  if (isWeakEd25519(x)) throw new SignerKeyRejected("слабый ключ Ed25519: длина не 32 байта, неканоническая запись, точка вне кривой или малого порядка");
}
