import { defineConfig } from "vitest/config";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";

requireDisposableIntegrationEnvironment();

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
  },
});
