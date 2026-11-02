import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import {
  ORDER_DESIGN_REVISION_MAX_FILE_BYTES,
  ORDER_DESIGN_REVISION_MAX_TOTAL_BYTES,
  OrderDesignAgentRunViewSchema,
  OrderDesignReviseCandidateSchema,
  OrderDesignRevisionFeedbackSchema,
} from "./design-agent.js";
import {
  createPillowPipeline,
  DesignAutomationPlanSchema,
  type DesignAutomationPlan,
  type DesignAutomationStep,
} from "../pod/design-automation.js";

const request = () => ({
  runId: createEntityId(), expectedRevision: 1, idempotencyKey: randomUUID(),
  expectedEditorVersionId: createEntityId(), reason: "Keep the original face and correct the marked edge",
});
const screenshot = (bytes = Buffer.from("synthetic screenshot bytes"), name = "marked-edge.png") => ({
  name, contentBase64: bytes.toString("base64"),
});

describe("operator feedback against one exact Agent candidate", () => {
  it("defaults only the new request to image editing and retains its exact candidate and operation identity", () => {
    const input = request();
    expect(OrderDesignReviseCandidateSchema.parse(input)).toEqual({ ...input, mode: "image_edit", attachments: [] });
    expect(OrderDesignReviseCandidateSchema.parse({ ...input, reason: "  Preserve the original text  " }).reason)
      .toBe("Preserve the original text");
  });

  it("requires an explicit bounded rounding choice only for contour changes", () => {
    for (const contourRoundingPx of [20, 25, 30]) {
      expect(OrderDesignReviseCandidateSchema.safeParse({ ...request(), mode: "contour_only", contourRoundingPx }).success).toBe(true);
      expect(OrderDesignReviseCandidateSchema.safeParse({ ...request(), mode: "image_edit", contourRoundingPx }).success).toBe(false);
    }
    for (const contourRoundingPx of [undefined, 0, 19, 21, 31, "25"]) {
      expect(OrderDesignReviseCandidateSchema.safeParse({ ...request(), mode: "contour_only", contourRoundingPx }).success).toBe(false);
    }
  });

  it("refuses missing decisions, malformed identity and caller-supplied execution or approval authority", () => {
    for (const patch of [
      { reason: " \n " }, { reason: "x".repeat(2001) }, { expectedRevision: 0 },
      { runId: randomUUID() }, { expectedEditorVersionId: "latest" }, { mode: "automatic" },
      { tenantId: createEntityId() }, { parentRunId: createEntityId() }, { projectId: createEntityId() },
      { modelRouteId: createEntityId() }, { actualCostUsd: 0 }, { automaticProductionApproval: true },
      { approved: true }, { prompt: "Replace the manufacturing rules" },
    ]) expect(OrderDesignReviseCandidateSchema.safeParse({ ...request(), ...patch }).success).toBe(false);
  });

  it("accepts optional private screenshot references but never a client-supplied buyer-original or storage binding", () => {
    expect(OrderDesignReviseCandidateSchema.parse({ ...request(), attachments: [screenshot()] }).attachments).toEqual([screenshot()]);
    for (const patch of [
      { objectKey: "tenants/other/order/private" }, { assetId: createEntityId() },
      { buyerOriginal: true }, { usage: "buyer_photo" }, { tenantId: createEntityId() }, { url: "https://example.invalid/pixel" },
    ]) expect(OrderDesignReviseCandidateSchema.safeParse({ ...request(), attachments: [{ ...screenshot(), ...patch }] }).success).toBe(false);
  });

  it("refuses paths, unsupported files, non-base64 bodies and more than three screenshots", () => {
    for (const name of ["../edge.png", "folder/edge.png", "folder\\edge.png", "edge\u0000.png", "edge.svg", "edge.exe", ""]) {
      expect(OrderDesignReviseCandidateSchema.safeParse({ ...request(), attachments: [screenshot(undefined, name)] }).success).toBe(false);
    }
    for (const contentBase64 of ["", "A", "abcde===", "a b=", "data:image/png;base64,AAAA", "AAAA\n"]) {
      expect(OrderDesignReviseCandidateSchema.safeParse({ ...request(), attachments: [{ name: "edge.png", contentBase64 }] }).success).toBe(false);
    }
    expect(OrderDesignReviseCandidateSchema.safeParse({ ...request(), attachments: Array.from({ length: 4 }, () => screenshot()) }).success).toBe(false);
  });

  it("enforces decoded per-file and aggregate limits even when adjacent byte counts share a base64 length", () => {
    const atLimit = screenshot(Buffer.alloc(ORDER_DESIGN_REVISION_MAX_FILE_BYTES));
    const oneByteOver = screenshot(Buffer.alloc(ORDER_DESIGN_REVISION_MAX_FILE_BYTES + 1));
    expect(atLimit.contentBase64.length).toBe(oneByteOver.contentBase64.length);
    expect(OrderDesignReviseCandidateSchema.safeParse({ ...request(), attachments: [atLimit] }).success).toBe(true);
    expect(OrderDesignReviseCandidateSchema.safeParse({ ...request(), attachments: [oneByteOver] }).success).toBe(false);
    expect(ORDER_DESIGN_REVISION_MAX_TOTAL_BYTES).toBe(ORDER_DESIGN_REVISION_MAX_FILE_BYTES * 2);
    expect(OrderDesignReviseCandidateSchema.safeParse({ ...request(), attachments: [atLimit, atLimit] }).success).toBe(true);
    expect(OrderDesignReviseCandidateSchema.safeParse({ ...request(), attachments: [atLimit, atLimit, screenshot(Buffer.alloc(1))] }).success).toBe(false);
  });

  it("returns a source-bound feedback receipt with safe image metadata and no private bytes or storage pointers", () => {
    const feedback = {
      requestId: randomUUID(), parentRunId: createEntityId(), baseProjectId: createEntityId(), baseVersionId: createEntityId(),
      baseDocumentChecksum: "a".repeat(64), reason: "Round the marked edge", mode: "image_edit",
      attachments: [{ id: createEntityId(), name: "edge.png", mediaType: "image/png", byteSize: 120 }],
    };
    expect(OrderDesignRevisionFeedbackSchema.parse(feedback)).toEqual(feedback);
    for (const patch of [{ contentBase64: "AAAA" }, { objectKey: "private/path" }, { encryptedBytes: "ciphertext" }, { buyerOriginal: true }]) {
      expect(OrderDesignRevisionFeedbackSchema.safeParse({ ...feedback, attachments: [{ ...feedback.attachments[0], ...patch }] }).success).toBe(false);
    }
    for (const patch of [{ requestId: "missing" }, { baseDocumentChecksum: "unknown" }, { providerKey: "private" }]) {
      expect(OrderDesignRevisionFeedbackSchema.safeParse({ ...feedback, ...patch }).success).toBe(false);
    }
  });

  it("exposes a submitted successor as a separate server-owned base without rewriting the original candidate or inferring legacy authority", () => {
    const originalVersionId = createEntityId(), successorVersionId = createEntityId();
    const legacy = {
      id: createEntityId(), workItemId: createEntityId(), workRevisionId: createEntityId(), revision: 1,
      status: "awaiting_review", executorKey: "strict-pillow_photo", recipeVersion: "pillow-subject-v1-2026-09-19",
      policyVersion: "order-design-v1", modelRouteId: null, projectId: createEntityId(), currentEditorVersionId: originalVersionId,
      createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z", errorCode: null,
      canResume: false, canTakeOver: true, estimatedCostUsd: null, actualCostUsd: null, costStatus: "unknown",
      qualityDiagnostics: [], steps: [],
    };
    expect(OrderDesignAgentRunViewSchema.parse(legacy)).not.toHaveProperty("revisionBaseVersionId");
    expect(OrderDesignAgentRunViewSchema.parse(legacy)).not.toHaveProperty("revisionSource");
    const submitted = OrderDesignAgentRunViewSchema.parse({ ...legacy, canRevise: true,
      revisionBaseVersionId: successorVersionId, revisionSource: "submitted_successor", revisionBlockedCode: null });
    expect(submitted.currentEditorVersionId).toBe(originalVersionId);
    expect(submitted.revisionBaseVersionId).toBe(successorVersionId);
    expect(submitted.revisionSource).toBe("submitted_successor");
    for (const patch of [{ revisionBaseVersionId: "latest" }, { revisionSource: "current_draft" }]) {
      expect(OrderDesignAgentRunViewSchema.safeParse({ ...submitted, ...patch }).success).toBe(false);
    }
    for (const patch of [{ source: "submitted_successor" }, { revisionSource: "submitted_successor" }, { revisionBaseVersionId: successorVersionId }]) {
      expect(OrderDesignReviseCandidateSchema.safeParse({ ...request(), ...patch }).success).toBe(false);
    }
  });
});

