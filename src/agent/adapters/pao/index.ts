// Адаптер ПАО к порту «платёжная платформа»; типы agentic-core/pao используются только здесь (Р19).
// Перевод событий (map.feedFromPao) наружу не отдаётся: лента — через порт событий (Р34).
export { PaoPlatform, PAO_COPY_VERSION, assertPaoVersion, type PaoPlatformOptions } from "./adapter.js";
// Реестр кодов ПАО ядра (К17): полный реестр агента собирает место сборки (Р36 п. 1).
export { PAO_DIAG } from "@kuzin4u/agentic-core/pao";
