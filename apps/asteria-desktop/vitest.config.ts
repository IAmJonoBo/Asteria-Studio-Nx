import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, "src/renderer"),
  test: {
    environment: "jsdom",
    setupFiles: [path.resolve(__dirname, "src/renderer/test/setup.ts")],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 70,
        statements: 70,
        branches: 60,
        functions: 65,
      },
    },
  },
});
