import { businessAssistSelection, type CreateAssist } from "@yummyai/contracts/ai/assist";
export type AssistInput = CreateAssist extends infer T
  ? T extends CreateAssist
    ? Omit<T, "modelId" | "requestId">
    : never
  : never;
export async function assistApi<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/ai-assists/${path}`, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(typeof data?.message === "string" ? data.message : "分析服务暂不可用");
  return data as T;
}
export function sameAssistInput(request: CreateAssist | null, input: AssistInput | null): boolean {
  if (!request || !input || request.kind !== input.kind) return false;
  if ("expectedFingerprint" in request && "expectedFingerprint" in input) {
    return (
      request.expectedFingerprint === input.expectedFingerprint &&
      JSON.stringify(businessAssistSelection(request)) ===
        JSON.stringify(businessAssistSelection(input))
    );
  }
  if (request.kind === "template_config" && input.kind === "template_config")
    return request.inspectionId === input.inspectionId;
  if (request.kind === "sku_package" && input.kind === "sku_package")
    return (
      request.listingId === input.listingId && request.expectedVersionId === input.expectedVersionId
    );
  if (request.kind === "creative" && input.kind === "creative")
    return (
      request.scopeId === input.scopeId &&
      request.prompt === input.prompt &&
      JSON.stringify(request.requirements) === JSON.stringify(input.requirements) &&
      input.sources.length === request.sources.length &&
      input.sources.every((s, i) => {
        const pin = request.sources[i];
        return (
          pin?.researchItemId === s.researchItemId &&
          (!s.snapshotId || pin.snapshotId === s.snapshotId) &&
          (s.studyRevisionId === undefined || pin.studyRevisionId === s.studyRevisionId)
        );
      })
    );
  if (request.kind === "order_review" && input.kind === "order_review")
    return (
      request.orderLineId === input.orderLineId &&
      request.expectedRevision === input.expectedRevision &&
      request.expectedSourceVersionId === input.expectedSourceVersionId
    );
  return (
    request.kind === "artwork_preflight" &&
    input.kind === "artwork_preflight" &&
    request.orderLineId === input.orderLineId &&
    request.expectedRevision === input.expectedRevision &&
    request.expectedEditorVersionId === input.expectedEditorVersionId
  );
}
