import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setImmediate } from "node:timers";
import { collectP2BrowserChild, inspectP2BrowserSuiteResult, p2BrowserSuitesPassed, P2_BROWSER_SUITES } from "../testing/p2-browser-suite-results.mjs";

function fixture(exitCode = 0) {
  const nonce = "a".repeat(32), root = path.resolve("synthetic-p2-no-files"), directory = path.join(root, "tmp", "order-daily-artifacts-" + nonce);
  const expected = { root, candidate: "b".repeat(32), buildId: "synthetic-build", studioBundleId: "c".repeat(64) };
  const manifest = { browserMode: "compiled", artifactDirectory: directory, outputOwnershipReceipt: path.join(directory, "output-ownership.json"),
    database: "order_daily_e2e_" + nonce, bucket: "order-daily-e2e-" + nonce, redis: "yummyai-daily-" + nonce,
    databaseDeleted: true, bucketDeleted: true, redisDeleted: true, identityServiceClosed: true, operationalCandidatePreserved: true,
    cleanupErrors: [], browserSandboxDeleted: null, studioRuntime: { closed: true, bundleId: expected.studioBundleId },
    webCandidateId: expected.candidate, webBuildId: expected.buildId, testExitCode: exitCode,
    creativeResponseAdoptionBrowser: { family: "synthetic_pinned_browser", driverVersion: "1.61.1" }, studioPaidImageBrowser: null, creativeOwnerResponseAdoptionBrowser: null };
  return { manifest, expected, inspect: () => inspectP2BrowserSuiteResult(P2_BROWSER_SUITES[0], exitCode, "synthetic test output\n" + JSON.stringify(manifest) + "\n", expected) };
}

