// Порт событий — часть порта «платёжная платформа» (Р19) по составу AG-К5: лента и подписка (Р34). Модуль
// src/agent/events видит только его. Событие — сигнал, статус — по GET (Р29 п. 5, Р34 п. 5).
import type { PlatformEvent, PlatformEventType } from "../../shared/domain.js";
import type { Mutation } from "./mutation.js";

/** Элемент ленты: событие ядра или пропуск (Р34 п. 6). У пропуска есть `event_id` — курсор двигается. */
export type FeedItem =
  | { kind: "event"; event: PlatformEvent }
  /** тип вне перечня ПАО 1.4.0 — тип не переносится (строка Платформы вне перечня) */
  | { kind: "ignored"; eventId: string; detail: "UNKNOWN_TYPE" }
  /** тип из перечня, `data` не по схеме; `type` — для ответа (б) владельца: mandate.* — перечитать мандаты */
  | { kind: "ignored"; eventId: string; detail: "INVALID_DATA"; type: PlatformEventType };

export interface EventsPort {
  /** Лента после курсора `after` (null — с начала), по порядку Платформы; пустой массив — событий больше нет.
   *  Элемент без `event_id`, `type` или `at` — отказ UNKNOWN всего ответа (Р34 п. 6). */
  listEvents(after: string | null): Promise<FeedItem[]>;
  /** Подписка на push (`PUT /pao/v1/subscription`); заменяет прежнюю целиком (РП40 п. 1). */
  subscribe(url: string, types: readonly PlatformEventType[], m: Mutation): Promise<void>;
}
