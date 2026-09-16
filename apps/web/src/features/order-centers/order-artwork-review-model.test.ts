import { describe, expect, it } from "vitest";
import type {
  ProductionEditorDetailView,
  ProductionEditorRenderView,
} from "@yummyai/contracts/pod/production-editor-api";
import { artworkPreviewPending, artworkReviewFile } from "./order-artwork-review-model";

function render(
  id: string,
  overrides: Partial<ProductionEditorRenderView> = {},
): ProductionEditorRenderView {
  return {
    id,
    versionId: "current",
    purpose: "preview",
    status: "completed",
    errorCode: null,
    createdAt: "2026-09-15T01:00:00.000Z",
    preflight: null,
    files: [{ key: "sheet", name: "sheet.png", mediaType: "image/png", byteSize: 100 }],
    ...overrides,
  };
}
function editor(renders: ProductionEditorRenderView[]) {
  return {
    project: { id: "project", currentVersionId: "current" },
    version: { id: "current" },
    renders,
  } as ProductionEditorDetailView;
}

describe("operator artwork preview selection", () => {
  it("never substitutes a historical sheet or AI cutout for the current composed sheet", () => {
    const view = editor([
      render("old", { versionId: "old" }),
      render("cutout", { purpose: "image_edit" }),
      render("enhanced", { purpose: "order_image_enhancement" }),
    ]);
    expect(artworkReviewFile(view)).toBeNull();
    view.renders.push(render("current-proof"));
    expect(artworkReviewFile(view)?.render.id).toBe("current-proof");
    view.version.id = "old";
    expect(artworkReviewFile(view)).toBeNull();
  });
  it("selects the latest viewable sheet without mistaking TIFF or a failed retry for an image", () => {
    const view = editor([
      render("failed", { status: "failed", createdAt: "2026-09-15T05:00:00.000Z" }),
      render("tiff", {
        purpose: "production",
        createdAt: "2026-09-15T04:00:00.000Z",
        files: [{ key: "tiff", name: "sheet.tif", mediaType: "image/tiff", byteSize: 200 }],
      }),
      render("latest", { purpose: "production", createdAt: "2026-09-15T03:00:00.000Z" }),
      render("first"),
    ]);
    expect(artworkReviewFile(view)?.url).toBe(
      "/api/production-editor/projects/project/renders/latest/files/sheet",
    );
  });
  it("only waits for composed sheets belonging to this version", () => {
    const view = editor([
      render("old", { status: "processing", versionId: "old" }),
      render("ai", { status: "queued", purpose: "image_edit" }),
    ]);
    expect(artworkPreviewPending(view)).toBe(false);
    view.renders.push(render("new", { status: "queued" }));
    expect(artworkPreviewPending(view)).toBe(true);
  });
});
