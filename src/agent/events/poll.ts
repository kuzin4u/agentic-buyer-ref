// Чтение ленты, пока покупка ждёт события (модули подтверждений и операций): push может не прийти. Между чтениями —
// макрозадача: лента без своей паузы не займёт процессор и не задержит таймеры исхода. Отказ ленты (слушатель упал —
// событие прочитается снова, Р34 п. 3; Платформа просит повторить GET, Р49 п. 3) — пауза `retryMs` и чтение дальше, пока
// ожидание живо (ревью КТ1 AG-11 ч. 2 № 3); без `retryMs` — опрос прекращается, исход — по таймерам ожидания.

export async function poll(wake: (() => Promise<void>) | undefined, done: () => boolean, retryMs?: number): Promise<void> {
  if (wake === undefined) return;
  while (!done()) {
    try {
      await wake();
    } catch {
      if (retryMs === undefined) return;
      await new Promise<void>((r) => setTimeout(r, retryMs));
      continue;
    }
    await new Promise<void>((r) => setImmediate(r));
  }
}
