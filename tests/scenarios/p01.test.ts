// П01 (профиль contour, Р23): регистрация и первое подписанное обращение. Т1, A2 п. 3–5.
import { afterEach, describe, expect, it } from "vitest";
import { kidOf } from "../../src/agent/signer/index.js";
import { coreOn } from "../support/core.js";
import { PaoStand, platformKid, CONFIGURATION } from "../support/pao-stand.js";

let stand: PaoStand;
afterEach(() => stand?.close());

describe("П01 — регистрация и первое подписанное обращение (GET /pao/v1/agent)", () => {
  it("200, status ACTIVE; kid в ответе совпадает с вычисленным агентом (RFC 7638); в журнале — kid подписи", async () => {
    stand = new PaoStand();
    const { core, journal } = await coreOn(stand);
    const self = await core.start();

    const [d] = stand.descriptors;
    expect(self.status).toBe("ACTIVE");
    expect(self.keys.map((k) => k.kid)).toEqual([kidOf(d!.public_key)]);
    expect(platformKid(d!.public_key)).toBe(kidOf(d!.public_key)); // независимое вычисление стенда
    expect(stand.log()).toEqual([CONFIGURATION, { op: "GET /pao/v1/agent", status: 200 }]);
    expect(stand.stub.violations).toEqual([]);
    expect(journal.entries).toContainEqual(expect.objectContaining({ kind: "request.signed", kid: d!.kid }));
    // в журнале только идентификаторы — ни открытого, ни закрытого ключа
    expect(JSON.stringify(journal.entries)).not.toContain(d!.public_key);
  });
});