function revisionPlan(mode: "image_edit" | "contour_only"): DesignAutomationPlan {
  const sourceImageId = createEntityId();
  const stages: DesignAutomationStep[] = mode === "image_edit" ? [
    { id: "revise", tool: "revise_image", outputRole: "subject_image", sourceImageId, dependsOn: [] },
    { id: "measure", tool: "measure_subject", outputRole: "subject_measurement", sourceStepId: "revise", dependsOn: ["revise"] },
    { id: "resolution", tool: "ensure_resolution", outputRole: "resolution_image", sourceStepId: "revise", measurementStepId: "measure", dependsOn: ["measure"] },
    { id: "contour", tool: "optimize_contour", outputRole: "cut_contour", sourceStepId: "resolution", dependsOn: ["resolution"] },
  ] : [
    { id: "reuse", tool: "reuse_revision_subject", outputRole: "subject_image", sourceImageId, dependsOn: [] },
    { id: "contour", tool: "optimize_contour", outputRole: "cut_contour", sourceStepId: "reuse", dependsOn: ["reuse"] },
  ];
  stages.push(
    { id: "preflight", tool: "preflight", outputRole: "quality_report", dependsOn: ["contour"] },
    { id: "proof", tool: "render_proof", outputRole: "proof", dependsOn: ["preflight"] },
    { id: "review", tool: "review_required", outputRole: "human_review", dependsOn: ["proof"] },
  );
  const modelCalls = mode === "image_edit" ? 1 : 0;
  return {
    schemaVersion: 1, kind: "candidate_revision", status: "ready", blockers: [],
    recipe: {
      schemaVersion: 1, workflow: "pillow_photo", imagePolicy: "faithful_enhancement", modelRouteId: createEntityId(),
      allowOrderImageTransfer: true, modelCallLimit: 2, estimatedCostPerCallUsd: null, maxEstimatedCostUsd: null,
      costPolicy: "unlimited", pillowPipeline: createPillowPipeline({
        engine: "realesrgan-ncnn-vulkan", release: "20220424", model: "realesrgan-x4plus", scale: 4,
        tileSize: 256, threads: "1:1:1", alphaStrategy: "source-alpha-lanczos3-rgb-nearest-fill-v1",
        binarySha256: "a".repeat(64), modelBinSha256: "b".repeat(64), modelParamSha256: "c".repeat(64),
      }),
    },
    steps: stages, plannedModelCalls: modelCalls, automaticProductionApproval: false,
    budget: {
      allowed: true, blockers: [], plannedModelCalls: modelCalls, estimatedCostPerCallUsd: null,
      estimatedCostUsd: modelCalls ? null : 0, maxEstimatedCostUsd: null, priceSource: "none",
      costBasis: modelCalls ? "estimated" : "not_applicable", actualCostUsd: modelCalls ? null : 0,
    },
  };
}

