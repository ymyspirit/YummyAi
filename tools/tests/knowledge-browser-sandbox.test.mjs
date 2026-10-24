import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  createKnowledgeBrowserSandbox,
  cleanupKnowledgeBrowserSandbox,
} from "../testing/knowledge-browser-sandbox.mts";

test("snapshot cleanup rejects invalid identity and purpose before filesystem mutation", async () => {
  for (const token of ["", "..", "../owned", "A".repeat(32), "a".repeat(31)])
    await assert.rejects(cleanupKnowledgeBrowserSandbox(token), /Invalid/);
  await assert.rejects(cleanupKnowledgeBrowserSandbox("a".repeat(32), "../private"), /Invalid/);
  for (const port of [0, 65536, 3122.5])
    await assert.rejects(createKnowledgeBrowserSandbox("a".repeat(32), port), /Invalid/);
});

test("interrupted snapshot cleanup removes its own files and preserves junction targets and shared sources", async () => {
  const token = randomUUID().replaceAll("-", ""),
    root = resolve("tmp", "knowledge-web-" + token),
    sentinel = resolve("tmp", "knowledge-cleanup-target-" + token),
    scratch = resolve("tmp");
  assert.ok(root.startsWith(scratch + sep) && sentinel.startsWith(scratch + sep));
  const source = await readFile("apps/web/package.json");
  try {
    const snapshot = await createKnowledgeBrowserSandbox(token);
    await mkdir(sentinel, { recursive: true });
    await writeFile(resolve(sentinel, "keep.txt"), "owned target survives");
    await symlink(sentinel, resolve(root, "target-junction"), "junction");
    await writeFile(resolve(root, "transient-test.txt"), "temporary");
    await assert.rejects(access(resolve(root, ".env")), (error) => error.code === "ENOENT");
    await cleanupKnowledgeBrowserSandbox(token);
    await assert.rejects(access(root), (error) => error.code === "ENOENT");
    assert.equal(await readFile(resolve(sentinel, "keep.txt"), "utf8"), "owned target survives");
    assert.deepEqual(await readFile("apps/web/package.json"), source);
    await snapshot.cleanup();
  } finally {
    await cleanupKnowledgeBrowserSandbox(token);
    assert.ok(
      sentinel.startsWith(scratch + sep) && sentinel.endsWith("knowledge-cleanup-target-" + token),
      "Unsafe test teardown",
    );
    await rm(sentinel, { recursive: true, force: true });
  }
});
