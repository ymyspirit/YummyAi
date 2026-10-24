import { HarnessContractError } from "@yummyai/ai-core";
import type { PodInvocationReceipt } from "@yummyai/contracts/harness";
import type { CreativeWorkerIdentity } from "./creative-execution-admission.js";
import type { CreativeExecutionRecovery, CreativeExecutionClaim } from "./creative-execution-recovery.js";
import { decodePodResponse, podResultCheckpoint } from "./pod-artwork-response.js";
import type { PodArtworkExecutionRecord, PodArtworkGateway } from "./pod-artwork.processor.js";
import { podInvocationReceipt, podResultChecksum } from "./pod-invocation-receipt.js";

export async function executeCreativePod(recovery: CreativeExecutionRecovery, identity: CreativeWorkerIdentity,
  claim: CreativeExecutionClaim, gateway: PodArtworkGateway, input: PodArtworkExecutionRecord, signal: AbortSignal) {
  if (!claim.hasResponse) {
    await gateway.prepare?.(input); signal.throwIfAborted();
    await recovery.markSubmitted(identity, claim, { taskType: claim.operation.kind, modelKey: input.modelKey ?? `pod:${input.toolKey}`, provider: "pod-processor" });
    let savedReceipt: PodInvocationReceipt | undefined, checkpointSaved = false;
    const result = await gateway.execute(identity, input, signal, async (receipt, checkpoint) => {
      await recovery.record(identity, claim, checkpoint ? { version: "creative-response-v1", kind: "pod", checkpoint } : undefined, receipt);
      savedReceipt = receipt; checkpointSaved = checkpoint !== undefined;
    });
    if (!checkpointSaved) {
      const receipt = savedReceipt ?? podInvocationReceipt(result, podResultChecksum(result));
      await recovery.record(identity, claim, { version: "creative-response-v1", kind: "pod", checkpoint: podResultCheckpoint(result, receipt) }, receipt);
    }
  }
  const response = await recovery.read(identity, claim);
  if (response.kind !== "pod") throw new Error("CREATIVE_RESPONSE_INVALID");
  return decodePodResponse(response.checkpoint);
}

/** Errors crossing queue/log boundaries are selected codes, never provider bodies or private prompts. */
export function creativeFailure(cause: unknown) {
  const status = cause && typeof cause === "object" && "status" in cause ? cause.status : undefined;
  if ([403, 404, 409].includes(Number(status)) || cause instanceof HarnessContractError)
    return { code: "CREATIVE_AUTHORITY_OR_INPUT_CHANGED", permanent: true };
  // These are the owning visual module's explicit source/review invalidations,
  // not transient infrastructure failures. Submitted calls still retain spend.
  if (cause instanceof Error && ["visual_source_changed", "visual_artwork_changed", "visual_review_required"].includes(cause.message))
    return { code: "CREATIVE_AUTHORITY_OR_INPUT_CHANGED", permanent: true };
  const known = new Set(["CREATIVE_RESPONSE_EXPIRED", "CREATIVE_RESPONSE_INVALID", "CREATIVE_RESPONSE_TOO_LARGE", "CREATIVE_INPUT_ASSET_CHANGED",
    "CREATIVE_INPUT_ASSET_MISSING", "CREATIVE_INPUT_ASSET_UNAVAILABLE", "CREATIVE_ARTIFACT_STORAGE_CHANGED", "CREATIVE_ARTIFACT_CHANGED",
    "CREATIVE_LEGACY_AUTHORITY_MISSING", "CREATIVE_ORIGINAL_ACTOR_MISMATCH", "CREATIVE_BUDGET_REQUIRED", "CREATIVE_BUDGET_INVALID",
    "CREATIVE_PRIOR_BUDGET_OVERRUN", "CREATIVE_TASK_BUDGET_EXCEEDED", "CREATIVE_MONTHLY_BUDGET_EXCEEDED", "CREATIVE_ORIGINAL_BUDGET_CHANGED"]);
  if (cause instanceof Error && known.has(cause.message)) return { code: cause.message, permanent: true };
  return { code: "CREATIVE_LOCAL_PROCESSING_FAILED", permanent: false };
}

export function creativeFailureDiagnostic(cause: unknown) {
  const error = cause instanceof Error ? cause : undefined;
  const category = ["Error", "TypeError", "RangeError", "ZodError", "PostgresError"].includes(error?.name ?? "") ? error!.name : "Error";
  const locations = (error?.stack?.split("\n").slice(1, 6) ?? []).flatMap(line => {
    const match = /([A-Za-z0-9_.-]{1,100}\.(?:ts|mts|js)):(\d+):\d+/.exec(line);
    return match ? [`${match[1]}:${match[2]}`] : [];
  });
  const inner = error?.cause && typeof error.cause === "object" ? error.cause as Record<string, unknown> : {};
  return { category, locations,
    ...(typeof inner.code === "string" && /^[A-Z0-9]{5}$/.test(inner.code) ? { databaseCode: inner.code } : {}),
    ...(typeof inner.constraint_name === "string" && /^[a-z_]{1,100}$/.test(inner.constraint_name) ? { databaseConstraint: inner.constraint_name } : {}),
  };
}
