import { defineConfig } from "vitest/config";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";

const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
if (!nonce || process.env.E2E_AGENT_COMMAND_ISOLATED !== "1" || process.env.E2E_ISOLATED_DAILY !== "1" ||
  process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
  process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Agent original commands require exact current disposable nonce database and private bucket before loading tests");
export default defineConfig({ ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/ai/agent-command.integration.test.ts"], maxWorkers: 1, fileParallelism: false, testTimeout: 120_000, hookTimeout: 120_000 } });
