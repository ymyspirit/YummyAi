import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { CANVAS_WORKFLOW_TEMPLATES, type CanvasResultView } from "@yummyai/contracts/pod/canvas-bridge";
import { canvasResultSelection, recentCanvasProjects, type CanvasBriefRow } from "./canvas-workspace-model";
describe("canvas workflow workbench", () => {
  it("shows one project with its newest step while preserving legacy standalone tasks", () => {
    const rootId = createEntityId(), childId = createEntityId();
    const root: CanvasBriefRow = { id: rootId, name: "Project A", status: "completed", resultCount: 2, approvedCount: 1, createdAt: "2026-09-09T00:00:00Z", workflow: { rootBatchId: rootId, parentBatchId: null, stepIndex: 0, sourceVersionIds: [], template: CANVAS_WORKFLOW_TEMPLATES[1]! } };
    const child = { ...root, id: childId, name: "Project A · Refine", workflow: { ...root.workflow!, parentBatchId: rootId, stepIndex: 1 } };
    const legacy = { ...root, id: createEntityId(), name: "Legacy task", workflow: null };
    for (const rows of [[root, child, legacy], [child, legacy, root]]) {
      const projects = recentCanvasProjects(rows);
      expect(projects).toHaveLength(2);
      expect(projects.find((project) => project.rootId === rootId)).toMatchObject({ name: "Project A", latest: { id: childId } });
    }
  });
  it("separates selections for approval and progression and counts all unreviewed results", () => {
    const result = (status: CanvasResultView["status"]): CanvasResultView => ({ versionId: createEntityId(), assetId: createEntityId(), name: "Synthetic", status, rejectionReason: null, width: 100, height: 100, previewPath: "/private", productionProjects: [] });
    const results = [result("approved"), result("pending_review"), result("rejected"), result("adapting")];
    const selected = canvasResultSelection(results, results.map((entry) => entry.versionId));
    expect(selected.pending.map((entry) => entry.versionId)).toEqual([results[1].versionId]);
    expect(selected.approved.map((entry) => entry.versionId)).toEqual([results[0].versionId]);
    expect(selected.unreviewed).toBe(2);
  });
});
