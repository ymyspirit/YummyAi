import assert from "node:assert/strict";
import test from "node:test";
import { compareInventory, verifyCanvasUpstream } from "../scripts/canvas-upstream.mjs";

test("reviewed vendor source matches the release lock", async () => {
  const current = await verifyCanvasUpstream();
  assert.equal(current.vendorUnchanged, true);
  assert.match(current.commit, /^[a-f0-9]{40}$/);
  assert.ok(current.fileCount > 0);
});
test("upgrade comparison identifies additions, removals and changed source", () => {
  const before = { "src/storage.ts": { sha256: "a" }, "src/old.ts": { sha256: "b" }, LICENSE: { sha256: "license" } };
  const after = { "src/storage.ts": { sha256: "changed" }, "src/new.ts": { sha256: "c" }, LICENSE: { sha256: "license" } };
  assert.deepEqual(compareInventory(before, after), { added: ["src/new.ts"], removed: ["src/old.ts"], changed: ["src/storage.ts"] });
  assert.deepEqual(compareInventory(before, before), { added: [], removed: [], changed: [] });
});
