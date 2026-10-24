import { harnessChecksum } from "@yummyai/ai-core";
import type { PodExecutableToolKey } from "@yummyai/contracts";
import { PodCompletionRecordSchema, type PodCompletionRecord, type PodCompletionV1 } from "@yummyai/contracts/pod/completion";
import type { PodMethodSnapshot } from "@yummyai/contracts/harness/methods";
import { assertPodCompletionContract } from "./harness.js";
import { PodOwnerError } from "./errors.js";

export function sealPodCompletion(tool: PodExecutableToolKey, snapshot: PodMethodSnapshot | null, raw: unknown): PodCompletionRecord {
  const evidence = assertPodCompletionContract(tool, snapshot, raw);
  return { evidence, checksum: harnessChecksum(evidence) };
}

/** Read the original technical handoff, independently of subsequent business review. */
export function readPodCompletion(
  task: { id: string; designTaskId: string; toolKey: PodExecutableToolKey; resultVersionId: string | null },
  execution?: { phase: string; inputFingerprint: string; responseChecksum: string | null; methodSnapshot: PodMethodSnapshot | null; completionEvidence: PodCompletionV1 | null; completionChecksum: string | null },
): PodCompletionRecord | null {
  if (!execution || (execution.completionEvidence === null && execution.completionChecksum === null)) return null;
  const record = PodCompletionRecordSchema.safeParse({ evidence: execution.completionEvidence, checksum: execution.completionChecksum });
  if (record.success) {
    const { evidence, checksum } = record.data;
    const expectedMode = execution.methodSnapshot === null ? "legacy_missing"
      : execution.methodSnapshot.executionContract.skill.version === "pod-method-2026-10-18-v1" ? "legacy_owner_view" : "native_completion";
    if (execution.phase === "completed" && harnessChecksum(evidence) === checksum
      && evidence.taskId === task.id && evidence.designTaskId === task.designTaskId && evidence.toolKey === task.toolKey
      && evidence.resultVersionId === task.resultVersionId && evidence.inputFingerprint === execution.inputFingerprint
      && evidence.responseChecksum === execution.responseChecksum
      && evidence.methodContractChecksum === (execution.methodSnapshot?.executionContract.checksum ?? null)
      && evidence.methodValidation === expectedMode) return record.data;
  }
  throw new PodOwnerError("POD_COMPLETION_INVALID", 409, "POD 原始交接记录与执行或文件版本不一致，请核验原记录；不会重建或补造历史证据");
}
