"use client";
import { useState, type ReactNode } from "react";
import { Ban, FileCheck2, RefreshCw } from "lucide-react";
import type { PublicationSubmitRequestView, PublicationStatusReadView } from "@yummyai/contracts/marketplace/publication-submit";

export function SubmissionPair({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
export const submissionStateLabel = (state: string) => ({ queued: "原正式任务已保存", processing: "处理中", submission_accepted: "平台已接受提交 尚未证明可售", sync_pending: "平台状态待同步",
  published: "平台观察为已发布", publication_failed: "平台刊登未完成", deactivated: "平台状态为停用", cancelled: "原任务已取消", reconciliation_required: "原正式提交结果未知 需核对",
  failed: "原正式任务失败", retry_pending: "等待原任务处理", scheduled: "原计划已保存" }[state] ?? `原状态 ${state}`);
export const submissionExecutionLabel = (state: string) => ({ waiting_node: "等待绑定节点", claimed: "节点已领取", running: "节点执行中", unknown_outcome: "平台请求结果未知",
  succeeded: "节点回执已保存", failed: "节点执行失败", cancelled: "节点任务已取消", expired: "节点任务已到期", authority_changed: "原授权依据已变化" }[state] ?? state);
export function PublicationStatusReceipt({ value }: { value: PublicationStatusReadView }) {
  return <section className="psu-status" aria-label={`原平台状态观察 ${value.id}`}><h4>独立平台状态观察</h4>
    {value.target.sourceSubmissionId === null ? <p className="psu-warning" role="status">仅按原 SKU 查询 不能证明原未知 PUT 已成功 不能据此将原正式提交标为成功</p> : <p>SKU 当前状态观察 不能单独证明本次版本全部内容已生效 {value.adoptedAsRequestStatus ? "原服务已将此观察采纳为原请求状态" : "此观察未被采纳为原请求状态"}</p>}
    <dl className="psu-facts"><SubmissionPair label="状态查询 ID"><code>{value.id}</code></SubmissionPair><SubmissionPair label="原查询请求键"><code>{value.requestKey}</code></SubmissionPair>
      <SubmissionPair label="原查询校验值"><code>{value.requestChecksum}</code></SubmissionPair><SubmissionPair label="原正式请求 ID"><code>{value.requestId}</code></SubmissionPair>
      <SubmissionPair label="所引平台提交 ID"><code>{value.target.sourceSubmissionId ?? "未取得 仅 SKU 观察"}</code></SubmissionPair><SubmissionPair label="查询节点状态">{submissionExecutionLabel(value.execution.state)}</SubmissionPair>
      <SubmissionPair label="原 SKU"><code>{value.target.sku}</code></SubmissionPair><SubmissionPair label="查询节点 ID"><code>{value.execution.nodeId}</code></SubmissionPair>
      <SubmissionPair label="节点诊断"><code>{value.execution.errorCode ?? "未提供"}</code></SubmissionPair></dl>
    <details><summary>独立查询原固定依据</summary><dl className="psu-facts"><SubmissionPair label="原账户 ID"><code>{value.target.accountId}</code></SubmissionPair>
      <SubmissionPair label="原 Listing ID"><code>{value.target.listingId}</code></SubmissionPair><SubmissionPair label="原 Listing 版本 ID"><code>{value.target.listingVersionId}</code></SubmissionPair>
      <SubmissionPair label="原站点">{value.target.marketplaceId}</SubmissionPair><SubmissionPair label="原载荷校验值"><code>{value.target.payloadChecksum}</code></SubmissionPair>
      <SubmissionPair label="原资产清单校验值"><code>{value.target.assetManifestChecksum}</code></SubmissionPair><SubmissionPair label="原能力版本 ID"><code>{value.target.capabilitySnapshotId}</code></SubmissionPair>
      <SubmissionPair label="所引原正式节点任务 ID"><code>{value.target.submissionExecutionId}</code></SubmissionPair><SubmissionPair label="所引原正式目标校验值"><code>{value.target.submissionTargetChecksum}</code></SubmissionPair>
      <SubmissionPair label="所引原事件 ID"><code>{value.target.sourceEventId}</code></SubmissionPair><SubmissionPair label="所引原事件序号">{value.target.sourceEventSequence}</SubmissionPair>
      <SubmissionPair label="查询证书代次">{value.execution.certificateGeneration}</SubmissionPair><SubmissionPair label="查询绑定修订">{value.execution.bindingRevision}</SubmissionPair>
      <SubmissionPair label="查询授权代次"><code>{value.execution.authorizationGeneration}</code></SubmissionPair></dl></details>
    {value.result ? <><p>平台观察结果 {submissionStateLabel(value.result.status)}</p><dl className="psu-facts"><SubmissionPair label="平台 Listing ID"><code>{value.result.externalListingId}</code></SubmissionPair>
      <SubmissionPair label="平台原状态">{value.result.externalState}</SubmissionPair><SubmissionPair label="实际观察时间"><time>{value.result.submittedAt}</time></SubmissionPair></dl><SubmissionIssues issues={value.result.issues} /></> : <p>本次尚无平台状态结果 不表示不存在 Listing</p>}
  </section>;
}
function SubmissionIssues({ issues }: { issues: PublicationSubmitRequestView["request"]["current"]["issues"] }) {
  return issues.length ? <ul className="psu-issues" aria-label="原正式刊登问题">{issues.map((issue, index) => <li key={`${issue.code}:${index}`}><strong>{issue.severity} · {issue.code}</strong>{issue.path && <code>{issue.path}</code>}<p>{issue.message}</p></li>)}</ul> : <p>当前回执没有返回问题 不代表业务内容已完整或保证可售</p>;
}
export function PublicationSubmitReceipt({ value, busy, cancelBlocked, onRefresh, onCancel }: { value: PublicationSubmitRequestView; busy: boolean; cancelBlocked: boolean; onRefresh(): void; onCancel(reason: string): void }) {
  const [reason, setReason] = useState("");
  const { request, intent, execution, result } = value;
  return <section className="psu-receipt" aria-label="原正式提交回执"><header className="psu-heading"><h4><FileCheck2 size={16} />{submissionStateLabel(request.current.status)}</h4><button type="button" disabled={busy} onClick={onRefresh}><RefreshCw size={14} />重新读取原正式请求</button></header>
    <p>本次正式提交会完整替换所选站点的原 SKU 内容 校验通过与平台接受提交均不等于已经可售</p>
    <dl className="psu-facts"><SubmissionPair label="完整原正式请求 ID"><code>{request.id}</code></SubmissionPair><SubmissionPair label="原预览父请求 ID"><code>{request.parentRequestId}</code></SubmissionPair>
      <SubmissionPair label="原请求键"><code>{intent.requestKey}</code></SubmissionPair><SubmissionPair label="原目标校验值"><code>{intent.requestChecksum}</code></SubmissionPair>
      <SubmissionPair label="原账户 ID"><code>{request.accountId}</code></SubmissionPair><SubmissionPair label="原站点">{request.marketplaceId}</SubmissionPair>
      <SubmissionPair label="原 Listing ID"><code>{request.listingId}</code></SubmissionPair><SubmissionPair label="原能力版本 ID"><code>{request.capabilitySnapshotId}</code></SubmissionPair>
      <SubmissionPair label="原 SKU"><code>{intent.target.sku}</code></SubmissionPair><SubmissionPair label="原 Listing 版本 ID"><code>{request.listingVersionId}</code></SubmissionPair>
      <SubmissionPair label="原载荷校验值"><code>{request.payloadChecksum}</code></SubmissionPair><SubmissionPair label="原资产清单校验值"><code>{intent.target.assetManifestChecksum}</code></SubmissionPair>
      <SubmissionPair label="原节点任务 ID"><code>{execution.id}</code></SubmissionPair><SubmissionPair label="节点实际状态">{submissionExecutionLabel(execution.state)}</SubmissionPair>
      <SubmissionPair label="原节点 ID"><code>{execution.nodeId}</code></SubmissionPair><SubmissionPair label="原证书代次">{execution.certificateGeneration}</SubmissionPair>
      <SubmissionPair label="原绑定修订">{execution.bindingRevision}</SubmissionPair><SubmissionPair label="原授权代次"><code>{execution.authorizationGeneration}</code></SubmissionPair>
      <SubmissionPair label="平台提交 ID"><code>{result?.externalSubmissionId ?? request.current.externalSubmissionId ?? "未取得 不证明已提交"}</code></SubmissionPair>
      <SubmissionPair label="节点诊断"><code>{execution.errorCode ?? "未提供"}</code></SubmissionPair></dl>
    {execution.state === "unknown_outcome" || request.current.status === "reconciliation_required" ? <p className="psu-warning" role="status">原正式 PUT 结果未知 只核对原回执或明确查询平台状态 不换键重新提交</p> : null}
    {result && <><p>正式请求平台回执 {submissionStateLabel(result.status)}</p><dl className="psu-facts"><SubmissionPair label="平台原状态">{result.externalState}</SubmissionPair><SubmissionPair label="平台 Listing ID"><code>{result.externalListingId}</code></SubmissionPair><SubmissionPair label="平台回执时间"><time>{result.submittedAt}</time></SubmissionPair></dl><SubmissionIssues issues={result.issues} /></>}
    <details><summary>原预览依据与当前事件</summary><dl className="psu-facts"><SubmissionPair label="所引原预览事件 ID"><code>{intent.target.previewEventId}</code></SubmissionPair>
      <SubmissionPair label="所引原预览事件序号">{intent.target.previewEventSequence}</SubmissionPair><SubmissionPair label="所引原预览节点任务 ID"><code>{intent.target.previewExecutionId}</code></SubmissionPair>
      <SubmissionPair label="原事件 ID"><code>{request.current.id}</code></SubmissionPair><SubmissionPair label="事件序号">{request.current.sequence}</SubmissionPair><SubmissionPair label="事件时间"><time>{request.current.occurredAt}</time></SubmissionPair></dl><SubmissionIssues issues={request.current.issues} /></details>
    <details><summary>近期独立状态查询 · {value.statusReads.length} 条</summary><p>本清单最多 20 条 不是完整历史 每笔查询保留自己的原键与节点回执</p>{value.statusReads.map(row => <PublicationStatusReceipt key={row.id + ":" + row.execution.updatedAt} value={row} />)}</details>
    {value.access.canCancel && <form className="psu-cancel" onSubmit={event => { event.preventDefault(); if (!busy && !cancelBlocked && reason.trim()) onCancel(reason.trim()); }}><label><span>取消原正式请求理由</span><input required maxLength={500} value={reason} disabled={busy || cancelBlocked} onChange={event => setReason(event.target.value)} /></label><button type="submit" disabled={busy || cancelBlocked || !reason.trim()}><Ban size={14} />明确取消尚未执行的原正式请求</button><p>取消由原服务当前状态裁决 不撤回已经发生的平台操作</p></form>}
    {cancelBlocked && <p className="psu-warning">当前取消入口不可用 请只读取原正式请求 不自动重发取消</p>}
  </section>;
}
