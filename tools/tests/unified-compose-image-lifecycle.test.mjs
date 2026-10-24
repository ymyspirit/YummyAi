import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { resolveAppImageRecovery, withAppImageMaintenance } from "../scripts/unified-compose-image-lifecycle.mjs";

// Synthetic two-file maintenance states only. No filesystem, Docker, credential,
// database, process, or provider participates in snapshot recovery. The last
// case uses one ephemeral loopback reservation and closes it in every path.
const sha = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n").digest("hex");
function state(pin) {
  const model = { services: { sub2api: { image: pin, environment: { SYNTHETIC_VALUE: "$literal" } } } };
  return { model, manifest: { version: 1, project: "yummyai", baselineSha256: "a".repeat(64), runtimeSha256: sha(model) } };
}
function fixture() {
  return { version: 1, id: "00000000-0000-4000-8000-000000000001", operation: "adopt-image",
    before: state("weishaw/sub2api:v1"), after: state("weishaw/sub2api@sha256:" + "b".repeat(64)) };
}
const hashes = value => ({ runtimeSha256: sha(value.model), manifestSha256: sha(value.manifest) });

test("recovery resumes either exact side after no writes, either partial write, or both writes", () => {
  const journal = fixture(), original = globalThis.structuredClone(journal), before = hashes(journal.before), after = hashes(journal.after);
  for (const runtimeSha256 of [before.runtimeSha256, after.runtimeSha256])
    for (const manifestSha256 of [before.manifestSha256, after.manifestSha256])
      for (const use of ["before", "after"]) {
        const selected = resolveAppImageRecovery(journal, { runtimeSha256, manifestSha256 }, use);
        assert.deepEqual(selected, journal[use]); assert.notEqual(selected, journal[use]);
        selected.model.services.sub2api.image = "SYNTHETIC_CHANGED_LOCAL_COPY";
      }
  assert.deepEqual(journal, original);
});
test("recovery refuses external runtime or manifest edits before selecting either snapshot", () => {
  const journal = fixture(), original = hashes(journal.before);
  for (const current of [{ ...original, runtimeSha256: "c".repeat(64) }, { ...original, manifestSha256: "c".repeat(64) }])
    assert.throws(() => resolveAppImageRecovery(journal, current, "after"), /^Error: UNIFIED_COMPOSE_IMAGE_RECOVERY_EXTERNAL_CHANGE$/);
});
test("recovery preserves the immutable original baseline even for a known runtime state", () => {
  const journal = fixture(); journal.after.manifest.baselineSha256 = "d".repeat(64);
  assert.throws(() => resolveAppImageRecovery(journal, hashes(journal.before), "before"), /^Error: UNIFIED_COMPOSE_IMAGE_ORIGINAL_BASELINE_CHANGED$/);
});
test("corrupt snapshot hash, invalid identity, operation and selection never become accepted recovery", () => {
  for (const mutate of [value => { value.after.manifest.runtimeSha256 = "e".repeat(64); }, value => { value.id = "../foreign"; },
    value => { value.version = 2; }, value => { value.operation = "reset-database"; }, value => { value.after.manifest.project = "foreign"; }]) {
    const journal = fixture(); mutate(journal);
    assert.throws(() => resolveAppImageRecovery(journal, hashes(journal.before), "after"), /^Error: UNIFIED_COMPOSE_IMAGE_TRANSITION_INVALID$/);
  }
  const journal = fixture();
  assert.throws(() => resolveAppImageRecovery(journal, hashes(journal.before), "unknown"), /^Error: UNIFIED_COMPOSE_IMAGE_TRANSITION_INVALID$/);
});
test("maintenance serializes competing recoveries and releases its reservation on both success and failure", async () => {
  let release, acquired;
  const blocked = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { acquired = resolve; });
  const first = withAppImageMaintenance(async port => { acquired(port); await blocked; return "first"; }, { port: 0 });
  const port = await ready;
  try {
    await assert.rejects(withAppImageMaintenance(() => assert.fail("competing recovery entered critical section"), { port }),
      /^Error: UNIFIED_COMPOSE_IMAGE_MAINTENANCE_LOCK_UNAVAILABLE$/);
  } finally { release(); await first; }
  await assert.rejects(withAppImageMaintenance(() => { throw new Error("SYNTHETIC_OPERATION_FAILED"); }, { port }),
    /^Error: SYNTHETIC_OPERATION_FAILED$/);
  assert.equal(await withAppImageMaintenance(() => "released", { port }), "released");
});
