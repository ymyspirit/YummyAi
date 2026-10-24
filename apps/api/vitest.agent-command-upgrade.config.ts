import { defineConfig } from "vitest/config";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";

const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
const source = process.env.E2E_AGENT_COMMAND_LEGACY_SOURCE, expected = fileURLToPath(new URL("../../tmp/agent-command-20261022-6f2d9a84/old172-source", import.meta.url));
const redis = process.env.E2E_DISPOSABLE_REDIS_URL;
if (!nonce || process.env.E2E_AGENT_COMMAND_ISOLATED !== "1" || process.env.E2E_ISOLATED_DAILY !== "1" ||
  process.env.E2E_AGENT_LOOP_ISOLATED !== "1" || process.env.E2E_AGENT_READ_ISOLATED !== "1" || !redis || process.env.REDIS_URL !== redis ||
  process.env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` || !["redis:", "rediss:"].includes(new URL(redis).protocol) ||
  !["localhost", "127.0.0.1", "[::1]"].includes(new URL(redis).hostname) ||
  process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0173" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
  process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !source || !isAbsolute(source) || resolve(source) !== resolve(expected))
  throw new Error("Agent original command upgrade requires exact frozen172 source and isolated pre-0173 nonce resources before loading tests");
export default defineConfig({ ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/ai/agent-command-upgrade.integration.test.ts"], maxWorkers: 1, fileParallelism: false, testTimeout: 180_000, hookTimeout: 180_000 } });
