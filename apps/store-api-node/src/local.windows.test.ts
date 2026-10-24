import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseStoreNodeConfiguration } from "./config.js";
import { noLinks, withStoreNodeLock } from "./storage.js";

const passphrase = "synthetic-store-node-passphrase-for-unit";

async function withOwnedDirectory(label: string, action: (directory: string) => Promise<void>) {
  const parent = path.resolve(tmpdir()), prefix = `yummyai-store-node-${label}-`;
  await noLinks(parent);
  const directory = await mkdtemp(path.join(parent, prefix));
  try { await action(directory); }
  finally {
    expect(path.dirname(directory)).toBe(parent);
    expect(path.basename(directory).startsWith(prefix)).toBe(true);
    await noLinks(directory);
    expect((await lstat(directory)).isDirectory()).toBe(true);
    // The only junction created by these cases must already have been unlinked.
    for (const entry of await readdir(directory, { withFileTypes: true })) expect(entry.isSymbolicLink()).toBe(false);
    await rm(directory, { recursive: true, force: false });
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  }
}

// These cases exercise the real platform gate and Windows ACL/FileShare.None helper.
// The package config excludes this file on other platforms; nothing spoofs win32.
describe("store node Windows local boundary", () => {
  it("requires explicit bounded arguments and keeps credentials out of arguments", async () => {
    await withOwnedDirectory("arguments", async directory => {
      const dir = `--dir=${directory}`;
      const value = parseStoreNodeConfiguration(["run", dir, "--interval-ms=1000"], { STORE_NODE_KEY_PASSPHRASE: passphrase });
      expect(value.operation).toBe("run"); expect(value.intervalMs).toBe(1000);
      for (const args of [["run", dir, `--dir=${path.join(directory, "other")}`], ["run", dir, "--token=synthetic-secret"],
        ["init", dir, "--interval-ms=1000"], ["enroll", dir], ["run", "--dir=relative"]])
        expect(() => parseStoreNodeConfiguration(args, { STORE_NODE_KEY_PASSPHRASE: passphrase })).toThrow(/^store_node_/);
      expect(() => parseStoreNodeConfiguration(["init", dir], { STORE_NODE_KEY_PASSPHRASE: "short" })).toThrow("store_node_passphrase_invalid");
    });
  });

  it("enables work explicitly without changing heartbeat run or accepting app secrets in arguments", async () => {
    await withOwnedDirectory("work-arguments", async directory => {
      const args = [`--dir=${directory}`, "--interval-ms=1000"];
      expect(parseStoreNodeConfiguration(["work", ...args], { STORE_NODE_KEY_PASSPHRASE: passphrase }).operation).toBe("work");
      expect(parseStoreNodeConfiguration(["run", ...args], { STORE_NODE_KEY_PASSPHRASE: passphrase }).operation).toBe("run");
      for (const extra of ["--etsy-secret=synthetic-secret", "--amazon-client-secret=synthetic-secret", "--amazon-app-client-id=synthetic-client",
        "--platform-url=https://synthetic.invalid", "--interval-ms=1000"])
        expect(() => parseStoreNodeConfiguration(["work", ...args, extra], { STORE_NODE_KEY_PASSPHRASE: passphrase })).toThrow("store_node_arguments_invalid");
    });
  });

  it("commits ciphertext under the Windows OS lock and safely reopens the same protected directory", async () => {
    await withOwnedDirectory("identity", async directory => {
      await withStoreNodeLock(directory, async lock => { await lock.commit(Buffer.from("synthetic-cipher-v1")); lock.assertHeld(); });
      await withStoreNodeLock(directory, async lock => { await lock.commit(Buffer.from("synthetic-cipher-v2")); lock.assertHeld(); });
      expect(await readFile(path.join(directory, "state.pe"), "utf8")).toBe("synthetic-cipher-v2");
    });
  }, 30000);

  it("serializes heartbeat and journal replacements under one Windows OS lock", async () => {
    await withOwnedDirectory("execution", async directory => {
      await withStoreNodeLock(directory, async lock => {
        await Promise.all([lock.commit(Buffer.from("synthetic-heartbeat-1")), lock.commitJournal(Buffer.from("synthetic-journal-1"))]);
        await Promise.all([lock.commitJournal(Buffer.from("synthetic-journal-2")), lock.commit(Buffer.from("synthetic-heartbeat-2"))]);
        lock.assertHeld();
      });
      expect(await readFile(path.join(directory, "state.pe"), "utf8")).toBe("synthetic-heartbeat-2");
      expect(await readFile(path.join(directory, "execution.pe"), "utf8")).toBe("synthetic-journal-2");
    });
  }, 30000);

  it("rejects an ancestor junction even when its absolute caller path uses forward slashes", async () => {
    await withOwnedDirectory("junction", async directory => {
      const target = path.join(directory, "target"), link = path.join(directory, "alias");
      try {
        await mkdir(target); await symlink(target, link, "junction");
        await expect(noLinks(path.join(link, "not-present").replace(/\\/g, "/"))).rejects.toThrow("store_node_storage_unavailable");
      } finally {
        const linked = await lstat(link).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
        if (linked) {
          expect(linked.isSymbolicLink()).toBe(true);
          expect(path.toNamespacedPath(path.resolve(path.dirname(link), await readlink(link)))).toBe(path.toNamespacedPath(target));
          await unlink(link);
        }
      }
    });
  });
});
