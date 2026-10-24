import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { factoryErpRetentionEnvironment } from "../scripts/factory-erp-source-retention-runtime.mjs";

const local = { DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:5432/synthetic",
  REDIS_URL: "redis://localhost:6379", S3_ENDPOINT: "http://127.0.0.1:9000" };
const message = "LOCAL_FACTORY_ERP_RETENTION_CONFIGURATION_INVALID";

test("factory ERP retention fixes one maintenance scheduler and zero consumers despite inherited broad capabilities", () => {
  const input = { ...local, NODE_ENV: "development", TSX_DISABLE_CACHE: "0", WORKER_QUEUES: "all", WORKER_SCHEDULERS: "all" };
  const result = factoryErpRetentionEnvironment(input);
  assert.equal(result.NODE_ENV, "production"); assert.equal(result.TSX_DISABLE_CACHE, "1");
  assert.equal(result.WORKER_QUEUES, "none"); assert.equal(result.WORKER_SCHEDULERS, "factoryErpSourceRetentionScheduler");
  assert.equal(input.WORKER_QUEUES, "all"); assert.equal(input.WORKER_SCHEDULERS, "all");
  for (const name of Object.keys(local)) assert.equal(result[name], local[name]);
});

test("factory ERP retention rejects remote, missing, expanded and malformed infrastructure without loading Worker", () => {
  for (const name of Object.keys(local)) for (const value of [undefined, "invalid", local[name].replace(/127\.0\.0\.1|localhost/, "erp.example"),
    `${local[name]}?synthetic=value`, `${local[name]}#synthetic`])
    assert.throws(() => factoryErpRetentionEnvironment({ ...local, [name]: value }), { message });
  for (const [name, value] of [["S3_ENDPOINT", "http://synthetic:synthetic@127.0.0.1:9000"],
    ["S3_ENDPOINT", "http://127.0.0.1:9000/arbitrary"], ["DATABASE_URL", "postgresql://127.0.0.1:5432/"]])
    assert.throws(() => factoryErpRetentionEnvironment({ ...local, [name]: value }), { message });
  for (const args of [["--queues=all"], ["--schedulers=all"], ["--execute=true"]])
    assert.throws(() => factoryErpRetentionEnvironment(local, args), { message });
});

test("factory ERP retention preserves explicit synthetic loopback addresses without changing the caller environment", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const input = { DATABASE_URL: `postgresql://synthetic:synthetic@${host}:5432/synthetic`,
      REDIS_URL: `redis://${host}:6379`, S3_ENDPOINT: `http://${host}:9000` };
    const before = { ...input }, result = factoryErpRetentionEnvironment(input);
    assert.deepEqual(input, before); assert.equal(result.DATABASE_URL, input.DATABASE_URL);
    assert.deepEqual(result.WORKER_SCHEDULERS.split(","), ["factoryErpSourceRetentionScheduler"]);
  }
});

test("the actual factory ERP entry rejects arguments before importing TypeScript or opening infrastructure", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/factory-erp-source-retention-runtime.mjs", import.meta.url)), "--queues=all"],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...local, TSX_DISABLE_CACHE: "1" } });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 1); assert.equal(stdout, ""); assert.equal(stderr, `${message}\n`);
});
