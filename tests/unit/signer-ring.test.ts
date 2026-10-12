// Связка ключей: плановая ротация (A2 п. 5.3), сроки — только от платформы (РП23), сверка с реестром (fail-closed).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { loadParams } from "../../src/shared/config.js";
import { KeyRing, SignerKeyRejected, SignerStopped, generateKey, kidOf, listKeys } from "../../src/agent/signer/index.js";
import { lockDir, readMeta } from "../../src/agent/signer/keystore.js";
import type { AgentKey, AgentSelf } from "../../src/shared/domain.js";
import { coreOn } from "../support/core.js";
import { AGENT, PaoStand } from "../support/pao-stand.js";

const DAY = 86_400_000;
const params = loadParams();
/** стендовый key_overlap_days агента — из конфигурации, не литералом */
const OVERLAP = params.key_overlap_days * DAY;
let stand: PaoStand | undefined;
let dir: string | undefined;
afterEach(async () => {
  await stand?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  stand = dir = undefined;
});

const signedKids = (j: MemoryJournal) => j.entries.filter((e) => e.kind === "request.signed").map((e) => e.kid);

describe("плановая ротация против стенда ПАО", () => {
  it("до valid_to больше key_overlap_days — ротации нет; меньше — новый ключ регистрируется прежним, затем переход", async () => {
    stand = new PaoStand(); // ключ внесён сутки назад на key_ttl_days стенда
    const { core, journal } = await coreOn(stand);
    await core.start();
    const old = stand.descriptors[0]!.kid;

    await core.maintainKeys();
    expect(stand.registrations).toEqual([]);

    stand.clock = new Date(Date.parse(stand.validTo(old)) - OVERLAP);
    await core.maintainKeys();
    const [fresh] = stand.registrations;
    expect(fresh).toBeDefined();
    // регистрация подписана прежним ключом; переход — только после ответа платформы
    const reg = journal.entries.findIndex((e) => e.kind === "key.registered");
    expect(journal.entries[reg - 1]).toMatchObject({ kind: "request.signed", kid: old });
    expect(journal.entries.slice(reg)).toContainEqual(expect.objectContaining({ kind: "key.switched", kid: fresh }));
    expect(stand.calls("POST /pao/v1/agent/keys")).toMatchObject([{ status: 201, idempotencyKey: `agent-key-${fresh}` }]);

    await core.platform.agentSelf();
    expect(signedKids(journal).at(-1)).toBe(fresh);
    expect(stand.stub.violations).toEqual([]);
  });

  it("сроки — из ответа платформы, а не из key_ttl_days: ключ на key_ttl_days / 3 ротируется за key_overlap_days до своего valid_to", async () => {
    stand = new PaoStand({ ttlDays: params.key_ttl_days / 3 }); // платформа выдала срок короче стендового key_ttl_days
    const { core } = await coreOn(stand);
    await core.start();
    const validTo = Date.parse(stand.validTo(stand.descriptors[0]!.kid));

    stand.clock = new Date(validTo - OVERLAP - 1000);
    await core.maintainKeys();
    expect(stand.registrations).toEqual([]);
    stand.clock = new Date(validTo - OVERLAP);
    await core.maintainKeys();
    expect(stand.registrations).toHaveLength(1);
  });

  it("срок прежнего ключа после регистрации — тот, что сократила платформа (now + overlap по РП23)", async () => {
    const short = Math.floor(params.key_overlap_days / 2); // платформа сокращает срок короче стендового key_overlap_days агента
    expect(short).toBeGreaterThan(0);
    expect(short).toBeLessThan(params.key_overlap_days);
    stand = new PaoStand({ overlapDays: short });
    const { core } = await coreOn(stand);
    await core.start();
    const old = stand.descriptors[0]!.kid;
    stand.clock = new Date(Date.parse(stand.validTo(old)) - OVERLAP);
    await core.maintainKeys();
    expect(stand.validTo(old)).toBe(new Date(stand.clock.getTime() + short * DAY).toISOString());
    // новейший ключ сам ещё не близок к сроку — повторной ротации нет
    await core.maintainKeys();
    expect(stand.registrations).toHaveLength(1);
  });

  it("регистрация не прошла — подпись остаётся на прежнем ключе", async () => {
    stand = new PaoStand();
    const { core, journal } = await coreOn(stand);
    await core.start();
    const old = stand.descriptors[0]!.kid;
    stand.clock = new Date(Date.parse(stand.validTo(old)) - DAY);
    stand.stub.fail("POST /pao/v1/agent/keys", { code: "UPSTREAM_UNAVAILABLE" }, params.pao_max_attempts); // на все попытки адаптера

    await expect(core.maintainKeys()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(journal.entries.some((e) => e.kind === "key.switched")).toBe(false);
    await core.platform.agentSelf();
    expect(signedKids(journal).at(-1)).toBe(old);
  });
});

describe("сверка с реестром (fail-closed)", () => {
  const ring = (j = new MemoryJournal()) => {
    dir = mkdtempSync(join(tmpdir(), "buyref-keys-"));
    const d = generateKey(dir).descriptor;
    const now = new Date("2026-10-12T09:00:00Z");
    const r = new KeyRing({ dir, params, journal: j, now: () => now });
    const key = (over: Partial<AgentKey> = {}): AgentKey => ({
      kid: d.kid,
      alg: "ed25519",
      publicKey: d.public_key,
      validFrom: "2026-10-01T00:00:00Z",
      validTo: "2026-12-30T00:00:00Z",
      status: "ACTIVE",
      ...over,
    });
    const self = (keys: AgentKey[], status: AgentSelf["status"] = "ACTIVE") => async (): Promise<AgentSelf> => ({ agentCode: AGENT, status, keys });
    return { r, d, key, self, j };
  };

  it.each([
    ["открытый ключ в реестре не совпадает с хранилищем", (k: ReturnType<typeof ring>) => [k.key({ publicKey: generateKey(join(dir!, "other")).descriptor.public_key })], "KEY_MISMATCH"],
    ["в реестре нет нашего ключа", () => [], "NO_ACTIVE_KEY"],
    ["ключ в реестре REVOKED", (k: ReturnType<typeof ring>) => [k.key({ status: "REVOKED" })], "NO_ACTIVE_KEY"],
    ["ключ в реестре EXPIRED", (k: ReturnType<typeof ring>) => [k.key({ status: "EXPIRED" })], "NO_ACTIVE_KEY"],
    ["valid_to уже наступил", (k: ReturnType<typeof ring>) => [k.key({ validTo: "2026-10-12T09:00:00Z" })], "NO_ACTIVE_KEY"],
    ["платформа не сообщила valid_to", (k: ReturnType<typeof ring>) => [k.key({ validTo: null })], "NO_ACTIVE_KEY"],
  ])("%s — остановка", async (_n, keys, reason) => {
    const k = ring();
    await expect(k.r.start(k.self(keys(k)))).rejects.toThrow(SignerStopped);
    expect(k.j.entries.at(-1)).toMatchObject({ kind: "agent.stopped", reason });
    expect(() => k.r.port().current()).toThrow(SignerStopped);
  });

  it("агент SUSPENDED по ответу GET /pao/v1/agent — остановка", async () => {
    const k = ring();
    await expect(k.r.start(k.self([k.key()], "SUSPENDED"))).rejects.toThrow(SignerStopped);
    expect(k.j.entries.at(-1)).toMatchObject({ kind: "agent.stopped", reason: "AGENT_SUSPENDED" });
  });

  /** Платформа-подделка для ротации: регистрирует присланный ключ; ответ GET /pao/v1/agent задаёт тест. */
  const rotating = (k: ReturnType<typeof ring>, after: (fresh: AgentKey) => AgentKey[], reply?: (fresh: AgentKey) => AgentKey) => {
    let fresh: AgentKey | undefined;
    return {
      registerKey: async (draft: { alg: string; publicKey: string }): Promise<AgentKey> => {
        fresh = k.key({ kid: kidOf(draft.publicKey), publicKey: draft.publicKey, validFrom: "2026-10-12T09:00:00Z" });
        return reply ? reply(fresh) : fresh;
      },
      agentSelf: async (): Promise<AgentSelf> => ({ agentCode: AGENT, status: "ACTIVE", keys: after(fresh!) }),
    };
  };

  it("платформа подтвердила при регистрации чужой ключ — остановка (KEY_MISMATCH)", async () => {
    const k = ring();
    await k.r.start(k.self([k.key()]));
    const other = generateKey(dir!).descriptor;
    await expect(k.r.rotate(rotating(k, (f) => [k.key(), f], (f) => ({ ...f, kid: other.kid, publicKey: other.public_key })))).rejects.toMatchObject({
      reason: "KEY_MISMATCH",
    });
    expect(() => k.r.port().current()).toThrow(SignerStopped);
  });

  it("платформа вернула новый ключ не ACTIVE — ключ отклонён и не повторяется; подпись на прежнем; следующая ротация — новый ключ", async () => {
    const k = ring();
    await k.r.start(k.self([k.key()]));
    const sent: string[] = [];
    const p = rotating(k, (f) => [k.key(), f], (f) => (sent.push(f.kid), { ...f, status: "REVOKED" }));
    await expect(k.r.rotate(p)).rejects.toThrow(SignerKeyRejected);
    expect(k.r.port().current().kid).toBe(k.d.kid);
    await expect(k.r.rotate(p)).rejects.toThrow(SignerKeyRejected);
    expect(new Set(sent).size).toBe(2);
    expect(listKeys(dir!).filter((x) => x.state === "revoked")).toHaveLength(2);
  });

  it("после регистрации платформа не показала новый ключ действующим — SignerKeyRejected, подпись на прежнем", async () => {
    const k = ring();
    await k.r.start(k.self([k.key()]));
    await expect(k.r.rotate(rotating(k, () => [k.key()]))).rejects.toThrow(SignerKeyRejected);
    expect(k.r.port().current().kid).toBe(k.d.kid);
  });

  it("сверка после регистрации не подтвердила переход — подпись на прежнем ключе, повтор — тот же ключ и тот же Idempotency-Key", async () => {
    const k = ring();
    await k.r.start(k.self([k.key()]));
    const sent: string[] = [];
    const p = rotating(k, () => [k.key()], (f) => (sent.push(f.kid), f));
    await expect(k.r.rotate(p)).rejects.toThrow(SignerKeyRejected);
    // регистрация подтверждена — постоянное имя; ключом допуска не станет: в метаданных его нет
    expect(listKeys(dir!).find((x) => x.kid === sent[0])).toEqual({ kid: sent[0], state: "active" });
    expect(Object.keys(readMeta(dir!))).toEqual([k.d.kid]);
    await expect(k.r.rotate(p)).rejects.toThrow(SignerKeyRejected);
    expect(new Set(sent)).toEqual(new Set([sent[0]]));
    expect(k.r.port().current().kid).toBe(k.d.kid);
  });

  it("новый ключ в ответе есть, но срок ещё не начался — переход не подтверждён, в метаданные не попадает; повтор — тот же ключ", async () => {
    const k = ring();
    await k.r.start(k.self([k.key()]));
    const sent: string[] = [];
    const p = rotating(k, (f) => [k.key(), { ...f, validFrom: "2026-10-20T00:00:00Z" }], (f) => (sent.push(f.kid), f));
    await expect(k.r.rotate(p)).rejects.toThrow(SignerKeyRejected);
    expect(Object.keys(readMeta(dir!))).toEqual([k.d.kid]);
    await expect(k.r.rotate(p)).rejects.toThrow(SignerKeyRejected);
    await expect(k.r.rotate(p)).rejects.toThrow(SignerKeyRejected);
    expect(new Set(sent).size).toBe(1);
    expect(listKeys(dir!).filter((x) => x.state === "active")).toHaveLength(2);
  });

  it("после подтверждённого перехода ключ не считается ожидающим: следующая ротация — новый ключ, даже если реестр его не показал", async () => {
    const k = ring();
    await k.r.start(k.self([k.key()]));
    const sent: string[] = [];
    let first: AgentKey | undefined;
    // первая ротация: новый ключ B подтверждён; вторая: реестр показывает только A, B пропал
    const p = {
      registerKey: async (draft: { alg: string; publicKey: string }): Promise<AgentKey> => {
        const f = k.key({ kid: kidOf(draft.publicKey), publicKey: draft.publicKey, validFrom: "2026-10-12T09:00:00Z" });
        sent.push(f.kid);
        first ??= f;
        return f;
      },
      agentSelf: async (): Promise<AgentSelf> => ({ agentCode: AGENT, status: "ACTIVE", keys: sent.length === 1 ? [k.key(), first!] : [k.key()] }),
    };
    await k.r.rotate(p);
    expect(k.r.port().current().kid).toBe(sent[0]);
    await expect(k.r.rotate(p)).rejects.toThrow(SignerKeyRejected);
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toBe(sent[0]);
  });

  it("новый ключ после регистрации отозван сверкой — повторно не регистрируется; следующая ротация — новый ключ", async () => {
    const k = ring();
    await k.r.start(k.self([k.key()]));
    const sent: string[] = [];
    const p = rotating(k, (f) => [k.key(), { ...f, status: "REVOKED" }], (f) => (sent.push(f.kid), f));
    await expect(k.r.rotate(p)).rejects.toThrow(SignerKeyRejected);
    expect(listKeys(dir!)).toContainEqual({ kid: sent[0], state: "revoked" });
    await expect(k.r.rotate(p)).rejects.toThrow(SignerKeyRejected);
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toBe(sent[0]);
    expect(listKeys(dir!)).toContainEqual({ kid: sent[0], state: "revoked" }); // не вернулся в <kid>.pem
  });

  it("ожидающий перехода ключ затем отозван сверкой — следующая ротация создаёт новый ключ", async () => {
    const k = ring();
    await k.r.start(k.self([k.key()]));
    const sent: string[] = [];
    // 1) срок нового ключа не начался — ожидание перехода; 2) тот же ключ отозван сверкой; 3) новый ключ
    const steps = [(f: AgentKey) => [k.key(), { ...f, validFrom: "2026-10-20T00:00:00Z" }], (f: AgentKey) => [k.key(), { ...f, status: "REVOKED" as const }]];
    let step = 0;
    const q = rotating(k, (f) => steps[Math.min(step, 1)]!(f), (f) => (sent.push(f.kid), f));
    await expect(k.r.rotate(q)).rejects.toThrow(SignerKeyRejected);
    step = 1;
    await expect(k.r.rotate(q)).rejects.toThrow(SignerKeyRejected);
    expect(sent[1]).toBe(sent[0]); // повтор ожидающего — тот же ключ
    await expect(k.r.rotate(q)).rejects.toThrow(SignerKeyRejected);
    expect(sent[2]).not.toBe(sent[0]); // отозванный не регистрируется повторно
  });

  it("close на уже остановленной связке во время ротации: ответ регистрации не пишется в хранилище", async () => {
    const k = ring();
    await k.r.start(k.self([k.key()]));
    let release!: (key: AgentKey) => void;
    const p = {
      registerKey: (draft: { alg: string; publicKey: string }) =>
        new Promise<AgentKey>((r) => (release = () => r(k.key({ kid: kidOf(draft.publicKey), publicKey: draft.publicKey })))),
      agentSelf: async (): Promise<AgentSelf> => ({ agentCode: AGENT, status: "ACTIVE", keys: [k.key()] }),
    };
    const rotation = k.r.rotate(p);
    await new Promise((r) => setTimeout(r, 0));
    k.r.port().stop("AGENT_SUSPENDED"); // другое обращение остановило агента
    k.r.close();
    release(k.key());
    await expect(rotation).rejects.toThrow(SignerStopped);
    expect(listKeys(dir!).filter((x) => x.state === "active").map((x) => x.kid)).toEqual([k.d.kid]);
    expect(listKeys(dir!).filter((x) => x.state === "pending")).toHaveLength(1);
  });

  it("close: подпись и запись в хранилище остановлены (CLOSED), каталог освобождён", async () => {
    const k = ring();
    await k.r.start(k.self([k.key()]));
    k.r.close();
    expect(() => k.r.port().current()).toThrow(SignerStopped);
    await expect(k.r.rotate(rotating(k, (f) => [k.key(), f]))).rejects.toThrow(SignerStopped);
    expect(listKeys(dir!).filter((x) => x.state === "pending")).toHaveLength(0);
    expect(() => lockDir(dir!)()).not.toThrow();
  });

  it("в реестре действующий ключ, которого нет в хранилище, — запись key.foreign в журнале", async () => {
    const k = ring();
    const foreign = generateKey(join(dir!, "foreign")).descriptor; // подкаталог: файлы ключей не видны listKeys
    await k.r.start(k.self([k.key(), k.key({ kid: foreign.kid, publicKey: foreign.public_key })]));
    expect(k.j.entries).toContainEqual(expect.objectContaining({ kind: "key.foreign", kid: foreign.kid }));
  });

  it("ключ, срок которого ещё не начался (valid_from в будущем), не используется", async () => {
    const k = ring();
    await expect(k.r.start(k.self([k.key({ validFrom: "2026-10-13T00:00:00Z" })]))).rejects.toMatchObject({ reason: "NO_ACTIVE_KEY" });
  });

  it("ключа нет в новом ответе реестра — он больше не подтверждён: после отзыва нового ключа — остановка", async () => {
    const k = ring();
    await k.r.start(k.self([k.key()]));
    await k.r.rotate(rotating(k, (f) => [f])); // прежний ключ из ответа пропал
    const fresh = k.r.port().current().kid;
    expect(fresh).not.toBe(k.d.kid);
    expect(() => k.r.port().keyRevoked(fresh)).toThrow(SignerStopped);
    expect(k.j.entries.at(-1)).toMatchObject({ kind: "agent.stopped", reason: "NO_ACTIVE_KEY" });
  });

  it("подписант связки не раскрывает ключ: только kid, alg, sign; журнал — только идентификаторы", async () => {
    const k = ring();
    await k.r.start(k.self([k.key()]));
    const s = k.r.port().current();
    expect(Object.keys(s).sort()).toEqual(["alg", "kid", "sign"]);
    s.sign(Buffer.from("x"));
    expect(JSON.stringify(k.j.entries)).not.toContain(k.d.public_key);
  });
});
