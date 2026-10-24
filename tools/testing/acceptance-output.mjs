import path from "node:path";
import process from "node:process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";

const fail = code => { throw new Error("Acceptance output: " + code); };
const same = (left, right) => path.relative(left, right) === "";
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
const overlaps = (left, right) => left === right || inside(left, right) || inside(right, left);

async function withoutLinks(root, target) {
  for (let cursor = target;; cursor = path.dirname(cursor)) {
    try {
      const item = await lstat(cursor);
      if (item.isSymbolicLink()) fail("linked_path");
      if (cursor !== target && !item.isDirectory()) fail("parent_not_directory");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (same(cursor, root)) break;
    if (path.dirname(cursor) === cursor) fail("outside_workspace");
  }
}

async function requireFresh(target) {
  try { await lstat(target); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  fail("output_already_exists");
}

async function historicalProtectedPaths(root) {
  const statePath = path.join(root, "docs/project-control/state.json");
  let state;
  try { await withoutLinks(root, statePath); state = JSON.parse(await readFile(statePath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const latestRejection = state.cleanupPolicy?.latestPolicyRejection;
  const relative = typeof latestRejection === "string" ? latestRejection : latestRejection?.record;
  if (!relative) return [];
  const record = path.resolve(root, relative), boundary = path.join(root, "docs/project-control/checkpoints");
  if (!inside(boundary, record)) fail("invalid_protected_path_record");
  await withoutLinks(root, record);
  const value = JSON.parse(await readFile(record, "utf8"));
  if (!Array.isArray(value.cumulativeRejectedPaths) || value.cumulativeRejectedPaths.some(item => typeof item !== "string")) fail("invalid_protected_paths");
  return value.cumulativeRejectedPaths.filter(item => path.isAbsolute(item));
}

/** The fixture runner owns one fresh cache leaf and the effective Playwright
 * output. Planning rejects existing/protected paths before creating either. */
export async function prepareAcceptanceOutput({ workspace, token, requestedRoot, args = [], protectedPaths = [] }) {
  if (!/^[a-f0-9]{32}$/.test(token) || !Array.isArray(args)) fail("invalid_identity");
  const root = await realpath(workspace), temporary = path.join(root, "tmp");
  const parent = requestedRoot ? path.resolve(root, requestedRoot) : temporary;
  if (!same(parent, temporary) && !inside(temporary, parent)) fail("outside_temporary_workspace");
  const artifactDirectory = path.join(parent, "order-daily-artifacts-" + token);
  const forwardedArgs = [];
  let explicitOutput;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (typeof argument !== "string") fail("invalid_arguments");
    if (argument === "--last-failed" || argument === "--last-failed-file" || argument.startsWith("--last-failed-file=")) fail("fresh_run_required");
    if (argument !== "--output" && !argument.startsWith("--output=")) { forwardedArgs.push(argument); continue; }
    if (explicitOutput !== undefined) fail("duplicate_output_argument");
    explicitOutput = argument === "--output" ? args[++index] : argument.slice("--output=".length);
    if (typeof explicitOutput !== "string" || !explicitOutput.trim() || explicitOutput.startsWith("--")) fail("invalid_output_argument");
  }
  const browserOutputDirectory = explicitOutput === undefined ? path.join(artifactDirectory, "playwright") : path.resolve(root, explicitOutput);
  if (!inside(temporary, browserOutputDirectory)) fail("outside_temporary_workspace");
  if (browserOutputDirectory === artifactDirectory || inside(browserOutputDirectory, artifactDirectory)) fail("output_contains_cache_root");
  const blocked = [...protectedPaths, ...await historicalProtectedPaths(root)].map(item => path.resolve(root, item));
  const fold = value => process.platform === "win32" ? value.toLowerCase() : value;
  for (const target of [artifactDirectory, browserOutputDirectory]) {
    if (blocked.some(item => overlaps(fold(item), fold(target)))) fail("protected_path");
    await withoutLinks(root, target);
    await requireFresh(target);
  }
  await mkdir(parent, { recursive: true });
  await withoutLinks(root, artifactDirectory);
  await mkdir(artifactDirectory); // No overwrite or cleanup of an existing run.
  const receiptPath = path.join(artifactDirectory, "output-ownership.json");
  await writeFile(receiptPath, JSON.stringify({ version: 1, token, createdAt: new Date().toISOString(),
    artifactDirectory, browserOutputDirectory, browserOutputExplicit: explicitOutput !== undefined,
    protectedPathCount: blocked.length, scope: "standard runner caches and Playwright artifacts; not arbitrary test-code file writes",
  }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return {
    artifactDirectory, browserOutputDirectory, receiptPath, forwardedArgs,
    browserArgs: [...forwardedArgs, "--output", browserOutputDirectory],
    environment: {
      PWTEST_CACHE_DIR: path.join(artifactDirectory, "playwright-transform-cache"),
      TSX_DISABLE_CACHE: "1",
      PLAYWRIGHT_LAST_RUN_OUTPUT_FILE: path.join(browserOutputDirectory, ".last-run.json"),
      PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(artifactDirectory, "reports/html"),
      PLAYWRIGHT_HTML_OPEN: "never",
      PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(artifactDirectory, "reports/results.json"),
      PLAYWRIGHT_JUNIT_OUTPUT_FILE: path.join(artifactDirectory, "reports/results.xml"),
      PLAYWRIGHT_BLOB_OUTPUT_DIR: path.join(artifactDirectory, "reports/blob"),
      PLAYWRIGHT_BLOB_OUTPUT_FILE: path.join(artifactDirectory, "reports/blob/report.zip"),
    },
  };
}
