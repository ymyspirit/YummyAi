import assert from "node:assert/strict";
import test from "node:test";
import { materialRetentionEnvironment } from "../scripts/material-retention-runtime.mjs";

import { incomingRetentionEnvironment } from "../scripts/incoming-retention-runtime.mjs";

const local = { DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:5432/local",
  REDIS_URL: "redis://localhost:6379", S3_ENDPOINT: "http://127.0.0.1:9000" };

for (const [configure, scheduler, failure] of [
  [materialRetentionEnvironment, "materialCommandRetentionScheduler", "LOCAL_MATERIAL_RETENTION_CONFIGURATION_INVALID"],
  [incomingRetentionEnvironment, "incomingCommandRetentionScheduler", "LOCAL_INCOMING_RETENTION_CONFIGURATION_INVALID"],
]) {
test(scheduler + " maintenance fixes an empty consumer plan despite broad inherited Worker settings", () => {
  const input = { ...local, WORKER_QUEUES: "all", WORKER_SCHEDULERS: "all", TSX_DISABLE_CACHE: "0" };
  const result = configure(input);
  assert.equal(result.WORKER_QUEUES, "none"); assert.equal(result.WORKER_SCHEDULERS, scheduler);
  assert.equal(result.NODE_ENV, "production"); assert.equal(result.TSX_DISABLE_CACHE, "1");
  assert.equal(input.WORKER_QUEUES, "all");
});

test(scheduler + " remote or malformed resources and capability arguments fail before application import", () => {
  for (const key of Object.keys(local)) for (const value of [undefined, "invalid", local[key].replace(/127\.0\.0\.1|localhost/, "erp.example"), local[key] + "?sensitive=value"]) {
    assert.throws(() => configure({ ...local, [key]: value }), { message: failure });
  }
  assert.throws(() => configure(local, ["--queues=all"]), { message: failure });
});

}
