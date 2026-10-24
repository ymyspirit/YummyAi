"use client";
import { useMemo,useRef,useState,type FormEvent } from "react";
import { CreateLogisticsTaskSchema,type LogisticsOptions,type LogisticsConnectionView,type LogisticsPackage } from "@yummyai/contracts/logistics";
import { logisticsError,logisticsRequest,localDate } from "./logistics-client";
import { useLeaveGuard } from "../navigation/use-leave-guard";
type Declaration=LogisticsPackage["declarations"][number];
type Parcel={weight:string;length:string;width:string;height:string;evidence:string;containsBattery:boolean;declarations:Array<Partial<Declaration>>};
const parcel=():Parcel=>({weight:"",length:"",width:"",height:"",evidence:"",containsBattery:false,declarations:[]});
export function LogisticsTaskForm({options,connections,onSaved}:{options:LogisticsOptions;connections:LogisticsConnectionView[];onSaved():Promise<void>}) {
  const [firstId,setFirst]=useState(""),[selected,setSelected]=useState<string[]>([]),[connectionId,setConnection]=useState(""),[parcels,setParcels]=useState<Parcel[]>([parcel()]);
  const [busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const keys=useRef(new Map<string,string>());useLeaveGuard(dirty,busy);
  const first=options.candidates.find(c=>c.productionOrderId===firstId),group=options.candidates.filter(c=>c.orderId===first?.orderId&&c.factoryId===first?.factoryId);
  const chosen=group.filter(c=>selected.includes(c.productionOrderId)),routes=connections.filter(c=>c.profile.factoryId===first?.factoryId&&c.rule);
  const ready=useMemo(()=>chosen.length?localDate(new Date(Math.ceil(Math.max(...chosen.map(c=>Date.parse(c.expectedCompletionAt)))/60000)*60000).toISOString()):"",[chosen]);
  function choose(id:string){const row=options.candidates.find(c=>c.productionOrderId===id);setFirst(id);setSelected(row?[id]:[]);setConnection("");setParcels([{...parcel(),declarations:row?[{sku:row.sku??"",quantity:row.quantity,minorUnitDigits:2}]:[]}]);setDirty(true);}
  function updateParcel(i:number,patch:Partial<Parcel>){setParcels(v=>v.map((p,j)=>i===j?{...p,...patch}:p));setDirty(true);}
  async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();setBusy(true);setError("");setNotice("");try{
    const data=new FormData(e.currentTarget),raw={orderId:first?.orderId,productionOrderIds:selected,connectionId,expectedOrderSequence:first?.orderSequence,readyAt:new Date(String(data.get("readyAt"))).toISOString(),latestShipAt:new Date(String(data.get("latestShipAt"))).toISOString(),deliverBy:new Date(String(data.get("deliverBy"))).toISOString(),deadlineSource:String(data.get("deadlineSource")),
      packages:parcels.map(p=>({weightGrams:Number(p.weight),dimensionsMm:{length:Number(p.length),width:Number(p.width),height:Number(p.height)},evidence:p.evidence,containsBattery:p.containsBattery,declarations:p.declarations.map(d=>({...d,quantity:Number(d.quantity),unitPriceMinor:Number(d.unitPriceMinor),unitWeightGrams:Number(d.unitWeightGrams)}))}))};
    const signature=JSON.stringify(raw);if(!keys.current.has(signature))keys.current.set(signature,crypto.randomUUID());
    const input=CreateLogisticsTaskSchema.parse({...raw,idempotencyKey:keys.current.get(signature)});
    const result=await logisticsRequest("tasks",input);setDirty(false);setNotice(`物流任务已固定 ${result.taskId}。自动规则未启用时仅询价。`);await onSaved();
  }catch(e){setError(logisticsError(e));}finally{setBusy(false);}}
  return <form className="logistics-form" onSubmit={e=>void submit(e)} onChange={()=>setDirty(true)}>
    <fieldset className="logistics-fields" disabled={busy}>
      <label className="logistics-wide">订单与工厂<select aria-label="订单与工厂" required value={firstId} onChange={e=>choose(e.target.value)}><option value="">选择已确认排期的商品</option>{options.candidates.map(c=><option key={c.productionOrderId} value={c.productionOrderId} disabled={!!c.taskId||c.blockers.length>0}>{c.orderNumber} · {c.factoryName} · {c.sku??"缺少 SKU"} × {c.quantity}{c.taskId?" · 已有物流任务":c.blockers.length?` · ${c.blockers.join("；")}`:""}</option>)}</select></label>
      {first&&<div className="logistics-wide">{group.map(c=><label className="logistics-candidate" key={c.productionOrderId}><input type="checkbox" disabled={!!c.taskId||c.blockers.length>0} checked={selected.includes(c.productionOrderId)} onChange={e=>setSelected(v=>e.target.checked?[...v,c.productionOrderId]:v.filter(id=>id!==c.productionOrderId))}/>{c.sku??"缺少 SKU"} × {c.quantity} · {new Date(c.expectedCompletionAt).toLocaleString()}{c.taskId?" · 已有任务":c.blockers.join("；")}</label>)}<p className="oc-muted">同订单不同工厂分别建任务。申报商品及数量须覆盖当前所选商品。</p></div>}
      <label>实际发货连接<select aria-label="实际发货连接" required value={connectionId} onChange={e=>setConnection(e.target.value)}><option value="">选择已配置规则的路线</option>{routes.map(c=><option key={c.id} value={c.id}>{c.profile.name} · {c.profile.originCountryCode} · {c.rule?.autoPurchase?"自动购单":"仅询价"}</option>)}</select></label>
      <label>预计可交运时间<input key={ready} type="datetime-local" name="readyAt" required defaultValue={ready}/></label>
      <label>最晚发货<input type="datetime-local" name="latestShipAt" required/></label><label>最晚送达<input type="datetime-local" name="deliverBy" required/></label>
      <label className="logistics-wide">交期依据<input name="deadlineSource" required minLength={5} maxLength={2000} placeholder="平台要求、买家约定与工厂交运安排"/></label>
    </fieldset>
    {parcels.map((p,i)=><fieldset className="logistics-fields logistics-package" key={i} disabled={busy}><legend>包裹 {i+1}</legend>
      {([['weight','重量（克）'],['length','长（毫米）'],['width','宽（毫米）'],['height','高（毫米）']] as const).map(([key,label])=><label key={key}>{label}<input type="number" required min={1} step={1} value={p[key]} onChange={e=>updateParcel(i,{[key]:e.target.value})}/></label>)}
      <label className="logistics-wide">包装与实测依据<input required minLength={5} maxLength={2000} value={p.evidence} onChange={e=>updateParcel(i,{evidence:e.target.value})} placeholder="包装资料版本、称重和尺寸核对凭证"/></label>
      <label className="logistics-check"><input type="checkbox" checked={p.containsBattery} onChange={e=>updateParcel(i,{containsBattery:e.target.checked})}/>包含电池</label>
      {p.declarations.map((d,j)=><div className="logistics-fields logistics-wide" key={j}>{([['sku','商品 SKU','text'],['quantity','数量','number'],['nameEn','英文品名','text'],['nameCn','中文品名','text'],['unitPriceMinor','单价（最小货币单位）','number'],['currency','申报币种','text'],['minorUnitDigits','申报币种小数位','number'],['unitWeightGrams','单件重量（克）','number'],['hsCode','HS 编码','text'],['originCountryCode','商品原产国家','text']] as const).map(([key,label,type])=><label key={key}>{label}<input required type={type} min={key==='minorUnitDigits'?0:1} max={key==='minorUnitDigits'?3:undefined} step={1} maxLength={key==='currency'?3:key==='originCountryCode'?2:200} value={d[key]??""} onChange={e=>updateParcel(i,{declarations:p.declarations.map((row,k)=>k===j?{...row,[key]:type==='number'?Number(e.target.value):e.target.value}:row)})}/></label>)}<button className="oc-button" type="button" onClick={()=>updateParcel(i,{declarations:p.declarations.filter((_,k)=>k!==j)})}>删除申报商品</button></div>)}
      <button className="oc-button" type="button" onClick={()=>updateParcel(i,{declarations:[...p.declarations,{minorUnitDigits:2}]})}>添加申报商品</button>{parcels.length>1&&<button className="oc-button" type="button" onClick={()=>setParcels(v=>v.filter((_,j)=>j!==i))}>删除此包裹</button>}
    </fieldset>)}
    <div className="oc-actions"><button className="oc-button" type="button" disabled={busy||connections.find(c=>c.id===connectionId)?.profile.provider==="yunexpress"} onClick={()=>{setParcels(v=>[...v,parcel()]);setDirty(true);}}>添加包裹</button><button className="oc-button primary" disabled={busy||!chosen.length||!routes.length}>固定任务并执行规则</button></div>
    <p className="oc-muted">云途 OMS 路线每个任务固定一个包裹。缺少地址、包装或渠道条件时，任务进入人工待办。</p>
    {notice&&<p role="status">{notice}</p>}{error&&<p className="logistics-error" role="alert">{error}</p>}
  </form>;
}
