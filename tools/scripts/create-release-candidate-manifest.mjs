import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export async function createReleaseCandidateManifest({
  rootDir,
  outputDir = path.join(rootDir, "output", "release-candidate"),
  commitSha,
  workflowCommitSha = process.env.GITHUB_SHA,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!rootDir) throw new Error("rootDir is required");

  const [packageJson, nodeVersion, migrationJournal] = await Promise.all([
    readJson(path.join(rootDir, "package.json")),
    readFile(path.join(rootDir, ".nvmrc"), "utf8").then((value) => value.trim()),
    readJson(path.join(rootDir, "packages", "database", "migrations", "meta", "_journal.json")),
  ]);
  const suppliedCommit = commitSha ?? workflowCommitSha;
  if (!suppliedCommit && trackedChanges(rootDir)) {
    throw new Error(
      "Tracked worktree changes must be committed before creating a release candidate manifest",
    );
  }
  const resolvedCommit = suppliedCommit ?? gitCommit(rootDir);
  if (!/^[0-9a-f]{40}$/i.test(resolvedCommit))
    throw new Error("A full 40-character commit SHA is required");

  const extensionDir = path.join(rootDir, "apps", "extension", ".output");
  const zipNames = (await readdir(extensionDir)).filter((name) => name.endsWith(".zip")).sort();
  for (const browser of ["chrome", "edge"]) {
    if (!zipNames.some((name) => name.endsWith(`-${browser}.zip`))) {
      throw new Error(`Missing ${browser} extension package`);
    }
  }

  const artifacts = await Promise.all(
    zipNames.map(async (name) => {
      const absolutePath = path.join(extensionDir, name);
      const [bytes, file] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
      return {
        name,
        path: path.relative(rootDir, absolutePath).replaceAll(path.sep, "/"),
        bytes: file.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
  const latestMigration = migrationJournal.entries?.at(-1)?.tag;
  if (typeof latestMigration !== "string" || latestMigration.length === 0) {
    throw new Error("Migration journal has no latest tag");
  }

  const manifest = {
    schemaVersion: 1,
    candidateScope: "code-verification-only",
    authorizedProviderAcceptance: "not-recorded-by-ci",
    commitSha: resolvedCommit.toLowerCase(),
    generatedAt,
    sourceRef: process.env.GITHUB_REF_NAME || null,
    workflowRunId: process.env.GITHUB_RUN_ID || null,
    toolchain: {
      node: nodeVersion,
      pnpm: String(packageJson.packageManager ?? "").replace(/^pnpm@/, ""),
    },
    latestMigration,
    verification: [
      "drizzle-check",
      "lint",
      "typecheck",
      "unit",
      "integration",
      "e2e",
      "build",
      "tracked-secret-scan",
    ],
    artifacts,
  };

  await mkdir(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, "release-candidate-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, manifestPath };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function gitCommit(rootDir) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim();
}

function trackedChanges(rootDir) {
  const generatedFiles = new Set(["apps/web/next-env.d.ts"]);
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: rootDir,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).replaceAll("\\", "/"))
    .some((file) => !generatedFiles.has(file));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { manifestPath } = await createReleaseCandidateManifest({ rootDir: process.cwd() });
  process.stdout.write(`${path.relative(process.cwd(), manifestPath).replaceAll(path.sep, "/")}\n`);
}
