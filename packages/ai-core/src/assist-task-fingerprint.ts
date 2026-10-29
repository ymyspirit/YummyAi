import { assistFingerprint, type AssistContext } from "./assist.js";
/** Business evidence identity, excluding transport IDs and retrieval clocks. */
export function assistTaskFingerprint(prepared: AssistContext) {
  const request: Partial<AssistContext["request"]> = { ...prepared.request };
  delete request.requestId; delete request.modelId; delete request.expectedTaskFingerprint;
  const content = { ...prepared, request, data: { ...prepared.data } };
  delete content.expiresAt; delete content.accessPolicy; delete content.inputAuthority; delete content.executionContract;
  // Output policy is pinned separately by the execution policy, not business evidence.
  delete content.outputTokenPolicy;
  for (const field of ["retrieval", "operatingKnowledge"] as const) {
    const value = content.data[field];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const retrieval = { ...value } as Record<string, unknown>; delete retrieval.retrievedAt; content.data[field] = retrieval;
    }
  }
  return assistFingerprint(content);
}
