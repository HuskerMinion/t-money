// Vitest config for the T-Money desktop frontend.
// Kept separate from vite.config.ts so the Tauri dev/build pipeline is
// untouched. jsdom + @testing-library/react; every test that reaches the
// backend mocks `@tauri-apps/api/core` (see src/test/tauriMock.ts).
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Components carry Tailwind class names but assert on structure, not
    // style — skip PostCSS/Tailwind entirely so tests stay fast.
    css: false,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    restoreMocks: true,
  },
});
