"use client";

import { CircleAlert, FileClock, RefreshCw } from "lucide-react";
import type { MarketplaceListingSyncAction, MarketplaceListingSyncEventView, MarketplaceListingSyncRequestView } from "@yummyai/contracts/marketplace/listing-operations";

export const listingSyncActionLabels: Record<MarketplaceListingSyncAction, string> = { read: "读取价格与库存", read_full_content: "读取完整内容",
  push_price_inventory: "写入批准价格与库存", push_full_content: "写入完整批准内容" };
export const listingSyncStatusLabels: Record<MarketplaceListingSyncRequestView["current"]["status"], string> = {
  queued: "原任务已保存", processing: "处理中", completed: "已完成本次核对", drift_detected: "发现差异",
  retry_pending: "原任务等待重试", reconciliation_required: "结果需对账", failed: "原任务失败",
};
export function ListingSyncPair({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}
export function ListingSyncReceipt({ request, events, requestKey, requestChecksum, busy, onRefresh, onReadEvents }: {
  request: MarketplaceListingSyncRequestView; events: MarketplaceListingSyncEventView[] | null; requestKey?: string; requestChecksum?: string;
  busy: boolean; onRefresh: () => void; onReadEvents: () => void;
}) {
  return <section className="lsi-receipt" aria-label="原同步请求详情"><header className="lsi-heading"><h4><FileClock size={16} />{listingSyncStatusLabels[request.current.status]}</h4>
    <button disabled={busy} onClick={onRefresh} type="button"><RefreshCw size={14} />重新读取原请求</button></header>
    <p>{request.current.status === "queued" ? "此状态只表示原同步任务已保存 不承诺已入队派发或平台已接受" :
      request.current.status === "reconciliation_required" ? "原平台结果需要对账 不能据此判断写入未发生 请保留原请求读取凭据" : "以下内容来自本笔原请求 不以今天的 Listing 或最新同步结果替代"}</p>
    <dl className="lsi-facts"><ListingSyncPair label="原同步请求 ID"><code>{request.id}</code></ListingSyncPair>
      <ListingSyncPair label="原账户 ID"><code>{request.accountId}</code></ListingSyncPair><ListingSyncPair label="原 Listing ID"><code>{request.listingId}</code></ListingSyncPair>
      <ListingSyncPair label="原 Listing 版本 ID"><code>{request.listingVersionId}</code></ListingSyncPair><ListingSyncPair label="原发布来源 ID"><code>{request.sourcePublicationRequestId}</code></ListingSyncPair>
      <ListingSyncPair label="原动作">{listingSyncActionLabels[request.action]}</ListingSyncPair><ListingSyncPair label="原平台与站点">{request.platform} · {request.marketplaceId}</ListingSyncPair>
      <ListingSyncPair label="原外部 Listing">{request.externalListingId}</ListingSyncPair><ListingSyncPair label="原意图键"><code>{requestKey ?? "此详情未附原意图键"}</code></ListingSyncPair>
      <ListingSyncPair label="原目标校验值"><code>{requestChecksum ?? "此详情未附客户端目标校验值"}</code></ListingSyncPair>
      <ListingSyncPair label="原服务幂等校验值"><code>{request.idempotencyKey}</code></ListingSyncPair><ListingSyncPair label="原期望状态校验值"><code>{request.desiredChecksum}</code></ListingSyncPair>
      <ListingSyncPair label="原创建时间"><time>{request.createdAt}</time></ListingSyncPair><ListingSyncPair label="原创建者 ID"><code>{request.createdBy ?? "历史未提供"}</code></ListingSyncPair>
    </dl>
    <SyncEvent event={request.current} />
    <details className="lsi-events"><summary>原事件历史{events ? ` · ${events.length} 条` : ""}</summary>
      <button disabled={busy} onClick={onReadEvents} type="button">读取原事件历史</button>
      {events ? <ol>{events.map(event => <li key={event.id}><SyncEvent event={event} /></li>)}</ol> : <p>尚未读取原事件历史 当前回执不代表完整历史</p>}
    </details>
  </section>;
}
function SyncEvent({ event }: { event: MarketplaceListingSyncEventView }) {
  return <section className="lsi-event" aria-label={`原同步事件 ${event.sequence}`}><header><strong>{event.sequence} · {listingSyncStatusLabels[event.status]}</strong><time>{event.occurredAt}</time></header>
    <dl className="lsi-facts"><ListingSyncPair label="原事件 ID"><code>{event.id}</code></ListingSyncPair><ListingSyncPair label="诊断代码"><code>{event.code ?? "未提供"}</code></ListingSyncPair>
      <ListingSyncPair label="原平台快照校验值"><code>{event.snapshotChecksum ?? "本事件未提供原平台快照校验值"}</code></ListingSyncPair></dl>
    {event.message && <p className="lsi-notice"><CircleAlert size={14} />{event.message}</p>}
    {event.issues.length > 0 && <ul className="lsi-issues" aria-label="原平台问题">{event.issues.map((issue, index) => <li key={`${issue.code}:${index}`}><strong>{issue.severity} · {issue.code}</strong>
      {issue.path && <code>{issue.path}</code>}<p>{issue.message}</p></li>)}</ul>}
    {event.snapshot ? <details className="lsi-snapshot"><summary>核对本事件原平台快照</summary><dl className="lsi-facts"><ListingSyncPair label="原平台状态">{event.snapshot.externalState}</ListingSyncPair>
      <ListingSyncPair label="原观察时间">{event.snapshot.observedAt}</ListingSyncPair></dl>
      <NativeValue label="原内容" value={event.snapshot.content} /><NativeValue label="原价格" value={event.snapshot.price} /><NativeValue label="原库存" value={event.snapshot.inventory} />
    </details> : <p className="lsi-caption">本事件没有原平台快照 未提供的价格和库存保持未知</p>}
  </section>;
}
function NativeValue({ label, value }: { label: string; value: unknown }) {
  return <section className="lsi-native-value"><h5>{label}</h5>{value === null || value === undefined ? <p>未提供 不等于 0</p> :
    typeof value === "object" ? <pre>{JSON.stringify(value, null, 2)}</pre> : <p>{String(value)}</p>}</section>;
}
