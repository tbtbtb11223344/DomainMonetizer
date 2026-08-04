import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "ops/**/*.test.mjs"],
    environment: "node",
    coverage: { reporter: ["text", "json-summary"] },
  },
});
