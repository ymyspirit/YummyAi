"use client";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { OrderReviewWorkspaceSchema, type OrderReviewWorkspace } from "@yummyai/contracts/order/review";
import { reviewMoney, reviewProfitLabels } from "./order-review-format";
import { allocationDimensionLabel } from "./order-review-panel";
import "./order-centers.css";
import "./order-review.css";

function beijingDate(value: Date) { return new Date(value.getTime() + 8 * 3600000).toISOString().slice(0, 10); }
function periodQuery(from: string, to: string) {
  return new URLSearchParams({ from: new Date(`${from}T00:00:00+08:00`).toISOString(),
    to: new Date(new Date(`${to}T00:00:00+08:00`).getTime() + 86400000).toISOString() });
}
export function OrderReviewWorkspacePanel() {
  const [from, setFrom] = useState(() => beijingDate(new Date(Date.now() - 29 * 86400000)));
  const [to, setTo] = useState(() => beijingDate(new Date()));
  const [sku, setSku] = useState(""), [platform, setPlatform] = useState("");
  const [query, setQuery] = useState(() => periodQuery(from, to).toString()), [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<OrderReviewWorkspace | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  useEffect(() => {
    const abort = new AbortController(); setData(null); setLoading(true); setError("");
    void fetch(`/api/order-centers/review${query ? `?${query}` : ""}`, { cache: "no-store", signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error(response.status === 403 ? "缺少订单、私有订单资料或财务读取权限。" : response.status === 401 ? "身份会话已失效，请重新登录。" : response.status === 400 ? "请选择不超过 93 天的有效日期范围。" : "复盘读取失败，请重试。");
      const next = OrderReviewWorkspaceSchema.parse(await response.json()); if (!abort.signal.aborted) setData(next);
    }).catch(error => { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : "复盘读取失败。"); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [query, refresh]);
  function apply(event: React.FormEvent) {
    event.preventDefault();
    const start = new Date(`${from}T00:00:00+08:00`), end = new Date(new Date(`${to}T00:00:00+08:00`).getTime() + 86400000);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || end.getTime() - start.getTime() > 93 * 86400000) { setError("请选择不超过 93 天的有效日期范围。"); return; }
    const params = periodQuery(from, to);
    if (sku.trim()) params.set("sku", sku.trim()); if (platform) params.set("platform", platform);
    setQuery(params.toString()); setRefresh(value => value + 1);
  }
  return <section className="or-workspace or-review" aria-label="SKU 履约与利润复盘" aria-busy={loading}>
    <form className="or-filters" onSubmit={apply}><label>下单开始日期<input type="date" value={from} required onChange={event => setFrom(event.target.value)} /></label>
      <label>结束日期（含当日）<input type="date" value={to} required onChange={event => setTo(event.target.value)} /></label>
      <label>平台<select value={platform} onChange={event => setPlatform(event.target.value)}><option value="">Amazon / Etsy</option><option value="amazon">Amazon</option><option value="etsy">Etsy</option></select></label>
      <label>销售 SKU<input value={sku} maxLength={150} placeholder="完整 SKU，可留空" onChange={event => setSku(event.target.value)} /></label>
      <button className="oc-button" type="submit" disabled={loading}><RefreshCw size={14} />读取复盘</button></form>
    <p className="or-note">日期按北京时间筛选下单时间；每次最多读取最近 50 单。一单有多个 SKU 时保留整单证据。</p>
    {loading && <p role="status">正在汇总实际履约节点、账本与返工证据…</p>}
    {error && <p role="alert" className="oc-error">{error}</p>}
    {data && <>
      <p className="or-scope">期间共有 {data.totalOrderCount} 单 · 成功读取 {data.orderCount} 单 · 读取失败 {data.failedOrderCount} 单{data.truncated ? " · 当前结果为部分范围，请缩小期间" : ""}</p>
      {data.diagnostics.length > 0 && <ul className="or-issues">{data.diagnostics.map(message => <li key={message}>{message}</li>)}</ul>}
      <p className="or-note">准时比例 = 已全量交运且有平台截止时间的商品中按时交运的比例；补做比例 = 本次读取商品中已建立补做单的比例。利润按相同币种、口径版本、分摊维度及固定版本集分别汇总，整单共用费用不会自动分摊到 SKU。</p>
      {data.groups.length ? <div className="or-scroll" tabIndex={0} aria-label="SKU 复盘表"><table className="or-table or-sku-table"><thead><tr><th>SKU / 固定版本</th><th>工厂</th><th>订单 / 件数</th><th>交运与准时比例</th><th>驳回 / 补做</th><th>已分配贡献利润</th></tr></thead><tbody>
        {data.groups.map((group, index) => <tr key={index}><td><strong>{group.skuCode ?? "SKU 待确认"}</strong><span>{group.specification ?? "规格待确认"}{group.specificationVersionNumber && ` V${group.specificationVersionNumber}`} · {group.recipeVersionNumber ? `配方 V${group.recipeVersionNumber}` : "无固定配方"}</span><code>{group.profileVersionId ? `工艺 ${group.profileVersionId}` : "无固定工艺版本"}</code></td>
          <td>{group.factoryName ?? (group.factoryStatus === "unknown" ? "工厂记录待读取" : group.factoryStatus === "multiple" ? "多个工厂，归属待拆分" : "未安排工厂")}</td>
          <td>{group.orderCount} 单 / {group.lineCount} 商品<small>{group.quantity} 件</small></td>
          <td>{group.onTimeBps === null ? "比例待核对" : `准时 ${(group.onTimeBps / 100).toFixed(1)}%`}<small>按时 {group.onTime} / 逾期 {group.late}</small><small>超期未交运 {group.overdue} / 待交运 {group.pending} / 缺依据 {group.unknownDeadline}</small></td>
          <td>审核 {group.reviewRejections ?? "待读取"} / 工厂拒收 {group.factoryRejections ?? "待读取"}<small>补做单 {group.remakeCount ?? "待读取"} 个 / {group.remakeQuantity ?? "待读取"} 件</small><small>商品补做比例 {group.remakeBps === null ? "待核对" : `${(group.remakeBps / 100).toFixed(1)}%`}</small></td>
          <td>{group.profitTotals.map(total => <span key={JSON.stringify([total.currency, total.metricVersionId, total.allocationDimension ?? null, total.allocationVersionSetChecksum ?? null])}><strong>{reviewMoney(total.profitMinor, total.currency)}</strong><small>口径 V{total.metricVersion} · {total.lineCount} 个商品</small><code>原口径版本 {total.metricVersionId}</code>{total.allocationVersionSetChecksum || total.allocationDimension ? <><small>分摊维度 {allocationDimensionLabel(total.allocationDimension)}</small><code>固定分摊版本集 {total.allocationVersionSetChecksum ?? "原版本集依据待核对"}</code></> : <small>未关联费用分摊依据 原事实直接归属核对</small>}</span>)}{!group.profitTotals.length && <strong>利润待核对 / 待分配</strong>}<small>已核验分配 {group.verifiedProfitLines} / 待核对或分配 {group.unallocatedProfitLines}</small></td></tr>)}</tbody></table></div> : <p className="or-note">该期间没有可读取的定制订单。请调整日期或 SKU。</p>}
      <h2>返回订单核对证据</h2><ul className="or-orders">{data.orders.map(order => <li key={order.orderId}><a href={`/production?line=${order.lineId}`}>{order.externalOrderId}</a><span>{reviewProfitLabels[order.profitStatus]} · {order.reworkCount} 条追溯记录</span>{order.diagnostics.length > 0 && <small>{order.diagnostics.join("；")}</small>}</li>)}</ul>
    </>}
  </section>;
}
