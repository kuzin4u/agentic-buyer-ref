// Порт мандатов — часть порта «платёжная платформа» (Р19) по составу AG-К5: мандаты отдельно от допуска и ключей,
// платёжных данных, событий и споров. Клиент мандатов (src/agent/mandates) видит только его.
import type { Evidence, Mandate, MandateCheck, MandateDraft, MandateRef } from "../../shared/domain.js";
import type { Mutation } from "./mutation.js";

export interface MandatePort {
  /** Запрос мандата; подписывает человек вне агента — ответ обычно PENDING_SIGNATURE (SPEC §9). */
  requestMandate(draft: MandateDraft, m: Mutation): Promise<Mandate>;
  getMandate(id: string): Promise<Mandate>;
  /** Остаток — в валюте мандата ссылки; нет `as_of` или он старше `registry_cache_ttl_sec` — решает ядро (Р29 п. 4). */
  verifyMandate(ref: MandateRef): Promise<MandateCheck>;
  relinquishMandate(id: string, m: Mutation): Promise<Mandate>;
  mandateEvidence(id: string): Promise<Evidence>;
}
