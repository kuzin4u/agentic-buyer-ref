// Адаптер ПАО к порту «платёжная платформа»; типы agentic-core/pao используются только здесь (Р19).
// Перевод событий (map.feedFromPao) наружу не отдаётся: лента — через порт событий (Р34).
export { PaoPlatform, PAO_COPY_VERSION, assertPaoVersion, type PaoPlatformOptions } from "./adapter.js";
// Ограничитель частоты обращений (Р59): один на агента — создаёт место сборки.
export { Pace, type PaceOptions } from "./pace.js";
// Реестр кодов ПАО ядра (К17): полный реестр агента собирает место сборки (Р36 п. 1).
export { PAO_DIAG } from "@kuzin4u/agentic-core/pao";
// Коды отказа самого клиента ПАО (К18 ядра v0.9.0, Р37 п. 1): PAO_CLIENT_REDIRECT, PAO_CLIENT_SIGNER_MISSING.
export { PAO_CLIENT_CODES, PAO_CLIENT_DIAG } from "@kuzin4u/agentic-core/pao";
