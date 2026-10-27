"use client";
import { useState } from "react";
import { createPortal } from "react-dom";
import { Check, ImageOff, LoaderCircle, Maximize2, Minimize2, RotateCcw } from "lucide-react";
import type { OrderWorkDetail } from "@yummyai/contracts/order/workspace";
import type { ProductionEditorDetailView } from "@yummyai/contracts/pod/production-editor-api";
import { artworkPreviewPending, artworkReviewFile, currentProductionRender } from "./order-artwork-review-model";
import { label } from "./order-center-model";
import { OrderCustomerRequirements } from "./order-customer-requirements";
import { OrderArtworkChecks } from "./order-artwork-checks";
import { OrderSubjectMeasurement } from "./order-subject-measurement";
import { OrderArtworkAudit } from "./order-artwork-audit";
import { applyArtworkAudit, type ArtworkAuditReport } from "@yummyai/contracts/ai/artwork-audit";
import type { ProductionEditorFocus } from "../production-editor/production-editor-workspace";
import "./order-artwork-review.css";

type ReviewAction = "submit_artwork" | "approve_artwork" | "reject_artwork";

export function OrderArtworkReview({
  editor,
  detail,
  disabled,
  reason,
  onReason,
  onAction,
  onPreview,
  onOpen,
  onResolve,
  advance,
  onAdvance,
  hasNext,
  decisionFooter,
  onAdvanceAction,
}: {
  editor: ProductionEditorDetailView;
  detail: OrderWorkDetail;
  disabled: boolean;
  reason: string;
  onReason: (value: string) => void;
  onAction: (action: ReviewAction) => void;
  onPreview: () => void;
  onOpen: () => void;
  onResolve: (focus: ProductionEditorFocus) => void;
  advance: boolean;
  onAdvance: (value: boolean) => void;
  hasNext?: boolean;
  decisionFooter?: HTMLElement | null;
  onAdvanceAction?: (action: ReviewAction) => void;
}) {
  const proof = artworkReviewFile(editor);
  const [loaded, setLoaded] = useState("");
  const [failed, setFailed] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState(false);
  const imageKey = proof ? `${proof.url}?attempt=${attempt}` : "";
  const visible = !!imageKey && loaded === imageKey && failed !== imageKey;
  const pending = artworkPreviewPending(editor);
  const [auditReport, setAuditReport] = useState<ArtworkAuditReport | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const currentAudit = auditReport?.versionId === editor.version.id && auditReport.revision === detail.line.revision && !detail.line.sourceChanged ? auditReport : null;
  const check = proof?.render.preflight ? applyArtworkAudit(proof.render.preflight, currentAudit) : null;
  const fileIssues = check?.issues.filter(i => !i.code.startsWith("artwork_audit_")) ?? [];
  const fileCheck = check && currentAudit ? {...check, issues: fileIssues, productionReady: !fileIssues.some(i => i.severity !== "warning")} : check;
  const state = detail.line.artwork;
  const candidate = detail.line.designCandidateReview === true;
  const canReview = candidate || state === "in_review";
  const production = currentProductionRender(editor);
  const canSubmit = !candidate && ["in_progress", "changes_requested"].includes(state);
  const canReject = candidate || ["in_review", "approved"].includes(state);
  const locked =
    disabled ||
    detail.line.held ||
    !!detail.line.archivedAt ||
    editor.version.id !== editor.project.currentVersionId ||
    !!editor.project.workSource && detail.versions.find(version => version.revision === detail.line.revision)?.id !== editor.project.workSource.revisionId;
  const decisionBlocked = locked || auditBusy || !visible || !check?.productionReady;
  const latestRejection = detail.events
    .filter((event) => event.action === "reject_artwork")
    .toSorted((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];

  return (
    <section className="oc-artwork-review" aria-label="生产图审核">
      <div className="oc-section-heading">
        <h2>
          {candidate ? "审核无人设计稿" : "生产图审核"} <span className="oc-badge">V{editor.version.versionNumber}</span>
        </h2>
        <span className="oc-badge">{candidate ? "无人设计稿待审核" : label(state)}</span>
      </div>
      <div className="oc-artwork-review-grid">
        <OrderCustomerRequirements key={detail.line.id} detail={detail} revisionId={editor.project.workSource?.revisionId} />
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
          <OrderSubjectMeasurement key={`${editor.version.id}:${detail.line.id}`} editor={editor} detail={detail} />
        </div>
        <div className="oc-artwork-decision">
          {editor.version.document.productType === "shaped_pillow" && <OrderArtworkAudit key={`${detail.line.id}:${detail.line.revision}:${editor.version.id}`} orderId={detail.line.id} revision={detail.line.revision} versionId={editor.version.id} disabled={locked || !!detail.line.sourceChanged} onReport={setAuditReport} onBusy={setAuditBusy} />}
          <OrderArtworkChecks check={fileCheck} editor={editor} disabled={locked} onResolve={onResolve} />
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
            {canReview && (
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
                {candidate ? "驳回并交美工修改" : "驳回修改"}
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
          {canReview && !!reason.trim() && (
            <p className="oc-hint">已填写驳回理由；如需通过，请先清空理由。</p>
          )}
          {canSubmit && <p className="oc-hint">当前处于制图阶段，提交后由运营审核。</p>}
          {candidate && <p className="oc-hint">这是 Agent 生成的待审稿 顾客要求 原图和完整检查仍需核对 驳回后美工沿本单原项目修改</p>}
          {candidate && (!visible || auditBusy || !check?.productionReady) && <p className="oc-hint">原技术与视觉核对尚未全部满足 当前不能通过 可填写具体理由交美工修改</p>}
          {state === "approved" && (
            <p className={production?.status === "failed" ? "oc-error" : "oc-notice"} role="status">
              {production?.status === "completed" ? "审核已完成，生产文件已准备好，等待生产人员安排。"
                : production?.status === "queued" || production?.status === "processing" ? "审核已完成，系统正在后台准备生产文件。你可以继续审核下一单。"
                : production?.status === "failed" ? "审核已完成，生产文件生成异常，请由制图人员在生产中心处理。"
                : "审核已完成，生产文件尚未准备好，请由制图人员在生产中心处理。"}
            </p>
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
          {canSubmit && <button type="button" className="oc-button" disabled={disabled} onClick={onOpen}>
            编辑生产文件
          </button>}
        </div>
      </div>
      {decisionFooter && onAdvanceAction && (canReview || canReject) && createPortal(
        <div className="oc-review-quick-actions" role="group" aria-label="审图快速操作">
          {canReview && <button type="button" className="oc-button primary"
            disabled={decisionBlocked || !!reason.trim()} onClick={() => onAdvanceAction("approve_artwork")}>
            <Check size={16} />通过审核{hasNext ? "并下一单" : "并返回列表"}
          </button>}
          {canReject && <button type="button" className="oc-button" disabled={locked || !reason.trim()}
            onClick={() => onAdvanceAction("reject_artwork")}>
            {candidate ? "驳回并交美工修改" : "驳回修改"}{hasNext ? "并下一单" : "并返回列表"}
          </button>}
        </div>, decisionFooter,
      )}
    </section>
  );
}
