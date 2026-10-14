import { defineConfig } from "vitest/config";
// Все расширения TypeScript: тест .test.mts/.test.tsx не должен молча выпадать из прогона (ревью К2.1 № 4)
export default defineConfig({ test: { include: ["tests/**/*.test.{ts,mts,cts,tsx}"] } });
