import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

export const P2_BROWSER_SUITES = Object.freeze([
  "creative-response-adoption-browser", "studio-paid-image-browser", "creative-owner-response-adoption-browser",
]);
const browserMetadata = Object.freeze({
  "creative-response-adoption-browser": "creativeResponseAdoptionBrowser",
  "studio-paid-image-browser": "studioPaidImageBrowser",
  "creative-owner-response-adoption-browser": "creativeOwnerResponseAdoptionBrowser",
});
const samePath = (left, right) => process.platform === "win32"
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);

export function collectP2BrowserChild(child, sinks = {}) {
  assert(child.stdout && child.stderr, "P2_BROWSER_CHILD_PIPES_REQUIRED");
  return new Promise((resolve, reject) => {
    const chunks = [];
    child.stdout.on("data", data => { chunks.push(data); sinks.stdout?.(data); });
    child.stderr.on("data", data => { sinks.stderr?.(data); });
    child.stdout.once("error", reject); child.stderr.once("error", reject); child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal, stdout: Buffer.concat(chunks).toString("utf8") }));
  });
}

// A failing assertion may be collected only after the original runner proves
// complete teardown. Missing, partial or mismatched receipts stop the lane.
export function inspectP2BrowserSuiteResult(suite, exitCode, output, expected) {
  assert(P2_BROWSER_SUITES.includes(suite), "P2_BROWSER_UNKNOWN_SUITE");
  assert(Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255, "P2_BROWSER_ABNORMAL_CHILD_EXIT");
  const rows = output.split(/\r?\n/).flatMap(line => {
    try { const value = JSON.parse(line); return value?.browserMode === "compiled" && Object.hasOwn(value, "testExitCode") ? [value] : []; }
    catch { return []; }
  });
  assert.equal(rows.length, 1, "P2_BROWSER_EXACT_TEARDOWN_RECEIPT_REQUIRED");
  const manifest = rows[0];
  const selectedMetadata = manifest[browserMetadata[suite]];
  assert(selectedMetadata && typeof selectedMetadata.family === "string" && selectedMetadata.family.length > 0
    && selectedMetadata.driverVersion === "1.61.1", "P2_BROWSER_SUITE_METADATA_REQUIRED");
  for (const other of P2_BROWSER_SUITES.filter(value => value !== suite))
    assert.equal(manifest[browserMetadata[other]], null, "P2_BROWSER_OTHER_SUITE_METADATA");
  const nonce = path.basename(manifest.artifactDirectory).replace(/^order-daily-artifacts-/, "");
  assert.match(nonce, /^[a-f0-9]{32}$/, "P2_BROWSER_INVALID_RESOURCE_OWNER");
  const directory = path.join(expected.root, "tmp", "order-daily-artifacts-" + nonce);
  assert(samePath(manifest.artifactDirectory, directory), "P2_BROWSER_FOREIGN_OUTPUT_ROOT");
  assert(samePath(manifest.outputOwnershipReceipt, path.join(directory, "output-ownership.json")), "P2_BROWSER_FOREIGN_OWNERSHIP_RECEIPT");
  assert.equal(manifest.database, "order_daily_e2e_" + nonce, "P2_BROWSER_FOREIGN_DATABASE");
  assert.equal(manifest.bucket, "order-daily-e2e-" + nonce, "P2_BROWSER_FOREIGN_BUCKET");
  assert.equal(manifest.redis, "yummyai-daily-" + nonce, "P2_BROWSER_FOREIGN_REDIS");
  for (const field of ["databaseDeleted", "bucketDeleted", "redisDeleted", "identityServiceClosed", "operationalCandidatePreserved"])
    assert.equal(manifest[field], true, "P2_BROWSER_INCOMPLETE_TEARDOWN_" + field);
  assert.deepEqual(manifest.cleanupErrors, [], "P2_BROWSER_TEARDOWN_ERRORS");
  assert.equal(manifest.browserSandboxDeleted, null, "P2_BROWSER_UNEXPECTED_DEV_SANDBOX");
  assert.equal(manifest.studioRuntime?.closed, true, "P2_BROWSER_STUDIO_NOT_CLOSED");
  assert.equal(manifest.studioRuntime.bundleId, expected.studioBundleId, "P2_BROWSER_STUDIO_CHANGED");
  assert.equal(manifest.webCandidateId, expected.candidate, "P2_BROWSER_CANDIDATE_CHANGED");
  assert.equal(manifest.webBuildId, expected.buildId, "P2_BROWSER_BUILD_CHANGED");
  assert.equal(manifest.testExitCode, exitCode, "P2_BROWSER_EXIT_RECEIPT_MISMATCH");
  return { suite, exitCode, teardownVerified: true, nonce,
    manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") };
}

export function p2BrowserSuitesPassed(results) {
  assert.equal(results.length, P2_BROWSER_SUITES.length, "P2_BROWSER_ALL_SUITES_REQUIRED");
  assert.deepEqual(results.map(result => result.suite), P2_BROWSER_SUITES, "P2_BROWSER_EXACT_SUITE_ORDER_REQUIRED");
  assert(results.every(result => result.teardownVerified === true && Number.isInteger(result.exitCode)), "P2_BROWSER_UNVERIFIED_SUITE_RESULT");
  assert(results.every(result => /^[a-f0-9]{32}$/.test(result.nonce)) && new Set(results.map(result => result.nonce)).size === P2_BROWSER_SUITES.length,
    "P2_BROWSER_INDEPENDENT_RESOURCE_OWNERS_REQUIRED");
  return results.every(result => result.exitCode === 0);
}
