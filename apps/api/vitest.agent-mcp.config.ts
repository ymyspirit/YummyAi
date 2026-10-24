import { defineConfig } from "vitest/config";
import { requireDisposableIntegrationEnvironment } from "../../tools/testing/require-disposable-integration.mjs";

const database = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
const redis = process.env.E2E_DISPOSABLE_REDIS_URL, local = ["localhost", "127.0.0.1", "[::1]"];
if (!nonce || ["E2E_AGENT_MCP_ISOLATED", "E2E_AGENT_NATIVE_ISOLATED", "E2E_AGENT_TOOLS_ISOLATED", "E2E_AGENT_PLAN_ISOLATED", "E2E_AGENT_LOOP_ISOLATED", "E2E_AGENT_COMMAND_ISOLATED", "E2E_AGENT_READ_ISOLATED", "E2E_ROLE_BENCHMARK_ISOLATED", "E2E_BUSINESS_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_EVALUATION_ISOLATED", "E2E_ISOLATED_DAILY"].some(key => process.env[key] !== "1") ||
  process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || !local.includes(database.hostname) || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` ||
  !redis || process.env.REDIS_URL !== redis || process.env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` ||
  !["redis:", "rediss:"].includes(new URL(redis).protocol) || !local.includes(new URL(redis).hostname))
  throw new Error("MCP Agent requires every opt-in and exact current nonce database, private bucket and Redis before test loading");

export default defineConfig({ ...(process.env.YUMMYAI_TEST_CACHE_DIR ? { cacheDir: process.env.YUMMYAI_TEST_CACHE_DIR } : {}),
  test: { include: ["src/ai/agent-mcp.integration.test.ts"], maxWorkers: 1, fileParallelism: false, testTimeout: 120_000, hookTimeout: 120_000 } });
