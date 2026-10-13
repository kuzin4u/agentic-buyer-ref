// Связка ключей: fail-closed вокруг допуска (стадия 0), сроков и ротации (ревью 3b № 1–8).
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SignerKeyRejected, SignerStopped, SignerSuspended, generateKey, listKeys } from "../../src/agent/signer/index.js";
import { markKey, readMeta, writeMeta } from "../../src/agent/signer/keystore.js";
import { PlatformFailure } from "../../src/shared/domain.js";
import { CREDENTIALS, DRAFT, coreOn } from "../support/core.js";
import { PaoStand } from "../support/pao-stand.js";

const DAY = 86_400_000;
const OP = "POST /pao/v1/credentials" as const;
let stand: PaoStand;
afterEach(() => stand?.close());

describe("допуск не подтверждён — подписи нет", () => {
  it("до start: обращение — SignerStopped NOT_ADMITTED, в сеть не уходит", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    const { core } = await coreOn(stand);
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "i1" })).rejects.toMatchObject({ reason: "NOT_ADMITTED" });
    expect(stand.stub.calls).toHaveLength(0);
  });

  it("допуск сорвался (503 на все попытки): обращения закрыты; повтор допуска — затем работа", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    const { core, journal } = await coreOn(stand);
    stand.stub.fail("GET /pao/v1/agent", { code: "UPSTREAM_UNAVAILABLE" }, core.params.pao_max_attempts);

    await expect(core.start()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(journal.entries.at(-1)).toMatchObject({ kind: "admission.failed", reason: "UPSTREAM_UNAVAILABLE" });
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "i1" })).rejects.toThrow(SignerStopped);
    expect(stand.calls(OP)).toHaveLength(0);

    await expect(core.start()).resolves.toMatchObject({ status: "ACTIVE" });
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "i1" })).resolves.toMatchObject({ status: "ISSUED" });
  });
});

