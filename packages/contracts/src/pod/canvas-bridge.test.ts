import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { CANVAS_WORKFLOW_TEMPLATES, CanvasWorkflowSnapshotSchema, ContinueCanvasWorkflowInputSchema, CreateCanvasBriefInputSchema, ReviewCanvasResultsInputSchema } from "./canvas-bridge.js";
describe("canvas workflow contracts", () => {
  it("rejects caller-authored workflow snapshots and unknown presets at task creation", () => {
    const input = { requestId: "b1066318-210c-44aa-9bfe-44a44b21b557", name: "Test", prompt: "Test" };
    expect(CreateCanvasBriefInputSchema.parse(input).templateKey).toBe("freeform");
    expect(CreateCanvasBriefInputSchema.safeParse({ ...input, templateKey: "arbitrary" }).success).toBe(false);
    expect(CreateCanvasBriefInputSchema.safeParse({ ...input, canvasWorkflow: {} }).success).toBe(false);
  });
  it("requires unique selections and an explicit rejection reason", () => {
    const id = createEntityId();
    expect(ReviewCanvasResultsInputSchema.safeParse({ versionIds: [id], decision: "reject" }).success).toBe(false);
    expect(ContinueCanvasWorkflowInputSchema.safeParse({ versionIds: [id, id], prompt: "Test" }).success).toBe(false);
    expect(ContinueCanvasWorkflowInputSchema.safeParse({ versionIds: [], prompt: "Test" }).success).toBe(false);
  });
  it("validates each built-in snapshot and rejects steps outside the pinned template", () => {
    for (const template of CANVAS_WORKFLOW_TEMPLATES) {
      const snapshot = { template, rootBatchId: createEntityId(), parentBatchId: null, sourceVersionIds: [], stepIndex: 0 };
      expect(CanvasWorkflowSnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(CanvasWorkflowSnapshotSchema.safeParse({ ...snapshot, stepIndex: template.steps.length }).success).toBe(false);
    }
  });
});
