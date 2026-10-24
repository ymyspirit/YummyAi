import { defineConfig } from "vitest/config";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";

const database = new URL(requireDisposableIntegrationEnvironment()), redis = process.env.E2E_DISPOSABLE_REDIS_URL;
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1], source = process.env.E2E_AGENT_LOOP_LEGACY_SOURCE;
const expected = fileURLToPath(new URL("../../tmp/agent-loop-20261022-68018aa3/old171-source", import.meta.url)), loopback = ["localhost", "127.0.0.1", "[::1]"];
if (!nonce || process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_AGENT_LOOP_ISOLATED !== "1" || process.env.E2E_AGENT_READ_ISOLATED !== "1" ||
  process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0172" || !source || !isAbsolute(source) || resolve(source) !== resolve(expected) || !loopback.includes(database.hostname) ||
  process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || process.env.REDIS_URL !== redis || process.env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` ||
  !["redis:", "rediss:"].includes(new URL(redis).protocol) || !loopback.includes(new URL(redis).hostname))
  throw new Error("Agent loop upgrade requires the real frozen171 source and exact isolated pre-0172 nonce resources before loading tests");

export default defineConfig({ ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/ai/agent-loop-upgrade.integration.test.ts"], maxWorkers: 1, fileParallelism: false, testTimeout: 180_000, hookTimeout: 180_000 },
});
