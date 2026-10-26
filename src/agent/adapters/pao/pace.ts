// Ограничитель частоты обращений к ПАО (Р59): ровный интервал не выше rate_limit_per_min второго слоя лимита Платформы
// (ПАО §2, РП63: окна по 30 с, в окне — не больше половины предела; «ровную частоту держите сами»). Ведро не годится:
// всплеск в одно окно Платформы — 429. Один ограничитель на агента: счётчик Платформы — по коду агента, а адаптеров ПАО
// у агента несколько (основной, допуск, сверка) — его создаёт место сборки и передаёт всем (Р59 п. 1).
import type { AgentSelf } from "../../../shared/domain.js";

/** Смена предела (Р59 п. 3): detail — `AGENT:<n>` или `FALLBACK:NO_FIELD` / `FALLBACK:OUT_OF_RANGE`. */
export interface PaceJournal {
  record(entry: { at: string; kind: "pao.rate_limit"; detail: string }): void;
}

export interface PaceOptions {
  /** pao_rate_limit_fallback_per_min — пока предел Платформы неизвестен (fail-closed, Р59 п. 3) */
  fallbackPerMin: number;
  journal: PaceJournal;
  now?: () => Date;
  /** монотонные часы в мс; по умолчанию performance.now */
  monotonic?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Предел, с которым агент начинает: запасной, без записи — смены ещё не было. */
const INITIAL = "FALLBACK:INITIAL";

export class Pace {
  #perMin: number;
  #detail = INITIAL;
  /** время отправки последнего обращения, которому выдано место в очереди (мс монотонных часов) */
  #last = -Infinity;
  /** до этого времени не уходит ни одно обращение агента — пауза после 429 (Р59 п. 4) */
  #holdUntil = -Infinity;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: PaceOptions) {
    this.#perMin = o.fallbackPerMin;
    this.clock = o.monotonic ?? (() => performance.now());
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Действующий предел в минуту. */
  get perMin(): number {
    return this.#perMin;
  }

  /** Ожидание, если обращение начнётся сейчас (мс): для срока выдачи реквизита до постановки в очередь (Р45 п. 2.4). */
  delay(): number {
    const t = this.clock();
    return Math.max(0, this.#slot(t) - t);
  }

  /** Место в очереди и ожидание до него: между отправками — не меньше 60 000 / предел мс; порядок — порядок вызова. Пауза,
   *  объявленная во время ожидания, — новое место после неё (без опроса часов: время отсчитывается от места). */
  async wait(): Promise<void> {
    let t = this.clock();
    for (;;) {
      const at = this.#slot(t);
      this.#last = at;
      if (at > t) await this.sleep(at - t);
      if (this.#holdUntil <= at) return;
      t = at;
    }
  }

  /** 429 (Р59 п. 4): окно Платформы общее для всех обращений агента — ни одно не уходит раньше, чем через `sec` секунд. */
  hold(sec: number): void {
    this.#holdUntil = Math.max(this.#holdUntil, this.clock() + sec * 1000);
  }

  #slot(t: number): number {
    return Math.max(t, this.#last + 60_000 / this.#perMin, this.#holdUntil);
  }

  /**
   * Предел из ответа GET /pao/v1/agent (Р59 п. 3): целое ≥ 1 — как есть; нет поля или вне границ — запасная частота.
   * Запись pao.rate_limit — только при смене, до действия; смена — в finally: сбой журнала её не отменяет (Р-645).
   */
  learn(self: Pick<AgentSelf, "rateLimitPerMin">): void {
    const v = self.rateLimitPerMin;
    const known = v !== undefined && Number.isSafeInteger(v) && v >= 1;
    const perMin = known ? v : this.o.fallbackPerMin;
    const detail = known ? `AGENT:${v}` : v === undefined ? "FALLBACK:NO_FIELD" : "FALLBACK:OUT_OF_RANGE";
    if (detail === this.#detail) return;
    try {
      this.o.journal.record({ at: (this.o.now ?? (() => new Date()))().toISOString(), kind: "pao.rate_limit", detail });
    } finally {
      this.#perMin = perMin;
      this.#detail = detail;
    }
  }
}
