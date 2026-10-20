// Окно дробления (Р39 п. 4): по корневому INTENT, как у Платформы (#37 п. 1). Окно только запрещает и никогда не
// разрешает — решение о списании по verify (инвариант 6). Только в памяти ядра: после перезапуска пусто, долю ловит
// Платформа (остаточный риск, к пересмотру при AG-20).
import type { StandParams } from "../../shared/config.js";
import type { Money } from "../../shared/domain.js";

/** Исход операции в окне: отказ и CONFIRMATION_REQUIRED окно не занимают; сбой или неизвестный исход — занимает
 *  (fail-closed). */
export type SplitOutcome = "APPROVED" | "REFUSED" | "UNKNOWN";

interface Entry {
  root: string;
  amount: number;
  at: number;
  outcome: SplitOutcome | "IN_PROGRESS";
}

/** Место операции в окне: занято от входа в стадию 5; исход — по ответу Платформы. */
export interface SplitSlot {
  settle(outcome: SplitOutcome): void;
}

export class SplitWindow {
  readonly #entries: Entry[] = [];

  constructor(
    private readonly params: Pick<StandParams, "split_window_sec" | "split_min_ops">,
    private readonly now: () => Date,
  ) {}

  /** Доля (#37 п. 1): итог не выше порога, а с ним в окне по корню не меньше `split_min_ops` операций и их сумма выше
   *  порога. Итог выше порога — не доля: его ведёт стадия 4. Валюта — только RUB (до окна иная не доходит). */
  isShare(root: string, total: Money, thresholdKop: number): boolean {
    if (total.amount > thresholdKop) return false;
    const inWindow = this.#live(root);
    return inWindow.length + 1 >= this.params.split_min_ops && inWindow.reduce((s, e) => s + e.amount, total.amount) > thresholdKop;
  }

  /** Занять место в окне на входе в стадию 5 — синхронно после `isShare`, без ожидания между ними: параллельная покупка
   *  под тем же корнем увидит эту операцию. */
  open(root: string, total: Money): SplitSlot {
    const e: Entry = { root, amount: total.amount, at: this.now().getTime(), outcome: "IN_PROGRESS" };
    this.#entries.push(e);
    return {
      settle: (outcome) => {
        if (e.outcome === "IN_PROGRESS") e.outcome = outcome;
      },
    };
  }

  #live(root: string): Entry[] {
    const from = this.now().getTime() - this.params.split_window_sec * 1000;
    // вышедшие из окна больше не нужны ни одной проверке
    for (let i = this.#entries.length - 1; i >= 0; i--) if (this.#entries[i]!.at < from) this.#entries.splice(i, 1);
    return this.#entries.filter((e) => e.root === root && e.outcome !== "REFUSED");
  }
}
