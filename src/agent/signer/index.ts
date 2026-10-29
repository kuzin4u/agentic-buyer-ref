// Подпись обращений и ротация ключей; ключи подписи живут только здесь (инвариант 2).
// Наружу — kid, проверка слабых ключей, хранилище (подписант и описатель), связка ключей; закрытый ключ не экспортируется.
export {
  SignerKeyRejected,
  SignerRotationStopped,
  SignerStopped,
  SignerSuspended,
  TlsCertificateRejected,
  TlsConfigInvalid,
  TlsTrustMismatch,
  type TlsCertRejection,
} from "./errors.js";
export { assertKid, kidOf, type Ed25519Jwk } from "./kid.js";
export { assertStrongEd25519 } from "./weak.js";
export { generateKey, listKeys, loadKey, type KeyState, type LoadedKey, type SignerDescriptor } from "./keystore.js";
export { KeyRing, type Admit, type KeyRingOptions } from "./ring.js";
// Ключ канала mTLS (Р64): наружу — описатель, CSR для заявления на допуск, закрепление корня и установка сертификата;
// закрытый ключ — только внутри signer.
export {
  generateTlsKey,
  installTlsCertificate,
  parseFingerprint,
  pinRoot,
  tlsCsr,
  tlsKeyDescriptor,
  type InstallTlsOptions,
  type InstalledTlsCertificate,
  type TlsKeyDescriptor,
  type TlsRoot,
} from "./tls.js";
