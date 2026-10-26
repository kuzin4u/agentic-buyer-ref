// Тестовая обёртка над PaoStub agentic-core для П01–П03 и связки ключей; написана под v0.3.0; с ядром v0.6.0 (Р31) её поведение не менялось.
// ОБЁРТКА, НЕ ДОРАБОТКА ЗАГЛУШКИ: эмулирует то, чего не было в PaoStub v0.3.0 (расхождение № 9 в STATUS):
//  1) статус EXCLUDED: GET /pao/v1/agent — 200, status EXCLUDED; прочие методы — 403 AGENT_SUSPENDED (РП23 п. 6.3 Платформы);
//  2) сроки ключей в GET /pao/v1/agent;
//  3) POST /pao/v1/agent/keys по РП23: новый ключ на key_ttl_days, сроки прежних ACTIVE сокращаются до now + key_overlap_days;
//  4) класс агента в GET /pao/v1/agent (Р27);
//  5) НЕ эмулируется: KEY_INVALID и REQUEST_INVALID при регистрации (РП31 п. 2 — свой отозванный, чужой ключ, alg, тело
//     не по схеме) — обёртка отвечает 201; где нужен отказ, тест ставит stub.fail (он главнее обработчика). STATUS «Открыто», Р31.
// С v0.5.0 (К13 ядра) заглушка умеет 1–4 сама, но свои обработчики GET /pao/v1/agent и POST /pao/v1/agent/keys по-прежнему
// имеют приоритет — тесты идут через обёртку. Упрощение обёртки до заглушки ядра — STATUS «Открыто» (Р31).
// Ключ заглушки: status необязателен с v0.5.0 (PaoStubKey), по умолчанию ACTIVE.
// Подпись, nonce, окно времени, Idempotency-Key и схемы проверяет сама заглушка.
import { createHash, createPublicKey } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaoStub, type PaoOperationKey, type PaoStubAgent, type PaoStubOptions } from "@kuzin4u/agentic-core/pao";
import { generateKey, type SignerDescriptor } from "../../src/agent/signer/index.js";
import { writeMeta } from "../../src/agent/signer/keystore.js";
import { loadParams } from "../../src/shared/config.js";

export const AGENT = "nspk:agent:buyref-01:v3";
const DAY = 86_400_000;

/** kid так, как его присваивает платформа: RFC 7638 по {crv,kty,x}; независимо от signer/kid.ts агента. */
export function platformKid(publicKey: string): string {
  const { x } = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }).export({ format: "jwk" });
  return createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest("base64url");
}

export interface StandOptions {
  /** сколько ключей агента уже в реестре и в хранилище: первый внесён оператором при допуске, остальные — следы
   *  прошлых ротаций агента (их valid_from — в метаданных хранилища) */
  keys?: number;
  /** агент вообще не внесён в реестр (AGENT_UNKNOWN) */
  unregistered?: boolean;
  ttlDays?: number;
  overlapDays?: number;
  /** обработчики прочих операций — как у PaoStub */
  handlers?: PaoStubOptions["handlers"];
  /** ответ GET /.well-known/pao-configuration (Р33 п. 10); по умолчанию PaoStub отдаёт versions ["v1"] */
  configuration?: PaoStubOptions["configuration"];
}

/** Р33 п. 10: чтение конфигурации на стадии 0 — первое обращение каждого допуска (PaoStub отдаёт versions ["v1"]). */
export const CONFIGURATION = { op: "GET /.well-known/pao-configuration", status: 200 } as const;

export class PaoStand {
  readonly dir = mkdtempSync(join(tmpdir(), "buyref-keys-"));
  readonly descriptors: SignerDescriptor[] = [];
  status: "ACTIVE" | "SUSPENDED" | "EXCLUDED" = "ACTIVE";
  /** класс в реестре (эмуляция, см. шапку); undefined — поле не отдаётся */
  agentClass: string | undefined = "BUYER";
  /** предел второго слоя лимита (ПАО §2, Р59); undefined — поле не отдаётся (в ПАО 1.4.0 необязательно) */
  rateLimitPerMin: number | undefined = undefined;
  clock = new Date("2026-10-12T09:00:00Z");
  readonly stub: PaoStub;
  private readonly agent: PaoStubAgent = { agentCode: AGENT, status: "ACTIVE", keys: [] };
  private readonly dates = new Map<string, { valid_from: string; valid_to: string }>();
  private readonly ttl: number;
  private readonly overlap: number;