describe("допуск: SPEC §7а и состояние ключей между перезапусками", () => {
  it("SIGNATURE_INVALID при допуске — один повтор тем же ключом с новой подписью, затем остановка с исходным отказом", async () => {
    stand = new PaoStand({ keys: 0 });
    generateKey(stand.dir); // ключ не внесён в реестр — платформа не примет подпись
    const { core } = await coreOn(stand);
    const err = (await core.start().catch((e: unknown) => e)) as SignerStopped;
    expect(err).toBeInstanceOf(SignerStopped);
    expect(err.reason).toBe("SIGNATURE_INVALID");
    expect(err.cause).toMatchObject({ code: "SIGNATURE_INVALID" });
    const calls = stand.calls("GET /pao/v1/agent");
    expect(calls.map((c) => c.status)).toEqual([401, 401]);
    expect(calls[1]!.nonce).not.toBe(calls[0]!.nonce);
  });

  it("два подтверждённых ключа, ключ допуска отозван — допуск вторым ключом, одно лишнее обращение (SPEC §7а)", async () => {
    stand = new PaoStand({ keys: 2 });
    const [older, newest] = stand.descriptors; // по метаданным newest — ключ допуска
    stand.revoke(newest!.kid);
    const { core, journal } = await coreOn(stand);
    await expect(core.start()).resolves.toMatchObject({ status: "ACTIVE" });
    const calls = stand.calls("GET /pao/v1/agent");
    expect(calls.map((c) => c.status)).toEqual([401, 200]);
    expect(calls[1]!.nonce).not.toBe(calls[0]!.nonce);
    expect(journal.entries.filter((e) => e.kind === "request.signed").map((e) => e.kid)).toEqual([newest!.kid, older!.kid]);
    expect(listKeys(stand.dir)).toContainEqual({ kid: newest!.kid, state: "revoked" });
  });

  it("переход на допуске, затем 503 — повторный start: допуск подтверждённым ключом, отозванный больше не подписывает", async () => {
    stand = new PaoStand({ keys: 2 });
    const [older, newest] = stand.descriptors;
    stand.revoke(newest!.kid);
    const { core, journal } = await coreOn(stand);
    stand.stub.fail("GET /pao/v1/agent", { code: "UPSTREAM_UNAVAILABLE" }, core.params.pao_max_attempts + 1); // первый отказ съест 401
    // 401 (newest) → переход на older → 503 на все попытки адаптера
    await expect(core.start()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    await expect(core.start()).resolves.toMatchObject({ status: "ACTIVE" });
    const signed = journal.entries.filter((e) => e.kind === "request.signed").map((e) => e.kid);
    expect(signed[0]).toBe(newest!.kid);
    expect(signed.slice(1).every((k) => k === older!.kid)).toBe(true);
    expect(stand.calls("GET /pao/v1/agent").at(-1)).toMatchObject({ status: 200 });
  });

  it("повторный start — новый допуск со своим одним переходом", async () => {
    stand = new PaoStand({ keys: 3 });
    const [oldest, middle, newest] = stand.descriptors;
    stand.revoke(newest!.kid);
    const { core, journal } = await coreOn(stand);
    stand.stub.fail("GET /pao/v1/agent", { code: "UPSTREAM_UNAVAILABLE" }, core.params.pao_max_attempts + 1);
    await expect(core.start()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" }); // переход newest → middle, затем 503
    stand.revoke(middle!.kid);
    await expect(core.start()).resolves.toMatchObject({ status: "ACTIVE" }); // middle отозван → переход на oldest
    expect(listKeys(stand.dir)).toContainEqual({ kid: oldest!.kid, state: "active" });
    expect(listKeys(stand.dir)).toContainEqual({ kid: middle!.kid, state: "revoked" });
    expect(listKeys(stand.dir)).toContainEqual({ kid: newest!.kid, state: "revoked" });
    await core.platform.agentSelf();
    expect(journal.entries.filter((e) => e.kind === "request.signed").at(-1)).toMatchObject({ kid: oldest!.kid });
  });

  it("ключ допуска отозван, другой рабочий ключ не подтверждён в метаданных — не пробуется: остановка", async () => {
    stand = new PaoStand({ keys: 2 });
    const [older, newest] = stand.descriptors;
    writeMeta(stand.dir, { [newest!.kid]: readMeta(stand.dir)[newest!.kid]! }); // older в метаданных нет
    stand.revoke(newest!.kid);
    const { core } = await coreOn(stand);
    await expect(core.start()).rejects.toMatchObject({ reason: "NO_ACTIVE_KEY", cause: expect.objectContaining({ code: "AGENT_KEY_REVOKED" }) });
    expect(stand.calls("GET /pao/v1/agent")).toHaveLength(1);
    expect(listKeys(stand.dir)).toContainEqual({ kid: older!.kid, state: "active" });
  });

  it("ключ допуска отозван, у другого подтверждённого ключа valid_to по метаданным истёк — остановка", async () => {
    stand = new PaoStand({ keys: 2 });
    const [older, newest] = stand.descriptors;
    const meta = readMeta(stand.dir);
    writeMeta(stand.dir, { ...meta, [older!.kid]: { ...meta[older!.kid]!, valid_to: "2026-10-01T00:00:00Z" } });
    stand.revoke(newest!.kid);
    const { core } = await coreOn(stand);
    await expect(core.start()).rejects.toMatchObject({ reason: "NO_ACTIVE_KEY" });
    expect(stand.calls("GET /pao/v1/agent")).toHaveLength(1);
  });

  it("три подтверждённых ключа, отозваны два новейших — только один переход: остановка после второго отказа", async () => {
    stand = new PaoStand({ keys: 3 });
    stand.revoke(stand.descriptors[2]!.kid);
    stand.revoke(stand.descriptors[1]!.kid);
    const { core } = await coreOn(stand);
    await expect(core.start()).rejects.toMatchObject({ reason: "NO_ACTIVE_KEY" });
    expect(stand.calls("GET /pao/v1/agent").map((c) => c.status)).toEqual([401, 401]);
  });

  it("ключ допуска — с самым поздним подтверждённым valid_from из метаданных", async () => {
    stand = new PaoStand({ keys: 3 });
    const middle = stand.descriptors[1]!;
    const to = "2026-12-30T00:00:00Z";
    writeMeta(stand.dir, { [stand.descriptors[0]!.kid]: { valid_from: "2026-10-01T00:00:00Z", valid_to: to }, [middle.kid]: { valid_from: "2026-10-05T00:00:00Z", valid_to: to } });
    const { core, journal } = await coreOn(stand);
    await core.start();
    expect(journal.entries.find((e) => e.kind === "request.signed")).toMatchObject({ kid: middle.kid });
  });

  it("несколько рабочих ключей без метаданных — неоднозначно: остановка KEY_AMBIGUOUS до обращения к платформе", async () => {
    stand = new PaoStand({ keys: 2 });
    rmSync(join(stand.dir, "keys.meta.json"));
    const { core } = await coreOn(stand);
    await expect(core.start()).rejects.toMatchObject({ reason: "KEY_AMBIGUOUS" });
    expect(stand.stub.calls).toHaveLength(0);
  });

  it("повреждённые метаданные — допуск не начинается (SignerKeyRejected)", async () => {
    stand = new PaoStand({ keys: 2 });
    writeFileSync(join(stand.dir, "keys.meta.json"), "{", { mode: 0o600 });
    const { core } = await coreOn(stand);
    await expect(core.start()).rejects.toThrow(SignerKeyRejected);
    expect(stand.stub.calls).toHaveLength(0);
  });

  it("после допуска метаданные содержат valid_from подтверждённых действующих ключей", async () => {
    stand = new PaoStand();
    const { core } = await coreOn(stand);
    await core.start();
    const kid = stand.descriptors[0]!.kid;
    expect(readMeta(stand.dir)).toEqual({ [kid]: { valid_from: expect.any(String), valid_to: stand.validTo(kid) } });
  });

  it("во время допуска рабочий порт не подписывает: параллельное обращение — SignerStopped NOT_ADMITTED", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    const { core } = await coreOn(stand);
    const admission = core.start();
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "i1" })).rejects.toMatchObject({ reason: "NOT_ADMITTED" });
    await admission;
    expect(stand.calls(OP)).toHaveLength(0);
  });

  it("отзыв записан в хранилище: после перезапуска отозванный ключ не загружается и не регистрируется повторно", async () => {
    stand = new PaoStand({ keys: 2, handlers: CREDENTIALS });
    const first = await coreOn(stand);
    await first.core.start();
    const newest = stand.descriptors[1]!.kid;
    stand.revoke(newest);
    await first.core.platform.issueCredential(DRAFT, { idempotencyKey: "i1" });
    expect(listKeys(stand.dir)).toContainEqual({ kid: newest, state: "revoked" });
    first.core.close(); // перезапуск: прежний процесс освободил каталог

    const second = await coreOn(stand);
    await second.core.start();
    expect(second.journal.entries.filter((e) => e.kind === "key.loaded").map((e) => e.kid)).not.toContain(newest);
    stand.clock = new Date(Date.parse(stand.validTo(stand.descriptors[0]!.kid)) - DAY);
    await second.core.maintainKeys();
    expect(stand.registrations).toHaveLength(1);
    expect(stand.registrations[0]).not.toBe(newest);
  });

  it("сирота при перезапуске: временный файл ключа (регистрация не подтверждена) не используется и помечается брошенным", async () => {
    stand = new PaoStand();
    const first = await coreOn(stand);
    await first.core.start();
    stand.clock = new Date(Date.parse(stand.validTo(stand.descriptors[0]!.kid)) - DAY);
    stand.stub.fail("POST /pao/v1/agent/keys", { code: "UPSTREAM_UNAVAILABLE" }, first.core.params.pao_max_attempts);
    await expect(first.core.maintainKeys()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    const orphan = listKeys(stand.dir).find((x) => x.state === "pending")!.kid;
    first.core.close(); // перезапуск: прежний процесс освободил каталог

    const second = await coreOn(stand);
    await second.core.start();
    expect(listKeys(stand.dir)).toContainEqual({ kid: orphan, state: "abandoned" });
    expect(second.journal.entries).toContainEqual(expect.objectContaining({ kind: "key.abandoned", kid: orphan }));
    expect(second.journal.entries.filter((e) => e.kind === "request.signed").map((e) => e.kid)).not.toContain(orphan);
    await second.core.maintainKeys();
    expect(stand.registrations).toHaveLength(1);
    expect(stand.registrations[0]).not.toBe(orphan);
    expect(listKeys(stand.dir)).toContainEqual({ kid: stand.registrations[0]!, state: "active" });
  });
});

