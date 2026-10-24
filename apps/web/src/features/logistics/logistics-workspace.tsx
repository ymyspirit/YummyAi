"use client";
import Link from "next/link";
import { useCallback,useEffect,useRef,useState } from "react";
import { RefreshCw,Truck } from "lucide-react";
import { LogisticsOptionsSchema,type LogisticsOptions,type LogisticsTaskView,type LogisticsConnectionView, type LogisticsTaskState } from "@yummyai/contracts/logistics";
import { LogisticsTaskForm } from "./logistics-task-form";
import { LogisticsConnectionForm } from "./logistics-connection-form";
import { logisticsError,logisticsRequest,logisticsDiagnostic } from "./logistics-client";
import "../order-centers/order-centers.css";
import "./logistics.css";
export const logisticsStates:Record<LogisticsTaskState,string>={pending:"待询价",quoted:"已询价，等待规则启用",purchasing:"购单处理中",created:"物流订单已确认",label_requesting:"获取面单中",completed:"面单准备完成",attention:"需要人工核对",reconciliation_required:"结果不确定，须查单",cancelled:"已取消本地任务"};
const money=(n:number|null,c:string|null,digits=2)=>n===null?"未返回":`${(n/10**digits).toFixed(digits)} ${c??"币种待核对"}`;
export function LogisticsWorkspace({orderId,taskId}:{orderId?:string;taskId?:string}) {
  const [tasks,setTasks]=useState<LogisticsTaskView[]>([]),[connections,setConnections]=useState<LogisticsConnectionView[]>([]),[options,setOptions]=useState<LogisticsOptions|null>(null);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(""),[configError,setConfigError]=useState("");
  const requestNumber=useRef(0);
  const reload=useCallback(async(signal?:AbortSignal)=>{
    const current=++requestNumber.current;
    const focused:LogisticsTaskView|undefined=taskId?await logisticsRequest(`tasks/${encodeURIComponent(taskId)}`,undefined,signal):undefined;
    if(focused&&orderId&&focused.orderId!==orderId)throw new Error("此物流任务不属于所选订单，请核对入口");
    const activeOrder=focused?.orderId??orderId,query=activeOrder?`?orderId=${encodeURIComponent(activeOrder)}`:"";
    const [t,o,c]=await Promise.allSettled([focused?Promise.resolve({tasks:[focused]}):logisticsRequest(`tasks${query}`,undefined,signal),logisticsRequest(`options${query}`,undefined,signal),logisticsRequest("connections",undefined,signal)]);
    if(signal?.aborted||current!==requestNumber.current)return;
    if(t.status!=="fulfilled"||o.status!=="fulfilled")throw new Error(logisticsError(t.status==="rejected"?t.reason:o.status==="rejected"?o.reason:undefined));
    setTasks(t.value.tasks);setOptions(LogisticsOptionsSchema.parse(o.value));
    if(c.status==="fulfilled"){setConnections(c.value.connections);setConfigError("");}else setConfigError(logisticsError(c.reason));
  },[orderId,taskId]);
  useEffect(()=>{const ctl=new AbortController();setLoading(true);setError("");setTasks([]);setOptions(null);void reload(ctl.signal).catch(e=>{if(!ctl.signal.aborted)setError(logisticsError(e));}).finally(()=>{if(!ctl.signal.aborted)setLoading(false);});return()=>ctl.abort();},[reload]);
  async function dispatch(task:LogisticsTaskView,mode:"quote"|"purchase"|"reconcile") {
    setBusy(true);setError("");try{await logisticsRequest(`tasks/${task.id}/dispatch`,{mode,idempotencyKey:crypto.randomUUID()});await reload();}catch(e){setError(logisticsError(e));}finally{setBusy(false);}
  }
  return <main className="oc-page logistics-page" aria-busy={loading}>
    <header className="oc-header"><div><h1><Truck size={22}/>物流下单</h1><p>按订单和实际发货工厂准备面单，核对时效、报价与实际费用。</p></div><div className="oc-actions"><Link className="oc-button" href="/production">生产中心</Link><Link className="oc-button" href="/shipments">实际发货</Link><Link className="oc-button" href="/shipments?view=logistics">已有物流订单同步</Link><button className="oc-button" disabled={busy||loading} onClick={()=>{setLoading(true);void reload().catch(e=>setError(logisticsError(e))).finally(()=>setLoading(false));}}><RefreshCw size={16}/>刷新</button></div></header>
    {error&&<p role="alert" className="logistics-error">{error}</p>}{loading&&<p role="status">正在读取物流任务…</p>}
    {taskId&&<p className="oc-muted">当前显示指定物流任务 · <Link href="/?attention=logistics#fulfillment-attention">返回履约待办</Link> · <Link href="/logistics">查看全部物流任务</Link></p>}
    {options?.canCreate&&<details className="logistics-section"><summary>为已排期商品创建物流任务</summary><LogisticsTaskForm options={options} connections={connections} onSaved={reload}/></details>}
    {!loading&&!error&&!tasks.length&&<p className="oc-muted">尚无物流任务。生产排期确认工厂、数量和完工时间后，可按工厂创建任务。</p>}
    <div className="logistics-tasks">{tasks.map(task=><article key={task.id} className="logistics-task">
      <div className="logistics-task-title"><strong>{task.orderNumber} · {task.factoryName}</strong><span>{logisticsStates[task.status]}</span></div>
      <p className="oc-muted">{task.connectionName} · {task.externalReference} · <Link href={`/production?order=${task.orderId}`}>生产与工厂交付</Link></p>
      <dl><div><dt>已选报价</dt><dd>{money(task.quotedCostMinor,task.quotedCurrency,task.minorUnitDigits)}</dd></div><div><dt>实际费用</dt><dd>{money(task.actualCostMinor,task.actualCurrency,task.minorUnitDigits)}</dd></div><div><dt>最晚发货</dt><dd>{task.latestShipAt?new Date(task.latestShipAt).toLocaleString():"资料已到期"}</dd></div><div><dt>送达要求</dt><dd>{task.deliverBy?new Date(task.deliverBy).toLocaleString():"资料已到期"}</dd></div></dl>
      {task.diagnostic&&<p role="status">待办原因：{logisticsDiagnostic(task.diagnostic)}</p>}
      {task.labelMode==="factory_pull"&&task.status==="completed"&&<p>ShipOS 面单由工厂按上方物流订单编号拉取。</p>}
      {task.trackingNumbers.length>0&&<p>跟踪号：{task.trackingNumbers.join(" / ")}</p>}
      <div className="oc-actions">{options?.canCreate&&!['completed','cancelled'].includes(task.status)&&<button className="oc-button" disabled={busy} onClick={()=>void dispatch(task,["purchasing","created","label_requesting","reconciliation_required"].includes(task.status)?"reconcile":"purchase")}>{["purchasing","created","label_requesting","reconciliation_required"].includes(task.status)?"查询并核对结果":"按固定规则执行"}</button>}{task.labels.map(label=><a className="oc-button" key={label.id} href={`/api/logistics/tasks/${task.id}/labels/${label.id}`}>下载 {label.fileName}</a>)}</div>
      {!!task.quotes.length&&<details><summary>查看报价依据（{task.quotes.length}）</summary><div className="logistics-quote-list">{task.quotes.map((q,i)=><p key={i}>{q.channelName} · {money(q.totalMinor,q.currency,task.minorUnitDigits)} · {q.transitDaysMax===null?"时效未核验":`${q.transitDaysMin}–${q.transitDaysMax} 天`} · {q.currencySource??"币种未核验"} · {q.transitSource??"时效未核验"}{q.diagnostic&&` · ${q.diagnostic}`}</p>)}</div></details>}
    </article>)}</div>
    {options?.truncated&&<p>当前显示最近 100 个生产任务，请从订单筛选。</p>}
    <details className="logistics-section"><summary>发货连接与自动购单规则</summary>{configError&&<p role="alert">{configError}</p>}
      {options?.canConfigure&&<LogisticsConnectionForm factories={options.factories} connections={connections} onSaved={reload}/>}
      {connections.map(c=><p key={c.id}>{c.profile.name} V{c.version} · {c.profile.provider} · 实际发货地 {c.profile.originCountryCode} · {c.verifiedAt?"账户已核验":"当前版本待核验"} · {c.rule?.autoPurchase?"自动购单已启用":"自动购单未启用"}</p>)}
    </details>
  </main>;
}
