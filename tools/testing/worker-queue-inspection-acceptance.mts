import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveWorkspacePath } from "../scripts/backup-restore.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === "--report" && args[1], "A fresh public report path is required");
const reportFile = await resolveWorkspacePath(root, args[1]!, { fresh: true });
const exec = promisify(execFile), requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const Redis = requireWeb("ioredis");
const marker = randomUUID(), name = "yummyai-queue-inspection-" + marker.slice(0, 8);
const password = randomBytes(24).toString("hex"), canary = "synthetic-payload-never-in-audit-output";
const proof: Record<string, unknown> = { recordedAt: new Date().toISOString(), status: "running", fixture: { redis: name }, actualPaidCalls: 0, normalWorkerStarted: false, cases: [], cleanup: { redisDeleted: false } };
const cases: string[] = [];
let id: string | undefined, redis: InstanceType<typeof Redis> | undefined;
let phase = "start_fixture";

try {
  const created = await exec("docker", ["run", "--detach", "--rm", "--name", name, "--label", "yummyai.queue-inspection=" + marker, "--publish", "127.0.0.1::6379", "redis:8-alpine"], { cwd: root, windowsHide: true, timeout: 15000 });
  id = created.stdout.trim(); assert(/^[a-f0-9]{64}$/.test(id), "Fixture container identity required");
  const binding = await exec("docker", ["port", id, "6379/tcp"], { windowsHide: true, timeout: 5000 });
  const port = Number(binding.stdout.trim().split(":").at(-1)); assert(Number.isSafeInteger(port) && port > 0);
  phase = "connect_fixture";
  redis = new Redis({ host: "127.0.0.1", port, lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000, retryStrategy: (attempt: number) => attempt < 5 ? 100 : null });
  redis.on("error", () => undefined); await redis.connect();
  await redis.rpush("bull:media:wait", "synthetic-media-a", "synthetic-media-b");
  await redis.rpush("bull:workflow-node:active", "synthetic-active");
  await redis.rpush("bull:studio-generation:paused", "synthetic-paused");
  await redis.zadd("bull:amazon-order-report-retention:delayed", 1, "synthetic-delayed");
  await redis.zadd("bull:pod-artwork:prioritized", 1, "synthetic-priority");
  await redis.zadd("bull:pod-export:waiting-children", 1, "synthetic-parent");
  await redis.zadd("bull:ai-assist:completed", 1, "synthetic-completed");
  await redis.rpush("bull:not-declared:wait", "foreign-queue");
  await redis.set("bull:media:synthetic-media-a", canary);
  const before = (await redis.keys("*")).sort();
  phase = "restrict_fixture_acl";
  // Mutations now fail at Redis itself, including queue metadata creation.
  await redis.acl("SETUSER", "default", "on", "resetpass", ">" + password, "resetkeys", "~bull:*", "-@all", "+@read", "+@connection");
  const run = async (override: string) => {
    try {
      const result = await exec(process.execPath, ["--import", "./apps/api/node_modules/tsx/dist/loader.mjs", "tools/scripts/inspect-local-worker-queues.mts"], { cwd: root, windowsHide: true, timeout: 12000, env: { ...process.env, REDIS_URL: override } });
      return { ...result, code: 0 };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: failed.code };
    }
  };
  const url = `redis://:${password}@127.0.0.1:${port}/0`, success = await run(url);
  phase = "read_only_inspection";
  proof.childResult = { exitCode: success.code, publicErrorCode: /^[a-z_]+\s*$/.test(success.stderr) ? success.stderr.trim() : "non_code_output", stdoutEmpty: success.stdout.length === 0 };
  assert.equal(success.code, 0, "Read-only Redis credentials must allow inspection");
  const report = JSON.parse(success.stdout);
  assert.equal(report.declaredQueues, 32); assert.equal(report.pendingEntries, 7);
  assert.equal(report.requiresOperationalReview, true); assert.equal(report.workerStartAuthorized, false);
  assert.equal(report.queueConstructorsUsed, false); assert.equal(report.jobPayloadsRead, false);
  assert.equal(report.queues.find((queue: { name: string }) => queue.name === "media").counts.wait, 2);
  assert(!report.queues.some((queue: { name: string }) => queue.name === "not-declared"));
  assert(!success.stdout.includes(canary) && !success.stdout.includes(password) && !success.stderr.includes(password));
  assert.deepEqual((await redis.keys("*")).sort(), before); assert.equal(await redis.get("bull:media:synthetic-media-a"), canary);
  cases.push("real_redis_read_only_acl_all_32_queues_no_payload_or_metadata_writes");
  const mismatch = await run(url.slice(0, -1) + "1");
  assert.equal(mismatch.code, 1); assert.equal(mismatch.stderr.trim(), "queue_inspection_worker_database_mismatch");
  assert.equal(mismatch.stdout, ""); cases.push("different_database_cannot_misrepresent_current_worker_namespace");
  const wrongPassword = await run(`redis://:synthetic-invalid@127.0.0.1:${port}/0`);
  assert.equal(wrongPassword.code, 1); assert.equal(wrongPassword.stderr.trim(), "queue_inspection_failed");
  assert(!wrongPassword.stderr.includes(password) && !wrongPassword.stderr.includes(canary));
  cases.push("redis_authentication_failure_is_bounded_and_redacted");
  proof.status = "pass";
} catch (error) {
  proof.status = "failed"; proof.error = "queue_inspection_acceptance_failed"; proof.failedPhase = phase;
  proof.errorType = error instanceof Error ? error.name : "unknown";
  process.exitCode = 1;
} finally {
  if (redis) { try { await redis.quit(); } catch { /* Docker teardown remains mandatory. */ } finally { redis.disconnect(); } }
  try {
    if (id) {
      const observed = JSON.parse((await exec("docker", ["inspect", id], { windowsHide: true, timeout: 5000 })).stdout)[0];
      assert.equal(observed.Config.Labels["yummyai.queue-inspection"], marker);
      await exec("docker", ["stop", "--timeout", "3", id], { windowsHide: true, timeout: 10000 });
    }
    const remaining = await exec("docker", ["container", "ls", "-aq", "--filter", "label=yummyai.queue-inspection=" + marker], { windowsHide: true, timeout: 5000 });
    assert.equal(remaining.stdout.trim(), "", "Fixture Redis must be independently absent");
    proof.cleanup = { redisDeleted: true };
  } catch {
    proof.status = "failed"; proof.cleanup = { redisDeleted: false, error: "fixture_cleanup_requires_readback" }; process.exitCode = 1;
  }
  proof.cases = cases;
  await fs.mkdir(path.dirname(reportFile), { recursive: true });
  await fs.writeFile(reportFile, JSON.stringify(proof, null, 2) + "\n", { flag: "wx" });
}
process.stdout.write(JSON.stringify({ status: proof.status, casesPassed: cases.length, cleanup: proof.cleanup, actualPaidCalls: 0 }) + "\n");
