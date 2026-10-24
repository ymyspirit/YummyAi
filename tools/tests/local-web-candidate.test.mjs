import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { completeLocalWebCandidate, parseWebCandidateArgs, prepareLocalWebCandidate, verifyLocalWebCandidate, verifyWebSource } from "../scripts/local-web-candidate.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const workspace = process.cwd();
const identities = [];

async function fixture() {
  const id = randomUUID().replaceAll("-", "");
  const root = path.resolve(workspace, "tmp", "web-candidate-fixture-" + id);
  identities.push({ id, root });
  const inputs = {
    "package.json": "{}", "pnpm-lock.yaml": "lockfileVersion: 9", "pnpm-workspace.yaml": "packages: []", "tsconfig.base.json": "{}",
    "apps/web/package.json": "{}", "apps/web/tsconfig.json": "{}", "apps/web/next-env.d.ts": "export {}",
    "apps/web/next.config.ts": "export default {}", "apps/web/src/app/layout.tsx": "export default function Layout() {}",
    "packages/contracts/src/index.ts": "export {}", "apps/web/public/plugins/bridge.js": "original public bytes",
    "patches/synthetic.patch": "synthetic dependency correction",
    "node_modules/sentinel": "root dependencies survive", "apps/web/node_modules/next/package.json": '{"version":"16.2.10"}',
  };
  for (const [name, value] of Object.entries(inputs)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), value);
  }
  await writeFile(path.join(root, ".env"), "PRIVATE=never-copy-this");
  const files = Object.entries(inputs).filter(([name]) => !name.includes("node_modules") && !name.includes("/public/")).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ path: name, bytes: Buffer.byteLength(value), sha256: sha(value) }));
  return { root, id, source: { files, sha256: sha(JSON.stringify(files)) } };
}

async function completed() {
  const input = await fixture(), candidate = await prepareLocalWebCandidate(input.root, input.id, input.source);
  for (const [name, value] of Object.entries({ ".next/BUILD_ID": "candidate-build", ".next/required-server-files.json": "{}", ".next/server/app-paths-manifest.json": "{}", ".next/static/app.js": "compiled" })) {
    await mkdir(path.dirname(path.join(candidate.web, name)), { recursive: true });
    await writeFile(path.join(candidate.web, name), value);
  }
  return { ...input, candidate, completed: await completeLocalWebCandidate(candidate) };
}

test.after(async () => {
  for (const { id, root } of identities) {
    assert.equal(root, path.resolve(workspace, "tmp", "web-candidate-fixture-" + id));
    assert.match(id, /^[a-f0-9]{32}$/);
    await rm(root, { recursive: true, force: true });
    await assert.rejects(readFile(path.join(root, "package.json")), { code: "ENOENT" });
  }
});

test("candidate arguments cannot become arbitrary paths or leak into Next CLI arguments", () => {
  const id = "a".repeat(32);
  assert.deepEqual(parseWebCandidateArgs(["--hostname", "127.0.0.1", "--candidate=" + id, "--port", "3000"]), { id, nextArgs: ["--hostname", "127.0.0.1", "--port", "3000"] });
  for (const args of [["--candidate"], ["--candidate", "../private"], ["--candidate", id, "--candidate=" + id]])
    assert.throws(() => parseWebCandidateArgs(args), /identity/);
});

test("every personal compiled browser suite uses the explicitly selected candidate", () => {
  const program = `
    import assert from 'node:assert/strict';
    const names = ['erp-identity','teams','product-access','listing-authority','sales-plan-session','sales-plan-references','sales-package-history','channel-mapping','sales-composition','sales-editor-lifecycle','catalog-editor','factory-directory','specification-facts','quality-assessment','manufacturing'];
    for (const name of names) {
      const {default: config} = await import('./apps/web/playwright.' + name + '.config.ts');
      const web = config.webServer.filter(server => !String(server.url).includes(':8130'));
      assert.equal(web.length, 1, name);
      assert.equal(web[0].command, process.env.KNOWLEDGE_BROWSER_COMMAND, name + ' command');
      assert.equal(web[0].cwd, process.env.KNOWLEDGE_BROWSER_CWD, name + ' cwd');
    }
  `;
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(path.join(workspace, "apps/api/node_modules/tsx/dist/loader.mjs")).href, "--input-type=module", "-e", program], {
    cwd: workspace, encoding: "utf8", timeout: 15000, windowsHide: true,
    env: {
      ...process.env, E2E_COMPILED_WEB: "1", E2E_ISOLATED_DAILY: "1",
      DATABASE_URL: "postgres://invalid.invalid:1/order_daily_e2e_" + "a".repeat(32),
      S3_PRIVATE_BUCKET: "order-daily-e2e-" + "a".repeat(32),
      KNOWLEDGE_BROWSER_COMMAND: "node selected-candidate --port 3130",
      KNOWLEDGE_BROWSER_CWD: path.join(workspace, ".artifacts", "synthetic candidate with spaces"),
    },
  });
  assert.equal(result.status, 0, result.stderr);
});

