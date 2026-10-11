// Адаптер ПАО к порту «платёжная платформа»; типы agentic-core/pao используются только здесь (Р19).
// Перевод событий (map.eventFromPao) наружу не отдаётся: приём событий с проверкой подписи — AG-06.
export { PaoPlatform, PAO_COPY_VERSION, assertPaoVersion, type PaoPlatformOptions } from "./adapter.js";
