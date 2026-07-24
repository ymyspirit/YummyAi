import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createReleaseCandidateManifest } from "../scripts/create-release-candidate-manifest.mjs";

test("creates a commit-bound manifest for Chrome and Edge packages", async () => {
  const rootDir = await fixtureRoot();
  const result = await createReleaseCandidateManifest({
    rootDir,
    commitSha: "a".repeat(40),
    generatedAt: "2026-07-24T12:00:00.000Z",
  });
  const stored = JSON.parse(await readFile(result.manifestPath, "utf8"));

  assert.equal(stored.commitSha, "a".repeat(40));
  assert.equal(stored.latestMigration, "0038_p1_quota_telemetry");
  assert.equal(stored.candidateScope, "code-verification-only");
  assert.equal(stored.authorizedProviderAcceptance, "not-recorded-by-ci");
  assert.deepEqual(
    stored.artifacts.map((artifact) => artifact.name),
    ["yummyai-0.0.0-chrome.zip", "yummyai-0.0.0-edge.zip"],
  );
  assert.match(stored.artifacts[0].sha256, /^[0-9a-f]{64}$/);
});

test("fails closed when an Edge package is missing", async () => {
  const rootDir = await fixtureRoot({ includeEdge: false });
  await assert.rejects(
    createReleaseCandidateManifest({ rootDir, commitSha: "b".repeat(40) }),
    /Missing edge extension package/,
  );
});

test("fails closed when local tracked source changes are present", async () => {
  const rootDir = await fixtureRoot();
  git(rootDir, ["init"]);
  git(rootDir, ["config", "user.email", "release-test@example.test"]);
  git(rootDir, ["config", "user.name", "Release Test"]);
  git(rootDir, ["add", "."]);
  git(rootDir, ["commit", "-m", "fixture"]);
  await writeFile(
    path.join(rootDir, "package.json"),
    JSON.stringify({ packageManager: "pnpm@11.10.1" }),
  );

  await assert.rejects(
    createReleaseCandidateManifest({ rootDir, workflowCommitSha: null }),
    /Tracked worktree changes must be committed/,
  );
});

async function fixtureRoot({ includeEdge = true } = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "yummyai-release-"));
  const extensionDir = path.join(rootDir, "apps", "extension", ".output");
  const migrationDir = path.join(rootDir, "packages", "database", "migrations", "meta");
  await Promise.all([
    mkdir(extensionDir, { recursive: true }),
    mkdir(migrationDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(rootDir, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.10.0" }),
    ),
    writeFile(path.join(rootDir, ".nvmrc"), "24.17.0\n"),
    writeFile(
      path.join(migrationDir, "_journal.json"),
      JSON.stringify({ entries: [{ tag: "0038_p1_quota_telemetry" }] }),
    ),
    writeFile(path.join(extensionDir, "yummyai-0.0.0-chrome.zip"), "chrome-package"),
    ...(includeEdge
      ? [writeFile(path.join(extensionDir, "yummyai-0.0.0-edge.zip"), "edge-package")]
      : []),
  ]);
  return rootDir;
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
