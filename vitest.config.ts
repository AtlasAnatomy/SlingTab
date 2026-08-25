import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts: that one loads @crxjs, which wants
// a manifest and an extension build context we do not need for pure unit tests.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