describe("допуск и хранилище: третье ревью 3b", () => {
  it("один ключ хранилища не загрузился — допуск не начинается; после исправления загружаются все", async () => {
    stand = new PaoStand({ keys: 2 });
    const last = [...stand.descriptors].sort((a, b) => (a.kid < b.kid ? -1 : 1))[1]!.kid;
    chmodSync(join(stand.dir, `${last}.pem`), 0o644);
    const { core, journal } = await coreOn(stand);
    await expect(core.start()).rejects.toThrow(SignerKeyRejected);
    expect(journal.entries.filter((e) => e.kind === "key.loaded")).toHaveLength(0);
    expect(journal.entries.at(-1)).toMatchObject({ kind: "admission.failed", reason: "KEY_REJECTED" });
    expect(stand.stub.calls).toHaveLength(0);
    chmodSync(join(stand.dir, `${last}.pem`), 0o600);
    await expect(core.start()).resolves.toMatchObject({ status: "ACTIVE" });
    expect(journal.entries.filter((e) => e.kind === "key.loaded")).toHaveLength(2);
  });

  it("состояние отзыва не записалось в хранилище — остановка KEYSTORE_WRITE_FAILED, отозванным ключом больше не подписывается", async () => {
    stand = new PaoStand({ keys: 2, handlers: CREDENTIALS });
    const { core } = await coreOn(stand);
    await core.start();
    stand.revoke(stand.descriptors[1]!.kid);
    chmodSync(stand.dir, 0o755);
    try {
      await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "i1" })).rejects.toMatchObject({ reason: "KEYSTORE_WRITE_FAILED" });
      await expect(core.platform.agentSelf()).rejects.toThrow(SignerStopped);
      expect(stand.calls(OP)).toHaveLength(1);
    } finally {
      chmodSync(stand.dir, 0o700);
    }
  });

  it("у kid два файла (действующий и отозванный) — побеждает отозванный, ключ не загружается", async () => {
    stand = new PaoStand({ keys: 2 });
    const kid = stand.descriptors[1]!.kid;
    copyFileSync(join(stand.dir, `${kid}.pem`), join(stand.dir, `${kid}.revoked.pem`));
    chmodSync(join(stand.dir, `${kid}.revoked.pem`), 0o600);
    expect(listKeys(stand.dir)).toContainEqual({ kid, state: "revoked" });
    const { core, journal } = await coreOn(stand);
    await core.start();
    expect(journal.entries.filter((e) => e.kind === "key.loaded").map((e) => e.kid)).not.toContain(kid);
    expect(existsSync(join(stand.dir, `${kid}.pem`))).toBe(false); // лишнее имя удалено: ключ не воскреснет
    expect(existsSync(join(stand.dir, `${kid}.revoked.pem`))).toBe(true);
  });
});

