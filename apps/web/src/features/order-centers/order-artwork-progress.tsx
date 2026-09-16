"use client";
import type { ProductionEditorDetailView } from "@yummyai/contracts/pod/production-editor-api";
import { dateTime } from "./order-center-model";
import { artworkReviewFile } from "./order-artwork-review-model";

const taskNames = {
  order_image_enhancement: "顾客图片保真美化",
  image_edit: "AI 抠图素材",
  preview: "预览文件",
  production: "正式生产文件",
};
const taskStates = {
  queued: "等待执行",
  processing: "正在处理",
  completed: "已完成",
  failed: "失败，需处理",
};

export function OrderArtworkProgress({
  editor,
  onOpen,
}: {
  editor: ProductionEditorDetailView;
  onOpen: () => void;
}) {
  const renders = [...editor.renders].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = renders.filter(
    (render, index) => renders.findIndex((item) => item.purpose === render.purpose) === index,
  );
  const checked = artworkReviewFile(editor)?.render.preflight;
  const issues = checked?.issues ?? [];
  return (
    <section className="oc-section oc-artwork-progress" aria-label="制图进度与审核准备">
      <div className="oc-section-heading">
        <h2>制图进度与审核准备</h2>
        <button type="button" className="oc-button" onClick={onOpen}>
          查看生产文件
        </button>
      </div>
      <p>
        当前稿件 V{editor.version.versionNumber} ·{" "}
        {editor.version.reviewed ? "此版本已审核" : "此版本待审核"}
      </p>
      {!latest.length ? (
        <p className="oc-hint">尚无 AI 或文件生成任务记录。稿件是否完成，请打开生产文件核对。</p>
      ) : (
        <ul className="oc-task-progress">
          {latest.map((render) => {
            const version = editor.versions.find((item) => item.id === render.versionId);
            return (
              <li key={render.id}>
                <span>
                  {taskNames[render.purpose]}{" "}
                  <small>· {version ? `基于 V${version.versionNumber}` : "历史版本"}</small>
                </span>
                <span className={`oc-badge ${render.status === "failed" ? "warning" : ""}`}>
                  {taskStates[render.status]}
                </span>
                <small>{dateTime(render.createdAt)}</small>
                {render.status === "failed" && (
                  <p>
                    {render.versionId === editor.version.id
                      ? "请在生产文件中查看失败原因并处理后重试。"
                      : "此失败任务属于历史版本，请先核对当前稿件是否还需处理。"}
                    {render.errorCode && <small>（{render.errorCode}）</small>}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="oc-hint">
        {!checked
          ? "当前版本尚无文件校验记录，请在生产文件中校验。"
          : checked.productionReady
            ? "最近一次文件校验通过，请完成运营审图。"
            : "最近一次文件校验仍有待处理事项。"}
      </p>
      {issues.length > 0 && (
        <ul className="oc-preflight-issues">
          {issues.map((issue, index) => (
            <li key={`${issue.code}:${index}`}>
              <span className={`oc-badge ${issue.severity === "error" ? "warning" : ""}`}>
                {issue.severity === "error"
                  ? "需修正"
                  : issue.severity === "manual"
                    ? "人工确认"
                    : "提醒"}
              </span>{" "}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
