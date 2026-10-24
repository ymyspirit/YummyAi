import assert from "node:assert/strict";
import test from "node:test";
import { financeRetentionEnvironment } from "../scripts/finance-command-retention-runtime.mjs";

const local = { DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:5432/synthetic",
  REDIS_URL: "redis://localhost:6379", S3_ENDPOINT: "http://127.0.0.1:9000" };
test("finance privacy maintenance fixes its only scheduler and zero consumers despite inherited all flags", () => {
  const input = { ...local, NODE_ENV: "development", TSX_DISABLE_CACHE: "0", WORKER_QUEUES: "all", WORKER_SCHEDULERS: "all" };
  const result = financeRetentionEnvironment(input);
  assert.equal(result.NODE_ENV, "production"); assert.equal(result.TSX_DISABLE_CACHE, "1");
  assert.equal(result.WORKER_QUEUES, "none"); assert.equal(result.WORKER_SCHEDULERS, "financeCommandRetentionScheduler");
  assert.equal(input.WORKER_QUEUES, "all"); assert.equal(input.WORKER_SCHEDULERS, "all");
});
test("finance privacy entry refuses missing, remote, malformed or query-bearing infrastructure before importing any Worker", () => {
  for (const name of Object.keys(local)) for (const value of [undefined, "invalid", local[name].replace(/127\.0\.0\.1|localhost/, "erp.example"),
    `${local[name]}?queues=all`, `${local[name]}#synthetic`])
    assert.throws(() => financeRetentionEnvironment({ ...local, [name]: value }), { message: "LOCAL_FINANCE_RETENTION_CONFIGURATION_INVALID" });
  for (const args of [["--queues=all"], ["--schedulers=all"], ["--execute=true"]])
    assert.throws(() => financeRetentionEnvironment(local, args), { message: "LOCAL_FINANCE_RETENTION_CONFIGURATION_INVALID" });
});
test("finance privacy environment preserves synthetic isolated endpoints and does not add any execution consumer", () => {
  const result = financeRetentionEnvironment(local);
  for (const name of Object.keys(local)) assert.equal(result[name], local[name]);
  assert.deepEqual(result.WORKER_SCHEDULERS.split(","), ["financeCommandRetentionScheduler"]);
  assert.equal(result.WORKER_QUEUES, "none");
});
