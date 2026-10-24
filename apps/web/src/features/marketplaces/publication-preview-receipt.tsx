"use client";
import { useState, type ReactNode } from "react";
import { Ban, CircleAlert, FileClock, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useWorkflowReturn } from "../navigation/use-workflow-return";
import { workflowHref } from "../navigation/workflow-href";
import type { PublicationPreviewRequestView } from "@yummyai/contracts/marketplace/publication-preview";
import type { MarketplacePublicationEventView } from "@yummyai/contracts/marketplace/publication";
import { PublicationSubmitWorkspace } from "./publication-submit-workspace";

export const publicationStatusLabel = (status: string) => ({ queued: "原任务已保存", scheduled: "原计划已保存", processing: "处理中", validation_passed: "校验通过 未发布",
  validation_failed: "校验未通过", cancelled: "原任务已取消", failed: "原任务失败", retry_pending: "原任务等待重试", reconciliation_required: "原结果需核对",
  draft_created: "原平台草稿已创建", published: "原平台已发布", publication_failed: "原发布失败", deactivated: "原平台已停用",
  sync_pending: "原平台状态待同步", submission_accepted: "平台已接受提交", configuration_applied: "原配置已写入", media_uploaded: "原媒体已上传",
  activation_accepted: "平台已接受激活" }[status] ?? `原状态 ${status}`);
export const previewExecutionLabel = (state: string) => ({ waiting_node: "等待绑定节点", claimed: "节点已领取", running: "节点执行中", unknown_outcome: "节点结果未知",
  succeeded: "节点已完成", failed: "节点执行失败", cancelled: "节点任务已取消", expired: "原节点任务已到期", authority_changed: "原授权依据已变化" }[state] ?? state);
