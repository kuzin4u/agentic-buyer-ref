// Проверка записей журнала агента (Р37 п. 3): закрытый набор полей, код агента в каждой записи, причина — код полного
// реестра, ни следа тайн обращения. Тайны берутся из журнала обращений заглушки ПАО (x-nonce и Idempotency-Key каждого
// запроса) — значения, а не имена: имена полей проверяет закрытый набор (ревью К2.1 № 3).
import { expect } from "vitest";
import type { PaoStubCall } from "@kuzin4u/agentic-core/pao";
import { DIAG } from "../../src/agent/compose.js";
import { JOURNAL_FIELDS, type JournalEntry } from "../../src/agent/journal/index.js";

/** calls — журнал обращений заглушки; secrets — прочие значения, которых в журнале быть не должно. */
export function expectJournalClean(
  entries: readonly JournalEntry[],
  agent: string,
  calls: readonly PaoStubCall[],
  secrets: readonly string[] = [],
): void {
  expect(entries.length).toBeGreaterThan(0);
  const fields = new Set<string>(JOURNAL_FIELDS);
  for (const e of entries) {
    expect(Object.keys(e).filter((k) => !fields.has(k)), `поля вне набора: ${e.kind}`).toEqual([]);
    expect(e.agent, `без кода агента: ${e.kind}`).toBe(agent);
    if (e.reason !== undefined) expect(Object.hasOwn(DIAG, e.reason), `код вне реестра: ${e.reason}`).toBe(true);
  }
  const values = [...calls.flatMap((c) => [c.nonce, c.idempotencyKey]), ...secrets].filter((v): v is string => typeof v === "string" && v !== "");
  expect(values.length, "нечего искать: заглушка не видела ни nonce, ни ключа").toBeGreaterThan(0);
  const text = JSON.stringify(entries);
  for (const v of values) expect(text, `в журнале значение обращения: ${v}`).not.toContain(v);
}
