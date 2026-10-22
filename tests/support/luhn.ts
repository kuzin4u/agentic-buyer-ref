// Серия цифр с верной суммой Луна — собирается во время прогона, литералов, похожих на номер карты, в репозитории нет
// (инвариант 1, guard.py). Префикс в тестах — 9…: такие номера карт не выпускаются.

/** `prefix` и контрольная цифра Луна. */
export function luhnTail(prefix: string): string {
  let sum = 0;
  for (let i = 0; i < prefix.length; i++) {
    let d = Number(prefix[prefix.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return prefix + String((10 - (sum % 10)) % 10);
}
