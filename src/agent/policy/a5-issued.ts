// Реестр решений человека по A5, выданных оболочкой (Р39 п. 5): политика принимает только их (инвариант 7). Отметку
// ставит только фабрика оболочки (`shell/a5-decision.ts`): `markIssued` вне shell/ импортировать нельзя — правило
// графа импортов; ядро берёт из оболочки только типы. Решение одноразовое (Р40 п. 2): потраченные — отдельный реестр,
// тратит конвейер. Оба реестра — только в памяти процесса (нюанс Р40).
import type { HumanA5Decision } from "../shell/a5-decision.js";

const issued = new WeakSet<object>();
const spent = new WeakSet<object>();

/** Отметить решение как выданное оболочкой; только для фабрики решения в shell/a5-decision.ts. */
export function markIssued(d: object): void {
  issued.add(d);
}

/** Выдано фабрикой оболочки: структурная копия или подделка с приведением типа — не решение человека. */
export function issuedByShell(d: unknown): d is HumanA5Decision {
  return typeof d === "object" && d !== null && issued.has(d);
}

/** Решение потрачено на запрос CART (Р40 п. 2): при любом исходе запроса, второй раз не покрывает. */
export function spend(d: HumanA5Decision): void {
  spent.add(d);
}

/** Решение уже потрачено на запрос CART. */
export function isSpent(d: HumanA5Decision): boolean {
  return spent.has(d);
}
