import { defineConfig } from "vitest/config";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";

const database = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
const redis = process.env.E2E_DISPOSABLE_REDIS_URL, source = process.env.E2E_AGENT_PLAN_LEGACY_SOURCE;
const expected = fileURLToPath(new URL("../../tmp/agent-plan-20261022-b41e0c72/old173-source", import.meta.url));
const local = ["localhost", "127.0.0.1", "[::1]"];
if (!nonce || ["E2E_AGENT_PLAN_ISOLATED", "E2E_AGENT_LOOP_ISOLATED", "E2E_AGENT_COMMAND_ISOLATED", "E2E_AGENT_READ_ISOLATED", "E2E_ISOLATED_DAILY"].some(key => process.env[key] !== "1") ||
  process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0174" || !local.includes(database.hostname) || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` ||
  !redis || process.env.REDIS_URL !== redis || process.env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` ||
  !["redis:", "rediss:"].includes(new URL(redis).protocol) || !local.includes(new URL(redis).hostname) || !source || !isAbsolute(source) || resolve(source) !== resolve(expected))
  throw new Error("Agent planning upgrade requires exact original173 graph, all isolated flags and exact pre-0174 nonce resources before test loading");

export default defineConfig({ ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/ai/agent-plan-upgrade.integration.test.ts"], maxWorkers: 1, fileParallelism: false, testTimeout: 180_000, hookTimeout: 180_000 } });
