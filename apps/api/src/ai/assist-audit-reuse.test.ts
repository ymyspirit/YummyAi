import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assistFingerprint } from "@yummyai/ai-core";
import { createEntityId } from "@yummyai/contracts";
import { AssistViewSchema, CreateAssistSchema } from "@yummyai/contracts/ai/assist";
import { ARTWORK_AUDIT_POLICY, ArtworkAuditCodeSchema, ArtworkAuditReportSchema } from "@yummyai/contracts/ai/artwork-audit";
import { AssistService } from "./assist.service.js";

/** Transport metadata only. No production document, image, review or approval is
 * constructed; every check remains needs_review and complete=false. */
function metadata() {
  const original = CreateAssistSchema.options[3].parse({ kind: "artwork_preflight", orderLineId: createEntityId(), expectedRevision: 2,
    expectedEditorVersionId: createEntityId(), modelId: createEntityId(), requestId: randomUUID(), automaticAudit: true });
  const submitted = { ...original, requestId: randomUUID() };
  const audit = ArtworkAuditReportSchema.parse({ policy: ARTWORK_AUDIT_POLICY, orderLineId: original.orderLineId, revision: 2,
    projectId: createEntityId(), versionId: original.expectedEditorVersionId, versionNumber: 1, documentHash: "a".repeat(64),
    sourceVersionId: null, factoryStandardId: null, ruleBasis: "Synthetic transport metadata only", complete: false,
    checks: ArtworkAuditCodeSchema.options.map(code => ({ code, title: code, status: "needs_review", method: "measurement",
      detail: "Synthetic transport check No artifact was produced", action: "", evidence: [], marks: [] })) });
  const view = AssistViewSchema.parse({ id: createEntityId(), kind: original.kind, scope: `order:${original.orderLineId}`, status: "queued",
    createdAt: "2026-10-22T00:00:00.000Z", completedAt: null, modelLabel: "Synthetic model", model: "synthetic", promptVersion: "synthetic",
    inputFingerprint: "b".repeat(64), stale: false, maxTaskCostUsd: 1, request: original, inputTokens: null, outputTokens: null,
    costUsd: null, error: null, diagnostics: [], sources: [], checks: [], result: null, artworkAudit: audit });
  return { original, submitted, view };
}

describe("Native automatic audit reuse proof transport", () => {
  it("identifies the existing policy run without claiming that the newly submitted request was persisted", () => {
    const sample = metadata(), before = JSON.stringify(sample);
    const proof = AssistService.prototype.automaticAuditReuseProof(sample.submitted, sample.view);
    expect(proof).toMatchObject({ disposition: "existing_policy_run", submittedRequestId: sample.submitted.requestId,
      submittedRequestChecksum: assistFingerprint(sample.submitted), originalRequestId: sample.original.requestId,
      originalRequestChecksum: assistFingerprint(sample.original), runId: sample.view.id, policy: ARTWORK_AUDIT_POLICY });
    expect(proof?.submittedRequestId).not.toBe(proof?.originalRequestId);
    expect(JSON.stringify(sample)).toBe(before);
  });

  it("does not mint a policy proof for ordinary, same-request, stale or mismatched original artwork pins", () => {
    const sample = metadata(), proof = AssistService.prototype.automaticAuditReuseProof;
    expect(proof(sample.original, sample.view)).toBeNull();
    expect(proof({ ...sample.submitted, automaticAudit: undefined }, sample.view)).toBeNull();
    expect(proof(sample.submitted, { ...sample.view, stale: true })).toBeNull();
    for (const submitted of [{ ...sample.submitted, orderLineId: createEntityId() }, { ...sample.submitted, expectedRevision: 3 },
      { ...sample.submitted, expectedEditorVersionId: createEntityId() }]) expect(proof(submitted, sample.view)).toBeNull();
    expect(proof(sample.submitted, { ...sample.view, artworkAudit: null })).toBeNull();
    expect(proof(sample.submitted, { ...sample.view, artworkAudit: { ...sample.view.artworkAudit!, versionId: createEntityId() } })).toBeNull();
  });
});
