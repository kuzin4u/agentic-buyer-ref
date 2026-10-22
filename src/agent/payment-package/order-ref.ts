// Номер заказа продавца перед запросом реквизита (Р45 п. 2.1, В1а): `Order.id` — данные продавца (инвариант 5). Не по
// маске ссылки или похож на номер карты — обращения к Платформе нет: номер карты из ответа продавца не уходит ни в ПАО, ни
// в журнал. Значение не пишется никуда — только причина PATTERN или PAN_LIKE.
import { SAFE_ID } from "../../shared/ids.js";

/** Маска ссылки агента: длина — как у Платформы (128). В YAML ПАО 1.4.0 у `order_ref` ограничений формата нет — тест-
 *  сторож сверяет это с копией; появятся — маску сводим с YAML (к пересмотру при ПАО 1.5.0). Маска — общая (Р46 п. 1). */
export const ORDER_REF = SAFE_ID;

export type OrderRefIssue = "PATTERN" | "PAN_LIKE";

/** Сумма Луна по строке цифр. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const panLength = (n: number): boolean => n >= 13 && n <= 19;

/** Фрагменты в форме UUID (8-4-4-4-12 шестнадцатеричных) — не номер карты (ПАО §4, РП49 (а) п. 3): правило «группы по
 *  4» иначе находит в них окно 13–19 цифр с верной суммой Луна. Заменяются разделителем до поиска, как у Платформы. */
const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Серия, похожая на номер карты (ПАО §4, РП49 (а)) — то же правило, что у Платформы v0.15.0 (`pao/body`): в цепочке
 *  групп цифр через одиночный дефис — группа из 13–19 цифр или окно подряд идущих групп по 4 цифры (последняя — 1–4),
 *  всего 13–19, с верной суммой Луна. Сплошная серия длиннее 19 цифр не проверяется. Пробелов маска не допускает. */
function panLike(ref: string): boolean {
  for (const chain of ref.replace(UUID_LIKE, "#").match(/\d+(?:-\d+)*/g) ?? []) {
    const groups = chain.split("-");
    for (let i = 0; i < groups.length; i++) {
      const first = groups[i]!;
      if (panLength(first.length) && luhn(first)) return true;
      let digits = "";
      for (let j = i; j < groups.length; j++) {
        const g = groups[j]!;
        if (g.length > 4) break;
        digits += g;
        if (j > i && panLength(digits.length) && luhn(digits)) return true;
        if (g.length < 4 || digits.length >= 19) break;
      }
    }
  }
  return false;
}

/** Причина, по которой номер заказа нельзя передать Платформе; null — можно. */
export function orderRefIssue(ref: string): OrderRefIssue | null {
  if (!ORDER_REF.test(ref)) return "PATTERN";
  return panLike(ref) ? "PAN_LIKE" : null;
}
