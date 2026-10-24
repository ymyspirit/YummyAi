"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, History, ShoppingCart } from "lucide-react";
import type { ProductSupplyView, ProductSupplyWorkspace, ProductSupplyVersionView } from "@yummyai/contracts/catalog/product-supply";
import { RecordDialog } from "../manual-operations/record-form";
import { loadProductSupplyHistory } from "./product-supply-actions";
import { ProductSupplyEditor, SupplyPurchaseDialog } from "./product-supply-forms";
import { unitNames } from "../manual-operations/operation-types";
import { formatMinorAmount } from "@yummyai/contracts/common/money";
import { formatStockQuantity } from "@yummyai/contracts/inventory/quantity";
import "./product-supply.css";
import { useWorkflowReturn } from "../navigation/use-workflow-return";

export const supplyModes = { custom_order: "定制订单", fba_replenishment: "FBA 备货" };
export const supplyStatus = { active: "供货中", paused: "暂停供货", discontinued: "停止供货" };
export const sampleStatus = { untested: "未验样", passed: "验样通过", failed: "验样未通过" };
export function supplyPrice(link: Pick<ProductSupplyView, "terms">) {
  return link.terms.unitCostMinor === null ? "待报价" : `${link.terms.currency} ${formatMinorAmount(link.terms.unitCostMinor, link.terms.currency)}`;
}

export function ProductSupplyWorkspacePanel({ data, productPlanId, supplierId }: {
  data: ProductSupplyWorkspace; productPlanId?: string; supplierId?: string;
}) {
  const router = useRouter();
  const workflow = useWorkflowReturn();
  const [editor, setEditor] = useState<ProductSupplyView | "new">();
  const [history, setHistory] = useState<ProductSupplyView>();
  const [purchase, setPurchase] = useState<ProductSupplyView>();
  const [message, setMessage] = useState("");
  const [orderId, setOrderId] = useState("");
  const [query, setQuery] = useState("");
  const links = data.links.filter((link) => (!productPlanId || link.productPlanId === productPlanId) && (!supplierId || link.supplierId === supplierId));
  const filtered = links.filter((link) => `${link.productName} ${link.supplierName} ${link.skuCode ?? ""} ${link.terms.specifications}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="product-supply-section" id="product-suppliers" aria-label={supplierId ? "供应产品" : "产品供应商"}>
    <header className="record-toolbar supply-heading"><div><h2>{supplierId ? "供应产品" : "产品供应商"}</h2><p>{links.length} 条供货关系 · 同一产品可按规格关联多个供应商</p></div>
      <button className="primary" onClick={() => setEditor("new")}><Plus size={15} />{supplierId ? "关联产品" : "关联供应商"}</button>
    </header>
    {message && <p className="record-notice success" role="status">{message} {orderId && <Link href={workflow.link(`/procurement?order=${orderId}`)}>查看采购草稿</Link>}</p>}
    {links.length > 0 && <label className="record-field supply-search"><span>搜索供货资料</span><input placeholder="产品、供应商或规格" value={query} onChange={(event) => setQuery(event.target.value)} /></label>}
    {!links.length ? <p className="record-notice">尚未建立供货关系。关联后可维护规格、采购价、起订量和交期，并从报价创建采购草稿。</p> : <div className="record-table-scroll"><table className="record-table supply-table"><thead><tr>
      <th>{supplierId ? "产品 / 规格" : "供应商 / 规格"}</th><th>用途 / 供货状态</th><th>采购价 / 起订量</th><th>交期 / 验样</th><th>操作</th>
    </tr></thead><tbody>{filtered.map((link) => <tr key={link.id}>
      <td><Link href={supplierId ? `/products?plan=${link.productPlanId}#product-suppliers` : `/suppliers/${link.supplierId}`}>{supplierId ? link.productName : link.supplierName}</Link>
        <span>{link.skuCode ?? "产品通用"}{link.terms.preference === "primary" ? " · 主供" : " · 备选"}</span>
        {link.terms.specifications && <span>{link.terms.specifications}</span>}
        {link.terms.supplierCode && <span>供方货号：{link.terms.supplierCode}</span>}
        {link.terms.purchaseUrl && <a href={link.terms.purchaseUrl} target="_blank" rel="noreferrer">采购链接 ↗</a>}
      </td>
      <td><span>{link.terms.fulfillmentModes.map((mode) => supplyModes[mode]).join("、")}</span><span>{supplyStatus[link.terms.status]}{link.supplierStatus !== "active" ? " · 供应商未启用" : ""}</span></td>
      <td><strong>{supplyPrice(link)}</strong><span>计价 {link.terms.priceBasisQuantity === undefined ? "原计价数量未单列" : `每 ${formatStockQuantity(link.terms.priceBasisQuantity)}`} {link.terms.purchaseUnit ? unitNames[link.terms.purchaseUnit] : "采购单位待核对"}</span><span>起订 {formatStockQuantity(link.terms.minimumOrderQuantity)} {unitLabel(link)}</span><span>报价 V{link.currentVersion} · {validity(link)}</span></td>
      <td><span>{link.terms.leadTimeDays === null ? "交期待确认" : `${link.terms.leadTimeDays} 天`}</span><span>{sampleStatus[link.terms.sampleStatus]}</span>{link.terms.process && <span>{link.terms.process}</span>}</td>
      <td><div className="supply-row-actions"><button onClick={() => setEditor(link)}>维护供货 / 报价</button><button onClick={() => setHistory(link)}><History size={14} />历史</button><button onClick={() => setPurchase(link)} disabled={link.terms.status !== "active" || link.supplierStatus !== "active"}><ShoppingCart size={14} />创建采购草稿</button></div></td>
    </tr>)}</tbody></table>{!filtered.length && <p className="record-help">没有匹配的供货记录。</p>}</div>}
    {editor && <ProductSupplyEditor data={data} link={editor === "new" ? undefined : editor} productPlanId={productPlanId} supplierId={supplierId} onClose={() => setEditor(undefined)} onSaved={() => { setEditor(undefined); setMessage("供货资料已保存，报价历史已保留。"); setOrderId(""); router.refresh(); }} />}
    {history && <SupplyHistory link={history} data={data} onClose={() => setHistory(undefined)} />}
    {purchase && <SupplyPurchaseDialog data={data} link={purchase} onClose={() => setPurchase(undefined)} onSaved={(record) => { setPurchase(undefined); setMessage(`采购草稿 ${record.code} 已创建。`); setOrderId(String(record.id)); router.refresh(); }} />}
  </section>;
}

