"use client";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { OrderReviewViewSchema, type OrderReviewView } from "@yummyai/contracts/order/review";
import { centerRequest, dateTime } from "./order-center-model";
import { reviewDeadlineLabels, reviewFactLabels, reviewMinutes, reviewMoney, reviewProfitLabels } from "./order-review-format";
import "./order-review.css";

export function OrderReviewPanel({ lineId, refreshToken = 0 }: { lineId: string; refreshToken?: number }) {
  const [data, setData] = useState<OrderReviewView | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setData(null); setLoading(true); setError("");
    void centerRequest(`lines/${lineId}/review`, undefined, abort.signal)
      .then(value => { if (!abort.signal.aborted) setData(OrderReviewViewSchema.parse(value)); })
      .catch(() => { if (!abort.signal.aborted) setError("复盘暂时无法读取，或当前成员缺少订单读取权限。"); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [lineId, refreshToken, refresh]);
  return <section className="or-review" aria-label="履约与利润复盘" aria-busy={loading}>
    <div className="or-heading"><div><h2>履约与利润复盘</h2><p>核对本单现有费用、实际节点和返工记录。</p></div>
      <button className="oc-button" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} />重新读取复盘</button></div>
    {loading && <p role="status">正在关联本单财务、工厂和交运证据…</p>}
    {error && <p role="alert" className="oc-error">{error}</p>}
    {data && <OrderReviewContent data={data} />}
  </section>;
}