describe("один процесс на каталог ключей", () => {
  it("второе ядро на том же каталоге — остановка KEYSTORE_LOCKED до обращения к платформе; после close — запуск", async () => {
    stand = new PaoStand();
    const first = await coreOn(stand);
    await first.core.start();
    const second = await coreOn(stand);
    await expect(second.core.start()).rejects.toMatchObject({ reason: "KEYSTORE_LOCKED" });
    expect(stand.calls("GET /pao/v1/agent")).toHaveLength(1);
    first.core.close();
    const third = await coreOn(stand);
    await expect(third.core.start()).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("блокировка упавшего процесса перехватывается", async () => {
    stand = new PaoStand();
    writeFileSync(join(stand.dir, ".lock"), "999999999", { mode: 0o600 });
    const { core } = await coreOn(stand);
    await expect(core.start()).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("свой pid прошлого запуска в .lock (pid переиспользован, например PID 1 в контейнере) — блокировка перехватывается", async () => {
    stand = new PaoStand();
    writeFileSync(join(stand.dir, ".lock"), String(process.pid), { mode: 0o600 });
    const { core } = await coreOn(stand);
    await expect(core.start()).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("пустой .lock — считается занятым: остановка KEYSTORE_LOCKED (снимается вручную)", async () => {
    stand = new PaoStand();
    writeFileSync(join(stand.dir, ".lock"), "", { mode: 0o600 });
    const { core } = await coreOn(stand);
    await expect(core.start()).rejects.toMatchObject({ reason: "KEYSTORE_LOCKED" });
    expect(stand.stub.calls).toHaveLength(0);
  });

  it("сбой файловой системы при блокировке — не KEYSTORE_LOCKED: допуск не начат, start можно повторить", async () => {
    stand = new PaoStand();
    mkdirSync(join(stand.dir, ".lock"), { mode: 0o700 }); // на месте файла блокировки — каталог
    const { core, journal } = await coreOn(stand);
    await expect(core.start()).rejects.toThrow(SignerKeyRejected);
    expect(journal.entries.at(-1)).toMatchObject({ kind: "admission.failed", reason: "KEY_REJECTED" });
    rmSync(join(stand.dir, ".lock"), { recursive: true });
    await expect(core.start()).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("брошенный временный ключ, регистрация которого всё же прошла, — в журнале key.abandoned_registered, не key.foreign", async () => {
    stand = new PaoStand();
    const first = await coreOn(stand);
    await first.core.start();
    stand.clock = new Date(Date.parse(stand.validTo(stand.descriptors[0]!.kid)) - DAY);
    // регистрация проходит, а ответ теряется: сверка после неё не доходит (503 на все попытки)
    stand.stub.fail("GET /pao/v1/agent", { code: "UPSTREAM_UNAVAILABLE" }, first.core.params.pao_max_attempts);
    await expect(first.core.maintainKeys()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    const registered = stand.registrations[0]!;
    // процесс упал до переименования: эмулируем, вернув файл под временное имя
    markKey(stand.dir, registered, "active", "pending");
    first.core.close();

    const second = await coreOn(stand);
    await second.core.start();
    expect(second.journal.entries).toContainEqual(expect.objectContaining({ kind: "key.abandoned_registered", kid: registered }));
    expect(second.journal.entries.some((e) => e.kind === "key.foreign")).toBe(false);
  });
});

describe("после допуска", () => {
  it("valid_to действующего ключа наступил — подписи нет, остановка (NO_ACTIVE_KEY)", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    const { core } = await coreOn(stand);
    await core.start();
    stand.clock = new Date(Date.parse(stand.validTo(stand.descriptors[0]!.kid)));
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "i1" })).rejects.toMatchObject({ reason: "NO_ACTIVE_KEY" });
    expect(stand.calls(OP)).toHaveLength(0);
  });

  it("GET /pao/v1/agent вернул EXCLUDED (200) после допуска — подпись остановлена", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    const { core, journal } = await coreOn(stand);
    await core.start();
    stand.status = "EXCLUDED";
    await expect(core.platform.agentSelf()).resolves.toMatchObject({ status: "EXCLUDED" });
    expect(journal.entries.at(-1)).toMatchObject({ kind: "agent.stopped", reason: "AGENT_EXCLUDED" });
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "i1" })).rejects.toThrow(SignerStopped);
    expect(stand.calls(OP)).toHaveLength(0);
  });

  // Р27: стадия 0 подтверждает статус ACTIVE и класс BUYER; AGENT_CLASS_MISMATCH — причина остановки ядра, не код ПАО.
  it("класс в реестре не BUYER при допуске — остановка AGENT_CLASS_MISMATCH, класс в журнале, без повтора", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    stand.agentClass = "SELLER";
    const { core, journal } = await coreOn(stand);
    await expect(core.start()).rejects.toMatchObject({ reason: "AGENT_CLASS_MISMATCH" });
    expect(stand.stub.calls.map((c) => c.op)).toEqual(["GET /pao/v1/agent"]);
    expect(journal.entries.filter((e) => e.kind === "agent.stopped")).toEqual([
      expect.objectContaining({ reason: "AGENT_CLASS_MISMATCH", detail: "SELLER" }),
    ]);
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "i1" })).rejects.toThrow(SignerStopped);
    await expect(core.start()).rejects.toThrow(SignerStopped);
    expect(stand.stub.calls).toHaveLength(1);
  });

  it("порядок: сначала статус, затем класс — SUSPENDED и SELLER дают AGENT_SUSPENDED", async () => {
    stand = new PaoStand();
    stand.status = "SUSPENDED";
    stand.agentClass = "SELLER";
    const { core, journal } = await coreOn(stand);
    await expect(core.start()).rejects.toMatchObject({ reason: "AGENT_SUSPENDED" });
    // причину в журнал пишет первым адаптер — порядок «статус → класс» проверяется и там
    expect(journal.entries.filter((e) => e.kind === "agent.stopped")).toEqual([expect.objectContaining({ reason: "AGENT_SUSPENDED" })]);
  });

  it("порядок в адаптере на прямом запросе после допуска: SUSPENDED и SELLER — AGENT_SUSPENDED", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    const { core, journal } = await coreOn(stand);
    await core.start();
    stand.status = "SUSPENDED";
    stand.agentClass = "SELLER";
    await core.platform.agentSelf();
    expect(journal.entries.filter((e) => e.kind === "agent.stopped")).toEqual([expect.objectContaining({ reason: "AGENT_SUSPENDED" })]);
  });

  it("нет class в ответе реестра при допуске — UNKNOWN, допуск не состоялся, подписи нет; повтор допуска возможен", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    stand.agentClass = undefined;
    const { core, journal } = await coreOn(stand);
    await expect(core.start()).rejects.toMatchObject({ code: "UNKNOWN" });
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "i1" })).rejects.toThrow(SignerStopped);
    expect(stand.calls(OP)).toHaveLength(0);
    expect(journal.entries.map((e) => e.kind)).not.toContain("signing.suspended");
    stand.agentClass = "BUYER";
    await expect(core.start()).resolves.toMatchObject({ agentClass: "BUYER" });
  });

  // Р27 (уточнение): после допуска ответ не по схеме — приостановка до успешной повторной сверки, не бессрочная остановка.
  it.each([
    ["нет class", (s: PaoStand) => (s.agentClass = undefined)],
    ["класс вне перечня", (s: PaoStand) => (s.agentClass = "ADMIN")],
    ["статус вне перечня", (s: PaoStand) => (s.status = "BLOCKED" as "ACTIVE")],
  ])("после допуска: %s — подпись приостановлена; корректная сверка — возобновлена", async (_n, garble) => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    const { core, journal } = await coreOn(stand);
    await core.start();
    garble(stand);
    await expect(core.platform.agentSelf()).rejects.toMatchObject({ code: "UNKNOWN" });
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "i1" })).rejects.toThrow(SignerSuspended);
    expect(stand.calls(OP)).toHaveLength(0);
    expect(journal.entries.filter((e) => e.kind === "signing.suspended")).toEqual([
      expect.objectContaining({ reason: "AGENT_SELF_UNKNOWN" }),
    ]);
    // повторная сверка, пока ответ не по схеме, — приостановка остаётся
    await expect(core.recheck()).rejects.toMatchObject({ code: "UNKNOWN" });
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "i1" })).rejects.toThrow(SignerSuspended);
    expect(journal.entries.filter((e) => e.kind === "signing.suspended")).toHaveLength(1);
    // ответ снова по схеме: ACTIVE и BUYER — подпись возобновлена
    stand.agentClass = "BUYER";
    stand.status = "ACTIVE";
    await expect(core.recheck()).resolves.toMatchObject({ status: "ACTIVE", agentClass: "BUYER" });
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "i1" })).resolves.toMatchObject({ status: "ISSUED" });
    expect(journal.entries.map((e) => e.kind)).toContain("signing.resumed");
    expect(journal.entries.map((e) => e.kind)).not.toContain("agent.stopped");
  });

  it("приостановка, затем сверка показала SELLER — бессрочная остановка AGENT_CLASS_MISMATCH", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    const { core, journal } = await coreOn(stand);
    await core.start();
    stand.agentClass = undefined;
    await expect(core.platform.agentSelf()).rejects.toMatchObject({ code: "UNKNOWN" });
    stand.agentClass = "SELLER";
    await expect(core.recheck()).rejects.toMatchObject({ reason: "AGENT_CLASS_MISMATCH" });
    expect(journal.entries.filter((e) => e.kind === "agent.stopped")).toEqual([
      expect.objectContaining({ reason: "AGENT_CLASS_MISMATCH", detail: "SELLER" }),
    ]);
    stand.agentClass = "BUYER";
    await expect(core.recheck()).rejects.toThrow(SignerStopped);
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "i1" })).rejects.toThrow(SignerStopped);
    expect(stand.calls(OP)).toHaveLength(0);
  });

  it("сбой связи (503) после допуска — не приостановка: подпись продолжается", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    const { core, journal } = await coreOn(stand);
    await core.start();
    stand.stub.fail("GET /pao/v1/agent", { code: "UPSTREAM_UNAVAILABLE" }, core.params.pao_max_attempts);
    await expect(core.platform.agentSelf()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(journal.entries.map((e) => e.kind)).not.toContain("signing.suspended");
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "i1" })).resolves.toMatchObject({ status: "ISSUED" });
  });

  it("класс сменился после допуска — сверка останавливает подпись", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    const { core, journal } = await coreOn(stand);
    await core.start();
    stand.agentClass = "SERVICE";
    await expect(core.platform.agentSelf()).resolves.toMatchObject({ agentClass: "SERVICE" });
    expect(journal.entries.at(-1)).toEqual(expect.objectContaining({ kind: "agent.stopped", reason: "AGENT_CLASS_MISMATCH", detail: "SERVICE" }));
    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "i1" })).rejects.toThrow(SignerStopped);
    expect(stand.calls(OP)).toHaveLength(0);
  });

  it("EXCLUDED в ответе сверки после регистрации ключа — остановка", async () => {
    stand = new PaoStand();
    const { core } = await coreOn(stand);
    await core.start();
    stand.clock = new Date(Date.parse(stand.validTo(stand.descriptors[0]!.kid)) - DAY);
    const p = core.maintainKeys();
    stand.status = "EXCLUDED"; // до первого обращения: регистрация проходит, сверка видит EXCLUDED
    await expect(p).rejects.toThrow(SignerStopped);
    expect(stand.calls("POST /pao/v1/agent/keys")).toHaveLength(1);
  });

  it("отозван последний ключ: SignerStopped несёт исходный отказ 401 AGENT_KEY_REVOKED в cause", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    const { core } = await coreOn(stand);
    await core.start();
    stand.revoke(stand.descriptors[0]!.kid);
    const err = (await core.platform.issueCredential(DRAFT, { idempotencyKey: "i1" }).catch((e: unknown) => e)) as SignerStopped;
    expect(err).toBeInstanceOf(SignerStopped);
    expect(err.cause).toBeInstanceOf(PlatformFailure);
    expect(err.cause).toMatchObject({ code: "AGENT_KEY_REVOKED", httpStatus: 401, idempotencyKey: "i1" });
  });
});

