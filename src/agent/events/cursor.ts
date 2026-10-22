// Курсор ленты событий между перезапусками (Р34 п. 3–4). Курсор — event_id последнего обработанного события; всё, что
// в ленте не позже него, обработано — отдельного множества event_id нет. Файл — только event_id и время записи (уточнение 2
// владельца); запись: временный файл → fsync → rename → fsync каталога. Нет файла — первый запуск; файл не читается или
// не по схеме — CursorInvalid: молча начинать с начала нельзя (инвариант 4), решает вызывающий (остановка агента).
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { SAFE_ID } from "../../shared/ids.js";

export const CURSOR_FILE = "events.cursor.json";

/** Форма event_id у агента — та же маска, что у идентификаторов ленты в адаптере (данные, не инструкция). */
export const EVENT_ID = SAFE_ID;

const CursorFile = z.strictObject({
  after: z.string().regex(EVENT_ID),
  saved_at: z.iso.datetime({ offset: true }),
});

/** Курсор не прочитан: файл есть, но не читается или не по схеме (Р34 п. 4). Путь и содержимое в сообщение не идут. */
export class CursorInvalid extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CursorInvalid";
  }
}

export interface EventCursorStore {
  /** null — курсора нет (первый запуск или сброс оператором): лента с начала. Не читается — CursorInvalid. */
  load(): string | null;
  /** Сохранить курсор после обработки события; сбой записи — исключение (дальше не обрабатывать). */
  save(after: string): void;
}

/** Хранилище в памяти — для тестов; `invalid` — курсор не читается (битый файл). */
export class MemoryCursorStore implements EventCursorStore {
  after: string | null = null;
  readonly saved: string[] = [];
  invalid = false;
  load(): string | null {
    if (this.invalid) throw new CursorInvalid("курсор ленты не по схеме");
    return this.after;
  }
  save(after: string): void {
    this.after = after;
    this.saved.push(after);
  }
}

export class FileCursorStore implements EventCursorStore {
  readonly #dir: string;
  readonly #now: () => Date;

  constructor(dir: string, now: () => Date = () => new Date()) {
    this.#dir = resolve(dir);
    this.#now = now;
  }

  load(): string | null {
    let text: string;
    try {
      text = readFileSync(join(this.#dir, CURSOR_FILE), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new CursorInvalid("курсор ленты не прочитан", { cause: e });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new CursorInvalid("курсор ленты не JSON");
    }
    const r = CursorFile.safeParse(raw);
    if (!r.success) throw new CursorInvalid("курсор ленты не по схеме");
    return r.data.after;
  }

  save(after: string): void {
    if (!EVENT_ID.test(after)) throw new CursorInvalid("event_id не по форме — курсор не записан");
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const tmp = join(this.#dir, `${CURSOR_FILE}.${process.pid}.tmp`);
    try {
      unlinkSync(tmp); // остаток прерванной записи
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const fd = openSync(tmp, "wx", 0o600);
    try {
      const buf = Buffer.from(JSON.stringify({ after, saved_at: this.#now().toISOString() }), "utf8");
      // частичная запись — ошибка до rename: прежний курсор остаётся на месте
      if (writeSync(fd, buf) !== buf.length) throw new CursorInvalid("курсор ленты записан не полностью");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, join(this.#dir, CURSOR_FILE));
    // rename переживает сбой питания только после fsync каталога
    const dfd = openSync(this.#dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  }
}
