import { describe, expect, it } from "vitest";
import { StoreNodeExecutionIntentSchema, clearStoreNodeExecutionIntents, forgetStoreNodeExecutionIntent, prepareStoreNodeExecution,
  readStoreNodeExecutionIntents, saveStoreNodeExecutionIntent, storeNodeExecutionOwnerScope, updateStoreNodeExecutionIntent } from "./store-node-execution-intent";
import { executionIds, executionInput, executionStorage, executionWorkspace } from "./store-node-execution.test-fixture";

const marker = () => StoreNodeExecutionIntentSchema.parse({ version: 1, ownerScope: "a".repeat(64), requestId: executionIds.request, requestChecksum: executionInput().requestChecksum,
  executionId: null, state: "prepared", createdAt: "2026-10-22T10:00:00.000Z" });
describe("node execution pure ID intents", () => {
  it("persists exactly seven scalar fields and blocks a new key until the original is explicitly reconciled", () => {
    const storage = executionStorage(), original = saveStoreNodeExecutionIntent(marker(), storage);
    const stored = JSON.parse(storage.getItem(storage.key(0)!)!) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["version", "ownerScope", "requestId", "requestChecksum", "executionId", "state", "createdAt"].sort());
    expect(stored).not.toHaveProperty("input"); expect(stored).not.toHaveProperty("secret");
    expect(() => saveStoreNodeExecutionIntent({ ...original, requestId: executionIds.other }, storage)).toThrow();
    expect(readStoreNodeExecutionIntents(original.ownerScope, storage)).toEqual([original]);
  });
  it("keeps original checksum and IDs through unknown recovery and never resurrects cleared markers", () => {
    const storage = executionStorage(), original = saveStoreNodeExecutionIntent(marker(), storage);
    const unknown = updateStoreNodeExecutionIntent({ ...original, state: "unknown" }, storage);
    expect(() => updateStoreNodeExecutionIntent({ ...unknown, requestChecksum: "f".repeat(64) }, storage)).toThrow();
    const known = updateStoreNodeExecutionIntent({ ...unknown, state: "known", executionId: executionIds.execution }, storage);
    expect(() => updateStoreNodeExecutionIntent({ ...known, executionId: executionIds.other }, storage)).toThrow();
    expect(() => updateStoreNodeExecutionIntent({ ...known, state: "unknown", executionId: null }, storage)).toThrow();
    forgetStoreNodeExecutionIntent(known, storage); expect(readStoreNodeExecutionIntents(known.ownerScope, storage)).toEqual([]);
    expect(() => updateStoreNodeExecutionIntent(known, storage)).toThrow();
  });
  it("isolates owner and account scopes and fails closed on storage failure or corrupted recovery data", async () => {
    expect(await storeNodeExecutionOwnerScope("tenant:actor", executionIds.account)).not.toBe(await storeNodeExecutionOwnerScope("tenant:other", executionIds.account));
    expect(await storeNodeExecutionOwnerScope("tenant:actor", executionIds.account)).not.toBe(await storeNodeExecutionOwnerScope("tenant:actor", executionIds.other));
    const storage = executionStorage(), value = saveStoreNodeExecutionIntent(marker(), storage);
    expect(readStoreNodeExecutionIntents("f".repeat(64), storage)).toEqual([]);
    storage.setItem(storage.key(0)!, JSON.stringify({ ...value, input: "not permitted" }));
    expect(() => readStoreNodeExecutionIntents(value.ownerScope, storage)).toThrow();
    expect(() => saveStoreNodeExecutionIntent(marker(), { ...executionStorage(), setItem() { throw new Error("synthetic storage unavailable"); } })).toThrow();
    clearStoreNodeExecutionIntents(storage); expect(storage.length).toBe(0);
  });
  it("prepares offline tasks with the actual server binding and normalized original synchronization input", async () => {
    const workspace = executionWorkspace(); expect(workspace.binding.online).toBe(false);
    const result = await prepareStoreNodeExecution(workspace, { amazonProductTypes: ["HOME"], etsyTaxonomyNodeIds: [], ttlHours: 24 }, "a".repeat(64));
    expect(result.input.nodeId).toBe(workspace.binding.nodeId); expect(result.input.authorizationGeneration).toBe(workspace.authorizationGeneration);
    expect(result.input.bindingRevision).toBe(3); expect(result.input.certificateGeneration).toBe(2);
    expect(result.intent.requestId).toBe(result.input.requestId); expect(result.intent.requestChecksum).toBe(result.input.requestChecksum);
    workspace.access.canSubmit = false; await expect(prepareStoreNodeExecution(workspace, {}, "a".repeat(64))).rejects.toThrow();
  });
});