  constructor(o: StandOptions = {}) {
    // По умолчанию платформа стенда работает по тем же стендовым параметрам, что и агент (config/params.stand.json).
    const params = loadParams();
    this.ttl = (o.ttlDays ?? params.key_ttl_days) * DAY;
    this.overlap = (o.overlapDays ?? params.key_overlap_days) * DAY;
    for (let i = 0; i < (o.keys ?? 1); i++) {
      const d = generateKey(this.dir).descriptor;
      this.descriptors.push(d);
      // При допуске ключи вносятся с разницей в сутки: новейший — последний.
      this.add(d, new Date(this.clock.getTime() - (o.keys ?? 1) * DAY + i * DAY));
    }
    // Несколько ключей — следы прошлых запусков агента: их подтверждённые valid_from уже в метаданных хранилища.
    if ((o.keys ?? 1) > 1) {
      writeMeta(this.dir, Object.fromEntries(this.descriptors.map((d) => [d.kid, { ...this.dates.get(d.kid)! }])));
    }
    this.stub = new PaoStub({
      ...(o.configuration && { configuration: o.configuration }),
      agents: o.unregistered ? [] : [this.agent],
      handlers: {
        ...o.handlers,
        "GET /pao/v1/agent": () => ({
          body: {
            agent_code: AGENT,
            status: this.status,
            // приведение — чтобы тест мог отдать и значение вне перечня ПАО (ожидается UNKNOWN у адаптера)
            ...(this.agentClass !== undefined && { class: this.agentClass as "BUYER" }),
            keys: this.agent.keys.map((k) => ({ kid: k.kid, alg: k.alg, public_key: k.publicKey, status: k.status ?? "ACTIVE", ...this.dates.get(k.kid)! })),
            ...(this.rateLimitPerMin !== undefined && { rate_limit_per_min: this.rateLimitPerMin }),
          },
        }),
        "POST /pao/v1/agent/keys": ({ body }) => {
          const now = this.clock.getTime();
          for (const k of this.agent.keys) {
            const d = this.dates.get(k.kid)!;
            if (k.status === "ACTIVE" && Date.parse(d.valid_to) > now + this.overlap) d.valid_to = new Date(now + this.overlap).toISOString();
          }
          const kid = this.add({ alg: body.alg, public_key: body.public_key }, this.clock);
          this.registrations.push(kid);
          return { status: 201, body: { kid, alg: body.alg, public_key: body.public_key, status: "ACTIVE" as const, ...this.dates.get(kid)! } };
        },
      },
    });
  }

  /** kid ключей, зарегистрированных агентом по HTTP */
  readonly registrations: string[] = [];

  private add(d: { alg: string; public_key: string }, from: Date): string {
    const kid = platformKid(d.public_key);
    this.agent.keys.push({ kid, alg: d.alg, publicKey: d.public_key, status: "ACTIVE" });
    this.dates.set(kid, { valid_from: from.toISOString(), valid_to: new Date(from.getTime() + this.ttl).toISOString() });
    return kid;
  }

  validTo(kid: string): string {
    return this.dates.get(kid)!.valid_to;
  }

  revoke(kid: string): void {
    const k = this.agent.keys.find((x) => x.kid === kid)!;
    k.status = "REVOKED";
  }

  /** Исключённый агент: GET /pao/v1/agent — EXCLUDED, указанные методы — 403 AGENT_SUSPENDED (эмуляция, см. шапку). */
  exclude(otherOps: PaoOperationKey[], times = 10): void {
    this.status = "EXCLUDED";
    for (const op of otherOps) this.stub.fail(op, { code: "AGENT_SUSPENDED" }, times);
  }

  calls(op: PaoOperationKey) {
    return this.stub.calls.filter((c) => c.op === op);
  }

  /** Полный журнал обращений к стенду: метод и статус по порядку — лишнее обращение к другому методу видно. */
  log() {
    return this.stub.calls.map(({ op, status }) => ({ op, status }));
  }

  async close(): Promise<void> {
    await this.stub.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
