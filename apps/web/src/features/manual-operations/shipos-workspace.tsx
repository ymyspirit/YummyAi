"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Download, RefreshCw, ShieldCheck } from "lucide-react";
import { SaveShiposConnectionSchema, ShiposConnectionViewSchema, ShiposOrderNumberSchema, ShiposRunViewSchema, ShiposWorkspaceSchema,
  type ShiposConnectionView, type ShiposWorkspace, type ShiposRecordView, type ShiposCarrierMapping } from "@yummyai/contracts/suppliers/shipos";
import "./shipos.css";

const diagnostics: Record<string, string> = { query_failed: "查询失败，可重试", not_returned: "ShipOS 未返回该订单", detail_unavailable: "详情接口暂不可用，费用待补充", detail_mismatch: "详情订单号或业务类型不一致", no_local_order: "本地无对应订单", ambiguous_local_order: "多个店铺订单号相同，暂不关联", retention_expired: "本地订单资料不可访问或已到期", interrupted: "上次同步中断，可重新同步", connection_changed: "同步期间连接有变更，请重新同步" };
const matches = { matched: "已关联", missing: "待关联", ambiguous: "关联有歧义", expired: "资料不可访问", unavailable: "查询未完成" };
const states: Record<string, string> = { running: "同步中", completed: "完成", partial: "部分完成", failed: "失败" };
const statusNames: Record<number, string> = { 11: "预报订单", 12: "正在出单", 13: "仓库待发", 14: "完成发货", 22: "已退款", 24: "补扣费用" };
const date = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));

type PanelProps = { supplierId: string; initial: ShiposWorkspace };
export function ShiposConnectionPanel(props: PanelProps) { return <ShiposWorkspacePanel {...props} mode="connection" />; }
export function ShiposSyncPanel(props: PanelProps) { return <ShiposWorkspacePanel {...props} mode="sync" />; }

