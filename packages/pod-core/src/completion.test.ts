import { describe, expect, it } from "vitest";
import { harnessChecksum } from "@yummyai/ai-core";
import { createEntityId, PodArtworkTaskViewSchema } from "@yummyai/contracts";
import { PodMethodSnapshotSchema } from "@yummyai/contracts/harness/methods";
import { PodProcessorResultV1Schema } from "@yummyai/contracts/pod/processor-result";
import { z } from "zod";
import { podHarness, supportedPodMethods } from "./harness.js";
import { readPodCompletion, sealPodCompletion } from "./completion.js";

function fixture(legacy = false) {
  const binding = podHarness("pattern_crop");
  const executionContract = legacy ? supportedPodMethods().find(method => method.methodKey === binding.skill.key && method.executionContract.skill.version.endsWith("-v1"))!.executionContract : binding.registry.pin(binding.skill);
  const methodSnapshot = PodMethodSnapshotSchema.parse({ schemaVersion: "pod-method-snapshot-v1", executionContract,
    methodSelection: { schemaVersion: "agent-method-selection-v1", mode: "builtin", methodKey: binding.skill.key, contractChecksum: executionContract.checksum, withdrawalGeneration: 0 } });
  const task = { id: createEntityId(), designTaskId: createEntityId(), toolKey: "pattern_crop" as const, resultVersionId: createEntityId() };
  const evidence = { contractVersion: "pod-completion-v1", taskId: task.id, designTaskId: task.designTaskId, toolKey: task.toolKey,
    inputFingerprint: "a".repeat(64), methodContractChecksum: executionContract.checksum, methodValidation: legacy ? "legacy_owner_view" : "native_completion",
    responseChecksum: "b".repeat(64), decodedWith: "pod-processor-result-v1", resultVersionId: task.resultVersionId, resultState: "awaiting_review",
    qualityCheckChecksum: "c".repeat(64), outputs: [{ ordinal: 0, assetId: createEntityId(), assetVersion: 1, checksumSha256: "d".repeat(64), byteSize: 30, mediaType: "image/png", role: "effect" }],
    requiresBusinessReview: true, automaticProductionApproval: false };
  const record = sealPodCompletion(task.toolKey, methodSnapshot, evidence);
  const execution = { phase: "completed", inputFingerprint: evidence.inputFingerprint, responseChecksum: evidence.responseChecksum, methodSnapshot, completionEvidence: record.evidence, completionChecksum: record.checksum };
  return { task, evidence, methodSnapshot, record, execution };
}

describe("original POD completion contracts", () => {
  it("seals actual output identity without coupling methods to operator task views", () => {
    const f = fixture(), tool = podHarness(f.task.toolKey).registry.describeSkill(podHarness(f.task.toolKey).skill).tools[0]!;
    expect(tool.outputSchemaKey).toBe("pod.completion-v1");
    expect(tool.outputSchemaChecksum).not.toBe(harnessChecksum(z.toJSONSchema(PodArtworkTaskViewSchema)));
    expect(readPodCompletion(f.task, f.execution)).toEqual(f.record);
    expect(readPodCompletion({ ...f.task, status: "approved" } as typeof f.task, f.execution)).toEqual(f.record);
  });
  it("rejects changed original execution, result identity and checksum instead of rebuilding evidence", () => {
    const f = fixture();
    for (const patch of [{ responseChecksum: "0".repeat(64) }, { inputFingerprint: "0".repeat(64) }, { phase: "response_ready" }, { completionChecksum: "0".repeat(64) }])
      expect(() => readPodCompletion(f.task, { ...f.execution, ...patch })).toThrow(/原始交接/);
    expect(() => readPodCompletion({ ...f.task, resultVersionId: createEntityId() }, f.execution)).toThrow(/原始交接/);
    expect(() => readPodCompletion(f.task, { ...f.execution, completionEvidence: { ...f.record.evidence, outputs: [{ ...f.record.evidence.outputs[0]!, assetId: createEntityId() }] } })).toThrow(/原始交接/);
    expect(readPodCompletion(f.task)).toBeNull();
    expect(readPodCompletion(f.task, { ...f.execution, completionEvidence: null, completionChecksum: null })).toBeNull();
    expect(() => readPodCompletion(f.task, { ...f.execution, completionEvidence: null })).toThrow(/原始交接/);
  });
  it("requires contiguous unique files, original method presence and an explicit business review", () => {
    const f = fixture();
    for (const patch of [{ outputs: [] }, { outputs: [f.evidence.outputs[0], f.evidence.outputs[0]] },
      { outputs: [{ ...f.evidence.outputs[0], ordinal: 1 }] }, { automaticProductionApproval: true }, { requiresBusinessReview: false },
      { methodContractChecksum: null }, { methodValidation: "legacy_owner_view" }, { storageObjectKey: "private/original" }])
      expect(() => sealPodCompletion(f.task.toolKey, f.methodSnapshot, { ...f.evidence, ...patch })).toThrow();
    expect(sealPodCompletion(f.task.toolKey, f.methodSnapshot, { ...f.evidence, resultState: "blocked" }).evidence.resultState).toBe("blocked");
  });
  it("keeps frozen v1 contracts supported across UI changes and labels their original owner boundary", () => {
    const f = fixture(true);
    expect(supportedPodMethods().filter(method => method.executionContract.skill.version.endsWith("-v1"))).toHaveLength(31);
    expect(supportedPodMethods().find(method => method.executionContract.checksum === f.methodSnapshot.executionContract.checksum)?.tools[0]?.outputSchemaKey).toBe("pod.artwork-task-view");
    expect(readPodCompletion(f.task, f.execution)?.evidence.methodValidation).toBe("legacy_owner_view");
    expect(() => sealPodCompletion(f.task.toolKey, f.methodSnapshot, { ...f.evidence, methodValidation: "native_completion" })).toThrow();
    expect(() => sealPodCompletion(f.task.toolKey, { ...f.methodSnapshot, executionContract: { ...f.methodSnapshot.executionContract, checksum: "0".repeat(64) } }, f.evidence)).toThrow();
    const missing = sealPodCompletion(f.task.toolKey, null, { ...f.evidence, methodContractChecksum: null, methodValidation: "legacy_missing" });
    expect(missing.evidence.methodContractChecksum).toBeNull();
  });
  it("validates the original processor wire format independently of completion and view fields", () => {
    const wire = { outputs: [{ dataBase64: "AQID", fileName: "original.png", mediaType: "image/png", role: "effect", metadata: { width: 1, height: 1, unit: "px", colorMode: "rgb", transparent: false, aiInference: "none" } }], modelKey: "synthetic", modelVersion: "v1", costUsd: 0.023, qualityCheckSnapshot: { passed: true } };
    expect(PodProcessorResultV1Schema.safeParse(wire).success).toBe(true);
    expect(PodProcessorResultV1Schema.safeParse({ ...wire, completion: fixture().record }).success).toBe(false);
    expect(PodProcessorResultV1Schema.safeParse({ ...wire, outputs: [{ ...wire.outputs[0], metadata: { width: 1 } }] }).success).toBe(false);
  });
});
