import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { captureRuntimeSource } from "./database-upgrade.mts";
import { verifyLocalWebCandidate } from "./local-web-candidate.mjs";
import { collectP2BrowserChild } from "../testing/p2-browser-suite-results.mjs";
import { inspectP6BrowserReceipt } from "../testing/p6-browser-receipt.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
assert(process.argv.length === 2 || process.argv.length === 3 && /^--candidate=[a-f0-9]{32}$/.test(process.argv[2]), "P6_BROWSER_ARGUMENTS_INVALID");
// CI reuses the already validated immutable creative candidate. Local acceptance
// can name an explicitly prepared candidate; neither mode silently rebuilds it.
const prior = process.argv.length === 2
  ? JSON.parse(await readFile(path.join(root, "output/p2-creative-browser/conclusion.json"), "utf8")) : null;
if (prior) assert(prior.passed === true && prior.compiled === true, "P6_BROWSER_PRIOR_CANDIDATE_UNVERIFIED");
const candidate = prior?.candidate ?? process.argv[2].slice("--candidate=".length);
const built = await verifyLocalWebCandidate(root, candidate), source = await captureRuntimeSource(root);
assert.equal(source.sha256, built.manifest.sourceSha256, "P6_BROWSER_SOURCE_CHANGED");
if (prior) {
  assert.equal(prior.sourceSha256, source.sha256, "P6_BROWSER_PRIOR_SOURCE_CHANGED");
  assert.equal(prior.buildId, built.manifest.buildId, "P6_BROWSER_PRIOR_BUILD_CHANGED");
}
const child = spawn(process.execPath, ["--env-file=.env", "--import", pathToFileURL(path.join(root, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
  path.join(root, "tools/scripts/run-order-daily-acceptance.mts"), "--suite=p6-knowledge-agent-browser", "--compiled-web", `--candidate=${candidate}`], {
  cwd: root, env: { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: path.join(root, "apps/api/tsconfig.json") },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
const result = await collectP2BrowserChild(child, { stdout: data => process.stdout.write(data), stderr: data => process.stderr.write(data) });
assert.equal(result.signal, null, "P6_BROWSER_CHILD_SIGNAL");
const receipt = inspectP6BrowserReceipt(result.stdout, { root, candidate, buildId: built.manifest.buildId, exitCode: result.exitCode });
assert.equal((await captureRuntimeSource(root)).sha256, source.sha256, "P6_BROWSER_SOURCE_CHANGED_DURING_TEST");
assert.equal((await verifyLocalWebCandidate(root, candidate)).manifest.sourceSha256, source.sha256, "P6_BROWSER_CANDIDATE_CHANGED_DURING_TEST");
const output = path.join(root, "output/p6-knowledge-agent-browser", receipt.nonce); await mkdir(output, { recursive: true });
await writeFile(path.join(output, "conclusion.json"), JSON.stringify({ version: 1, candidate, buildId: built.manifest.buildId, sourceSha256: source.sha256,
  ...receipt, passed: result.exitCode === 0, compiled: true, realPaidCalls: 0, ordinaryWorkerStarted: false,
  receiptSha256: createHash("sha256").update(JSON.stringify(receipt)).digest("hex") }, null, 2) + "\n", { flag: "wx" });
assert.equal(result.exitCode, 0, "P6_BROWSER_TEST_FAILURE");