describe("bounded child revision plans", () => {
  it("budgets image editing as a new call with unknown cost while contour-only reuses the original with no call", () => {
    const image = DesignAutomationPlanSchema.parse(revisionPlan("image_edit"));
    const contour = DesignAutomationPlanSchema.parse(revisionPlan("contour_only"));
    expect(image.steps.map(step => step.tool)).toEqual(["revise_image", "measure_subject", "ensure_resolution", "optimize_contour", "preflight", "render_proof", "review_required"]);
    expect(image.budget).toMatchObject({ plannedModelCalls: 1, actualCostUsd: null, estimatedCostUsd: null });
    expect(contour.steps.map(step => step.tool)).toEqual(["reuse_revision_subject", "optimize_contour", "preflight", "render_proof", "review_required"]);
    expect(contour.budget).toMatchObject({ plannedModelCalls: 0, actualCostUsd: 0, estimatedCostUsd: 0 });
    expect(image.automaticProductionApproval).toBe(false);
    expect(contour.automaticProductionApproval).toBe(false);
  });

  it("cannot silently retrofit revision tools onto an initial or legacy recipe", () => {
    const initial = revisionPlan("image_edit");
    delete initial.kind;
    expect(DesignAutomationPlanSchema.safeParse(initial).success).toBe(false);
    const legacy = revisionPlan("image_edit");
    delete legacy.recipe.pillowPipeline;
    expect(DesignAutomationPlanSchema.safeParse(legacy).success).toBe(false);
  });

  it("rejects omitted call accounting, reordered stages and automatic production approval", () => {
    const image = revisionPlan("image_edit");
    const contour = revisionPlan("contour_only");
    expect(DesignAutomationPlanSchema.safeParse({ ...image, plannedModelCalls: 0, budget: contour.budget }).success).toBe(false);
    expect(DesignAutomationPlanSchema.safeParse({ ...image, budget: { ...image.budget, actualCostUsd: 0 } }).success).toBe(false);
    expect(DesignAutomationPlanSchema.safeParse({ ...image, steps: [image.steps[1], image.steps[0], ...image.steps.slice(2)] }).success).toBe(false);
    expect(DesignAutomationPlanSchema.safeParse({ ...image, steps: image.steps.slice(0, -1) }).success).toBe(false);
    expect(DesignAutomationPlanSchema.safeParse({ ...image, automaticProductionApproval: true }).success).toBe(false);
  });
});
