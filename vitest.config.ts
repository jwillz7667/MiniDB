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
      reporter: ["text", "text-summary", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/repl.ts", // interactive entrypoint, exercised by hand
        "src/bench/**",
        "src/sql/ast.ts", // type-only declarations, no runtime code
        "src/**/*.test.ts",
      ],
      thresholds: {
        statements: 90,
        branches: 82,
        functions: 90,
        lines: 90,
      },
    },
  },
});
