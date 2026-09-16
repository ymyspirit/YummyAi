"use client";

import type { FulfillmentSupplierView } from "@yummyai/contracts";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { MasterRecordDialog } from "./master-record-dialog";

export function SuppliersWorkspace({ suppliers, productCounts, compact = false }: { suppliers: FulfillmentSupplierView[]; productCounts?: Record<string, number>; compact?: boolean }) {
  const [editing, setEditing] = useState<FulfillmentSupplierView | "new">();
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("active");
  const router = useRouter();
  const filtered = suppliers.filter((supplier) => (compact || !status || supplier.status === status) && `${supplier.name} ${supplier.regionCode}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <>
    {!compact && <div className="record-toolbar"><button className="primary" onClick={() => setEditing("new")}><Plus size={15} />新增供应商</button><Link href="/procurement">创建采购单</Link><Link href="/supplier-performance">查看供应商绩效</Link></div>}
    {message && <p className="record-notice success" role="status">{message}</p>}
    {!compact && <label className="record-field"><span>搜索供应商</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名称或地区" /></label>}
    {!compact && <label className="record-field"><span>供应商状态</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="active">启用</option><option value="suspended">暂停</option><option value="archived">归档</option><option value="">全部</option></select></label>}
    {!suppliers.length ? <div className="record-notice">暂无供应商，点击“新增供应商”建立第一份档案。</div> : <div className="record-table-scroll"><table className="record-table"><thead><tr><th>供应商</th><th>类型</th><th>地区</th><th>结算币种</th><th>状态</th>{!compact && <th>供货产品</th>}<th>操作</th></tr></thead><tbody>{filtered.map((supplier) => <tr key={supplier.id}>
      <td>{compact ? supplier.name : <Link href={`/suppliers/${supplier.id}`}>{supplier.name}</Link>}</td><td>{{ manual: "合作供应商", printify: "Printify", printful: "Printful" }[supplier.kind]}</td><td>{supplier.regionCode}</td><td>{supplier.settlementCurrency}</td><td>{{ active: "启用", suspended: "暂停", archived: "归档" }[supplier.status]}</td>
      {!compact && <td><Link href={`/suppliers/${supplier.id}`}>{productCounts ? `${productCounts[supplier.id] ?? 0} 个产品` : "查看供应产品"}</Link></td>}
      <td><button aria-label={`编辑供应商 ${supplier.name}`} onClick={() => setEditing(supplier)}>编辑资料</button></td>
    </tr>)}</tbody></table>{!filtered.length && <p className="record-help">没有匹配的供应商，请调整搜索。</p>}</div>}
    {editing && <MasterRecordDialog kind="supplier" record={editing === "new" ? undefined : { ...editing }} onClose={() => setEditing(undefined)} onSaved={(saved) => { setEditing(undefined); setMessage(`供应商 ${saved.name} 已保存。`); router.refresh(); }} />}
  </>;
}
