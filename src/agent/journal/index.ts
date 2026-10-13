// Журнал решений агента; без реквизитов и персональных данных в открытом виде.
// Записи — только идентификаторы (kid, коды отказов); ключевого материала журнал не получает (инвариант 2).

export type JournalKind =
  /** ключ из хранилища загружен */
  | "key.loaded"
  /** новый ключ создан, ещё не зарегистрирован */
  | "key.created"
  /** платформа подтвердила регистрацию ключа */
  | "key.registered"
  /** временный файл ключа прошлого запуска (регистрация не подтверждена) — не используется */
  | "key.abandoned"
  /** брошенный временный ключ оказался зарегистрированным (ответ на регистрацию был потерян); отзыв — после PS-05 */
  | "key.abandoned_registered"
  /** подпись переведена на другой ключ */
  | "key.switched"
  /** платформа сообщила, что ключ отозван */
  | "key.revoked"
  /** в реестре платформы действующий ключ агента, которого нет в хранилище (A2 п. 5: признак регистрации в обход) */
  | "key.foreign"
  /** обращение подписано ключом kid */
  | "request.signed"
  /** допуск не пройден этим ключом или целиком (код отказа в reason); допуск можно повторить */
  | "admission.failed"
  /** рабочая подпись приостановлена до успешной повторной сверки с реестром (Р27) */
  | "signing.suspended"
  /** повторная сверка прошла (ACTIVE и BUYER) — подпись возобновлена */
  | "signing.resumed"
  /** агент остановлен */
  | "agent.stopped";

export interface JournalEntry {
  at: string;
  kind: JournalKind;
  kid?: string;
  /** код отказа или причина остановки */
  reason?: string;
  /** уточнение причины — только значение перечня ПАО (например, класс из реестра при AGENT_CLASS_MISMATCH, Р27) */
  detail?: string;
}

export interface Journal {
  record(entry: JournalEntry): void;
}

/** Журнал в памяти — для тестов и минимальной оболочки. */
export class MemoryJournal implements Journal {
  readonly entries: JournalEntry[] = [];
  record(entry: JournalEntry): void {
    this.entries.push(Object.freeze({ ...entry }));
  }
}
