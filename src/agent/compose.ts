// Место сборки ядра (composition root) — единственное исключение из правила Р19: только здесь виден адаптер pao.
// Ядро (pipeline, policy, mandates, declines) получает платформу через порт и не знает, какая она.
import { loadParams, type StandParams } from "../shared/config.js";
import type { PaymentPlatform, PlatformCapabilities } from "./ports/payment-platform.js";
import { PaoPlatform, type PaoPlatformOptions } from "./adapters/pao/index.js";

export interface AgentCore {
  params: StandParams;
  platform: PaymentPlatform;
  capabilities: PlatformCapabilities;
}

export interface AgentCoreOptions {
  /** путь к стендовым параметрам; по умолчанию config/params.stand.json */
  paramsPath?: string;
  pao: Omit<PaoPlatformOptions, "params">;
}

export function createAgentCore(o: AgentCoreOptions): AgentCore {
  const params = loadParams(o.paramsPath);
  const platform = new PaoPlatform({ ...o.pao, params });
  return { params, platform, capabilities: platform.capabilities() };
}
