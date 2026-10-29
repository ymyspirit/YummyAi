import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { captureRuntimeSource } from "./database-upgrade.mts";
import { canvasRuntimeSourceStamp } from "./build-canvas-runtime.mjs";
import { verifyLocalWebCandidate } from "./local-web-candidate.mjs";
import { verifyStudioRuntime } from "./serve-studio-runtime.mjs";
import { collectP2BrowserChild } from "../testing/p2-browser-suite-results.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const suite = "studio-configuration-browser";
const samePath = (left, right) => process.platform === "win32"
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);
assert(process.argv.length === 2 || process.argv.length === 3 && /^--candidate=[a-f0-9]{32}$/.test(process.argv[2]),
  "STUDIO_CONFIGURATION_BROWSER_ARGUMENTS_INVALID");

// CI reuses the exact compiled candidate and sealed iframe already accepted by
// P2. Local use must supply both artifacts explicitly; this entry never builds.
const prior = process.argv.length === 2
  ? JSON.parse(await readFile(path.join(root, "output/p2-creative-browser/conclusion.json"), "utf8")) : null;
if (prior) assert(prior.passed === true && prior.compiled === true, "STUDIO_CONFIGURATION_BROWSER_PRIOR_UNVERIFIED");
const candidate = prior?.candidate ?? process.argv[2].slice("--candidate=".length);
assert.match(candidate, /^[a-f0-9]{32}$/, "STUDIO_CONFIGURATION_BROWSER_CANDIDATE_INVALID");
if (prior) assert.match(prior.studioBundleId, /^[a-f0-9]{64}$/, "STUDIO_CONFIGURATION_BROWSER_PRIOR_STUDIO_INVALID");
const manifestPath = prior
  ? path.join(root, ".artifacts/studio-runtime-releases", prior.studioBundleId, "manifest.json")
  : process.env.E2E_STUDIO_RUNTIME_MANIFEST;
assert(typeof manifestPath === "string" && path.isAbsolute(manifestPath), "STUDIO_CONFIGURATION_BROWSER_SEALED_RUNTIME_REQUIRED");
const built = await verifyLocalWebCandidate(root, candidate), source = await captureRuntimeSource(root);
assert.equal(source.sha256, built.manifest.sourceSha256, "STUDIO_CONFIGURATION_BROWSER_SOURCE_CHANGED");
const studio = await verifyStudioRuntime(manifestPath);
assert.equal(studio.manifest.sourceStamp, await canvasRuntimeSourceStamp(), "STUDIO_CONFIGURATION_BROWSER_STUDIO_SOURCE_CHANGED");
if (prior) {
  assert.equal(prior.sourceSha256, source.sha256, "STUDIO_CONFIGURATION_BROWSER_PRIOR_SOURCE_CHANGED");
  assert.equal(prior.buildId, built.manifest.buildId, "STUDIO_CONFIGURATION_BROWSER_PRIOR_BUILD_CHANGED");
  assert.equal(prior.studioBundleId, studio.id, "STUDIO_CONFIGURATION_BROWSER_PRIOR_STUDIO_CHANGED");
}

