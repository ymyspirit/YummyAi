import type { ProductionEditorDetailView } from "@yummyai/contracts/pod/production-editor-api";

export function currentProductionRender(editor: ProductionEditorDetailView) {
  return editor.renders.filter(render => render.versionId === editor.version.id && render.purpose === "production")
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0] ?? null;
}

/** Only composed sheets from the displayed immutable version can be reviewed. */
export function artworkReviewFile(editor: ProductionEditorDetailView) {
  if (editor.version.id !== editor.project.currentVersionId) return null;
  const renders = editor.renders
    .filter(
      (render) =>
        render.versionId === editor.version.id &&
        ["preview", "production"].includes(render.purpose),
    )
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  for (const render of renders) {
    if (render.status !== "completed") continue;
    const file = render.files.find((file) =>
      ["image/png", "image/jpeg", "image/webp"].includes(file.mediaType),
    );
    if (file)
      return {
        render,
        file,
        url: `/api/production-editor/projects/${editor.project.id}/renders/${render.id}/files/${encodeURIComponent(file.key)}`,
      };
  }
  return null;
}

export function artworkPreviewPending(editor: ProductionEditorDetailView) {
  return editor.renders.some(
    (render) =>
      render.versionId === editor.version.id &&
      ["preview", "production"].includes(render.purpose) &&
      ["queued", "processing"].includes(render.status),
  );
}
