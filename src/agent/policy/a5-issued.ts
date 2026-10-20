// Реестр решений человека по A5, выданных оболочкой (Р39 п. 5): политика принимает только их (инвариант 7). Отметку
// ставит только фабрика оболочки (`shell/a5-decision.ts`): `markIssued` вне shell/ импортировать нельзя — правило
// графа импортов; ядро берёт из оболочки только типы.
import type { HumanA5Decision } from "../shell/a5-decision.js";

const issued = new WeakSet<object>();

/** Отметить решение как выданное оболочкой; только для фабрики решения в shell/a5-decision.ts. */
export function markIssued(d: object): void {
  issued.add(d);
}

/** Выдано фабрикой оболочки: структурная копия или подделка с приведением типа — не решение человека. */
export function issuedByShell(d: unknown): d is HumanA5Decision {
  return typeof d === "object" && d !== null && issued.has(d);
}
