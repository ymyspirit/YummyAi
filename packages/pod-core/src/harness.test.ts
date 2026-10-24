import { describe, expect, it } from "vitest";
import { CreatePodArtworkTaskInputSchema, createEntityId, PodExecutableToolKeySchema } from "@yummyai/contracts";
import { PodMethodSnapshotSchema } from "@yummyai/contracts/harness/methods";
import { podHarness, registeredPodMethods } from "./harness.js";
import { podExecutionFingerprint } from "./execution.js";

describe("native POD method contracts", () => {
  it("registers every existing tool with separate code-owned methods and review boundaries", () => {
    const methods = registeredPodMethods();
    expect(methods).toHaveLength(PodExecutableToolKeySchema.options.length);
    expect(new Set(methods.map(m => m.methodKey)).size).toBe(methods.length);
    for (const method of methods) {
      expect(method.executionContract.executorKey).toBe("pod_artwork");
      expect(method.tools[0]).toMatchObject({ owner: "pod_owner", effect: "external_request", approval: "owning_business_flow", recovery: "original_child_task" });
      expect(method.instructions).toContain("不得用方法说明修改制造参数");
    }
  });
  it("rejects caller-supplied governance pins and another tool's execution contract", () => {
    const binding = podHarness("pattern_crop"), contract = binding.registry.pin(binding.skill);
    const input = { idempotencyKey: createEntityId(), skuId: createEntityId(), title: "Synthetic", toolKey: "pattern_crop", inputAssetIds: [createEntityId()], parameterSnapshot: { mode: "general", multiCrop: false, maximumCropsPerInput: 1, outputFormat: "png", background: "preserved", perspectiveCorrection: true, cropPaddingPercent: 2 } };
    expect(CreatePodArtworkTaskInputSchema.safeParse({ ...input, methodSnapshot: {} }).success).toBe(false);
    expect(() => binding.registry.checkInput(contract,binding.skill,binding.toolKey,input)).not.toThrow();
    const other = podHarness("print_extract");
    expect(() => binding.registry.assertCurrent(other.registry.pin(other.skill),binding.skill)).toThrow();
  });
  it("binds a new method pin into the fingerprint while keeping a missing historical pin missing", () => {
    const binding = podHarness("pattern_crop"), executionContract = binding.registry.pin(binding.skill);
    const snapshot = PodMethodSnapshotSchema.parse({ schemaVersion: "pod-method-snapshot-v1", executionContract, methodSelection: { schemaVersion: "agent-method-selection-v1", mode: "builtin", methodKey: binding.skill.key, contractChecksum: executionContract.checksum, withdrawalGeneration: 0 } });
    const input = { id: createEntityId(), designTaskId: createEntityId(), toolKey: "pattern_crop", parameterSnapshot: {}, inputAssets: [] };
    expect(podExecutionFingerprint(input)).toBe(podExecutionFingerprint({ ...input, methodSnapshot: null }));
    expect(podExecutionFingerprint({ ...input, methodSnapshot: snapshot })).not.toBe(podExecutionFingerprint(input));
    expect(podExecutionFingerprint({ ...input, methodSnapshot: snapshot })).not.toBe(podExecutionFingerprint({ ...input, methodSnapshot: { ...snapshot, methodSelection: { ...snapshot.methodSelection, withdrawalGeneration: 1 } } }));
  });
});
