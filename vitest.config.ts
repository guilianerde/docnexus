import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Native vector/model runtimes and durable filesystem tests share substantial I/O and memory.
    maxWorkers: 2,
    testTimeout: 60_000,
    setupFiles: ["test/setup.ts"],
    include: ["test/**/*.test.ts"],
    restoreMocks: true
  }
});
