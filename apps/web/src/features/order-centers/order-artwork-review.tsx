"use client";
import { useState } from "react";
import { Check, ImageOff, LoaderCircle, Maximize2, Minimize2, RotateCcw } from "lucide-react";
import type { OrderWorkDetail } from "@yummyai/contracts/order/workspace";
import type { ProductionEditorDetailView } from "@yummyai/contracts/pod/production-editor-api";
import { artworkPreviewPending, artworkReviewFile } from "./order-artwork-review-model";
import { label } from "./order-center-model";
import "./order-artwork-review.css";

type ReviewAction = "submit_artwork" | "approve_artwork" | "reject_artwork";
const issueOrder = { error: 0, manual: 1, warning: 2 };

export function OrderArtworkReview({
  editor,
  detail,
  disabled,
  reason,
  onReason,
  onAction,
  onPreview,
  onOpen,
  advance,
  onAdvance,
  hasNext,
}: {
  editor: ProductionEditorDetailView;
  detail: OrderWorkDetail;
  disabled: boolean;
  reason: string;
  onReason: (value: string) => void;
  onAction: (action: ReviewAction) => void;
  onPreview: () => void;
  onOpen: () => void;
  advance: boolean;
  onAdvance: (value: boolean) => void;
  hasNext?: boolean;
}) {
  const proof = artworkReviewFile(editor);
  const [loaded, setLoaded] = useState("");
  const [failed, setFailed] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState(false);
  const imageKey = proof ? `${proof.url}?attempt=${attempt}` : "";
  const visible = !!imageKey && loaded === imageKey && failed !== imageKey;
  const pending = artworkPreviewPending(editor);
  const check = proof?.render.preflight;
  const state = detail.line.artwork;
  const canSubmit = ["in_progress", "changes_requested"].includes(state);
  const canReject = ["in_review", "approved"].includes(state);
  const locked =
    disabled ||
    detail.line.held ||
    !!detail.line.archivedAt ||
    editor.version.id !== editor.project.currentVersionId;
  const decisionBlocked = locked || !visible || !check?.productionReady;
  const latestRejection = detail.events
    .filter((event) => event.action === "reject_artwork")
    .toSorted((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];

  return (
    <section className="oc-artwork-review" aria-label="生产图审核">
      <div className="oc-section-heading">
        <h2>
          生产图审核 <span className="oc-badge">V{editor.version.versionNumber}</span>
        </h2>
        <span className="oc-badge">{label(state)}</span>
      </div>
      <div className="oc-artwork-review-grid">
        <div className="oc-artwork-sheet">
          <div className="oc-artwork-sheet-toolbar">
            <span>当前版本 · {editor.version.document.spec.dpi} DPI</span>
            <button
              type="button"
              className="oc-button"
              disabled={!visible}
              onClick={() => setZoom(!zoom)}
            >
              {zoom ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              {zoom ? "适应窗口" : "原尺寸查看"}
            </button>
          </div>
          <div
            className="oc-artwork-preview"
            data-zoom={zoom || undefined}
            data-background={editor.version.document.exportBackground ?? "transparent"}
            aria-busy={!!proof && !visible && failed !== imageKey}
            tabIndex={0}
            aria-label="生产图预览区域"
          >
            {proof && failed !== imageKey && (
              <>
                {!visible && (
                  <p className="oc-artwork-preview-message" role="status">
                    <LoaderCircle size={20} />
                    正在加载当前生产图…
                  </p>
                )}
                {/* Authenticated private file; do not send customer artwork to an image optimizer. */}
                <img
                  key={imageKey}
                  src={imageKey}
                  alt={`当前生产图 V${editor.version.versionNumber}`}
                  decoding="async"
                  onLoad={() => setLoaded(imageKey)}
                  onError={() => setFailed(imageKey)}
                  style={{ visibility: visible ? "visible" : "hidden" }}
                />
              </>
            )}
            {(!proof || failed === imageKey) && (
              <div
                className="oc-artwork-preview-message"
                role={failed === imageKey && proof ? "alert" : "status"}
              >
                <ImageOff size={24} />
                <strong>
                  {proof
                    ? "生产图加载失败"
                    : pending
                      ? "当前生产图正在生成…"
                      : "当前版本尚无可查看的生产图"}
                </strong>
                <span>
                  {proof
                    ? "请重新加载后再审核。"
                    : pending
                      ? "完成后会自动显示在这里。"
                      : "生成预览后即可在此审图，历史稿件保留在下方。"}
                </span>
                <button
                  type="button"
                  className="oc-button"
                  disabled={locked || pending}
                  onClick={() => (proof ? setAttempt((value) => value + 1) : onPreview())}
                >
                  <RotateCcw size={14} />
                  {proof ? "重新加载图片" : pending ? "正在生成" : "生成当前预览"}
                </button>
              </div>
            )}
          </div>
          <p className="oc-hint">
            {proof?.render.purpose === "production" ? "正式生产文件" : "生产图预览"} ·
            显示完整排版，可切换原尺寸检查细节。
          </p>
        </div>
        <div className="oc-artwork-decision">
          <div className="oc-artwork-check">
            <strong>文件检查</strong>
            {check && (
              <p>
                输出尺寸 {check.widthPx} × {check.heightPx} px ·{" "}
                {editor.version.document.exportBackground === "white" ? "白底" : "透明背景"}
              </p>
            )}
            <p className={check?.productionReady ? "oc-hint" : "oc-error"}>
              {check?.productionReady
                ? "文件检查通过，请核对图案、尺寸与客户要求。"
                : check
                  ? "仍有待处理事项，完成后才能通过审核。"
                  : "生成当前版本预览后显示检查结果。"}
            </p>
            {!!check?.issues.length && (
              <details className="oc-artwork-issues" open={!check.productionReady}>
                <summary>检查明细（{check.issues.length}）</summary>
                <ul>
                  {check.issues
                    .toSorted((a, b) => issueOrder[a.severity] - issueOrder[b.severity])
                    .map((issue, index) => (
                      <li key={`${issue.code}:${index}`} data-severity={issue.severity}>
                        {issue.message}
                      </li>
                    ))}
                </ul>
              </details>
            )}
          </div>
          {state === "changes_requested" && latestRejection && (
            <p className="oc-error">上次驳回：{latestRejection.reason}</p>
          )}
          {canReject && (
            <label className="oc-full-field">
              驳回理由 <span className="oc-hint">驳回时必填</span>
              <textarea
                aria-label="驳回理由"
                value={reason}
                onChange={(event) => onReason(event.target.value)}
                disabled={locked}
                rows={3}
                maxLength={2000}
                placeholder="例如：脸颊外胡须过长，裁剪线不够圆滑。请说明需要修改的位置。"
              />
            </label>
          )}
          <div className="oc-artwork-decision-actions">
            {state === "in_review" && (
              <button
                type="button"
                className="oc-button primary"
                disabled={decisionBlocked || !!reason.trim()}
                onClick={() => onAction("approve_artwork")}
              >
                <Check size={16} />
                通过审核
              </button>
            )}
            {canReject && (
              <button
                type="button"
                className="oc-button"
                disabled={locked || !reason.trim()}
                onClick={() => onAction("reject_artwork")}
              >
                <RotateCcw size={16} />
                驳回修改
              </button>
            )}
            {canSubmit && (
              <button
                type="button"
                className="oc-button primary"
                disabled={decisionBlocked}
                onClick={() => onAction("submit_artwork")}
              >
                提交文件审核
              </button>
            )}
          </div>
          {state === "in_review" && !!reason.trim() && (
            <p className="oc-hint">已填写驳回理由；如需通过，请先清空理由。</p>
          )}
          {canSubmit && <p className="oc-hint">当前处于制图阶段，提交后由运营审核。</p>}
          {state === "approved" && (
            <p className="oc-notice">运营已通过此稿，可继续生成正式生产文件。</p>
          )}
          {hasNext !== undefined && (canSubmit || canReject) && (
            <label className="oc-check">
              <input
                type="checkbox"
                checked={advance}
                disabled={locked}
                onChange={(event) => onAdvance(event.target.checked)}
              />
              保存审核结果后{hasNext ? "处理下一单" : "返回列表"}
            </label>
          )}
          <button type="button" className="oc-button" disabled={disabled} onClick={onOpen}>
            编辑生产文件
          </button>
        </div>
      </div>
    </section>
  );
}