export function OrderReviewContent({ data }: { data: OrderReviewView }) {
  const profit = data.profit;
  return <>
    <div className="or-heading"><strong>{reviewProfitLabels[profit.status]}</strong><small>读取于 {dateTime(data.builtAt)}</small></div>
    <dl className="or-profit"><div><dt>核验收入</dt><dd>{reviewMoney(profit.revenueMinor, profit.currency)}</dd></div>
      <div><dt>核验成本</dt><dd>{reviewMoney(profit.costMinor, profit.currency)}</dd></div>
      <div><dt>贡献利润</dt><dd className={profit.profitMinor !== null && profit.profitMinor < 0 ? "oc-error" : ""}>{reviewMoney(profit.profitMinor, profit.currency)}</dd></div></dl>
    {(profit.runId || profit.allocationRunId || profit.allocationVersionSetChecksum || profit.allocationDimension) && <div className="or-note" aria-label="利润原计算与分摊依据"><span>原基础计算 ID</span><code>{profit.runId ?? "原基础计算 ID 待核对"}</code><span>口径 {profit.metricVersion === null ? "版本待核对" : `V${profit.metricVersion}`} · {dateTime(profit.calculatedAt)} 利润仅覆盖所选口径和已入账费用</span>
      {profit.allocationRunId || profit.allocationVersionSetChecksum || profit.allocationDimension ? <><span>独立分摊计算 ID</span><code>{profit.allocationRunId ?? "分摊计算 ID 待核对"}</code><span>分摊维度 {allocationDimensionLabel(profit.allocationDimension)}</span><span>固定分摊版本集校验值</span><code>{profit.allocationVersionSetChecksum ?? "原版本集依据待核对"}</code></> : <span>未关联费用分摊依据 仅核对原事实的直接归属 不自动分摊整单共用费用</span>}
    </div>}
    {profit.blockers.length > 0 && <ul className="or-issues">{profit.blockers.map(message => <li key={message}>{message}</li>)}</ul>}
    <div className="or-links"><a href="/finance/order-review">查看 SKU 履约与利润汇总</a><a href="/finance">查看财务账本与计算</a></div>
    <section><h3>费用证据</h3><p className="or-note">报价、费用报告和退款决定独立显示；入账金额见下方账本。两处金额不会重复相加。</p>
      {data.costs.length ? <div className="or-scroll" tabIndex={0} aria-label="费用证据表"><table className="or-table"><thead><tr><th>来源</th><th>确认状态</th><th>金额</th><th>入账匹配</th><th>依据</th></tr></thead><tbody>
        {data.costs.map(cost => <tr key={`${cost.source}:${cost.id}`}><td>{({ model: "模型", factory: "工厂返工", refund: "退款决定", shipment: "运单" })[cost.source]}</td>
          <td>{({ quote: "报价", confirmed: "已确认费用证据", unknown: "未知费用", not_required: "无需付费模型" })[cost.basis]}{!cost.current && <small>历史报价 / 费用状态</small>}</td>
          <td>{cost.amountUsd !== null ? `USD ${cost.amountUsd.toFixed(6)}` : reviewMoney(cost.amountMinor, cost.currency)}</td>
          <td>{cost.basis === "not_required" ? "无需模型费" : cost.ledgerFactIds.length ? `${cost.ledgerFactIds.length} 条账本事实` : "待入账 / 待核对"}</td>
          <td><span>{cost.note}</span><code>{cost.reference ?? "尚无费用凭证"}</code></td></tr>)}</tbody></table></div> : <p className="or-note">尚无模型、工厂返工、退款或运单费用证据。不能据此判断费用为零。</p>}
      <details><summary>本单已入账事实 · {data.facts.length} 条</summary>
        {data.facts.length ? <div className="or-scroll" tabIndex={0} aria-label="本单财务事实表"><table className="or-table"><thead><tr><th>事实</th><th>金额 / 方向</th><th>更正关系</th><th>商品归属</th><th>单据与凭证</th></tr></thead><tbody>
          {data.facts.map(fact => <tr key={fact.id}><td>{reviewFactLabels[fact.factType]}<small>{dateTime(fact.occurredAt)}</small></td><td>{reviewMoney(fact.amountMinor, fact.currency)}<small>{fact.direction === "debit" ? "支出" : "收入 / 冲减支出"}</small></td>
            <td>{({ original: "原始记录", reversal: "冲销", replacement: "替换记录" })[fact.correctionKind]}{fact.correctsFactId && <code>{fact.correctsFactId}</code>}</td>
            <td>{fact.orderLineId ? data.lines.find(line => line.id === fact.orderLineId)?.skuCode ?? "商品 SKU 待确认" : "整单金额，尚未分配商品"}</td>
            <td><code>{fact.statementId}</code><span>{fact.externalReference ?? "未提供外部凭证"}</span></td></tr>)}</tbody></table></div> : <p className="or-note">本单尚无归属明确的财务事实。</p>}
      </details>
    </section>
    {data.lines.map(line => <section className="or-line" key={line.id} aria-label={`商品复盘 ${line.skuCode ?? line.id}`}>
      <h3>{line.skuCode ?? "SKU 待确认"} · {line.quantity} 件</h3><p className="or-note">{line.specification ?? "固定规格待确认"}{line.specificationVersionNumber && ` V${line.specificationVersionNumber}`} · {line.recipeVersionNumber ? `配方 V${line.recipeVersionNumber}` : "无固定配方"} · {line.factoryName ?? (line.factoryStatus === "unknown" ? "工厂记录待读取" : line.factoryStatus === "multiple" ? "多个工厂，待拆分归属" : "尚未安排工厂")}</p>
      <p><strong>{reviewDeadlineLabels[line.deadline.status]}</strong> · 实际交运 {line.deadline.handedOverQuantity}/{line.quantity} 件</p>
      <p className="or-note">平台截止 {dateTime(line.deadline.shipByAt)} · 全量交运 {dateTime(line.deadline.handedOverAt)}{line.deadline.lateMinutes !== null && line.deadline.lateMinutes > 0 ? ` · 超时 ${reviewMinutes(line.deadline.lateMinutes)}` : ""}</p>
      {line.blockers.length > 0 && <ul className="or-issues">{line.blockers.map(message => <li key={message}>{message}</li>)}</ul>}
      <dl className="or-durations">{line.durations.map(duration => <div key={duration.label}><dt>{duration.label}</dt><dd>{duration.status === "invalid" ? "事件时间不一致，待核对" : reviewMinutes(duration.minutes)}{duration.status === "pending" && " · 当前等待"}</dd></div>)}</dl>
      <p className="or-note">审核驳回 {line.reviewRejections ?? "待读取"} 次 · 工厂拒收 {line.factoryRejections ?? "待读取"} 次 · 已建立补做单 {line.remakeCount ?? "待读取"} 个 / {line.remakeQuantity ?? "待读取"} 件。耗时按实际记录节点计算，首次完工不代表全单质检通过。</p>
      <details><summary>查看节点与固定版本 · {line.events.length} 条</summary><ol className="or-events">{line.events.map((event, index) => <li key={`${event.id}:${index}`}><time>{dateTime(event.occurredAt)}</time><div><strong>{event.label}{event.versionNumber !== null ? ` · V${event.versionNumber}` : ""}</strong><code>{event.reference}</code>{event.versionId && <code>原版本 {event.versionId}</code>}{event.note && <small>{event.note}</small>}</div></li>)}</ol>{!line.events.length && <p className="or-note">尚无可核对的履约事件。</p>}</details>
    </section>)}
    <section><h3>返工原因与版本追溯</h3><p className="or-note">下列原因来自审核、工厂回执和生产恢复记录；责任归属以原凭证和人工核对为准。</p>
      {data.rework.map(record => <article className="or-rework" key={`${record.source}:${record.id}`}><strong>{({ review: "审核记录", factory: "工厂回执", recovery: "生产恢复" })[record.source]} · {record.kind}</strong><small>{dateTime(record.occurredAt)} · {record.affectedQuantity ? `${record.affectedQuantity} 件` : "数量待核对"}</small><p>{record.reason}</p><code>依据 {record.reference ?? "见原记录"}</code>
        {(record.originalVersionId || record.replacementVersionId) && <p>原稿 {record.originalVersionNumber ? `V${record.originalVersionNumber} · ` : ""}{record.originalVersionId ?? "待核对"}<br />替换稿 {record.replacementVersionNumber ? `V${record.replacementVersionNumber} · ` : ""}{record.replacementVersionId ?? "未关联替换版本"}</p>}
        {record.replacementProductionOrderId && <code>替换生产单 {record.replacementProductionOrderId}</code>}</article>)}
      {!data.rework.length && <p className="or-note">当前读取范围没有返工记录。读取失败或历史缺失不代表从未返工。</p>}
    </section>
  </>;
}

export function allocationDimensionLabel(value: string | null | undefined) {
  const labels: Record<string, string> = { order: "订单", order_line: "订单行", sku: "SKU", listing: "刊登", period: "UTC 自然月" };
  return value ? labels[value] ?? "维度待核对" : "维度待核对";
}
