// Место сборки ядра (composition root) — единственное исключение из правила Р19: только здесь виден адаптер pao.
// Ядро (pipeline, policy, mandates, declines) получает платформу через порт и не знает, какая она.
// Подписант создаётся здесь из модуля signer; адаптер получает только порт подписи (инвариант 2).
import { loadParams, type StandParams } from "../shared/config.js";
import type { AgentSelf } from "../shared/domain.js";
import type { PaymentPlatform, PlatformCapabilities } from "./ports/payment-platform.js";
import { PaoPlatform, type PaoPlatformOptions } from "./adapters/pao/index.js";
import { MemoryJournal, type Journal, type JournalEntry } from "./journal/index.js";
import { MandateClient } from "./mandates/index.js";
import { KeyRing } from "./signer/index.js";

export interface AgentCore {
  params: StandParams;
  platform: PaymentPlatform;
  capabilities: PlatformCapabilities;
  /** клиент мандатов на порту мандатов той же платформы */
  mandates: MandateClient;
  journal: Journal;
  /** Стадия 0: версия ПАО Платформы (Р33 п. 10) — ниже 1.4.0: PlatformFailure(PLATFORM_PROTOCOL_UNSUPPORTED), агент
   *  остановлен, допуска нет; не определена — предупреждение platform.version_unknown в журнал и допуск. Затем
   *  ключи из хранилища и сверка с реестром платформы; до успеха никакие обращения, кроме допуска, не подписываются.
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
  // События версии ПАО (Р33 п. 10) пишет адаптер; время записи — по часам ядра, как у прочих событий журнала.
  const now = o.now ?? (() => new Date());
  const protocolJournal = { record: (e: JournalEntry) => journal.record({ ...e, at: now().toISOString() }) };
  const platform = new PaoPlatform({ ...o.pao, params, signing: ring.port(), journal: protocolJournal });
  // Р33 п. 10, шаг 1: до допуска и до любого обращения с мандатом. События версии пишет адаптер, остановку агента — тоже
  // он (порт подписи); отказ PLATFORM_PROTOCOL_UNSUPPORTED связка ключей пробрасывает как есть (агент уже остановлен).
  const connect = async (): Promise<void> => {
    await platform.checkProtocol();
  };
  return {
    params,
    platform,
    capabilities: platform.capabilities(),
    mandates: new MandateClient({ port: platform, params, journal, ...(o.now && { now: o.now }) }),
    journal,
    // Конфигурация читается после загрузки ключей (сбой хранилища — до обращения к Платформе) и перед GET /pao/v1/agent;
    // один раз за start, повтор допуска (SIGNATURE_INVALID) её не повторяет.
    start: () => {
      let connected = false;
      return ring.start(async (signing) => {
        if (!connected) {
          await connect();
          connected = true;
        }
        return new PaoPlatform({ ...o.pao, params, signing }).agentSelf();
      });
    },
    recheck: () => ring.recheck((signing) => new PaoPlatform({ ...o.pao, params, signing }).agentSelf()),
    maintainKeys: () => ring.maintain(platform),
    close: () => ring.close(),
  };
}
