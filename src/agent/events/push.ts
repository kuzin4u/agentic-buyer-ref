// Приём push-событий Платформы (Р34 п. 2): до ПАО 1.5.0 тело не подписано (РП39 п. 6) и в обработку не идёт — push только
// будит чтение ленты. Проверяется форма: JSON-объект Event (тип — любая строка), x-event-id равен event_id. Ответ — сразу,
// до чтения ленты (в пределах event_delivery_timeout_ms Платформы). HTTP-сервера здесь нет: он у оболочки или buyer_agent.

/** Маска event_id — та же, что у идентификаторов ленты в адаптере. */
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export type PushRejection = "NOT_JSON" | "NOT_EVENT" | "EVENT_ID_MISMATCH";

/** Часть журнала агента, которую видит приём push (Journal подходит). */
export interface PushJournal {
  record(entry: { at: string; kind: "event.push_rejected"; detail: PushRejection }): void;
}

export interface PushOptions {
  /** сигнал «прочитай ленту» — EventFeed.signal: слияние сигналов и предел частоты — там */
  wake: () => Promise<void>;
  journal: PushJournal;
  now?: () => Date;
}

export interface PushReply {
  status: 200 | 400;
}

/**
 * Приём одного push. Форма верна — 200 и сигнал ленте без ожидания чтения: отказ курсора уже остановил агента
 * (EVENTS_CURSOR_INVALID), прочий сбой чтения (503, UNKNOWN) здесь не пишется — его увидит следующий опрос (STATUS «Открыто»);
 * неверна — 400 и запись в журнал без содержимого тела (инвариант 5). Заголовки — в нижнем регистре, как у node:http.
 */
export function acceptPush(o: PushOptions, body: string, headers: Readonly<Record<string, string | string[] | undefined>>): PushReply {
  const reject = (detail: PushRejection): PushReply => {
    o.journal.record({ at: (o.now ?? (() => new Date()))().toISOString(), kind: "event.push_rejected", detail });
    return { status: 400 };
  };
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return reject("NOT_JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return reject("NOT_EVENT");
  const e = raw as { event_id?: unknown; type?: unknown; at?: unknown; data?: unknown };
  const dataOk = typeof e.data === "object" && e.data !== null && !Array.isArray(e.data);
  if (typeof e.event_id !== "string" || !EVENT_ID.test(e.event_id) || typeof e.type !== "string" || e.type === "" || typeof e.at !== "string" || !dataOk) {
    return reject("NOT_EVENT");
  }
  if (headers["x-event-id"] !== e.event_id) return reject("EVENT_ID_MISMATCH");
  void o.wake().catch(() => undefined);
  return { status: 200 };
}
