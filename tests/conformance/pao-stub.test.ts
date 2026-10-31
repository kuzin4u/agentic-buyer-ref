// Цель набора соответствия (AG-20, Р67 п. 1): адаптер ПАО напрямую против PaoStub agentic-core (ПАО 1.4.0).
import { newEd25519Signer } from "@kuzin4u/agentic-core";
import { PaoStub } from "@kuzin4u/agentic-core/pao";
import { Pace, PaoPlatform } from "../../src/agent/adapters/pao/index.js";
import { MemoryJournal } from "../../src/agent/journal/index.js";
import type { RequestSigning } from "../../src/agent/ports/index.js";
import { loadParams } from "../../src/shared/config.js";
import { describeConformance } from "./suite.js";

const AGENT = "nspk:agent:buyref-01:v1";
const params = loadParams();

describeConformance({
  name: "адаптер ПАО на PaoStub",
  async open() {
    const { signer, publicKey } = newEd25519Signer("kid_conformance");
    // Порт подписи с одним ключом: допуск и ротация — не предмет набора (signer-ring, П01–П03).
    const signing: RequestSigning = {
      current: () => signer,
      protective: () => signer,
      keyRevoked: () => {
        throw new Error("в наборе соответствия ключ не отзывается");
      },
      stop: () => {},
      suspend: () => {},
    };
    const stub = new PaoStub({
      configuration: { versions: ["1.4.0"] },
      agents: [{ agentCode: AGENT, keys: [{ kid: "kid_conformance", alg: "ed25519", publicKey, status: "ACTIVE" }] }],
    });
    const baseUrl = await stub.start();
    const journal = new MemoryJournal();
    const platform = new PaoPlatform({
      journal,
      baseUrl,
      agentCode: AGENT,
      signing,
      params,
      sleep: async () => {},
      pace: new Pace({ fallbackPerMin: Infinity, journal, sleep: async () => {} }),
    });
    return { platform, close: () => stub.close() };
  },
});
