import type { CanvasBrief, CanvasResultView } from "@yummyai/contracts/pod/canvas-bridge";
export type CanvasBriefRow = Pick<CanvasBrief, "id" | "name" | "status" | "resultCount" | "workflow"> & { approvedCount: number; createdAt: string };
/** One entry per project; earlier steps remain accessible from the step rail. */
export function recentCanvasProjects(rows: CanvasBriefRow[]) {
  const roots = new Map<string, { name: string; latest: CanvasBriefRow }>();
  for (const row of rows) {
    const key = row.workflow?.rootBatchId ?? row.id, current = roots.get(key);
    if (!current) roots.set(key, { name: row.name, latest: row });
    else if ((row.workflow?.stepIndex ?? 0) > (current.latest.workflow?.stepIndex ?? 0)) current.latest = row;
  }
  for (const [key, project] of roots) project.name = rows.find((row) => row.id === key)?.name ?? project.name;
  return [...roots.entries()].map(([rootId, project]) => ({ rootId, ...project }));
}
export function canvasResultSelection(results: CanvasResultView[], selected: string[]) {
  return {
    pending: results.filter((row) => selected.includes(row.versionId) && row.status === "pending_review"),
    approved: results.filter((row) => selected.includes(row.versionId) && row.status === "approved"),
    unreviewed: results.filter((row) => row.status === "pending_review" || row.status === "adapting").length,
  };
}
export function nextCanvasPrompt(brief: CanvasBrief) {
  const next = brief.workflow?.template.steps[brief.workflow.stepIndex + 1];
  return next ? `${next.instructions}\n\n原始需求：\n${brief.prompt}`.slice(0, 8000) : "";
}