test("source changes, traversal, links and environment files fail before candidate creation", async () => {
  const input = await fixture();
  await writeFile(path.join(input.root, "apps/web/src/app/layout.tsx"), "changed");
  await assert.rejects(prepareLocalWebCandidate(input.root, input.id, input.source), /source_changed/);
  for (const name of ["../private", "C:/private", "apps/web/.env", "apps\\web\\file", "apps//file"]) {
    const files = [{ path: name, sha256: sha("ignored") }];
    await assert.rejects(verifyWebSource(input.root, { files, sha256: sha(JSON.stringify(files)) }), /invalid_relative_file/);
  }
  const linkInput = await fixture();
  await symlink(path.join(linkInput.root, "packages"), path.join(linkInput.root, "linked-packages"), "junction");
  const files = [{ path: "linked-packages/contracts/src/index.ts", sha256: sha("export {}") }];
  await assert.rejects(verifyWebSource(linkInput.root, { files, sha256: sha(JSON.stringify(files)) }), /source_not_regular/);
});

test("staging keeps environment and previous builds out, freezes public files and never overwrites an operation", async () => {
  const input = await fixture();
  await mkdir(path.join(input.root, "apps/web/.next"));
  await writeFile(path.join(input.root, "apps/web/.next/BUILD_ID"), "previous");
  const candidate = await prepareLocalWebCandidate(input.root, input.id, input.source);
  assert.equal(await readFile(path.join(candidate.target, "patches/synthetic.patch"), "utf8"), "synthetic dependency correction");
  await assert.rejects(readFile(path.join(candidate.target, ".env")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(candidate.web, ".next/BUILD_ID")), { code: "ENOENT" });
  await writeFile(path.join(input.root, "apps/web/public/plugins/bridge.js"), "later source public");
  assert.equal(await readFile(path.join(candidate.web, "public/plugins/bridge.js"), "utf8"), "original public bytes");
  await assert.rejects(prepareLocalWebCandidate(input.root, input.id, input.source), { code: "EEXIST" });
  assert.equal(await readFile(path.join(input.root, "apps/web/.next/BUILD_ID"), "utf8"), "previous");
});

test("a verified built artifact survives later source edits but rejects runtime, public or dependency drift", async () => {
  const input = await completed();
  await writeFile(path.join(input.root, "apps/web/src/app/layout.tsx"), "later source change");
  assert.equal((await verifyLocalWebCandidate(input.root, input.id)).manifest.buildId, "candidate-build");
  const asset = path.join(input.candidate.web, "public/plugins/bridge.js");
  await writeFile(asset, "tampered");
  await assert.rejects(verifyLocalWebCandidate(input.root, input.id), /artifact_changed/);
  await writeFile(asset, "original public bytes");
  const lock = path.join(input.root, "pnpm-lock.yaml");
  await writeFile(lock, "another dependency graph");
  await assert.rejects(verifyLocalWebCandidate(input.root, input.id), /dependencies_changed/);
  await writeFile(lock, "lockfileVersion: 9");
  const patch = path.join(input.root, "patches/synthetic.patch");
  await writeFile(patch, "changed dependency correction");
  await assert.rejects(verifyLocalWebCandidate(input.root, input.id), /dependency_patch_changed/);
  await writeFile(patch, "synthetic dependency correction");
  const frozenPatch = path.join(input.candidate.target, "patches/synthetic.patch");
  await writeFile(frozenPatch, "tampered frozen correction");
  await assert.rejects(verifyLocalWebCandidate(input.root, input.id), /dependency_patch_changed/);
  await writeFile(frozenPatch, "synthetic dependency correction");
  const bundle = path.join(input.candidate.web, ".next/static/app.js");
  await writeFile(bundle, "wrong compiled bytes");
  await assert.rejects(verifyLocalWebCandidate(input.root, input.id), /artifact_changed/);
  assert.equal(await readFile(path.join(input.root, "node_modules/sentinel"), "utf8"), "root dependencies survive");
});

test("a candidate cannot be sealed from changed build inputs or a missing build", async () => {
  const input = await fixture(), candidate = await prepareLocalWebCandidate(input.root, input.id, input.source);
  await assert.rejects(completeLocalWebCandidate(candidate), { code: "ENOENT" });
  await writeFile(path.join(input.root, "apps/web/public/plugins/bridge.js"), "changed during compilation");
  await assert.rejects(completeLocalWebCandidate(candidate), /Public build inputs changed/);
});

test("an artifact manifest and required build identity cannot be replaced silently", async () => {
  const input = await completed(), manifestPath = path.join(input.candidate.target, "manifest.json");
  const original = await readFile(manifestPath, "utf8"), manifest = JSON.parse(original);
  manifest.artifacts[0].sha256 = "0".repeat(64);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyLocalWebCandidate(input.root, input.id), /invalid_artifact_manifest/);
  await writeFile(manifestPath, original);
  await writeFile(path.join(input.candidate.web, ".next/BUILD_ID"), "another-build");
  await assert.rejects(verifyLocalWebCandidate(input.root, input.id), /artifact_changed/);
});
