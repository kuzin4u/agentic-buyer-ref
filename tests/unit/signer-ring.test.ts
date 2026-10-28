// Связка ключей: плановая ротация (A2 п. 5.3), сроки — только от платформы (РП23), сверка с реестром (fail-closed).
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import { loadParams } from "../../src/shared/config.js";
import { KeyRing, SignerKeyRejected, SignerRotationStopped, SignerStopped, SignerSuspended, generateKey, kidOf, listKeys } from "../../src/agent/signer/index.js";
import { lockDir, readMeta, writeMeta } from "../../src/agent/signer/keystore.js";
import { PlatformFailure, type AgentKey, type AgentSelf } from "../../src/shared/domain.js";
import { ruleForFailure } from "../../src/agent/declines/index.js";
import { PaoPlatform } from "../../src/agent/adapters/pao/index.js";
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
    expect(journal.entries[reg - 2]).toMatchObject({ kind: "request.signed", kid: old });
    expect(journal.entries[reg - 1]).toMatchObject({ kind: "pao.call", method: "POST /pao/v1/agent/keys", attempt: 1, result: "ok" });
    expect(journal.entries.slice(reg)).toContainEqual(expect.objectContaining({ kind: "key.switched", kid: fresh }));
    expect(stand.calls("POST /pao/v1/agent/keys")).toMatchObject([{ status: 201, idempotencyKey: `agent-key-${fresh}` }]);

    await core.platform.agentSelf();
    expect(signedKids(journal).at(-1)).toBe(fresh);
    expect(stand.stub.violations).toEqual([]);
  });

  it("KEY_INVALID от заглушки (422) насквозь: каждый раз новый ключ, после предела ротация остановлена, подпись прежним (Р31)", async () => {
    stand = new PaoStand();
    const { core, journal } = await coreOn(stand);
    await core.start();
    const old = stand.descriptors[0]!.kid;
    const limit = (ruleForFailure("KEY_INVALID").maxRetries ?? 0) + 1;
    stand.stub.fail("POST /pao/v1/agent/keys", { code: "KEY_INVALID" }, limit + 1); // fail заглушки — раньше обработчика обёртки
    stand.clock = new Date(Date.parse(stand.validTo(old)) - OVERLAP);
    for (let i = 0; i < limit - 1; i++) await expect(core.maintainKeys()).rejects.toMatchObject({ code: "KEY_INVALID", httpStatus: 422 });
    // вызов, набравший предел, — сразу SignerRotationStopped с исходным отказом (ревью КТ1 № 5)
    const last = (await core.maintainKeys().catch((e: unknown) => e)) as SignerRotationStopped;
    expect(last).toBeInstanceOf(SignerRotationStopped);
    expect(last.cause).toMatchObject({ code: "KEY_INVALID", httpStatus: 422 });
    const posts = stand.calls("POST /pao/v1/agent/keys");
    expect(posts.map((c) => c.status)).toEqual(Array(limit).fill(422));
    expect(new Set(posts.map((c) => c.idempotencyKey)).size).toBe(limit); // каждый раз новый ключ
    expect(journal.entries.filter((e) => e.kind === "key.rotation_stopped")).toMatchObject([{ reason: "KEY_INVALID" }]);
    await expect(core.maintainKeys()).rejects.toThrow(SignerRotationStopped);
    expect(stand.calls("POST /pao/v1/agent/keys")).toHaveLength(limit);
    await core.platform.agentSelf();
    expect(signedKids(journal).at(-1)).toBe(old);
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
  /** clock — подменные часы теста (по умолчанию постоянные 2026-10-12T09:00Z) */
  const ring = (j = new MemoryJournal(), clock = { now: new Date("2026-10-12T09:00:00Z") }) => {
    dir = mkdtempSync(join(tmpdir(), "buyref-keys-"));
    const d = generateKey(dir).descriptor;
    const r = new KeyRing({ dir, params, journal: j, now: () => clock.now });
    const key = (over: Partial<AgentKey> = {}): AgentKey => ({
      kid: d.kid,
      alg: "ed25519",
      publicKey: d.public_key,
      validFrom: "2026-10-01T00:00:00Z",
      validTo: "2026-12-30T00:00:00Z",
      status: "ACTIVE",
      ...over,
    });
    const self = (keys: AgentKey[], status: AgentSelf["status"] = "ACTIVE", agentClass: AgentSelf["agentClass"] = "BUYER") => async (): Promise<AgentSelf> => ({ agentCode: AGENT, status, agentClass, keys });
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

  it("Р63 п. 1: агент SUSPENDED по ответу GET /pao/v1/agent при допуске — приостановка без остановки; повторный допуск с ACTIVE её снимает", async () => {
    const k = ring();
    await expect(k.r.start(k.self([k.key()], "SUSPENDED"))).rejects.toMatchObject({ name: "SignerSuspended", reason: "AGENT_SUSPENDED" });
    expect(k.r.stopReason).toBeNull();
    expect(k.r.suspendReason).toBe("AGENT_SUSPENDED");
    expect(k.r.admitted).toBe(false);
    expect(k.j.entries.map((e) => e.kind)).not.toContain("agent.stopped");
    expect(k.j.entries.filter((e) => e.kind === "admission.failed")).toMatchObject([{ reason: "AGENT_SUSPENDED", kid: k.d.kid }]);
    expect(() => k.r.port().current()).toThrow(expect.objectContaining({ reason: "NOT_ADMITTED" })); // рабочий порт — до допуска
    // повтор при той же приостановке — снова приостановка; затем ACTIVE — допуск и снятие
    await expect(k.r.start(k.self([k.key()], "SUSPENDED"))).rejects.toThrow(SignerSuspended);
    expect(k.j.entries.filter((e) => e.kind === "signing.suspended")).toHaveLength(1);
    await k.r.start(k.self([k.key()]));
    expect(k.r.admitted).toBe(true);
    expect(k.r.suspendReason).toBeNull();
    expect(k.j.entries.filter((e) => e.kind === "signing.resumed")).toHaveLength(1);
    expect(k.r.port().current().kid).toBe(k.d.kid);
  });

  it("Р63 п. 1: 403 AGENT_SUSPENDED на допуске — приостановка без остановки, admission.failed с кодом, start можно повторить", async () => {
    const k = ring();
    const failure = new PlatformFailure("AGENT_SUSPENDED", "never", "AGENT_SUSPENDED", 403, null);
    await expect(
      k.r.start(async (signing) => {
        signing.current();
        signing.suspend("AGENT_SUSPENDED"); // так делает адаптер (haltAgent)
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(k.r.stopReason).toBeNull();
    expect(k.r.suspendReason).toBe("AGENT_SUSPENDED");
    expect(k.j.entries.filter((e) => e.kind === "admission.failed")).toMatchObject([{ reason: "AGENT_SUSPENDED" }]);
    await k.r.start(k.self([k.key()]));
    expect(k.r.suspendReason).toBeNull();
  });

  // Р27: класс — после статуса; класс из реестра — в detail записи об остановке.
  it.each(["SELLER", "SURFACE", "SERVICE"] as const)("класс %s при допуске — остановка AGENT_CLASS_MISMATCH", async (cls) => {
    const k = ring();
    await expect(k.r.start(k.self([k.key()], "ACTIVE", cls))).rejects.toMatchObject({ reason: "AGENT_CLASS_MISMATCH" });
    expect(k.j.entries.at(-1)).toEqual(expect.objectContaining({ kind: "agent.stopped", reason: "AGENT_CLASS_MISMATCH", detail: cls }));
    expect(() => k.r.port().current()).toThrow(SignerStopped);
  });

  it("Р58 п. 3: SIGNATURE_INVALID дошёл до допуска без остановки адаптером — остановка, без повтора (повтор — у адаптера)", async () => {
    const k = ring();
    let calls = 0;
    const failure = new PlatformFailure("SIGNATURE_INVALID", "after_fix", "SIGNATURE_INVALID", 401, null);
    const err = (await k.r
      .start(async () => {
        calls++;
        throw failure;
      })
      .catch((e: unknown) => e)) as SignerStopped;
    expect(err).toBeInstanceOf(SignerStopped);
    expect(err.reason).toBe("SIGNATURE_INVALID");
    expect(err.cause).toBe(failure);
    expect(calls).toBe(1);
    expect(k.j.entries.at(-1)).toMatchObject({ kind: "agent.stopped", reason: "SIGNATURE_INVALID" });
  });

  it("Р63 п. 2: защитный вход подписывает при приостановке (три причины); до допуска, при остановке и без действующего ключа — SignerStopped", async () => {
    const clock = { now: new Date("2026-10-12T09:00:00Z") };
    const k = ring(new MemoryJournal(), clock);
    expect(() => k.r.port().protective()).toThrow(expect.objectContaining({ reason: "NOT_ADMITTED" }));
    await k.r.start(k.self([k.key()]));
    for (const reason of ["AGENT_SELF_UNKNOWN", "EVENTS_UNAVAILABLE", "AGENT_SUSPENDED"] as const) {
      k.r.port().suspend(reason);
      expect(k.r.suspendReason).toBe(reason);
      expect(() => k.r.port().current()).toThrow(SignerSuspended);
      expect(k.r.port().protective().kid).toBe(k.d.kid);
      await k.r.recheck(k.self([k.key()]));
      expect(k.r.suspendReason).toBeNull();
    }
    // срок ключа защитный вход не обходит (#usable)
    k.r.port().suspend("AGENT_SUSPENDED");
    clock.now = new Date("2026-12-30T00:00:00Z");
    expect(() => k.r.port().protective()).toThrow(expect.objectContaining({ name: "SignerStopped", reason: "NO_ACTIVE_KEY" }));
    expect(() => k.r.port().protective()).toThrow(SignerStopped);
  });

  /** Связка с двумя подтверждёнными ключами: A — ключ допуска (метаданные), B — второй действующий. */
  async function twoKeys() {
    const k = ring();
    const d2 = generateKey(dir!).descriptor;
    writeMeta(dir!, { [k.d.kid]: { valid_from: "2026-10-01T00:00:00Z", valid_to: "2026-12-30T00:00:00Z" } });
    const b = k.key({ kid: d2.kid, publicKey: d2.public_key, validFrom: "2026-09-01T00:00:00Z" });
    await k.r.start(k.self([k.key(), b]));
    expect(k.r.port().current().kid).toBe(k.d.kid);
    return { ...k, b: d2.kid };
  }

  it("Р63 п. 3: приостановка до локальной отметки — keyRevoked защитным путём отмечает ключ и не бросает; обычный путь — SignerSuspended", async () => {
    const k = await twoKeys();
    k.r.port().suspend("AGENT_SUSPENDED"); // пришла между 200 на отзыв и отметкой
    expect(k.r.port().keyRevoked(k.b, undefined, true).kid).toBe(k.d.kid);
    expect(k.j.entries).toContainEqual(expect.objectContaining({ kind: "key.revoked", kid: k.b, reason: "AGENT_KEY_REVOKED" }));
    expect(listKeys(dir!)).toContainEqual(expect.objectContaining({ kid: k.b, state: "revoked" }));
    expect(k.r.stopReason).toBeNull();
    expect(k.r.suspendReason).toBe("AGENT_SUSPENDED");
    expect(() => k.r.port().keyRevoked(k.b)).toThrow(SignerSuspended);
  });

  /** Адаптер ПАО на связке `k` и подставном fetch: отзыв ключа A — 401 AGENT_KEY_REVOKED (подписан им же, Р60 п. 7 (а)),
   *  подтверждающее GET /pao/v1/agent — статус агента `status`, A — REVOKED. У обращения — маршрут и kid подписи. */
  function selfRevoke(k: Awaited<ReturnType<typeof twoKeys>>, status: string, agentClass = "BUYER") {
    const calls: [string, string | undefined][] = [];
    const key = (kid: string, s: string) => ({ kid, alg: "ed25519", public_key: `pk_${kid}`, status: s, valid_from: "2026-10-01T00:00:00Z", valid_to: "2026-12-30T00:00:00Z" });
    const platform = new PaoPlatform({
      baseUrl: "http://pao.test",
      agentCode: AGENT,
      signing: k.r.port(),
      params,
      journal: k.j,
      sleep: async () => {},
      fetch: async (url, init) => {
        const route = `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`;
        const kid = /keyid="([^"]+)"/.exec(new Headers(init?.headers).get("signature-input") ?? "")?.[1];
        calls.push([route, kid]);
        const json = (s: number, body: unknown) => new Response(JSON.stringify(body), { status: s, headers: { "content-type": "application/json" } });
        if (route.endsWith("/revoke")) return json(401, { code: "AGENT_KEY_REVOKED", message: "отозван", retry: "new_key" });
        return json(200, { agent_code: AGENT, status, class: agentClass, keys: [key(k.d.kid, "REVOKED"), key(k.b, "ACTIVE")] });
      },
    });
    return { platform, calls };
  }

  it("Р63 К1.2 (а): при приостановке отзыв своего ключа подписи — 401, подтверждающее чтение защитным входом другим ключом; ACTIVE приостановку не снимает", async () => {
    const k = await twoKeys();
    k.r.port().suspend("AGENT_SUSPENDED");
    const { platform, calls } = selfRevoke(k, "ACTIVE");
    await expect(platform.revokeKey(k.d.kid, { idempotencyKey: "idem-revoke-a" })).resolves.toMatchObject({ kid: k.d.kid, status: "REVOKED" });
    expect(calls).toEqual([
      [`POST /pao/v1/agent/keys/${k.d.kid}/revoke`, k.d.kid],
      ["GET /pao/v1/agent", k.b],
    ]);
    expect(k.j.entries).toContainEqual(expect.objectContaining({ kind: "key.revoked", kid: k.d.kid }));
    // снятие — только сверкой (Р60 п. 2): подтверждающее чтение ACTIVE его не делает
    expect(k.r.suspendReason).toBe("AGENT_SUSPENDED");
    expect(k.j.entries.map((e) => e.kind)).not.toContain("signing.resumed");
    expect(() => k.r.port().current()).toThrow(SignerSuspended);
  });

  it.each([
    ["EXCLUDED", "BUYER", "AGENT_EXCLUDED"],
    ["ACTIVE", "SELLER", "AGENT_CLASS_MISMATCH"],
  ])("Р63 К1.2 (а): подтверждающее чтение при приостановке — %s / %s: обычная остановка %s", async (status, cls, reason) => {
    const k = await twoKeys();
    k.r.port().suspend("AGENT_SUSPENDED");
    const { platform } = selfRevoke(k, status, cls);
    await platform.revokeKey(k.d.kid, { idempotencyKey: "idem-revoke-a" }).catch(() => undefined);
    expect(k.r.stopReason).toBe(reason);
  });

  // chmod 0500 не мешает записи от root — тест зависит от среды (ревью КТ1 № 9)
  it.skipIf(process.getuid?.() === 0)("Р63 п. 5 (КТ1 сессии 44 № 5): сбой записи отметки — SignerStopped KEYSTORE_WRITE_FAILED с revokedKid; подпись уже остановлена — тоже с revokedKid", async () => {
    const k = await twoKeys();
    chmodSync(dir!, 0o500); // запись состояния ключа не пройдёт
    try {
      let err: unknown;
      try {
        k.r.port().keyRevoked(k.b, undefined, true);
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ name: "SignerStopped", reason: "KEYSTORE_WRITE_FAILED", revokedKid: k.b });
      expect(k.j.entries).toContainEqual(expect.objectContaining({ kind: "agent.stopped", reason: "KEYSTORE_WRITE_FAILED" }));
      // подпись уже остановлена: подтверждение отзыва ключа, которого связка не держит (отметки нет), — признак тоже
      let again: unknown;
      try {
        k.r.port().keyRevoked("kid_not_held");
      } catch (e) {
        again = e;
      }
      expect(again).toMatchObject({ name: "SignerStopped", reason: "KEYSTORE_WRITE_FAILED", revokedKid: "kid_not_held" });
    } finally {
      chmodSync(dir!, 0o700);
    }
  });

  describe("Р63 п. 6: отзыв брошенного ключа в maintain", () => {
    /** Связка с ключом допуска A и брошенным временным ключом B прошлого запуска, который реестр показывает ACTIVE. */
    async function abandoned(clock = { now: new Date("2026-10-12T09:00:00Z") }) {
      const k = ring(new MemoryJournal(), clock);
      const b = generateKey(dir!, "pending").descriptor;
      const bKey = k.key({ kid: b.kid, publicKey: b.public_key });
      await k.r.start(k.self([k.key(), bKey]));
      expect(k.j.entries).toContainEqual(expect.objectContaining({ kind: "key.abandoned_registered", kid: b.kid }));
      const revokes: string[] = [];
      const failure = (code: "UPSTREAM_UNAVAILABLE" | "KEY_INVALID") => new PlatformFailure(code, code === "KEY_INVALID" ? "never" : "same_key", code, code === "KEY_INVALID" ? 422 : 503, "x");
      /** платформа: revokeKey по очереди ответов (нет — успех), регистрация ключа — 503 (ротация отказала) */
      const platform = (replies: ("ok" | "UPSTREAM_UNAVAILABLE" | "KEY_INVALID")[] = []) => ({
        revokeKey: async (kid: string, o: { idempotencyKey: string }): Promise<AgentKey> => {
          revokes.push(`${kid}|${o.idempotencyKey}`);
          const r = replies.shift() ?? "ok";
          if (r !== "ok") throw failure(r);
          return { ...bKey, status: "REVOKED" };
        },
        registerKey: async (): Promise<AgentKey> => {
          throw failure("UPSTREAM_UNAVAILABLE");
        },
        agentSelf: k.self([k.key(), bKey]),
      });
      return { ...k, b: b.kid, bKey, revokes, platform, clock };
    }

    it("успех — key.revoked с причиной ABANDONED, ключ идемпотентности от kid; повторно не отзывается", async () => {
      const k = await abandoned();
      const p = k.platform();
      await k.r.maintain(p);
      expect(k.revokes).toEqual([`${k.b}|agent-key-revoke-${k.b}`]);
      expect(k.j.entries).toContainEqual(expect.objectContaining({ kind: "key.revoked", kid: k.b, reason: "ABANDONED" }));
      await k.r.maintain(p);
      expect(k.revokes).toHaveLength(1);
    });

    it("отказ отзыва (503) не блокирует ротацию; повтор — при следующем maintain тем же ключом; KEY_INVALID — снят с очереди", async () => {
      const k = await abandoned();
      const p = k.platform(["UPSTREAM_UNAVAILABLE", "KEY_INVALID"]);
      k.clock.now = new Date(Date.parse("2026-12-30T00:00:00Z") - OVERLAP); // пора ротировать
      // наружу — ошибка ротации, а не отзыва: ротация шла после отказа отзыва
      await expect(k.r.maintain(p)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", httpStatus: 503, idempotencyKey: "x" });
      expect(k.j.entries.filter((e) => e.kind === "key.created")).toHaveLength(1);
      await expect(k.r.maintain(p)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
      expect(k.revokes).toEqual([`${k.b}|agent-key-revoke-${k.b}`, `${k.b}|agent-key-revoke-${k.b}`]);
      await k.r.maintain(p).catch(() => undefined);
      expect(k.revokes).toHaveLength(2); // после KEY_INVALID — не отзывается
      expect(k.j.entries.filter((e) => e.kind === "key.revoked" && e.reason === "ABANDONED")).toEqual([]);
      // снят с записью для оператора: ключ был ACTIVE по сверке, Платформа его не знает
      expect(k.j.entries.filter((e) => e.kind === "key.revoke_dropped")).toEqual([expect.objectContaining({ kid: k.b, reason: "KEY_INVALID" })]);
    });

    it("при приостановке — отзыв идёт, ротации нет: SignerSuspended, как прежде", async () => {
      const k = await abandoned();
      k.r.port().suspend("AGENT_SUSPENDED");
      await expect(k.r.maintain(k.platform())).rejects.toBeInstanceOf(SignerSuspended);
      expect(k.revokes).toHaveLength(1);
      expect(k.j.entries).toContainEqual(expect.objectContaining({ kind: "key.revoked", kid: k.b, reason: "ABANDONED" }));
    });

    it("перезапуск до отзыва: новая связка на том же каталоге — сверка при допуске снова ставит ключ в очередь (нюанс п. 6)", async () => {
      const k = await abandoned();
      k.r.close(); // упал до maintain
      const j2 = new MemoryJournal();
      const r2 = new KeyRing({ dir: dir!, params, journal: j2, now: () => k.clock.now });
      await r2.start(k.self([k.key(), k.bKey]));
      await r2.maintain(k.platform());
      expect(k.revokes).toEqual([`${k.b}|agent-key-revoke-${k.b}`]);
      expect(j2.entries).toContainEqual(expect.objectContaining({ kind: "key.revoked", kid: k.b, reason: "ABANDONED" }));
      r2.close();
    });
  });

  it("SUSPENDED и SELLER — приостановка по статусу (Р63 п. 1), класс не проверяется", async () => {
    const k = ring();
    await expect(k.r.start(k.self([k.key()], "SUSPENDED", "SELLER"))).rejects.toMatchObject({ name: "SignerSuspended", reason: "AGENT_SUSPENDED" });
    expect(k.j.entries.map((e) => e.kind)).not.toContain("agent.stopped");
  });

  it("сверка после ротации: класс в реестре стал SELLER — остановка AGENT_CLASS_MISMATCH", async () => {
    const k = ring();
    await k.r.start(k.self([k.key()]));
    let fresh: AgentKey | undefined;
    const p = {
      registerKey: async (draft: { alg: string; publicKey: string }): Promise<AgentKey> =>
        (fresh = k.key({ kid: kidOf(draft.publicKey), publicKey: draft.publicKey, validFrom: "2026-10-12T09:00:00Z" })),
      agentSelf: async (): Promise<AgentSelf> => ({ agentCode: AGENT, status: "ACTIVE", agentClass: "SELLER", keys: [k.key(), fresh!] }),
    };
    await expect(k.r.rotate(p)).rejects.toMatchObject({ reason: "AGENT_CLASS_MISMATCH" });
    expect(k.j.entries.at(-1)).toEqual(expect.objectContaining({ kind: "agent.stopped", reason: "AGENT_CLASS_MISMATCH", detail: "SELLER" }));
    expect(() => k.r.port().current()).toThrow(SignerStopped);
  });

  // Р27 (уточнение): приостановка рабочей подписи до успешной повторной сверки; порт сверки — только на время recheck.
  describe("приостановка подписи (AGENT_SELF_UNKNOWN)", () => {
    const suspendedCount = (j: MemoryJournal) => j.entries.filter((e) => e.kind === "signing.suspended").length;

    it("suspend до допуска — без действия; после допуска — рабочая подпись SignerSuspended", async () => {
      const k = ring();
      k.r.port().suspend("AGENT_SELF_UNKNOWN");
      await k.r.start(k.self([k.key()]));
      expect(() => k.r.port().current()).not.toThrow();
      k.r.port().suspend("AGENT_SELF_UNKNOWN");
      k.r.port().suspend("AGENT_SELF_UNKNOWN");
      expect(() => k.r.port().current()).toThrow(SignerSuspended);
      expect(suspendedCount(k.j)).toBe(1); // повторная приостановка не пишется
    });

    it("suspend после остановки — без действия: остаётся SignerStopped", async () => {
      const k = ring();
      await k.r.start(k.self([k.key()]));
      k.r.port().stop("AGENT_SUSPENDED");
      k.r.port().suspend("AGENT_SELF_UNKNOWN");
      expect(() => k.r.port().current()).toThrow(SignerStopped);
      expect(suspendedCount(k.j)).toBe(0);
    });

    it("recheck без приостановки — без signing.resumed; при приостановке — снимает её", async () => {
      const k = ring();
      await k.r.start(k.self([k.key()]));
      await k.r.recheck(k.self([k.key()]));
      expect(k.j.entries.map((e) => e.kind)).not.toContain("signing.resumed");
      k.r.port().suspend("AGENT_SELF_UNKNOWN");
      await k.r.recheck(k.self([k.key()]));
      expect(k.j.entries.at(-1)).toMatchObject({ kind: "signing.resumed" });
      expect(() => k.r.port().current()).not.toThrow();
    });

    it("порт сверки подписывает при приостановке только во время recheck; после выхода — SignerSuspended", async () => {
      const k = ring();
      await k.r.start(k.self([k.key()]));
      k.r.port().suspend("AGENT_SELF_UNKNOWN");
      let kept: Parameters<Parameters<KeyRing["recheck"]>[0]>[0] | undefined;
      await expect(
        k.r.recheck(async (signing) => {
          kept = signing;
          expect(() => signing.current()).not.toThrow();
          throw new PlatformFailure("BAD_RESPONSE", "never", null, 200, null, "ответ ПАО не по схеме");
        }),
      ).rejects.toMatchObject({ code: "BAD_RESPONSE" });
      expect(() => kept!.current()).toThrow(SignerSuspended);
      expect(() => k.r.port().current()).toThrow(SignerSuspended);
    });

    it("гонка: приостановка во время сверки не снимается её (более ранним) ответом", async () => {
      const k = ring();
      await k.r.start(k.self([k.key()]));
      await k.r.recheck(async () => {
        k.r.port().suspend("AGENT_SELF_UNKNOWN"); // параллельный рабочий запрос получил ответ не по схеме
        return { agentCode: AGENT, status: "ACTIVE", agentClass: "BUYER", keys: [k.key()] };
      });
      expect(() => k.r.port().current()).toThrow(SignerSuspended);
      expect(k.j.entries.map((e) => e.kind)).not.toContain("signing.resumed");
    });

    // Р60 п. 1: приостановление оператором — сильнее прочих причин; до допуска — остановка, как прежде.
    it("AGENT_SUSPENDED заменяет AGENT_SELF_UNKNOWN (запись signing.suspended); повтор AGENT_SUSPENDED — без записи; прочая причина его не заменяет", async () => {
      const k = ring();
      await k.r.start(k.self([k.key()]));
      k.r.port().suspend("AGENT_SELF_UNKNOWN");
      k.r.port().suspend("AGENT_SUSPENDED");
      k.r.port().suspend("AGENT_SUSPENDED");
      k.r.port().suspend("EVENTS_UNAVAILABLE");
      expect(k.r.suspendReason).toBe("AGENT_SUSPENDED");
      expect(k.j.entries.filter((e) => e.kind === "signing.suspended").map((e) => e.reason)).toEqual(["AGENT_SELF_UNKNOWN", "AGENT_SUSPENDED"]);
      expect(() => k.r.port().current()).toThrow(expect.objectContaining({ reason: "AGENT_SUSPENDED" }));
    });

    it("гонка: AGENT_SUSPENDED во время сверки, начатой при AGENT_SELF_UNKNOWN, её ответом ACTIVE не снимается", async () => {
      const k = ring();
      await k.r.start(k.self([k.key()]));
      k.r.port().suspend("AGENT_SELF_UNKNOWN");
      await k.r.recheck(async () => {
        k.r.port().suspend("AGENT_SUSPENDED"); // параллельное обращение получило 403 AGENT_SUSPENDED
        return { agentCode: AGENT, status: "ACTIVE", agentClass: "BUYER", keys: [k.key()] };
      });
      expect(k.r.suspendReason).toBe("AGENT_SUSPENDED");
      expect(k.j.entries.map((e) => e.kind)).not.toContain("signing.resumed");
    });

    it("гонка (ревью К1.1 № 2): повторный AGENT_SUSPENDED во время сверки, начатой при AGENT_SUSPENDED, её ответом ACTIVE не снимается", async () => {
      const k = ring();
      await k.r.start(k.self([k.key()]));
      k.r.port().suspend("AGENT_SUSPENDED");
      await k.r.recheck(async () => {
        k.r.port().suspend("AGENT_SUSPENDED"); // 403 на запрос, подписанный до приостановки, пришёл после ответа сверки
        return { agentCode: AGENT, status: "ACTIVE", agentClass: "BUYER", keys: [k.key()] };
      });
      expect(k.r.suspendReason).toBe("AGENT_SUSPENDED");
      expect(k.j.entries.filter((e) => e.kind === "signing.suspended")).toHaveLength(1);
      expect(k.j.entries.map((e) => e.kind)).not.toContain("signing.resumed");
    });

    it("AGENT_SUSPENDED до допуска — приостановка без остановки (Р63 п. 1); AGENT_SELF_UNKNOWN до допуска — без действия", async () => {
      const k = ring();
      k.r.port().suspend("AGENT_SELF_UNKNOWN");
      expect(k.r.suspendReason).toBeNull();
      k.r.port().suspend("AGENT_SUSPENDED");
      expect(k.r.stopReason).toBeNull();
      expect(k.r.suspendReason).toBe("AGENT_SUSPENDED");
      expect(k.j.entries.at(-1)).toMatchObject({ kind: "signing.suspended", reason: "AGENT_SUSPENDED" });
    });

    it("сверка: SUSPENDED — приостановка AGENT_SUSPENDED (SignerSuspended), ключи не трогаются; ACTIVE — снятие; EXCLUDED — остановка", async () => {
      const k = ring();
      await k.r.start(k.self([k.key()]));
      await expect(k.r.recheck(k.self([k.key()], "SUSPENDED"))).rejects.toMatchObject({ name: "SignerSuspended", reason: "AGENT_SUSPENDED" });
      expect(k.r.suspendReason).toBe("AGENT_SUSPENDED");
      expect(k.r.stopReason).toBeNull();
      await k.r.recheck(k.self([k.key()]));
      expect(k.r.suspendReason).toBeNull();
      expect(k.j.entries.at(-1)).toMatchObject({ kind: "signing.resumed" });
      expect(() => k.r.port().current()).not.toThrow();
      await expect(k.r.recheck(k.self([k.key()], "EXCLUDED"))).rejects.toMatchObject({ name: "SignerStopped", reason: "AGENT_EXCLUDED" });
    });

    it("ротация при приостановке: регистрации нет, POST /pao/v1/agent/keys не отправляется", async () => {
      const k = ring();
      await k.r.start(k.self([k.key()]));
      k.r.port().suspend("AGENT_SELF_UNKNOWN");
      let registered = 0;
      const p = {
        registerKey: async (): Promise<AgentKey> => {
          registered++;
          return k.key();
        },
        agentSelf: k.self([k.key()]),
      };
      await expect(k.r.rotate(p)).rejects.toThrow(SignerSuspended);
      expect(registered).toBe(0);
    });

    it("приостановка между регистрацией и сверкой ротации — дальше подписи нет", async () => {
      const k = ring();
      await k.r.start(k.self([k.key()]));
      let fresh: AgentKey | undefined;
      const p = {
        registerKey: async (draft: { alg: string; publicKey: string }): Promise<AgentKey> =>
          (fresh = k.key({ kid: kidOf(draft.publicKey), publicKey: draft.publicKey, validFrom: "2026-10-12T09:00:00Z" })),
        agentSelf: async (): Promise<AgentSelf> => {
          k.r.port().suspend("AGENT_SELF_UNKNOWN");
          throw new PlatformFailure("BAD_RESPONSE", "never", null, 200, null, "ответ ПАО не по схеме");
        },
      };
      await expect(k.r.rotate(p)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
      expect(fresh).toBeDefined();
      expect(() => k.r.port().current()).toThrow(SignerSuspended);
    });

    it("AGENT_KEY_REVOKED во время сверки при приостановке — переход на другой ключ, сверка завершается", async () => {
      dir = mkdtempSync(join(tmpdir(), "buyref-keys-"));
      const d1 = generateKey(dir).descriptor;
      const d2 = generateKey(dir).descriptor;
      const j = new MemoryJournal();
      const now = new Date("2026-10-12T09:00:00Z");
      const key = (d: typeof d1, validFrom: string, status: AgentKey["status"] = "ACTIVE"): AgentKey => ({
        kid: d.kid, alg: "ed25519", publicKey: d.public_key, validFrom, validTo: "2026-12-30T00:00:00Z", status,
      });
      writeMeta(dir, {
        [d1.kid]: { valid_from: "2026-10-01T00:00:00Z", valid_to: "2026-12-30T00:00:00Z" },
        [d2.kid]: { valid_from: "2026-10-05T00:00:00Z", valid_to: "2026-12-30T00:00:00Z" },
      });
      const r = new KeyRing({ dir, params, journal: j, now: () => now });
      const both = async (): Promise<AgentSelf> => ({
        agentCode: AGENT, status: "ACTIVE", agentClass: "BUYER",
        keys: [key(d1, "2026-10-01T00:00:00Z"), key(d2, "2026-10-05T00:00:00Z")],
      });
      await r.start(both);
      expect(r.port().current().kid).toBe(d2.kid);
      r.port().suspend("AGENT_SELF_UNKNOWN");
      const revoked = new PlatformFailure("AGENT_KEY_REVOKED", "new_key", "AGENT_KEY_REVOKED", 401, null);
      await r.recheck(async (signing) => {
        expect(signing.current().kid).toBe(d2.kid);
        expect(signing.keyRevoked(d2.kid, revoked).kid).toBe(d1.kid);
        return { agentCode: AGENT, status: "ACTIVE", agentClass: "BUYER", keys: [key(d1, "2026-10-01T00:00:00Z"), key(d2, "2026-10-05T00:00:00Z", "REVOKED")] };
      });
      expect(j.entries.at(-1)).toMatchObject({ kind: "signing.resumed" });
      expect(r.port().current().kid).toBe(d1.kid);
      r.close();
    });
  });

  /** Платформа-подделка для ротации: регистрирует присланный ключ; ответ GET /pao/v1/agent задаёт тест. */
  const rotating = (k: ReturnType<typeof ring>, after: (fresh: AgentKey) => AgentKey[], reply?: (fresh: AgentKey) => AgentKey) => {
    let fresh: AgentKey | undefined;
    return {
      registerKey: async (draft: { alg: string; publicKey: string }): Promise<AgentKey> => {
        fresh = k.key({ kid: kidOf(draft.publicKey), publicKey: draft.publicKey, validFrom: "2026-10-12T09:00:00Z" });
        return reply ? reply(fresh) : fresh;
      },
      agentSelf: async (): Promise<AgentSelf> => ({ agentCode: AGENT, status: "ACTIVE", agentClass: "BUYER", keys: after(fresh!) }),
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

  describe("KEY_INVALID при регистрации (Р31)", () => {
    const keyInvalid = () => new PlatformFailure("KEY_INVALID", "after_fix", "KEY_INVALID", 422, null);
    /** Платформа: ответ на регистрацию задаёт очередь (true — принять, иначе — бросить отказ); ключи регистраций — в sent. */
    /** «inactive» — ключ зарегистрирован, но не ACTIVE (KEY_NOT_ACTIVE, Р58 п. 4 (а)) */
    const scripted = (k: ReturnType<typeof ring>, replies: (boolean | "inactive" | (() => PlatformFailure))[]) => {
      const sent: { kid: string; idem: string }[] = [];
      let fresh: AgentKey | undefined;
      return {
        sent,
        registerKey: async (draft: { alg: string; publicKey: string }, o: { idempotencyKey: string }): Promise<AgentKey> => {
          sent.push({ kid: kidOf(draft.publicKey), idem: o.idempotencyKey });
          const r = replies.shift() ?? keyInvalid;
          if (r !== true && r !== "inactive") throw (r as () => PlatformFailure)();
          fresh = k.key({ kid: kidOf(draft.publicKey), publicKey: draft.publicKey, validFrom: "2026-10-12T09:00:00Z" });
          return r === "inactive" ? { ...fresh, status: "REVOKED" } : fresh;
        },
        agentSelf: async (): Promise<AgentSelf> => ({ agentCode: AGENT, status: "ACTIVE", agentClass: "BUYER", keys: [k.key(), fresh!] }),
      };
    };
    const stopped = (j: MemoryJournal) => j.entries.filter((e) => e.kind === "key.rotation_stopped");

    it("ключ отклонён и тем же ключом не повторяется; следующая ротация — новый ключ; подпись на прежнем", async () => {
      const k = ring();
      await k.r.start(k.self([k.key()]));
      const p = scripted(k, []);
      await expect(k.r.rotate(p)).rejects.toMatchObject({ code: "KEY_INVALID" });
      expect(k.r.port().current().kid).toBe(k.d.kid);
      await expect(k.r.rotate(p)).rejects.toMatchObject({ code: "KEY_INVALID" });
      expect(new Set(p.sent.map((s) => s.kid)).size).toBe(2);
      expect(listKeys(dir!).filter((x) => x.state === "revoked").map((x) => x.kid).sort()).toEqual(p.sent.map((s) => s.kid).sort());
      expect(k.j.entries.filter((e) => e.kind === "key.revoked")).toMatchObject([{ reason: "KEY_INVALID" }, { reason: "KEY_INVALID" }]);
      expect(stopped(k.j)).toEqual([]);
    });

    it("после 3 отказов подряд ротация остановлена: инцидент в журнал, к платформе не обращается; подпись прежним ключом", async () => {
      const k = ring();
      await k.r.start(k.self([k.key()]));
      const p = scripted(k, []);
      const limit = (ruleForFailure("KEY_INVALID").maxRetries ?? 0) + 1; // 3 по SPEC §7а — сверяет declines.test
      for (let i = 0; i < limit - 1; i++) await expect(k.r.rotate(p)).rejects.toMatchObject({ code: "KEY_INVALID" });
      // вызов, набравший предел, — сразу SignerRotationStopped, исходный отказ — в cause (ревью КТ1 № 5)
      await expect(k.r.rotate(p)).rejects.toMatchObject({ name: "SignerRotationStopped", cause: { code: "KEY_INVALID" } });
      expect(stopped(k.j)).toMatchObject([{ reason: "KEY_INVALID" }]);
      const files = listKeys(dir!).length;
      await expect(k.r.rotate(p)).rejects.toThrow(SignerRotationStopped); // не SignerKeyRejected: нужен человек (Р58 п. 4 (г))
      expect(p.sent).toHaveLength(limit);
      expect(listKeys(dir!)).toHaveLength(files); // новый ключ не создаётся
      expect(stopped(k.j)).toHaveLength(1);
      expect(k.r.port().current().kid).toBe(k.d.kid);
    });

    it("успешная регистрация сбрасывает счёт подряд", async () => {
      const k = ring();
      await k.r.start(k.self([k.key()]));
      const p = scripted(k, [keyInvalid, keyInvalid, true, keyInvalid, keyInvalid]);
      for (let i = 0; i < 2; i++) await expect(k.r.rotate(p)).rejects.toMatchObject({ code: "KEY_INVALID" });
      await k.r.rotate(p);
      for (let i = 0; i < 2; i++) await expect(k.r.rotate(p)).rejects.toMatchObject({ code: "KEY_INVALID" });
      expect(stopped(k.j)).toEqual([]);
    });

    it("Р58 п. 4 (а): новый ключ не ACTIVE — в том же счёте подряд, что KEY_INVALID; предел — ротация остановлена", async () => {
      const k = ring();
      await k.r.start(k.self([k.key()]));
      const p = scripted(k, [keyInvalid, "inactive", keyInvalid]);
      await expect(k.r.rotate(p)).rejects.toMatchObject({ code: "KEY_INVALID" });
      await expect(k.r.rotate(p)).rejects.toThrow(SignerKeyRejected);
      expect(stopped(k.j)).toEqual([]);
      await expect(k.r.rotate(p)).rejects.toMatchObject({ name: "SignerRotationStopped", cause: { code: "KEY_INVALID" } });
      expect(stopped(k.j)).toMatchObject([{ reason: "KEY_INVALID" }]);
      expect(k.j.entries.filter((e) => e.kind === "key.revoked").map((e) => e.reason)).toEqual(["KEY_INVALID", "KEY_NOT_ACTIVE", "KEY_INVALID"]);
      await expect(k.r.rotate(p)).rejects.toThrow(SignerRotationStopped);
      expect(p.sent).toHaveLength(3);
      expect(k.r.port().current().kid).toBe(k.d.kid);
    });

    it("Р58 п. 4 (а): предел, набранный последним KEY_NOT_ACTIVE, — инцидент с этой причиной; успешная регистрация сбрасывает и его", async () => {
      const k = ring();
      await k.r.start(k.self([k.key()]));
      const p = scripted(k, ["inactive", true, keyInvalid, keyInvalid, "inactive"]);
      await expect(k.r.rotate(p)).rejects.toThrow(SignerKeyRejected);
      await k.r.rotate(p); // сброс
      for (let i = 0; i < 2; i++) await expect(k.r.rotate(p)).rejects.toMatchObject({ code: "KEY_INVALID" });
      expect(stopped(k.j)).toEqual([]);
      const err = (await k.r.rotate(p).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(SignerRotationStopped); // предел набран не-ACTIVE ключом — тоже сразу
      expect(err).not.toBeInstanceOf(SignerKeyRejected);
      expect(err.cause).toBeUndefined(); // исключения-отказа у KEY_NOT_ACTIVE нет
      expect(stopped(k.j)).toMatchObject([{ reason: "KEY_NOT_ACTIVE" }]);
    });

    // chmod 0500 не мешает записи от root — тест зависит от среды (ревью КТ1 № 9)
    it.skipIf(process.getuid?.() === 0)("Р58 п. 4 (б): сбой хранилища при KEY_INVALID — остановка KEYSTORE_WRITE_FAILED, detail KEY_INVALID, исходный отказ в cause", async () => {
      const k = ring();
      await k.r.start(k.self([k.key()]));
      const failure = keyInvalid();
      const p = {
        registerKey: async (): Promise<AgentKey> => {
          chmodSync(dir!, 0o500); // запись состояния ключа не пройдёт
          throw failure;
        },
        agentSelf: async (): Promise<AgentSelf> => ({ agentCode: AGENT, status: "ACTIVE", agentClass: "BUYER", keys: [k.key()] }),
      };
      try {
        const err = (await k.r.rotate(p).catch((e: unknown) => e)) as SignerStopped;
        expect(err).toBeInstanceOf(SignerStopped);
        expect(err.reason).toBe("KEYSTORE_WRITE_FAILED");
        expect(err.cause).toBe(failure);
        expect(k.j.entries.at(-1)).toMatchObject({ kind: "agent.stopped", reason: "KEYSTORE_WRITE_FAILED", detail: "KEY_INVALID" });
        expect(() => k.r.port().current()).toThrow(SignerStopped);
      } finally {
        chmodSync(dir!, 0o700);
      }
    });

    it("ревью КТ1 № 2: журнал отказывает на key.revoked — отзыв в хранилище и счёт подряд всё равно; после предела регистраций нет", async () => {
      // журнал отказывает только на key.revoked: допуск и прочие записи проходят
      const j = new (class extends MemoryJournal {
        override record(e: Parameters<MemoryJournal["record"]>[0]): void {
          if (e.kind === "key.revoked") throw new Error("журнал недоступен");
          super.record(e);
        }
      })();
      const k = ring(j);
      await k.r.start(k.self([k.key()]));
      const p = scripted(k, []);
      const limit = (ruleForFailure("KEY_INVALID").maxRetries ?? 0) + 1;
      for (let i = 0; i < limit; i++) await expect(k.r.rotate(p)).rejects.toThrow("журнал недоступен");
      // отклонённые ключи записаны отозванными до записи журнала: после перезапуска не станут рабочими
      expect(listKeys(dir!).filter((x) => x.state === "revoked").map((x) => x.kid).sort()).toEqual(p.sent.map((s) => s.kid).sort());
      // предел набран и при сбое журнала: ротация остановлена, к платформе больше не обращается
      await expect(k.r.rotate(p)).rejects.toThrow(SignerRotationStopped);
      expect(p.sent).toHaveLength(limit);
      expect(k.r.port().current().kid).toBe(k.d.kid);
    });

    it("Р58 п. 4 (в): ротация остановлена, прежний ключ истёк — остановка NO_ACTIVE_KEY (Р31 п. 4)", async () => {
      const clock = { now: new Date("2026-10-12T09:00:00Z") };
      const k = ring(new MemoryJournal(), clock);
      await k.r.start(k.self([k.key()]));
      const p = scripted(k, []);
      const limit = (ruleForFailure("KEY_INVALID").maxRetries ?? 0) + 1;
      for (let i = 0; i < limit - 1; i++) await expect(k.r.rotate(p)).rejects.toMatchObject({ code: "KEY_INVALID" });
      await expect(k.r.rotate(p)).rejects.toThrow(SignerRotationStopped);
      expect(k.r.port().current().kid).toBe(k.d.kid);
      clock.now = new Date("2026-12-30T00:00:00Z"); // valid_to прежнего ключа
      expect(() => k.r.port().current()).toThrow(expect.objectContaining({ name: "SignerStopped", reason: "NO_ACTIVE_KEY" }));
      expect(k.j.entries.at(-1)).toMatchObject({ kind: "agent.stopped", reason: "NO_ACTIVE_KEY" });
    });

    it("прочий отказ (итог неизвестен) — тот же ключ и тот же Idempotency-Key, в счёт предела не идёт", async () => {
      const k = ring();
      await k.r.start(k.self([k.key()]));
      const unknown = () => new PlatformFailure("NO_RESPONSE", "never", null, 0, null, "нет ответа");
      const p = scripted(k, [unknown, unknown, unknown, keyInvalid]);
      for (let i = 0; i < 3; i++) await expect(k.r.rotate(p)).rejects.toMatchObject({ code: "NO_RESPONSE" });
      await expect(k.r.rotate(p)).rejects.toMatchObject({ code: "KEY_INVALID" });
      expect(new Set(p.sent.map((s) => `${s.kid}/${s.idem}`)).size).toBe(1);
      expect(stopped(k.j)).toEqual([]);
    });
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
      agentSelf: async (): Promise<AgentSelf> => ({ agentCode: AGENT, status: "ACTIVE", agentClass: "BUYER", keys: sent.length === 1 ? [k.key(), first!] : [k.key()] }),
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
      agentSelf: async (): Promise<AgentSelf> => ({ agentCode: AGENT, status: "ACTIVE", agentClass: "BUYER", keys: [k.key()] }),
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
