import assert from "node:assert/strict";
import test from "node:test";
import { procurementRetentionEnvironment } from "../scripts/procurement-retention-runtime.mjs";

const local = { DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:5432/local",
  REDIS_URL: "redis://localhost:6379", S3_ENDPOINT: "http://127.0.0.1:9000" };

test("procurement privacy maintenance fixes zero business consumers despite inherited broad Worker configuration", () => {
  const input = { ...local, WORKER_QUEUES: "all", WORKER_SCHEDULERS: "all", NODE_ENV: "development", TSX_DISABLE_CACHE: "0" };
  const configured = procurementRetentionEnvironment(input);
  assert.equal(configured.WORKER_QUEUES, "none");
  assert.equal(configured.WORKER_SCHEDULERS, "procurementCommandRetentionScheduler");
  assert.equal(configured.NODE_ENV, "production");
  assert.equal(configured.TSX_DISABLE_CACHE, "1");
  assert.equal(input.WORKER_QUEUES, "all");
  assert.equal(input.WORKER_SCHEDULERS, "all");
});

test("procurement privacy entry refuses remote, malformed or expanded capabilities before Worker import", () => {
  for (const resource of Object.keys(local)) {
    const rejected = [undefined, "invalid", local[resource].replace(/127\.0\.0\.1|localhost/, "erp.example"),
      local[resource] + "?synthetic=value", local[resource] + "#synthetic"];
    for (const value of rejected) assert.throws(() => procurementRetentionEnvironment({ ...local, [resource]: value }),
      { message: "LOCAL_PROCUREMENT_RETENTION_CONFIGURATION_INVALID" });
  }
  for (const args of [["--queues=all"], ["--schedulers=all"], ["--execute-purchase=true"]])
    assert.throws(() => procurementRetentionEnvironment(local, args), { message: "LOCAL_PROCUREMENT_RETENTION_CONFIGURATION_INVALID" });
});
