import type {
  PillowProjectOrder,
  PillowOrderStage,
} from "@yummyai/contracts/catalog/pillow-project";
import type { ProductionEditorDetailView } from "@yummyai/contracts";

export function pillowFormalFile(artwork: string, detail: ProductionEditorDetailView | null) {
  const latest = detail?.renders
    .filter((r) => r.purpose === "production" && r.versionId === detail.version.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  return latest
    ? {
        id: latest.id,
        versionId: latest.versionId,
        status: latest.status,
        ready:
          artwork === "approved" &&
          !!detail?.version.reviewed &&
          latest.status === "completed" &&
          latest.preflight?.productionReady === true &&
          latest.files.length > 0 &&
          latest.files.every((f) => f.mediaType === "image/jpeg"),
      }
    : null;
}

/** Project progress is evidence, never an alternative production approval. */
export function pillowOrderStages(
  input: Pick<PillowProjectOrder, "line" | "currentArtwork" | "formalFile">,
): PillowOrderStage[] {
  const { line, currentArtwork, formalFile } = input;
  const stopped =
    line.held ||
    line.sideState === "on_hold" ||
    line.sideState === "cancelled" ||
    !!line.archivedAt;
  const stale = line.sourceChanged;
  const approved = line.artwork === "approved" && !!currentArtwork?.reviewed;
  const stages: PillowOrderStage[] = [
    {
      key: "requirements",
      label: "核对定制要求",
      status:
        line.preparation === "pushed"
          ? "complete"
          : line.preparation === "needs_information"
            ? "blocked"
            : "in_progress",
      detail:
        line.preparation === "pushed"
          ? "已保存并派发本单制作版本"
          : "核对顾客原图、裁切范围、尺寸与单双面，保存后派发",
    },
    {
      key: "artwork",
      label: "制作本单图稿",
      status:
        ["in_review", "approved"].includes(line.artwork) && currentArtwork
          ? "complete"
          : line.artwork === "changes_requested"
            ? "blocked"
            : line.artwork === "not_pushed"
              ? "not_started"
              : "in_progress",
      detail: "保真美化、抠图、清晰度与主体尺寸核对，再处理独立裁线",
    },
    {
      key: "review",
      label: "运营审核",
      status: approved
        ? "complete"
        : line.artwork === "changes_requested" || (line.artwork === "approved" && !approved)
          ? "blocked"
          : line.artwork === "in_review"
            ? "in_progress"
            : "not_started",
      detail: approved
        ? "当前制作版本已经运营审核"
        : "对照原图与当前完整稿件；技术检查不替代运营通过",
    },
    {
      key: "production",
      label: "正式文件与生产安排",
      status: ["failed", "quality_hold", "cancel_requested", "cancelled"].includes(line.production)
        ? "blocked"
        : approved && formalFile?.ready && !["not_released", "cancelled"].includes(line.production)
          ? "complete"
          : approved
            ? "in_progress"
            : "not_started",
      detail: formalFile?.ready
        ? line.production === "not_released"
          ? "正式文件已准备，等待生产人员安排"
          : "已记录生产安排，进度与质检在生产中心跟进"
        : formalFile?.status === "failed"
          ? "正式导出失败，请在生产中心处理"
          : "审核后生成正式 JPG，生产人员另行确认工厂、数量与排期",
    },
  ];
  if (stopped || stale)
    for (const stage of stages) {
      stage.status = "blocked";
      stage.detail = stopped
        ? "本单已暂停、归档或取消，先在订单中心核对状态"
        : "订单来源已变化，先重新核对本单定制要求";
    }
  return stages;
}