describe("ротация без повторной регистрации лишних ключей (инвариант 9)", () => {
  it("два параллельных maintainKeys — одна регистрация", async () => {
    stand = new PaoStand();
    const { core } = await coreOn(stand);
    await core.start();
    stand.clock = new Date(Date.parse(stand.validTo(stand.descriptors[0]!.kid)) - DAY);
    await Promise.all([core.maintainKeys(), core.maintainKeys()]);
    expect(stand.registrations).toHaveLength(1);
    expect(stand.calls("POST /pao/v1/agent/keys")).toHaveLength(1); // второй вызов ждёт ту же ротацию, а не шлёт повтор
  });

  it("регистрация сорвалась — повтор регистрирует тот же ключ с тем же Idempotency-Key", async () => {
    stand = new PaoStand();
    const { core } = await coreOn(stand);
    await core.start();
    stand.clock = new Date(Date.parse(stand.validTo(stand.descriptors[0]!.kid)) - DAY);
    stand.stub.fail("POST /pao/v1/agent/keys", { code: "UPSTREAM_UNAVAILABLE" }, core.params.pao_max_attempts);
    await expect(core.maintainKeys()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    await core.maintainKeys();
    const keys = new Set(stand.calls("POST /pao/v1/agent/keys").map((c) => c.idempotencyKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe(`agent-key-${stand.registrations[0]}`);
  });
});
