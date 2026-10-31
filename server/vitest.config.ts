import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/postgres.ts"],
    testTimeout: 20_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
