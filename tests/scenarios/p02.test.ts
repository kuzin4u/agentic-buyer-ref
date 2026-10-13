// П02 (профиль contour, Р23): обращение с отозванным ключом. Т1, A2 п. 5.4, SPEC §7а (AGENT_KEY_REVOKED, retry new_key).
import { afterEach, describe, expect, it } from "vitest";
import { PaoPlatform } from "../../src/agent/adapters/pao/index.js";
import { SignerStopped, loadKey } from "../../src/agent/signer/index.js";
import { loadParams } from "../../src/shared/config.js";
import { PlatformFailure } from "../../src/shared/domain.js";
import { CREDENTIALS, DRAFT, coreOn } from "../support/core.js";
import { AGENT, PaoStand } from "../support/pao-stand.js";

let stand: PaoStand;
afterEach(() => stand?.close());

const OP = "POST /pao/v1/credentials" as const;

describe("П02 — обращение с отозванным ключом", () => {
  it("повтор тем же отозванным ключом даёт тот же отказ 401 AGENT_KEY_REVOKED, retry new_key", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    const baseUrl = await stand.stub.start();
    const { signer } = loadKey(stand.dir, stand.descriptors[0]!.kid);
    stand.revoke(signer.kid);
    // Подпись одним и тем же ключом без перехода — чтобы увидеть ответ платформы на повтор.
    const fixed = { current: () => signer, keyRevoked: () => signer, stop: () => {}, suspend: () => {} };
    const platform = new PaoPlatform({ baseUrl, agentCode: AGENT, signing: fixed, params: loadParams() });
    for (let i = 0; i < 2; i++) {
      await expect(platform.issueCredential(DRAFT, { idempotencyKey: "idem-p02" })).rejects.toMatchObject({
        code: "AGENT_KEY_REVOKED",
        retry: "new_key",
        httpStatus: 401,
      });
    }
    // по обращению: отказ, переход «на тот же ключ» и один повтор — снова отказ
    expect(stand.log()).toEqual([{ op: OP, status: 401 }, { op: OP, status: 401 }, { op: OP, status: 401 }, { op: OP, status: 401 }]);
    expect(stand.stub.violations).toEqual([]);
  });

  it("есть другой действующий ключ: переход и один повтор с тем же Idempotency-Key и новой подписью", async () => {
    stand = new PaoStand({ keys: 2, handlers: CREDENTIALS });
    const { core, journal } = await coreOn(stand);
    await core.start();
    const [older, newest] = stand.descriptors;
    stand.revoke(newest!.kid); // действующий — новейший

    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "idem-p02" })).resolves.toMatchObject({ status: "ISSUED" });

    expect(stand.log()).toEqual([{ op: "GET /pao/v1/agent", status: 200 }, { op: OP, status: 401 }, { op: OP, status: 201 }]);
    expect(stand.stub.violations).toEqual([]);
    const calls = stand.calls(OP);
    expect(calls[0]!.idempotencyKey).toBe("idem-p02");
    expect(calls[1]!.idempotencyKey).toBe("idem-p02");
    expect(calls[1]!.nonce).not.toBe(calls[0]!.nonce);
    const kinds = journal.entries.filter((e) => e.kind !== "key.loaded").slice(-4);
    expect(kinds).toMatchObject([
      { kind: "request.signed", kid: newest!.kid },
      { kind: "key.revoked", kid: newest!.kid, reason: "AGENT_KEY_REVOKED" },
      { kind: "key.switched", kid: older!.kid },
      { kind: "request.signed", kid: older!.kid },
    ]);
  });

  it("нет действующего ключа — агент останавливается; дальше обращений нет", async () => {
    stand = new PaoStand({ handlers: CREDENTIALS });
    const { core, journal } = await coreOn(stand);
    await core.start();
    stand.revoke(stand.descriptors[0]!.kid);

    await expect(core.platform.issueCredential(DRAFT, { idempotencyKey: "idem-p02" })).rejects.toThrow(SignerStopped);
    await expect(core.platform.agentSelf()).rejects.toThrow(SignerStopped);
    expect(stand.log()).toEqual([{ op: "GET /pao/v1/agent", status: 200 }, { op: OP, status: 401 }]); // допуск и один отказ
    expect(stand.stub.violations).toEqual([]);
    expect(journal.entries.at(-1)).toMatchObject({ kind: "agent.stopped", reason: "NO_ACTIVE_KEY" });
  });

  it("без цикла: все ключи отозваны — не больше одного перехода за обращение", async () => {
    stand = new PaoStand({ keys: 3, handlers: CREDENTIALS });
    const { core } = await coreOn(stand);
    await core.start();
    for (const d of stand.descriptors) stand.revoke(d.kid);

    const err = await core.platform.issueCredential(DRAFT, { idempotencyKey: "idem-p02" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformFailure);
    expect(err).toMatchObject({ code: "AGENT_KEY_REVOKED" });
    expect(stand.log()).toEqual([{ op: "GET /pao/v1/agent", status: 200 }, { op: OP, status: 401 }, { op: OP, status: 401 }]);
    expect(stand.stub.violations).toEqual([]);
    expect(new Set(stand.calls(OP).map((c) => c.idempotencyKey))).toEqual(new Set(["idem-p02"]));
  });
});