function ShiposWorkspacePanel({ supplierId, initial, mode }: PanelProps & { mode: "connection" | "sync" }) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [data, setData] = useState(initial), [name, setName] = useState(initial.connection?.name ?? "ShipOS"), [status, setStatus] = useState(initial.connection?.status ?? "draft");
  const [appKey, setAppKey] = useState(""), [appSecret, setAppSecret] = useState(""), [clearCredentials, setClearCredentials] = useState(false);
  const [mappings, setMappings] = useState<ShiposCarrierMapping[]>(initial.connection?.channelMappings ?? []);
  const [numbers, setNumbers] = useState(""), [busy, setBusy] = useState<string | null>(null), [notice, setNotice] = useState(""), [error, setError] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null), stop = useRef(false);
  const pending = useRef<{ numbers: string[]; key: string } | null>(null);
  const base = `/api/shipos/${supplierId}`;
  async function request(path: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", cache: "no-store", headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await response.json(); if (!response.ok) throw new Error(json.message ?? "操作未完成"); return json;
  }
  async function refresh() { const workspace = ShiposWorkspaceSchema.parse(await request("")); setData(workspace); return workspace; }
  function begin(action: string) { setBusy(action); setError(""); setNotice(""); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!hydrated || busy) return; begin("save");
    try {
      const parsed = SaveShiposConnectionSchema.safeParse({ name, status, expectedVersion: data.connection?.version ?? 0, ...(appKey ? { appKey } : {}), ...(appSecret ? { appSecret } : {}), clearCredentials, channelMappings: mappings, idempotencyKey: crypto.randomUUID() });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "请检查连接配置");
      const saved = ShiposConnectionViewSchema.parse(await request("/connection", parsed.data));
      setData(current => ({ ...current, connection: saved })); setMappings(saved.channelMappings); setAppKey(""); setAppSecret(""); setClearCredentials(false); pending.current = null;
      setNotice(saved.status === "draft" && !saved.credentialsConfigured ? "连接草稿已保存；填入凭据后可测试连接。" : "连接配置已保存。");
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); } finally { setBusy(null); }
  }
  async function test() {
    if (!data.connection) return; begin("test");
    try { const result = await request("/test", { expectedVersion: data.connection.version }); setData(current => ({ ...current, connection: ShiposConnectionViewSchema.parse(result.connection) }));
      if (!result.success) throw new Error("连接测试失败，请检查已保存的凭据与账号接口权限。"); setNotice(`连接成功，可读取 ${result.channelCount} 个渠道。`);
    } catch (e) { setError(e instanceof Error ? e.message : "测试失败"); } finally { setBusy(null); }
  }
  async function sync(event: FormEvent) {
    event.preventDefault(); if (!data.connection) return; begin("sync"); stop.current = false;
    let remaining: string[] = [];
    try {
      const ids = [...new Set(numbers.split(/[,，\s]+/).filter(Boolean))];
      if (!ids.length || ids.length > 50) throw new Error("每次请输入 1–50 个已有订单号。");
      ids.forEach(number => { if (!ShiposOrderNumberSchema.safeParse(number).success) throw new Error("订单号只能包含字母、数字、点、横线和下划线。"); });
      let done = 0, attention = 0; setProgress({ done, total: ids.length });
      for (let offset = 0; offset < ids.length; offset += 5) {
        if (stop.current) break;
        const chunk = ids.slice(offset, offset + 5).sort();
        remaining = ids.slice(offset);
        if (pending.current && JSON.stringify(pending.current.numbers) !== JSON.stringify(chunk)) throw new Error("上次请求结果尚未确认，请先使用原订单号重试或刷新同步记录。");
        pending.current ??= { numbers: chunk, key: crypto.randomUUID() };
        const run = ShiposRunViewSchema.parse(await request("/sync", { orderNumbers: chunk, expectedVersion: data.connection.version, idempotencyKey: pending.current.key }));
        if (run.status === "running") throw new Error("该请求仍在处理中，请稍后刷新或使用原订单号重试。");
        pending.current = null; done += chunk.length; attention += run.records.filter(record => record.diagnostics.length > 0).length;
        setProgress({ done, total: ids.length }); await refresh();
      }
      setNotice(stop.current ? `已停止后续批次；已处理 ${done} 个订单号。` : `已处理 ${done} 个订单号${attention ? `，${attention} 条记录需要处理` : ""}。`);
    } catch (e) { if (pending.current && remaining.length) setNumbers(remaining.join("\n")); setError(e instanceof Error ? e.message : "同步失败"); await refresh().catch(() => {}); } finally { setBusy(null); }
  }
  async function reload() { begin("refresh"); try { await refresh(); pending.current = null; setNotice("同步记录已刷新。"); } catch { setError("记录暂时无法读取，请稍后重试。"); } finally { setBusy(null); } }
  const connection = data.connection;
  const configuring = mode === "connection";
  const syncHref = `/shipments?view=logistics&supplierId=${encodeURIComponent(supplierId)}`;
  return <section className="shipos-panel" aria-labelledby={`shipos-${mode}-title`}>
    <header className="shipos-header"><div><h2 id={`shipos-${mode}-title`}>{configuring ? "ShipOS 连接配置" : "ShipOS 已有订单"}</h2><p>{configuring ? "维护供应商的物流账号，所属工厂可以共用此连接。订单同步与面单在发货中心处理。" : "按订单号同步运单、现有面单和费用，核对本地订单关联。"}</p></div><span className="shipos-readonly"><ShieldCheck size={14} aria-hidden="true" />只读连接</span></header>
    <p className="shipos-boundary">仅查询已有订单与现有面单；不下单、不购买面单、不退款、不回写平台。ShipOS 状态不会自动触发生产或实际交运。</p>
    {configuring ? <><form className="shipos-config" onSubmit={save} autoComplete="off">
      <label>连接名称 <span>必填</span><input value={name} onChange={e => setName(e.target.value)} required maxLength={100} disabled={!hydrated || !!busy} /></label>
      <div className="shipos-field"><label htmlFor={`shipos-status-${supplierId}`}>连接状态</label><small>暂停后停止查询</small><select id={`shipos-status-${supplierId}`} value={status} onChange={e => setStatus(e.target.value as ShiposConnectionView["status"])} disabled={!hydrated || !!busy}><option value="draft">草稿</option><option value="active">启用</option><option value="paused">暂停</option></select></div>
      <label>AppKey <span>启用时需配置</span><input type="password" value={appKey} onChange={e => setAppKey(e.target.value)} autoComplete="new-password" maxLength={256} placeholder={connection?.credentialsConfigured ? "留空保留已有凭据" : "可稍后填写"} disabled={!hydrated || !!busy || clearCredentials} /></label>
      <label>AppSecret <span>启用时需配置</span><input type="password" value={appSecret} onChange={e => setAppSecret(e.target.value)} autoComplete="new-password" maxLength={256} placeholder={connection?.credentialsConfigured ? "留空保留已有凭据" : "可稍后填写"} disabled={!hydrated || !!busy || clearCredentials} /></label>
      <fieldset className="shipos-mappings" id="shipos-channel-mappings" disabled={!hydrated || !!busy}><legend>物流渠道承运信息（选填）</legend>
        <p className="shipos-empty">按 ShipOS 返回的完整渠道名对应实际承运商和发货国家。保存后，订单可以一起带入这些信息；未配置的渠道仍可手动核对填写。</p>
        {mappings.map((mapping, index) => <div className="shipos-mapping-row" key={index}>
          {([["channel", "ShipOS 渠道名称"], ["carrierCode", "承运商代码"], ["carrierName", "承运商名称"], ["carrierService", "物流服务"], ["shipFromCountryCode", "发货国家代码"]] as const).map(([key, title]) => <label key={key}>{title}<input required value={mapping[key]} maxLength={key === "shipFromCountryCode" ? 2 : key === "carrierCode" ? 80 : 160}
            pattern={key === "carrierCode" ? "[A-Z0-9_:-]+" : key === "shipFromCountryCode" ? "[A-Z]{2}" : undefined} placeholder={key === "shipFromCountryCode" ? "CN / US" : undefined}
            onChange={event => { const next = event.target.value; setMappings(rows => rows.map((row, position) => position === index ? { ...row, [key]: next } : row)); }} /></label>)}
          <button className="operation-button" type="button" onClick={() => setMappings(rows => rows.filter((_, position) => position !== index))}>移除此渠道</button>
        </div>)}
        <button className="operation-button" type="button" disabled={!hydrated || !!busy || mappings.length >= 50} onClick={() => setMappings(rows => [...rows, { channel: "", carrierCode: "", carrierName: "", carrierService: "", shipFromCountryCode: "" }])}>添加渠道对应关系</button>
      </fieldset>
      <div className="shipos-config-footer record-toolbar"><span>{connection?.credentialsConfigured ? `凭据已加密保存 · AppKey ${connection.appKeyHint}` : "尚未配置凭据，可先保存草稿"}{connection?.lastTestAt ? ` · ${date(connection.lastTestAt)} 测试${connection.lastTestResult === "success" ? "成功" : "失败"}` : ""}</span>
        {connection?.credentialsConfigured && <label className="shipos-clear"><input type="checkbox" checked={clearCredentials} onChange={e => { setClearCredentials(e.target.checked); setAppKey(""); setAppSecret(""); }} disabled={!hydrated || !!busy} />清除凭据</label>}
        <button className="operation-button primary" disabled={!hydrated || !!busy} type="submit">{busy === "save" ? "保存中…" : "保存连接"}</button><button className="operation-button" type="button" disabled={!hydrated || !!busy || !connection?.credentialsConfigured || connection.status === "paused"} onClick={test}>{busy === "test" ? "测试中…" : "测试连接"}</button>
      </div>
    </form><div className="shipos-jump"><Link href={syncHref}>前往物流订单同步</Link></div></> : <>
    <div className="shipos-connection-summary"><span>{connection ? `${connection.name} · ${connection.status === "active" ? "启用" : connection.status === "paused" ? "暂停" : "草稿"}` : "尚未配置 ShipOS 连接"}</span><Link href={`/suppliers/${encodeURIComponent(supplierId)}#shipos-connection-title`}>管理连接配置</Link></div>
    {(!connection?.credentialsConfigured || connection.status !== "active") && <p className="record-notice">请在供应商档案中配置并启用连接，再同步已有订单。</p>}
    <form className="shipos-sync" onSubmit={sync}><label>已有订单号<textarea value={numbers} onChange={e => setNumbers(e.target.value)} rows={3} maxLength={5500} placeholder="每行一个订单号，也可以用逗号分隔；一次最多 50 个" disabled={!hydrated || !!busy} /></label>
      <div className="shipos-actions record-toolbar"><span>{progress ? `进度 ${progress.done} / ${progress.total}` : "每批查询 5 个；查询失败或未关联的记录可以补齐资料后重新同步。"}</span>
        <button className="operation-button" type="button" onClick={reload} disabled={!hydrated || !!busy}><RefreshCw size={14} aria-hidden="true" />刷新记录</button>
        {busy === "sync" ? <button className="operation-button" type="button" onClick={() => { stop.current = true; setNotice("当前批次完成后停止。"); }}>停止后续批次</button> : <button className="operation-button primary" type="submit" disabled={!hydrated || !!busy || connection?.status !== "active"}>同步已有订单</button>}
      </div>
    </form>
    </>}
    <div aria-live="polite">{notice && <p className="record-notice">{notice}</p>}{error && <p className="record-notice error" role="alert">{error}</p>}</div>
    {!configuring && <><div className="shipos-results"><h3>最近同步结果 <span>{data.recent.length} 条</span></h3>
      {!data.recent.length ? <p className="shipos-empty">还没有同步记录。保存并启用连接后，输入 ShipOS 中已有的订单号。</p> : <div className="shipos-table" role="table" aria-label="ShipOS 已有订单同步结果"><div className="shipos-row shipos-head" role="row"><span>订单 / 本地关联</span><span>运单与现有面单</span><span>ShipOS 状态</span><span>费用</span><span>查询时间 / 待处理</span></div>{data.recent.map(record => <Record key={record.id} record={record} base={base} />)}</div>}
    </div>
    {!!data.runs.length && <details className="shipos-history"><summary>同步历史（最近 {data.runs.length} 批）</summary><ul>{data.runs.map(run => <li key={run.id}><time>{date(run.createdAt)}</time><span>{states[run.status]} · {run.orderNumbers.length} 个订单</span><span>{run.diagnostic ? diagnostics[run.diagnostic] : run.records.filter(record => record.diagnostics.length).length ? `${run.records.filter(record => record.diagnostics.length).length} 条待处理` : ""}</span></li>)}</ul></details>}
    {data.truncated && <p className="shipos-empty">当前展示最近 20 批记录；更早的同步证据仍然保留。</p>}
    </>}
  </section>;
}
function Record({ record, base }: { record: ShiposRecordView; base: string }) {
  return <div className="shipos-row" role="row"><div><strong>{record.orderNumber}</strong><small>{matches[record.match]}</small>{record.localLineId && <Link href={`/orders?line=${record.localLineId}`}>查看本地订单</Link>}</div>
    <div><span>{record.trackingNumber ?? "尚未返回运单号"}</span>{record.labelAvailable ? record.match === "matched" ? <a href={`${base}/records/${record.id}/label`}><Download size={13} aria-hidden="true" />下载现有面单</a> : <small>面单已存在，关联本地订单后可下载</small> : <small>未返回可读取的现有面单</small>}</div>
    <div><span>{record.statusCode === null ? "未返回" : statusNames[record.statusCode] ?? `状态 ${record.statusCode}`}</span><small>{record.channel ?? "渠道未返回"}</small>{record.cancelStatusCode !== null && record.cancelStatusCode !== 0 && <small>取消状态 {record.cancelStatusCode}</small>}</div>
    <div>{record.fee !== null && record.currency ? `${record.fee} ${record.currency}` : "待补充"}</div><div><time>{date(record.fetchedAt)}</time>{record.diagnostics.map(d => <small className="shipos-diagnostic" key={d}>{diagnostics[d]}</small>)}</div>
  </div>;
}
