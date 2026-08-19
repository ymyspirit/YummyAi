"use client";

import type { ReviewStatus } from "@yummyai/contracts";
import { AlertTriangle, Check, CheckCircle2, Clock3, Download, FileLock2, MessageSquareWarning, Send, ShieldCheck, X } from "lucide-react";
import { useState } from "react";

export interface ReviewDrawerView {
  id: string;
  listingVersion: number;
  listingVersionId: string;
  platform: "amazon" | "etsy";
  locale: string;
  status: ReviewStatus;
  submittedBy: string;
  submittedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  rejectionReason?: string;
  invalidatedByVersion?: number;
  assets: Array<{ id: string; fileName: string; version: number; authorized: boolean; rightsApproved: boolean }>;
  blockers: number;
  warnings: number;
}

export function ReviewDrawer({ review, onClose }: { review: ReviewDrawerView; onClose?: () => void }) {
  const [reason, setReason] = useState(review.rejectionReason ?? "");
  const exportReady = review.status === "approved" && review.assets.every((asset) => asset.authorized && asset.rightsApproved);
  const canApprove = review.status === "pending" && review.blockers === 0 && review.assets.every((asset) => asset.authorized && asset.rightsApproved);

  return (
    <aside className="review-drawer" aria-labelledby="review-title">
      <header className="review-drawer-head">
        <div><p>LISTING REVIEW / LOCKED SNAPSHOT</p><h2 id="review-title">V{String(review.listingVersion).padStart(2, "0")} 审核凭证</h2></div>
        <button type="button" aria-label="关闭审核抽屉" onClick={onClose}><X size={19} /></button>
      </header>

      <div className={`review-state review-state-${review.status}`}>
        <span>{stateIcon(review.status)}</span>
        <div><strong>{stateLabel(review.status)}</strong><small>{stateSummary(review)}</small></div>
      </div>

      {review.status === "invalidated" && <div className="review-invalidated"><AlertTriangle size={17} /><p><strong>批准已自动失效</strong><span>Listing 已产生 V{String(review.invalidatedByVersion ?? review.listingVersion + 1).padStart(2, "0")}；请提交新版本重新审核。</span></p></div>}

      <section className="review-pin">
        <p className="review-section-code">PINNED INPUT</p>
        <dl><div><dt>CHANNEL</dt><dd>{review.platform.toUpperCase()} / {review.locale}</dd></div><div><dt>VERSION ID</dt><dd><code>{shortId(review.listingVersionId)}</code></dd></div><div><dt>SUBMITTED</dt><dd>{formatTime(review.submittedAt)}</dd></div><div><dt>OWNER</dt><dd>{review.submittedBy}</dd></div></dl>
      </section>

      <section className="review-gate">
        <header><div><p className="review-section-code">RELEASE GATE</p><h3>发布前检查</h3></div><span>{canApprove || exportReady ? "READY" : "ACTION"}</span></header>
        <ul>
          <Gate label="平台阻断规则" detail={`${review.blockers} blockers / ${review.warnings} warnings`} pass={review.blockers === 0} />
          <Gate label="素材均来自授权域" detail={`${review.assets.filter((asset) => asset.authorized).length} / ${review.assets.length} files`} pass={review.assets.every((asset) => asset.authorized)} />
          <Gate label="素材权利记录已批准" detail="Rights source and approver pinned" pass={review.assets.every((asset) => asset.rightsApproved)} />
          <Gate label="版本未发生后续变更" detail={`Listing version V${String(review.listingVersion).padStart(2, "0")}`} pass={review.status !== "invalidated"} />
        </ul>
      </section>

      <section className="review-assets">
        <p className="review-section-code">AUTHORIZED ASSET PINS</p><h3>导出素材版本</h3>
        <ul>{review.assets.map((asset) => <li key={asset.id}><FileLock2 size={16} /><span><strong>{asset.fileName}</strong><small>{shortId(asset.id)}</small></span><b>V{asset.version}</b><em className={asset.authorized && asset.rightsApproved ? "asset-pass" : "asset-risk"}>{asset.authorized && asset.rightsApproved ? "AUTHORIZED" : "BLOCKED"}</em></li>)}</ul>
      </section>

      {review.status === "pending" && <section className="review-decision">
        <label htmlFor="review-reason"><MessageSquareWarning size={15} />驳回原因 <span>驳回时必填</span></label>
        <textarea id="review-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="指出具体字段、素材或合规问题…" rows={3} />
        <div><button type="button" className="review-reject" disabled={reason.trim().length < 3}><X size={16} />驳回并退回</button><button type="button" className="review-approve" disabled={!canApprove}><Check size={16} />批准此版本</button></div>
      </section>}

      {review.status === "rejected" && <section className="review-rejection-note"><p className="review-section-code">REJECTION REASON</p><blockquote>{review.rejectionReason}</blockquote><button type="button"><Send size={15} />重新提交修订版本</button></section>}

      {review.status === "approved" && <footer className="review-export"><div><ShieldCheck size={18} /><p><strong>审批快照已锁定</strong><span>{review.decidedBy} · {review.decidedAt ? formatTime(review.decidedAt) : "刚刚"}</span></p></div><button type="button" disabled={!exportReady}><Download size={16} />生成不可变 ZIP</button></footer>}
    </aside>
  );
}

function Gate({ label, detail, pass }: { label: string; detail: string; pass: boolean }) { return <li><span className={pass ? "gate-pass" : "gate-fail"}>{pass ? <Check size={13} /> : <X size={13} />}</span><p><strong>{label}</strong><small>{detail}</small></p></li>; }
function stateIcon(status: ReviewStatus) { return status === "approved" ? <CheckCircle2 size={20} /> : status === "pending" ? <Clock3 size={20} /> : <AlertTriangle size={20} />; }
function stateLabel(status: ReviewStatus) { return ({ pending: "等待人工审核", approved: "已批准并锁定", rejected: "已驳回", invalidated: "批准已失效" })[status]; }
function stateSummary(review: ReviewDrawerView) { return review.status === "pending" ? "审批人需确认平台规则和素材权利" : review.status === "approved" ? "仅此版本可用于当前导出" : review.status === "rejected" ? "修改后需创建新审核记录" : "后续修改切断了旧批准与导出权限"; }
function shortId(value: string) { return `${value.slice(0, 8)}…${value.slice(-4)}`; }
function formatTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
