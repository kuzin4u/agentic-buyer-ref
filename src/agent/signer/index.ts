// Подпись обращений и ротация ключей; ключи подписи живут только здесь (инвариант 2).
// Наружу — kid, проверка слабых ключей, хранилище (подписант и описатель); закрытый ключ не экспортируется.
export { SignerKeyRejected } from "./errors.js";
export { assertKid, kidOf, type Ed25519Jwk } from "./kid.js";
export { assertStrongEd25519 } from "./weak.js";
export { generateKey, loadKey, type LoadedKey, type SignerDescriptor } from "./keystore.js";
