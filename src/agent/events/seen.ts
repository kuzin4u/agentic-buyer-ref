// Окно обработанных event_id (Р50 п. 1; жёсткое условие владельца 3 к Р49): последние `max` по порядку обработки,
// старейший вытесняется при переполнении. Окно по номеру ленты не берётся — форма event_id порядка не обещает. Событие,
// вытесненное и прочитанное снова, — второй GET: безопасно, действие — по GET (Р34 п. 3). Только в памяти.

export class SeenWindow {
  /** Set хранит порядок вставки: первый — старейший */
  readonly #ids = new Set<string>();

  constructor(readonly max: number) {
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError("event_seen_max — целое не меньше 1");
  }

  get size(): number {
    return this.#ids.size;
  }

  has(id: string): boolean {
    return this.#ids.has(id);
  }

  add(id: string): void {
    if (this.#ids.has(id)) return;
    this.#ids.add(id);
    if (this.#ids.size > this.max) this.#ids.delete(this.#ids.values().next().value as string);
  }

  delete(id: string): void {
    this.#ids.delete(id);
  }
}
