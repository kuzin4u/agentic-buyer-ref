// Ограничитель частоты обращений к ПАО (Р59): ровный интервал не выше rate_limit_per_min второго слоя лимита Платформы
// (ПАО §2, РП63: окна по 30 с, в окне — не больше половины предела; «ровную частоту держите сами»). Ведро не годится:
// всплеск в одно окно Платформы — 429. Один ограничитель на агента: счётчик Платформы — по коду агента, а адаптеров ПАО
// у агента несколько (основной, допуск, сверка) — его создаёт место сборки и передаёт всем (Р59 п. 1).
import { paoRateIntervalMs as intervalMs } from "../../../shared/config.js";
import { PlatformFailure, type AgentSelf } from "../../../shared/domain.js";

/** Смена предела (Р59 п. 3): detail — `AGENT:<n>` или `FALLBACK:NO_FIELD` / `FALLBACK:OUT_OF_RANGE`; предел, с которым
 *  Платформа не пропускает ни одного обращения за окно, — ещё и pao.contract_violation (Р59 дополнение 1 п. 2). */
export interface PaceJournal {
  record(
    entry:
      | { at: string; kind: "pao.rate_limit"; detail: string }
      | { at: string; kind: "pao.contract_violation"; reason: "RATE_LIMITED"; detail: `RATE_LIMIT_UNUSABLE:${number}` },
  ): void;
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
  #interval: number;
  #detail = INITIAL;
  /** время отправки последнего обращения, которому выдано место в очереди (мс монотонных часов) */
  #last = -Infinity;
  /** до этого времени не уходит ни одно обращение агента — пауза после 429 (Р59 п. 4) */
  #holdUntil = -Infinity;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: PaceOptions) {
    this.#perMin = o.fallbackPerMin;
    this.#interval = intervalMs(o.fallbackPerMin);
    this.clock = o.monotonic ?? (() => performance.now());
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Действующий предел в минуту. */
  get perMin(): number {
    return this.#perMin;
  }

  /** Ожидание, если обращение начнётся сейчас (мс): для срока выдачи реквизита до постановки в очередь (Р45 п. 2.4).
   *  Часы не дают числа — бесконечность: ни в какой срок не помещается (fail-closed, ревью КТ1 № 1). */
  delay(): number {
    const t = this.clock();
    if (!Number.isFinite(t)) return Infinity;
    return Math.max(0, this.#slot(t) - t);
  }

  /** Место в очереди и ожидание до него: между отправками — не меньше интервала по пределу. Порядок — порядок вызова, кроме
   *  паузы: ожидавшее до неё получает новое место после неё — после уже выданных (Р59 нюанс К2). Цикл — по выданным
   *  местам, без опроса часов. Часы не дают числа — отказ до сети, место не выдано (ревью КТ1 № 1). */
  async wait(): Promise<void> {
    let t = this.clock();
    if (!Number.isFinite(t)) {
      throw new PlatformFailure("RATE_LIMITED", "never", null, 0, null, "монотонные часы не дают числа — обращение не отправлено");
    }
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
    const t = this.clock();
    // часы не дают числа — паузу не поставить; следующее wait() откажет само
    if (Number.isFinite(t)) this.#holdUntil = Math.max(this.#holdUntil, t + sec * 1000);
  }

  #slot(t: number): number {
    return Math.max(t, this.#last + this.#interval, this.#holdUntil);
  }

  /**
   * Предел из ответа GET /pao/v1/agent (Р59 п. 3): целое ≥ 0 — как есть; нет поля или вне границ — запасная частота. При
   * floor(L/2) = 0 (L = 1 или 0) — самый медленный темп и pao.contract_violation (Р59 дополнение 1 п. 2). Записи — только
   * при смене, до действия; смена — в finally: сбой журнала её не отменяет (Р-645).
   */
  learn(self: Pick<AgentSelf, "rateLimitPerMin">): void {
    const v = self.rateLimitPerMin;
    const known = v !== undefined && Number.isSafeInteger(v) && v >= 0;
    const perMin = known ? v : this.o.fallbackPerMin;
    const detail = known ? `AGENT:${v}` : v === undefined ? "FALLBACK:NO_FIELD" : "FALLBACK:OUT_OF_RANGE";
    if (detail === this.#detail) return;
    const at = (this.o.now ?? (() => new Date()))().toISOString();
    try {
      if (known && Math.floor(v / 2) === 0) {
        this.o.journal.record({ at, kind: "pao.contract_violation", reason: "RATE_LIMITED", detail: `RATE_LIMIT_UNUSABLE:${v}` });
      }
      this.o.journal.record({ at, kind: "pao.rate_limit", detail });
    } finally {
      this.#perMin = perMin;
      this.#interval = intervalMs(perMin);
      this.#detail = detail;
    }
  }
}
