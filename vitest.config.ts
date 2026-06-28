import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The storage engine writes real files to disk; isolate suites so temp
    // database files from one test never bleed into another.
    isolate: true,
    pool: "threads",
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/repl.ts", "src/bench/**", "src/**/*.test.ts"],
    },
  },
});
