import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { inspectP6BrowserReceipt } from "../testing/p6-browser-receipt.mjs";
const nonce = "a".repeat(32), root = path.resolve("synthetic-p6-root");
const expected = { root, candidate: "b".repeat(32), buildId: "fixed-build", exitCode: 0 };
const good = () => ({ browserMode: "compiled", p6KnowledgeAgentBrowser: true, artifactDirectory: path.join(root, "tmp", "order-daily-artifacts-" + nonce),
  outputOwnershipReceipt: path.join(root, "tmp", "order-daily-artifacts-" + nonce, "output-ownership.json"), database: "order_daily_e2e_" + nonce,
  bucket: "order-daily-e2e-" + nonce, redis: "yummyai-daily-" + nonce, databaseDeleted: true, bucketDeleted: true, redisDeleted: true,
  identityServiceClosed: true, operationalCandidatePreserved: true, cleanupErrors: [], browserSandboxDeleted: null, studioRuntime: null,
  webCandidateId: expected.candidate, webBuildId: expected.buildId, testExitCode: 0 });
test("P6 requires the exact personal compiled candidate and complete original teardown", () => {
  assert.deepEqual(inspectP6BrowserReceipt(JSON.stringify(good()), expected), { nonce, teardownVerified: true, exitCode: 0 });
  for (const patch of [{ p6KnowledgeAgentBrowser: false }, { databaseDeleted: false }, { identityServiceClosed: null }, { cleanupErrors: ["retained"] },
    { webCandidateId: "c".repeat(32) }, { webBuildId: "other" }, { database: "daily" }, { testExitCode: 1 }, { artifactDirectory: path.join(root, "foreign") }])
    assert.throws(() => inspectP6BrowserReceipt(JSON.stringify({ ...good(), ...patch }), expected));
  assert.throws(() => inspectP6BrowserReceipt("", expected));
  assert.throws(() => inspectP6BrowserReceipt(JSON.stringify(good()) + "\n" + JSON.stringify(good()), expected));
});
