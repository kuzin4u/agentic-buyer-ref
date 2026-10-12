// Слабые открытые ключи Ed25519: неканоническая запись точки или точка малого порядка ([8]A = O).
// С ключом малого порядка подпись «R = нейтраль, S = 0» верна для любого сообщения — подписать может любой (A2 п. 5.1).
// Алгоритм — тот же, что у Платформы (agentic-ps-platform v0.1.0, src/registry/keys.ts, аудит PS-04 №1);
// до CO-1 (проверка в ed25519Verifier agentic-core) агент держит свою копию.
import { SignerKeyRejected } from "./errors.js";

// Кривая Ed25519 (RFC 8032 §5.1): p = 2^255 − 19, d = −121665/121666, a = −1.
const P = 2n ** 255n - 19n;
const mod = (n: bigint): bigint => ((n % P) + P) % P;
function pow(b: bigint, e: bigint): bigint {
  let r = 1n;
  for (b = mod(b); e > 0n; e >>= 1n, b = (b * b) % P) if (e & 1n) r = (r * b) % P;
  return r;
}
const inv = (n: bigint): bigint => pow(n, P - 2n);
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

type Point = readonly [bigint, bigint];

/** Полная формула сложения скрученной кривой Эдвардса (a = −1). */
function add([x1, y1]: Point, [x2, y2]: Point): Point {
  const t = mod(D * x1 * x2 * y1 * y2);
  return [mod((x1 * y2 + y1 * x2) * inv(1n + t)), mod((y1 * y2 + x1 * x2) * inv(1n - t))];
}

/** Разбор 32 байт по RFC 8032 §5.1.3 со строгой каноничностью: y < p, x = 0 без знакового бита. Иначе null. */
function decodePoint(bytes: Buffer): Point | null {
  if (bytes.length !== 32) return null;
  const sign = bytes[31]! >> 7;
  const le = Buffer.from(bytes);
  le[31] = le[31]! & 0x7f;
  const y = BigInt(`0x${Buffer.from(le).reverse().toString("hex")}`);
  if (y >= P) return null;
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  let x = mod(u * pow(v, 3n) * pow(u * pow(v, 7n), (P - 5n) / 8n));
  if (mod(v * x * x) !== u) {
    if (mod(v * x * x) !== mod(-u)) return null;
    x = mod(x * SQRT_M1);
  }
  if (x === 0n && sign === 1) return null;
  if (Number(x & 1n) !== sign) x = mod(-x);
  return [x, y];
}

/** Слабый ключ: 32 байта точки не разбираются строго или [8]A — нейтраль. */
export function isWeakEd25519(x: Buffer): boolean {
  const a = decodePoint(x);
  if (!a) return true;
  let q: Point = a;
  for (let i = 0; i < 3; i++) q = add(q, q);
  return q[0] === 0n && q[1] === 1n;
}

/** Ключ слабый — SignerKeyRejected (fail-closed, инвариант 4). */
export function assertStrongEd25519(x: Buffer): void {
  if (isWeakEd25519(x)) throw new SignerKeyRejected("слабый ключ Ed25519: неканоническая запись или точка малого порядка");
}
