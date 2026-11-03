// Журнал обращений PaoStub глазами набора соответствия (AG-20, Р67; сессия 62, PR #99 — ядро v0.12.0+, agentic-core#44):
// какие обращения — от агента цели и подписаны ли им. `agentCode` PaoStub ставит только после успешной проверки подписи
// (К24 ядра); обращение другого агента — его `agentCode` или, при отказе подписи, нет `agentCode` и не свой `kid`.
// Сверка по `agentCode` — второй рубеж: адаптер сам сверяет `agent_code` в каждом ответе (`map.ts`), поэтому поломкой
// кода агента до неё не дойти; фильтр проверяется синтетическими записями (pao-stub-calls.test.ts, решение владельца
// #issuecomment-6608172924 п. 3).
import type { PaoStubCall } from "@kuzin4u/agentic-core/pao";
import type { PlatformCall } from "./suite.js";

/** Агент цели: код и `kid` единственного ключа (ротации в наборе нет). */
export interface OwnAgent {
  agentCode: string;
  kid: string;
}

/** Обращение — от агента цели: его `agentCode`; без `agentCode` (подпись не проверена или не прошла) — без `kid` или со
 *  своим `kid`. Чужой `agentCode` — не своё, даже со своим `kid`. */
export function isOwnCall(c: PaoStubCall, own: OwnAgent): boolean {
  if (c.agentCode !== undefined) return c.agentCode === own.agentCode;
  return c.kid === undefined || c.kid === own.kid;
}

/** Обращения агента цели в форме набора: подписано им — свой `agentCode` и свой `kid`. */
export function ownCalls(calls: readonly PaoStubCall[], own: OwnAgent): PlatformCall[] {
  return calls
    .filter((c) => isOwnCall(c, own))
    .map((c) => ({
      mutating: c.method !== "GET",
      status: c.status,
      ...(c.code !== undefined && { code: c.code }),
      signed: c.agentCode === own.agentCode && c.kid === own.kid,
      ...(c.idempotencyKey !== undefined && { idempotencyKey: c.idempotencyKey }),
      ...(c.nonce !== undefined && { nonce: c.nonce }),
    }));
}
