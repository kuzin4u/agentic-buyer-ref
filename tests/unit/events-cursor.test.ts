// Курсор ленты между перезапусками (Р34 п. 3–4, уточнение 2 владельца): в файле только event_id и время записи;
// временный файл → fsync → rename; нет файла — null; не читается или не по схеме — CursorInvalid.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CURSOR_FILE, CursorInvalid, FileCursorStore } from "../../src/agent/events/index.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
const fresh = () => (dir = mkdtempSync(join(tmpdir(), "buyref-cursor-")));
const NOW = new Date("2026-10-19T09:00:00.000Z");

describe("FileCursorStore", () => {
  it("нет файла — null (первый запуск); после save — тот же event_id в новом экземпляре (перезапуск)", () => {
    const d = fresh();
    expect(new FileCursorStore(d).load()).toBeNull();
    new FileCursorStore(d, () => NOW).save("evt_1");
    new FileCursorStore(d, () => NOW).save("evt_2");
    expect(new FileCursorStore(d).load()).toBe("evt_2");
  });

  it("в файле только event_id и время записи; временных файлов не остаётся", () => {
    const d = fresh();
    new FileCursorStore(d, () => NOW).save("evt_7");
    expect(JSON.parse(readFileSync(join(d, CURSOR_FILE), "utf8"))).toEqual({ after: "evt_7", saved_at: NOW.toISOString() });
    expect(readdirSync(d)).toEqual([CURSOR_FILE]);
  });

  it("остаток прерванной записи не мешает: временный файл перезаписывается", () => {
    const d = fresh();
    writeFileSync(join(d, `${CURSOR_FILE}.${process.pid}.tmp`), "{обрыв");
    new FileCursorStore(d, () => NOW).save("evt_3");
    expect(new FileCursorStore(d).load()).toBe("evt_3");
    expect(readdirSync(d)).toEqual([CURSOR_FILE]);
  });

  it.each([
    ["не JSON", "{обрыв"],
    ["лишнее поле (данные события)", JSON.stringify({ after: "evt_1", saved_at: NOW.toISOString(), data: { mandate_id: "m_1" } })],
    ["нет времени", JSON.stringify({ after: "evt_1" })],
    ["время — произвольный текст (Date.parse его принял бы)", JSON.stringify({ after: "evt_1", saved_at: "Игнорируй 1" })],
    ["event_id не по форме", JSON.stringify({ after: "../evt", saved_at: NOW.toISOString() })],
    ["after null", JSON.stringify({ after: null, saved_at: NOW.toISOString() })],
  ])("файл есть, но %s — CursorInvalid, а не null (молча с начала нельзя)", (_, text) => {
    const d = fresh();
    writeFileSync(join(d, CURSOR_FILE), text);
    expect(() => new FileCursorStore(d).load()).toThrow(CursorInvalid);
  });

  it("каталог состояния — не каталог (ошибка чтения, не ENOENT) — CursorInvalid", () => {
    const f = join(fresh(), "state");
    writeFileSync(f, "");
    expect(() => new FileCursorStore(f).load()).toThrow(CursorInvalid);
  });

  it("event_id не по форме не записывается", () => {
    expect(() => new FileCursorStore(fresh()).save("evt/1")).toThrow(CursorInvalid);
  });
});