export function PreviewPair({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
export function PublicationPreviewReceipt({ value, events, busy, canCancel, onRefresh, onEvents, onCancel }: {
  value: PublicationPreviewRequestView; events: MarketplacePublicationEventView[] | null; busy: boolean; canCancel: boolean;
  onRefresh(): void; onEvents(): void; onCancel(reason: string): void;
}) {
  const [reason, setReason] = useState(""), request = value.request, { current, back } = useWorkflowReturn();
  const href = workflowHref(`/listings/${request.listingId}?${new URLSearchParams({ tab: "Publish", listingVersionId: request.listingVersionId, publicationRequestId: request.id })}`, back ?? current);
  return <section className="ppv-receipt" aria-label="原发布预览详情"><header className="ppv-heading"><h4><FileClock size={16} />{publicationStatusLabel(request.current.status)}</h4>
    <button type="button" disabled={busy} onClick={onRefresh}><RefreshCw size={14} />重新读取原预览</button></header>
    <p className="ppv-notice">{value.admission === "node_preview" ? "这是绑定节点的 Amazon 校验预览 不创建或发布平台 Listing 不自动继续正式提交 离线时不转中央执行" : "这是原发布流程的历史请求 保留原动作与结果 不转换为新节点预览"}</p>
    <div className="ppv-actions"><Link href={href} prefetch={false}>打开此原预览固定链接</Link></div>
    <dl className="ppv-facts"><PreviewPair label="完整原发布请求 ID"><code>{request.id}</code></PreviewPair><PreviewPair label="原动作">{request.action}</PreviewPair>
      <PreviewPair label="原账户 ID"><code>{request.accountId}</code></PreviewPair><PreviewPair label="原站点">{request.marketplaceId}</PreviewPair>
      <PreviewPair label="原 Listing ID"><code>{request.listingId}</code></PreviewPair><PreviewPair label="固定 Listing 版本 ID"><code>{request.listingVersionId}</code></PreviewPair>
      <PreviewPair label="原能力版本 ID"><code>{request.capabilitySnapshotId}</code></PreviewPair><PreviewPair label="原载荷校验值"><code>{request.payloadChecksum}</code></PreviewPair>
      <PreviewPair label="原服务幂等校验值"><code>{request.idempotencyKey}</code></PreviewPair><PreviewPair label="原建立时间"><time>{request.createdAt}</time></PreviewPair>
      <PreviewPair label="原父请求 ID"><code>{request.parentRequestId ?? "无父请求"}</code></PreviewPair><PreviewPair label="原资产数">{request.assetCount}</PreviewPair></dl>
    {value.intent && <details><summary>核对原意图与节点依据</summary><dl className="ppv-facts"><PreviewPair label="原请求键"><code>{value.intent.requestKey}</code></PreviewPair>
      <PreviewPair label="原目标校验值"><code>{value.intent.requestChecksum}</code></PreviewPair><PreviewPair label="固定节点 ID"><code>{value.intent.target.nodeId}</code></PreviewPair>
      <PreviewPair label="原绑定修订">{value.intent.target.bindingRevision}</PreviewPair><PreviewPair label="原证书代次">{value.intent.target.certificateGeneration}</PreviewPair>
      <PreviewPair label="原授权代次"><code>{value.intent.target.authorizationGeneration}</code></PreviewPair><PreviewPair label="原资产清单校验值"><code>{value.intent.target.assetManifestChecksum}</code></PreviewPair>
      <PreviewPair label="固定 SKU"><code>{value.intent.target.variantSkuId ?? "原请求未提供"}</code></PreviewPair></dl></details>}
    {value.execution && <dl className="ppv-facts"><PreviewPair label="原节点任务 ID"><code>{value.execution.id}</code></PreviewPair><PreviewPair label="节点实际状态">{previewExecutionLabel(value.execution.state)}</PreviewPair>
      <PreviewPair label="原执行阶段">{value.execution.phase}</PreviewPair><PreviewPair label="原节点截止时间">{value.execution.expiresAt}</PreviewPair>
      <PreviewPair label="原节点诊断"><code>{value.execution.errorCode ?? "未提供"}</code></PreviewPair></dl>}
    <PreviewEvent event={request.current} />
    <details><summary>原发布事件历史{events ? ` · ${events.length} 条` : ""}</summary><button disabled={busy} type="button" onClick={onEvents}>读取原发布事件</button>
      {events ? <ol className="ppv-events">{events.map(event => <li key={event.id}><PreviewEvent event={event} /></li>)}</ol> : <p>尚未读取原历史 当前回执不等于完整事件历史</p>}</details>
    {value.access.canContinue && <p className="ppv-caption">原请求另有后续动作 本节点预览工作区不自动继续 请回原发布控制明确核对</p>}
    {canCancel && <form className="ppv-cancel" onSubmit={event => { event.preventDefault(); if (reason.trim()) onCancel(reason.trim()); }}><label><span>取消原预览理由</span>
      <textarea maxLength={500} required value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
      <button type="submit" disabled={busy || !reason.trim()}><Ban size={14} />明确取消此原预览</button><p className="ppv-caption">取消由原服务当前状态裁决 不回滚已发生的外部操作 读取恢复不会触发取消</p></form>}
    {value.admission === "node_preview" && request.platform === "amazon" && <PublicationSubmitWorkspace previewRequestId={request.id} listingId={request.listingId} listingVersionId={request.listingVersionId} sourceBusy={busy} />}
  </section>;
}
function PreviewEvent({ event }: { event: MarketplacePublicationEventView }) {
  return <section className="ppv-event" aria-label={`原发布事件 ${event.sequence}`}><header><strong>{event.sequence} · {publicationStatusLabel(event.status)}</strong><time>{event.occurredAt}</time></header>
    <dl className="ppv-facts"><PreviewPair label="原事件 ID"><code>{event.id}</code></PreviewPair><PreviewPair label="原诊断代码"><code>{event.code ?? "未提供"}</code></PreviewPair>
      <PreviewPair label="外部 Listing ID"><code>{event.externalListingId ?? "未提供 不代表已创建"}</code></PreviewPair><PreviewPair label="平台提交 ID"><code>{event.externalSubmissionId ?? "未提供"}</code></PreviewPair>
      <PreviewPair label="平台原状态">{event.externalState ?? "未提供"}</PreviewPair></dl>
    {event.message && <p className="ppv-notice"><CircleAlert size={14} />{event.message}</p>}
    {event.issues.length ? <ul className="ppv-issues" aria-label="原平台校验问题">{event.issues.map((issue, i) => <li key={`${issue.code}:${i}`}><strong>{issue.severity} · {issue.code}</strong>{issue.path && <code>{issue.path}</code>}<p>{issue.message}</p></li>)}</ul> : <p className="ppv-caption">此事件未返回平台问题 不能据此承诺可发布或业务正确</p>}
  </section>;
}
