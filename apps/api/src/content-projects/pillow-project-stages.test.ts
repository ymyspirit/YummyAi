import { describe, expect, it } from "vitest";
import { createEntityId, type ProductionEditorDetailView } from "@yummyai/contracts";
import type { PillowProjectOrder } from "@yummyai/contracts/catalog/pillow-project";
import { pillowFormalFile, pillowOrderStages } from "./pillow-project-stages.js";

function basis() {
  return {
    line: {
      preparation: "pushed",
      artwork: "approved",
      production: "not_released",
      held: false,
      sourceChanged: false,
      sideState: null,
      archivedAt: null,
    },
    currentArtwork: { reviewed: true },
    formalFile: { ready: true },
  } as Pick<PillowProjectOrder, "line" | "currentArtwork" | "formalFile">;
}
function editor() {
  const versionId = createEntityId();
  return {
    version: { id: versionId, reviewed: true },
    renders: [
      {
        id: createEntityId(),
        versionId,
        purpose: "production",
        status: "completed",
        preflight: { productionReady: true },
        files: [{ mediaType: "image/jpeg" }],
        createdAt: "2026-10-05T00:00:00Z",
      },
    ],
  } as ProductionEditorDetailView;
}
describe("pillow project evidence and independent production release", () => {
  it("keeps a ready approved JPG waiting for a real production arrangement", () => {
    expect(pillowOrderStages(basis()).find((s) => s.key === "production")).toMatchObject({
      status: "in_progress",
      detail: "正式文件已准备，等待生产人员安排",
    });
  });
  it("does not turn an automatic draft or outdated review into operator approval", () => {
    const input = basis();
    input.currentArtwork!.reviewed = false;
    expect(pillowOrderStages(input).find((s) => s.key === "review")?.status).toBe("blocked");
    expect(pillowOrderStages(input).find((s) => s.key === "production")?.status).toBe(
      "not_started",
    );
    input.line.artwork = "in_review";
    expect(pillowOrderStages(input).find((s) => s.key === "review")?.status).toBe("in_progress");
  });
  it("blocks the progress claim when the order is held or its source changed", () => {
    for (const flag of ["held", "sourceChanged"] as const) {
      const input = basis();
      input.line[flag] = true;
      expect(pillowOrderStages(input).every((s) => s.status === "blocked")).toBe(true);
    }
  });
  it("ignores older versions and never reuses a passing export while a newer attempt failed", () => {
    const detail = editor();
    expect(pillowFormalFile("approved", detail)?.ready).toBe(true);
    detail.renders.push({
      ...detail.renders[0]!,
      id: createEntityId(),
      createdAt: "2026-10-05T01:00:00Z",
      status: "failed",
      files: [],
    });
    expect(pillowFormalFile("approved", detail)?.ready).toBe(false);
    detail.version.id = createEntityId();
    expect(pillowFormalFile("approved", detail)).toBeNull();
  });
  it("requires completed JPG evidence, a passing preflight and current review", () => {
    for (const change of ["format", "preflight", "review", "draft"]) {
      const detail = editor();
      if (change === "format") detail.renders[0]!.files[0]!.mediaType = "image/png";
      if (change === "preflight") detail.renders[0]!.preflight!.productionReady = false;
      if (change === "review") detail.version.reviewed = false;
      expect(pillowFormalFile(change === "draft" ? "in_review" : "approved", detail)?.ready).toBe(
        false,
      );
    }
  });
});
