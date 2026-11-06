import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
  resolve: {
    alias: {
      "server-only": path.resolve(__dirname, "tests/helpers/server-only.ts"),
      "@": path.resolve(__dirname, "src"),
    },
  },
});
