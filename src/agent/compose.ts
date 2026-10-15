// Место сборки ядра (composition root) — единственное исключение из правила Р19: только здесь виден адаптер pao.
// Ядро (pipeline, policy, mandates, declines) получает платформу через порт и не знает, какая она.
// Подписант создаётся здесь из модуля signer; адаптер получает только порт подписи (инвариант 2).
import { loadParams, type StandParams } from "../shared/config.js";
import type { AgentSelf } from "../shared/domain.js";
import type { PaymentPlatform, PlatformCapabilities } from "./ports/payment-platform.js";
import { PaoPlatform, type PaoPlatformOptions } from "./adapters/pao/index.js";
import { MemoryJournal, type Journal } from "./journal/index.js";
import { MandateClient } from "./mandates/index.js";
import { KeyRing } from "./signer/index.js";

export interface AgentCore {
  params: StandParams;
  platform: PaymentPlatform;
  capabilities: PlatformCapabilities;
  /** клиент мандатов на порту мандатов той же платформы */
  mandates: MandateClient;
  journal: Journal;
  /** Стадия 0: ключи из хранилища и сверка с реестром платформы; до успеха никакие обращения, кроме допуска, не подписываются.
   *  Исходы отказа: SignerStopped (EXCLUDED, SUSPENDED по ответу, класс не BUYER — Р27, нет ключа) или PlatformFailure (AGENT_UNKNOWN,
   *  AGENT_SUSPENDED кодом) — в обоих случаях подпись остановлена; прочие сбои (503, тайм-аут, ответ не по схеме —
   *  UNKNOWN, Р27) — допуск можно повторить. */
  start(): Promise<AgentSelf>;
  /** Повторная сверка с реестром (Р27): снимает приостановку подписи при ACTIVE и BUYER; не ACTIVE или не BUYER — остановка;
   *  ответ снова не по схеме или сбой — приостановка остаётся. Расписание сверок — за вызывающим (AG-12). */
  recheck(): Promise<AgentSelf>;
  /** плановая ротация ключа, если до valid_to (по данным платформы) осталось не больше key_overlap_days */
  maintainKeys(): Promise<void>;
  /** освободить каталог ключей (один процесс на каталог) */
  close(): void;
}

export interface AgentCoreOptions {
  /** путь к стендовым параметрам; по умолчанию config/params.stand.json */
  paramsPath?: string;
  /** каталог ключей подписи (keystore); в тестах — временный */
  keysDir: string;
  journal?: Journal;
  now?: () => Date;
  pao: Omit<PaoPlatformOptions, "params" | "signing">;
}

export function createAgentCore(o: AgentCoreOptions): AgentCore {
  const params = loadParams(o.paramsPath);
  const journal = o.journal ?? new MemoryJournal();
  const ring = new KeyRing({ dir: o.keysDir, params, journal, ...(o.now && { now: o.now }) });
  // Рабочий адаптер получает порт, закрытый до допуска; запрос допуска идёт через отдельный адаптер с портом допуска.
  const platform = new PaoPlatform({ ...o.pao, params, signing: ring.port() });
  return {
    params,
    platform,
    capabilities: platform.capabilities(),
    mandates: new MandateClient({ port: platform, params, ...(o.now && { now: o.now }) }),
    journal,
    start: () => ring.start((signing) => new PaoPlatform({ ...o.pao, params, signing }).agentSelf()),
    recheck: () => ring.recheck((signing) => new PaoPlatform({ ...o.pao, params, signing }).agentSelf()),
    maintainKeys: () => ring.maintain(platform),
    close: () => ring.close(),
  };
}
