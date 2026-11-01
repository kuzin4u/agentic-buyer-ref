// Адрес страницы УПК для человека (Р69 п. 5, К1.5; Т7; SPEC §9): ссылка из GET запроса подтверждения показывается
// оболочке, но только безопасная — абсолютный `https:` без логина и пароля в адресе. Иначе ссылки нет: человек
// подтверждает в приложении банка (fail-closed). Ссылка не попадает в журнал, исход и тексты ошибок (инвариант 1).

/** Предел длины адреса: длиннее — не показывается (ответ не по смыслу, а не страница). */
const LINK_MAX = 2048;
/** Управляющий символ или пробел (U+0000–U+0020, U+007F–U+009F) — адрес не показывается (подмена текста для человека). */
const unsafe = (v: string): boolean => [...v].some((ch) => {
  const c = ch.codePointAt(0)!;
  return c <= 0x20 || (c >= 0x7f && c <= 0x9f);
});

/** Ссылка страницы УПК для показа человеку; не годится — null. Возвращается разобранный адрес (`URL.href`). */
export function pageLink(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > LINK_MAX || unsafe(v)) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.hostname === "") return null;
  return u.href;
}
