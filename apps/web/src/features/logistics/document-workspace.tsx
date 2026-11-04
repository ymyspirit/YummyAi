"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileSpreadsheet, RefreshCw, Search } from "lucide-react";
import type { DocumentAdapter, DocumentExportView, DocumentOptions, DocumentParcelOverride, OrderDocumentsPreview, PreviewOrderDocuments } from "@yummyai/contracts/logistics/documents";
import { ProductionDeliveryWorkspaceSchema, type ProductionDeliveryPackageView } from "@yummyai/contracts/order/production-delivery";
import { centerRead } from "../order-centers/order-center-model";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import { DocumentProfileForm } from "./document-profile-form";
import { DocumentLabelPanel } from "./document-label-panel";
import { documentRequest } from "./document-client";
import { logisticsError } from "./logistics-client";
import "./documents.css";

export const documentLabels: Record<DocumentAdapter, string> = { printeque_shipping: "Printeque 快递打单表", printeque_factory: "Printeque 工厂生产表", yunexpress: "云途标准模板" };
export function DocumentWorkspace({ orderId }: { orderId?: string }) {
  const [options, setOptions] = useState<DocumentOptions | null>(null), [history, setHistory] = useState<DocumentExportView[]>([]);
  const [selected, setSelected] = useState<string[]>(orderId ? [orderId] : []), [profileId, setProfileId] = useState(""), [adapter, setAdapter] = useState<DocumentAdapter>("printeque_shipping");
  const [preview, setPreview] = useState<OrderDocumentsPreview | null>(null), [overrides, setOverrides] = useState<DocumentParcelOverride[]>([]);
  const [packages, setPackages] = useState<ProductionDeliveryPackageView[]>([]), [packageIds, setPackageIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [query, setQuery] = useState("");
  const [profileState, setProfileState] = useState({ dirty: false, busy: false }), [labelState, setLabelState] = useState({ dirty: false, busy: false });
  const blocked = busy || profileState.dirty || profileState.busy || labelState.dirty || labelState.busy;
  const alive = useRef(true), generation = useRef(0), active = useRef<AbortController | null>(null), key = useRef(crypto.randomUUID());
  const selectionRef = useRef<PreviewOrderDocuments | null>(null);
  useLeaveGuard(overrides.length > 0 && !notice, busy);
  const clear = useCallback(() => { generation.current++; setOptions(null); setHistory([]); setPreview(null); setPackages([]); setSelected([]); setOverrides([]); setPackageIds([]); selectionRef.current = null; }, []);
  const handleError = useCallback((cause: unknown) => { if (cause && typeof cause === "object" && "status" in cause && [401, 403].includes(Number(cause.status))) clear(); setError(logisticsError(cause)); }, [clear]);
  const reload = useCallback(async (search = "", signal?: AbortSignal) => {
    const version = ++generation.current;
    const qs = new URLSearchParams(); if (orderId) qs.set("orderId", orderId); if (search) qs.set("q", search);
    const [next, past] = await Promise.all([documentRequest<DocumentOptions>(`options?${qs}`, undefined, signal), documentRequest<{ exports: DocumentExportView[] }>(`exports${orderId ? `?orderId=${orderId}` : ""}`, undefined, signal)]);
    if (!alive.current || signal?.aborted || version !== generation.current) return;
    setOptions(next); setHistory(past.exports);
    setSelected(previous => previous.filter(id => next.orders.some(order => order.id === id)));
    setProfileId(previous => next.profiles.some(profile => profile.id === previous) ? previous : next.profiles[0]?.id ?? "");
    setPreview(null); setPackages([]); setPackageIds([]); selectionRef.current = null;
  }, [orderId]);
  useEffect(() => {
    alive.current = true; const ctl = new AbortController(); active.current = ctl;
    void reload("", ctl.signal).catch(cause => { if (!ctl.signal.aborted) handleError(cause); }).finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    return () => { alive.current = false; generation.current++; ctl.abort(); active.current?.abort(); };
  }, [reload, handleError]);
  function invalidate() { generation.current++; setPreview(null); setNotice(""); selectionRef.current = null; key.current = crypto.randomUUID(); }
  const profile = options?.profiles.find(row => row.id === profileId);
  const adapters: DocumentAdapter[] = profile?.profile.route === "yunexpress" ? ["yunexpress"] : profile?.profile.productionAdapter === "printeque_factory" ? ["printeque_shipping", "printeque_factory"] : ["printeque_shipping"];
  const currentAdapter = adapters.includes(adapter) ? adapter : adapters[0]!;
  async function run(task: () => Promise<void>) { if (blocked) return; setBusy(true); setError(""); try { await task(); } catch (cause) { if (alive.current) handleError(cause); } finally { if (alive.current) setBusy(false); } }
  function selection(): PreviewOrderDocuments { return { profileVersionId: profileId, adapter: currentAdapter, orderIds: selected, overrides, deliveryPackageIds: currentAdapter === "printeque_factory" ? packageIds : [] }; }
  async function inspect() {
    const input = selection(), version = ++generation.current; active.current?.abort(); const ctl = new AbortController(); active.current = ctl;
    const result = await documentRequest<OrderDocumentsPreview>("preview", input, ctl.signal);
    if (!alive.current || version !== generation.current) return;
    selectionRef.current = input; setPreview(result); setNotice("");
  }
  async function generate() {
    if (!preview?.ready || !selectionRef.current) return;
    const version = generation.current;
    const result = await documentRequest<{ id: string; reused: boolean }>("generate", { ...selectionRef.current, expectedFingerprint: preview.fingerprint, idempotencyKey: key.current });
    if (!alive.current || version !== generation.current) return;
    setNotice(result.reused ? "已复用同一版本的导出文件 未新增重复记录" : "文件已生成 请下载后导入对应系统");
    const past = await documentRequest<{ exports: DocumentExportView[] }>(`exports${orderId ? `?orderId=${orderId}` : ""}`);
    if (alive.current && version === generation.current) setHistory(past.exports);
  }
  async function loadPackages() {
    active.current?.abort(); const ctl = new AbortController(); active.current = ctl; const version = ++generation.current;
    const results = await Promise.all(selected.map(id => centerRead(`deliveries?order=${id}`, ctl.signal).then(value => ProductionDeliveryWorkspaceSchema.parse(value))));
    if (!alive.current || ctl.signal.aborted || version !== generation.current) return;
    setPackages([...new Map(results.flatMap(result => result.packages).map(packet => [packet.id, packet])).values()]); setPackageIds([]); setPreview(null);
  }
  function updateOverride(orderId: string, update: Partial<DocumentParcelOverride>) {
    invalidate(); setOverrides(values => { const previous = values.find(value => value.orderId === orderId) ?? { orderId, reason: "" }; return [...values.filter(value => value.orderId !== orderId), { ...previous, ...update }]; });
  }
  return <section className="logistics-section documents" id="documents" aria-label="工厂导单与物流表" aria-busy={busy || loading}>
    <header className="document-heading"><h2><FileSpreadsheet size={19}/>工厂导单与物流表</h2><button className="oc-button" disabled={blocked || loading} onClick={() => void run(() => reload(query))}><RefreshCw size={15}/>刷新单据</button></header>
    <p className="oc-muted">选择整单和实际工厂 预检包裹后生成导入文件 同一订单多个商品共用一张物流面单</p>
    {loading && <p role="status">正在读取订单与工厂配置</p>}{error && <p role="alert" className="logistics-error">{error}</p>}
    {options && <>
      {!orderId && <form className="document-search" onSubmit={event => { event.preventDefault(); void run(() => reload(query)); }}><label>订单号<input aria-label="查找导单订单" value={query} maxLength={100} onChange={e => setQuery(e.target.value)} disabled={busy}/></label><button className="oc-button" disabled={busy}><Search size={15}/>查找</button></form>}
      <div className="document-orders" role="group" aria-label="选择整单">{options.orders.map(order => <label className="document-order" key={order.id}><input type="checkbox" disabled={blocked} checked={selected.includes(order.id)} onChange={e => { invalidate(); setOverrides([]); setPackageIds([]); setPackages([]); setSelected(ids => e.target.checked ? [...ids, order.id] : ids.filter(id => id !== order.id)); }}/><span>{order.number}</span><span className="oc-muted">{order.quantity} 件</span>{order.lineId && <Link href={`/orders?line=${order.lineId}`}>订单与地址</Link>}</label>)}</div>
      {!options.orders.length && <p>未找到可读取的订单 请先通过原订单导入入口承接资料</p>}
      {options.truncated && <p className="oc-muted">当前显示最近 100 单 请用订单号筛选</p>}
      <div className="logistics-form"><fieldset className="logistics-fields" disabled={blocked}>
        <label>实际发货工厂<select aria-label="导单工厂" value={profileId} onChange={e => { invalidate(); setProfileId(e.target.value); setOverrides([]); setPackageIds([]); setPackages([]); }}><option value="">请选择已配置工厂</option>{options.profiles.map(row => <option key={row.id} value={row.id}>{options.factories.find(factory => factory.id === row.factoryId)?.name} · {row.profile.name} V{row.version}</option>)}</select></label>
        <label>生成表格<select aria-label="生成表格" value={currentAdapter} onChange={e => { invalidate(); setAdapter(e.target.value as DocumentAdapter); setOverrides([]); setPackageIds([]); }} disabled={!profile}>{adapters.map(value => <option key={value} value={value}>{documentLabels[value]}</option>)}</select></label>
      </fieldset></div>
      {!options.profiles.length && <p>尚未配置工厂导单 在下方关联实际工厂和产品规格后即可使用</p>}
      {currentAdapter === "printeque_factory" && <div className="document-production"><p>生产表按正式交付文件名称关联每个商品 请先在生产中心完成审核与交付封存</p><button className="oc-button" disabled={busy || !selected.length || !options.canReadProduction} onClick={() => void run(loadPackages)}>读取所选订单的正式交付包</button>{packages.map(packet => <label className="logistics-check" key={packet.id}><input type="checkbox" disabled={busy || !packet.canDownload} checked={packageIds.includes(packet.id)} onChange={e => { invalidate(); setPackageIds(ids => e.target.checked ? [...ids, packet.id] : ids.filter(id => id !== packet.id)); }}/>{new Date(packet.createdAt).toLocaleString()} · {packet.items.length} 个商品 · {packet.canDownload ? "可导单" : "原生产校验待处理"}</label>)}<Link href={orderId ? `/production?order=${orderId}` : "/production"}>打开生产中心</Link></div>}
      <div className="oc-actions"><span>{selected.length} 个订单</span><button className="oc-button" disabled={blocked || !profile || !selected.length} onClick={() => void run(inspect)}>预检包裹与表格</button><button className="oc-button primary" disabled={blocked || !preview?.ready || !options.canGenerate} onClick={() => void run(generate)}><FileSpreadsheet size={16}/>{busy ? "正在处理" : "生成表格"}</button></div>
      <div className="document-result" data-open={preview !== null}><div>{preview && <>
        <p role="status">{preview.ready ? "预检通过" : "请先处理以下待核对项目"} · {preview.rowCount} 行 · {preview.factoryName}</p>
        {preview.orders.map(order => <article className="document-preview" key={order.orderId}><strong>{order.orderNumber}</strong>
          {order.parcel && <p>{order.parcel.quantity} 件 · {currentAdapter === "yunexpress" ? `${order.parcel.weightKg} kg · ${order.parcel.channelCode}` : `${order.parcel.weightLb} lb · ${order.parcel.lengthIn ?? "—"} × ${order.parcel.widthIn ?? "—"} × ${order.parcel.heightIn ?? "—"} in`}</p>}
          {order.blockers.map(message => <p className="logistics-error" key={message}>{message}</p>)}{order.notices.map(message => <p className="oc-muted" key={message}>{message}</p>)}
          <details><summary>查看导出字段</summary>{order.rows.map((row, index) => <dl className="document-row" key={index}>{Object.entries(row).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value ?? "留空"}</dd></div>)}</dl>)}</details>
        </article>)}
      </>}</div></div>
      {!!selected.length && currentAdapter !== "printeque_factory" && <details className="document-adjust"><summary>手动调整本次包裹或渠道</summary><p className="oc-muted">调整后须重新预检 地址请在原订单中修改并保存</p>{selected.map(id => { const value = overrides.find(item => item.orderId === id); return <fieldset className="logistics-form" key={id} disabled={busy}><legend>{options.orders.find(order => order.id === id)?.number}</legend><div className="logistics-fields">
        {currentAdapter === "yunexpress" ? <label>云途渠道<select value={value?.channelCode ?? ""} onChange={e => updateOverride(id, { channelCode: e.target.value ? e.target.value as "THPHR" | "ZBZXRPH" : undefined })}><option value="">按产品尺寸自动选择</option><option value="THPHR">特惠普货 THPHR</option><option value="ZBZXRPH">中包普货 ZBZXRPH</option></select></label> : <>{(["lengthIn", "widthIn", "heightIn", "weightLb"] as const).map((field, i) => <label key={field}>{["长 in", "宽 in", "高 in", "整单重量 lb"][i]}<input type="number" step="any" min="0.001" value={value?.[field] ?? ""} onChange={e => updateOverride(id, { [field]: e.target.value ? Number(e.target.value) : undefined })}/></label>)}<label>合包商品 SKU<input value={value?.goodsSku ?? ""} onChange={e => updateOverride(id, { goodsSku: e.target.value || undefined })}/></label><label>合包申报单价 USD<input type="number" min="0.01" step="0.01" value={value?.declaredUnitValueMinor ? value.declaredUnitValueMinor / 100 : ""} onChange={e => updateOverride(id, { declaredUnitValueMinor: e.target.value ? Math.round(Number(e.target.value) * 100) : undefined })}/></label></>}
        <label className="logistics-wide">调整原因 至少 5 字<input value={value?.reason ?? ""} onChange={e => updateOverride(id, { reason: e.target.value })}/></label></div>{value && <button type="button" className="oc-button" onClick={() => { invalidate(); setOverrides(items => items.filter(item => item.orderId !== id)); }}>恢复规格默认值</button>}</fieldset>; })}</details>}
      {notice && <p role="status">{notice}</p>}
      {selected.length === 1 && profile?.profile.route === "yunexpress" && <div inert={busy || profileState.dirty || profileState.busy}><DocumentLabelPanel key={selected[0]} orderId={selected[0]!} refreshToken={history.map(row => row.id).join(",")} canWrite={options.canGenerate} canReadProduction={options.canReadProduction} onStateChange={setLabelState}/></div>}
      <details className="document-history" open={history.length > 0}><summary>导出记录 · {history.length}</summary>{history.map(row => <div className="document-history-row" key={row.id}><div><strong>{documentLabels[row.adapter]}</strong><p className="oc-muted">{row.factoryName} · {new Date(row.createdAt).toLocaleString()} · {row.rowCount} 行</p>{row.reason && <p>{row.reason}</p>}</div>{row.available && <a className="oc-button" download href={`/api/logistics/documents/exports/${row.id}/file`}><Download size={16}/>下载表格</a>}</div>)}{!history.length && <p>尚未生成导出文件</p>}</details>
      {options.canConfigure && <details className="document-config" inert={busy || labelState.dirty || labelState.busy}><summary>工厂导单与包裹规格配置</summary><DocumentProfileForm options={options} onSaved={() => reload(query)} onStateChange={setProfileState}/></details>}
    </>}
  </section>;
}