test("successful and failed assertions retain their original exit after complete exact teardown", () => {
  for (const code of [0, 1]) { const f = fixture(code), result = f.inspect(); assert.equal(result.exitCode, code); assert.equal(result.teardownVerified, true); }
});
test("any missing resource, identity, Studio or candidate cleanup stops collection", () => {
  for (const field of ["databaseDeleted", "bucketDeleted", "redisDeleted", "identityServiceClosed", "operationalCandidatePreserved"]) {
    const f = fixture(1); f.manifest[field] = false; assert.throws(f.inspect, /P2_BROWSER_INCOMPLETE_TEARDOWN/);
  }
  const errors = fixture(1); errors.manifest.cleanupErrors.push("synthetic"); assert.throws(errors.inspect, /P2_BROWSER_TEARDOWN_ERRORS/);
  const studio = fixture(1); studio.manifest.studioRuntime.closed = false; assert.throws(studio.inspect, /P2_BROWSER_STUDIO_NOT_CLOSED/);
});
test("receipt failure, wrong exit and ambiguous or missing manifests never permit continuation", () => {
  const f = fixture(1); f.manifest.testExitCode = 0; assert.throws(f.inspect, /P2_BROWSER_EXIT_RECEIPT_MISMATCH/);
  for (const code of [null, -1, 1.2, 256]) assert.throws(() => inspectP2BrowserSuiteResult(P2_BROWSER_SUITES[0], code, "", f.expected), /P2_BROWSER_ABNORMAL_CHILD_EXIT/);
  assert.throws(() => inspectP2BrowserSuiteResult(P2_BROWSER_SUITES[0], 0, "not a receipt", f.expected), /P2_BROWSER_EXACT_TEARDOWN_RECEIPT_REQUIRED/);
  const good = fixture(); assert.throws(() => inspectP2BrowserSuiteResult(P2_BROWSER_SUITES[0], 0, [JSON.stringify(good.manifest), JSON.stringify(good.manifest)].join("\n"), good.expected), /P2_BROWSER_EXACT_TEARDOWN_RECEIPT_REQUIRED/);
});
test("foreign paths, owners, compiled build and Studio identities reject", () => {
  for (const [field, value] of [["artifactDirectory", path.resolve("foreign")], ["outputOwnershipReceipt", path.resolve("foreign.json")],
    ["database", "foreign"], ["bucket", "foreign"], ["redis", "foreign"], ["webCandidateId", "foreign"], ["webBuildId", "foreign"]]) {
    const f = fixture(); f.manifest[field] = value; assert.throws(f.inspect);
  }
  const studio = fixture(); studio.manifest.studioRuntime.bundleId = "foreign"; assert.throws(studio.inspect, /P2_BROWSER_STUDIO_CHANGED/);
  const dev = fixture(); dev.manifest.browserSandboxDeleted = true; assert.throws(dev.inspect, /P2_BROWSER_UNEXPECTED_DEV_SANDBOX/);
});
test("the final gate fails for every failing family even when all resources closed", () => {
  for (let failed = 0; failed < P2_BROWSER_SUITES.length; failed++) {
    const results = P2_BROWSER_SUITES.map((suite, index) => ({ suite, exitCode: index === failed ? 1 : 0, teardownVerified: true, nonce: String(index + 1).repeat(32) }));
    assert.equal(p2BrowserSuitesPassed(results), false);
  }
  assert.equal(p2BrowserSuitesPassed(P2_BROWSER_SUITES.map((suite, i) => ({ suite, exitCode: 0, teardownVerified: true, nonce: String(i + 1).repeat(32) }))), true);
});
test("missing, duplicated, reordered and unverified families cannot report success", () => {
  const complete = P2_BROWSER_SUITES.map((suite, i) => ({ suite, exitCode: 0, teardownVerified: true, nonce: String(i + 1).repeat(32) }));
  assert.throws(() => p2BrowserSuitesPassed(complete.slice(0, 2)), /P2_BROWSER_ALL_SUITES_REQUIRED/);
  assert.throws(() => p2BrowserSuitesPassed([complete[0], complete[0], complete[2]]), /P2_BROWSER_EXACT_SUITE_ORDER_REQUIRED/);
  assert.throws(() => p2BrowserSuitesPassed([...complete].reverse()), /P2_BROWSER_EXACT_SUITE_ORDER_REQUIRED/);
  assert.throws(() => p2BrowserSuitesPassed(complete.map((row, i) => i ? row : { ...row, teardownVerified: false })), /P2_BROWSER_UNVERIFIED_SUITE_RESULT/);
});
test("separate suites cannot reuse one disposable resource owner", () => {
  assert.throws(() => p2BrowserSuitesPassed(P2_BROWSER_SUITES.map(suite => ({ suite, exitCode: 0, teardownVerified: true, nonce: "a".repeat(32) }))), /P2_BROWSER_INDEPENDENT_RESOURCE_OWNERS_REQUIRED/);
});
test("child exit cannot finish receipt capture before close or mix stderr into UTF8 stdout", async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const forwarded = [], warnings = [], bytes = Buffer.from('{"evidence":"原始读取"}\n');
  let resolved = false;
  const pending = collectP2BrowserChild(child, { stdout: data => forwarded.push(data), stderr: data => warnings.push(data) });
  void pending.then(() => { resolved = true; });
  child.emit("exit", 1, null); await new Promise(resolve => setImmediate(resolve)); assert.equal(resolved, false);
  child.stdout.write(bytes.subarray(0, 16)); child.stderr.write("synthetic diagnostic\n"); child.stdout.end(bytes.subarray(16)); child.stderr.end();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(resolved, false);
  child.emit("close", 1, null); const result = await pending;
  assert.equal(result.exitCode, 1); assert.equal(result.signal, null); assert.equal(result.stdout, bytes.toString("utf8"));
  assert.equal(Buffer.concat(forwarded).toString("utf8"), bytes.toString("utf8")); assert.equal(Buffer.concat(warnings).toString("utf8"), "synthetic diagnostic\n");
});
test("a child startup error rejects collection without inventing a teardown receipt", async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const pending = collectP2BrowserChild(child); child.emit("error", new Error("SYNTHETIC_SPAWN_FAILED"));
  await assert.rejects(pending, /SYNTHETIC_SPAWN_FAILED/); child.stdout.end(); child.stderr.end();
});
test("a different browser family cannot substitute its teardown", () => {
  const f = fixture(); f.manifest.studioPaidImageBrowser = f.manifest.creativeResponseAdoptionBrowser;
  assert.throws(f.inspect, /P2_BROWSER_OTHER_SUITE_METADATA/);
  f.manifest.creativeResponseAdoptionBrowser = null; assert.throws(f.inspect, /P2_BROWSER_SUITE_METADATA_REQUIRED/);
});