function SupplyHistory({ link, data, onClose }: { link: ProductSupplyView; data: ProductSupplyWorkspace; onClose: () => void }) {
  const [versions, setVersions] = useState<ProductSupplyVersionView[]>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { let live = true; void loadProductSupplyHistory(link.id).then((result) => { if (live) { setVersions(result.versions); setError(result.error ?? ""); } }); return () => { live = false; }; }, [link.id, attempt]);
  return <RecordDialog title="供货与报价历史" onClose={onClose}><div className="supply-history"><p>{link.productName} · {link.supplierName} · {link.skuCode ?? "产品通用"}</p>
    {error ? <p className="record-notice error" role="alert">{error}<button onClick={() => { setError(""); setAttempt((value) => value + 1); }}>重试</button></p> : !versions ? <p role="status">正在读取历史…</p> : versions.map((version) => <article key={version.id}>
      <strong>V{version.version} · {supplyPrice(version)} · {new Date(version.createdAt).toLocaleString("zh-CN")}</strong>
      <p>{version.terms.fulfillmentModes.map((mode) => supplyModes[mode]).join("、")} · {supplyStatus[version.terms.status]} · {version.terms.preference === "primary" ? "主供" : "备选"}</p>
      <p>起订量 {formatStockQuantity(version.terms.minimumOrderQuantity)} {unitLabel(version)} · 计价 {version.terms.priceBasisQuantity === undefined ? "原计价数量未单列" : `每 ${formatStockQuantity(version.terms.priceBasisQuantity)}`} {version.terms.purchaseUnit ? unitNames[version.terms.purchaseUnit] : "采购单位待核对"} · 交期 {version.terms.leadTimeDays ?? "待确认"} 天 · {sampleStatus[version.terms.sampleStatus]}</p>
      <p>{version.terms.specifications || "规格待补充"} {version.terms.process}</p>
      <p>供方货号：{version.terms.supplierCode || "未填写"} · 库存物料：{data.stockItems.find((item) => item.id === version.terms.stockItemId)?.name ?? "未关联"}</p>
      {version.terms.purchaseUrl && <p><a href={version.terms.purchaseUrl} target="_blank" rel="noreferrer">查看该版本采购链接 ↗</a></p>}
      <p>有效期：{new Date(version.terms.validFrom).toLocaleString("zh-CN")} 至 {version.terms.validUntil ? new Date(version.terms.validUntil).toLocaleString("zh-CN") : "未设截止时间"}</p>
      {version.terms.notes && <p>{version.terms.notes}</p>}
    </article>)}
  </div></RecordDialog>;
}
function validity(link: ProductSupplyView) {
  if (new Date(link.terms.validFrom).getTime() > Date.now()) return "尚未生效";
  if (!link.terms.validUntil) return "未设截止时间";
  return `${Date.parse(link.terms.validUntil) <= Date.now() ? "已过期 · " : ""}${new Date(link.terms.validUntil).toLocaleDateString("zh-CN")} 到期`;
}
function unitLabel(link: Pick<ProductSupplyView, "terms">) {
  return link.terms.purchaseUnit ? unitNames[link.terms.purchaseUnit] : "原采购单位未单列";
}
