// Сигнал прерывания со счётом слушателей abort (Р49 ревью КТ1 № 14 (в), AG-12 ч. 3б): после итога ожидания на сигнале не
// должно остаться ни одного слушателя — иначе каждая покупка оставляет замыкание на долгоживущем сигнале (утечка).
export function trackedSignal(): { ac: AbortController; signal: AbortSignal; live: () => number } {
  const ac = new AbortController();
  const { signal } = ac;
  const listeners = new Set<unknown>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions | boolean) => {
    if (type === "abort") listeners.add(fn);
    add(type, fn, opts);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: EventListenerOptions | boolean) => {
    if (type === "abort") listeners.delete(fn);
    remove(type, fn, opts);
  }) as typeof signal.removeEventListener;
  // слушатель с { once: true } снимается и самим срабатыванием
  add("abort", () => listeners.clear());
  return { ac, signal, live: () => listeners.size };
}
