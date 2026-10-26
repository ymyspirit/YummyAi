import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";

const samePath = (left, right) => process.platform === "win32" ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
export function inspectP6BrowserReceipt(output, expected) {
  assert(Number.isInteger(expected.exitCode) && expected.exitCode >= 0 && expected.exitCode <= 255, "P6_BROWSER_EXIT_INVALID");
  const rows = output.split(/\r?\n/).flatMap(line => {
    try { const value = JSON.parse(line); return value?.browserMode === "compiled" && Object.hasOwn(value, "testExitCode") ? [value] : []; }
    catch { return []; }
  });
  assert.equal(rows.length, 1, "P6_BROWSER_EXACT_RECEIPT_REQUIRED");
  const value = rows[0]; assert.equal(value.p6KnowledgeAgentBrowser, true, "P6_BROWSER_WRONG_SUITE");
  const nonce = path.basename(value.artifactDirectory).replace(/^order-daily-artifacts-/, "");
  assert.match(nonce, /^[a-f0-9]{32}$/, "P6_BROWSER_NONCE_INVALID");
  const owned = path.join(expected.root, "tmp", "order-daily-artifacts-" + nonce);
  assert(samePath(value.artifactDirectory, owned), "P6_BROWSER_FOREIGN_OUTPUT");
  assert(samePath(value.outputOwnershipReceipt, path.join(owned, "output-ownership.json")), "P6_BROWSER_FOREIGN_RECEIPT");
  assert.equal(value.database, "order_daily_e2e_" + nonce); assert.equal(value.bucket, "order-daily-e2e-" + nonce);
  assert.equal(value.redis, "yummyai-daily-" + nonce);
  for (const field of ["databaseDeleted", "bucketDeleted", "redisDeleted", "identityServiceClosed", "operationalCandidatePreserved"])
    assert.equal(value[field], true, "P6_BROWSER_TEARDOWN_INCOMPLETE_" + field);
  assert.deepEqual(value.cleanupErrors, []); assert.equal(value.browserSandboxDeleted, null);
  if (value.studioRuntime !== null) assert.equal(value.studioRuntime.closed, true, "P6_BROWSER_STUDIO_NOT_CLOSED");
  assert.equal(value.webCandidateId, expected.candidate); assert.equal(value.webBuildId, expected.buildId);
  assert.equal(value.testExitCode, expected.exitCode);
  return { nonce, teardownVerified: true, exitCode: value.testExitCode };
}
