import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: [path.resolve(__dirname, "src/renderer/test/setup.ts")],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/test/**",
        "e2e/**",
        "src/preload/**",
        "src/ipc/contracts.ts",
        "src/main/main.ts",
        "src/renderer/main.tsx",
      ],
      thresholds: {
        lines: 80,
        statements: 80,
        branches: 75,
        functions: 80,
      },
    },
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