const child = spawn(process.execPath, ["--env-file-if-exists=.env", "--import",
  pathToFileURL(path.join(root, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
  path.join(root, "tools/scripts/run-order-daily-acceptance.mts"), `--suite=${suite}`, "--compiled-web", `--candidate=${candidate}`], {
  cwd: root,
  env: { ...process.env, E2E_STUDIO_RUNTIME_MANIFEST: studio.manifestPath,
    NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: path.join(root, "apps/api/tsconfig.json") },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
const result = await collectP2BrowserChild(child, { stdout: data => process.stdout.write(data), stderr: data => process.stderr.write(data) });
assert.equal(result.signal, null, "STUDIO_CONFIGURATION_BROWSER_CHILD_SIGNAL");
assert(Number.isInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 255, "STUDIO_CONFIGURATION_BROWSER_CHILD_EXIT_INVALID");
const receipts = result.stdout.split(/\r?\n/).flatMap(line => {
  try { const value = JSON.parse(line); return value?.browserMode === "compiled" && Object.hasOwn(value, "testExitCode") ? [value] : []; }
  catch { return []; }
});
assert.equal(receipts.length, 1, "STUDIO_CONFIGURATION_BROWSER_EXACT_RECEIPT_REQUIRED");
const receipt = receipts[0];
assert.equal(receipt.studioConfigurationBrowser, true, "STUDIO_CONFIGURATION_BROWSER_WRONG_SUITE");
const nonce = path.basename(receipt.artifactDirectory).replace(/^order-daily-artifacts-/, "");
assert.match(nonce, /^[a-f0-9]{32}$/, "STUDIO_CONFIGURATION_BROWSER_NONCE_INVALID");
const owned = path.join(root, "tmp", "order-daily-artifacts-" + nonce);
assert(samePath(receipt.artifactDirectory, owned), "STUDIO_CONFIGURATION_BROWSER_FOREIGN_OUTPUT");
assert(samePath(receipt.outputOwnershipReceipt, path.join(owned, "output-ownership.json")), "STUDIO_CONFIGURATION_BROWSER_FOREIGN_RECEIPT");
assert(samePath(receipt.browserOutputDirectory, path.join(owned, "playwright")), "STUDIO_CONFIGURATION_BROWSER_FOREIGN_BROWSER_OUTPUT");
assert.equal(receipt.database, "order_daily_e2e_" + nonce);
assert.equal(receipt.bucket, "order-daily-e2e-" + nonce);
assert.equal(receipt.redis, "yummyai-daily-" + nonce);
for (const field of ["databaseDeleted", "bucketDeleted", "redisDeleted", "identityServiceClosed", "operationalCandidatePreserved"])
  assert.equal(receipt[field], true, "STUDIO_CONFIGURATION_BROWSER_TEARDOWN_INCOMPLETE_" + field);
assert.deepEqual(receipt.cleanupErrors, [], "STUDIO_CONFIGURATION_BROWSER_TEARDOWN_ERRORS");
assert.equal(receipt.browserSandboxDeleted, null);
assert.equal(receipt.studioRuntime?.closed, true, "STUDIO_CONFIGURATION_BROWSER_STUDIO_NOT_CLOSED");
assert.equal(receipt.studioRuntime.bundleId, studio.id, "STUDIO_CONFIGURATION_BROWSER_STUDIO_CHANGED");
assert.equal(receipt.studioRuntime.sourceStamp, studio.manifest.sourceStamp, "STUDIO_CONFIGURATION_BROWSER_STUDIO_SOURCE_CHANGED");
assert.equal(receipt.webCandidateId, candidate, "STUDIO_CONFIGURATION_BROWSER_RECEIPT_CANDIDATE_CHANGED");
assert.equal(receipt.webBuildId, built.manifest.buildId, "STUDIO_CONFIGURATION_BROWSER_RECEIPT_BUILD_CHANGED");
assert.equal(receipt.testExitCode, result.exitCode, "STUDIO_CONFIGURATION_BROWSER_EXIT_RECEIPT_MISMATCH");

assert.equal((await captureRuntimeSource(root)).sha256, source.sha256, "STUDIO_CONFIGURATION_BROWSER_SOURCE_CHANGED_DURING_TEST");
const after = await verifyLocalWebCandidate(root, candidate);
assert.equal(after.manifest.sourceSha256, source.sha256, "STUDIO_CONFIGURATION_BROWSER_CANDIDATE_CHANGED_DURING_TEST");
assert.equal(after.manifest.buildId, built.manifest.buildId, "STUDIO_CONFIGURATION_BROWSER_BUILD_CHANGED_DURING_TEST");
const afterStudio = await verifyStudioRuntime(studio.manifestPath);
assert.equal(afterStudio.id, studio.id, "STUDIO_CONFIGURATION_BROWSER_STUDIO_CHANGED_DURING_TEST");
assert.equal(afterStudio.manifest.sourceStamp, await canvasRuntimeSourceStamp(), "STUDIO_CONFIGURATION_BROWSER_STUDIO_SOURCE_CHANGED_DURING_TEST");

const output = path.join(root, "output/studio-configuration-browser", nonce);
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "conclusion.json"), JSON.stringify({ version: 1, suite, nonce, candidate,
  buildId: built.manifest.buildId, sourceSha256: source.sha256, studioBundleId: studio.id,
  studioSourceStamp: studio.manifest.sourceStamp, compiled: true, passed: result.exitCode === 0,
  exitCode: result.exitCode, teardownVerified: true, configurationHttpBoundary: "synthetic_fixture",
  assistModelsHttpBoundary: "synthetic_fixture", realPaidCalls: 0, ordinaryWorkerStarted: false,
  receiptSha256: createHash("sha256").update(JSON.stringify(receipt)).digest("hex") }, null, 2) + "\n", { flag: "wx" });
assert.equal(result.exitCode, 0, "STUDIO_CONFIGURATION_BROWSER_TEST_FAILURE");
