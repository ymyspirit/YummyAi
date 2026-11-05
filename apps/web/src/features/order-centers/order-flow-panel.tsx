"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, CircleAlert, RefreshCw } from "lucide-react";
import { FULFILLMENT_FLOW_LABELS, FulfillmentFlowViewSchema, type FulfillmentFlowView } from "@yummyai/contracts/order/fulfillment-flow";

export async function flowRequest(path:string,body?:unknown,signal?:AbortSignal) {
  const response=await fetch(`/api/fulfillment-flow/${path}`,{method:body?"POST":"GET",cache:"no-store",signal,
    headers:body?{"content-type":"application/json"}:undefined,body:body?JSON.stringify(body):undefined});
  const result=await response.json();
  if(!response.ok)throw new Error(result.message??"读取失败 请重试");
  return result;
}
export function OrderFlowPanel({orderId,refreshToken,disabled,onChanged,onAutomaticDesign}:{orderId:string;refreshToken:number;disabled:boolean;onChanged():void;onAutomaticDesign(enabled:boolean):void}) {
  const [view,setView]=useState<FulfillmentFlowView|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[reload,setReload]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    setView(null);setError("");onAutomaticDesign(false);
    let timer:ReturnType<typeof setTimeout>|undefined;
    async function refresh(){
      try{
        const result=FulfillmentFlowViewSchema.parse(await flowRequest(`orders/${orderId}`,undefined,controller.signal));
        if(controller.signal.aborted)return;
        setView(result);setError("");onAutomaticDesign(result.automaticDesign);
        if(result.id&&!["completed","exception","paused"].includes(result.stage??""))timer=setTimeout(()=>void refresh(),15_000);
      }catch(error){if(!controller.signal.aborted)setError(error instanceof Error?error.message:"自动履约状态读取失败");}
    }
    void refresh();
    return()=>{controller.abort();clearTimeout(timer);};
  },[orderId,refreshToken,reload,onAutomaticDesign]);
  async function resume(){
    setBusy(true);setError("");
    try{setView(FulfillmentFlowViewSchema.parse(await flowRequest(`orders/${orderId}/resume`,{})));onChanged();}
    catch(error){setError(error instanceof Error?error.message:"继续处理失败");}finally{setBusy(false);}
  }
  return <section className="oc-flow-panel" aria-label="本单自动履约" aria-busy={busy}>
    <div className="oc-flow-heading"><h2>本单履约</h2><span>{view?.stage?FULFILLMENT_FLOW_LABELS[view.stage]:view?"审图通过后按规则继续":"正在读取"}</span>
      <button className="oc-text-button" aria-label="刷新本单履约状态" disabled={busy||disabled} onClick={()=>setReload(value=>value+1)}><RefreshCw size={14}/></button></div>
    {view?.route && <div className="oc-flow-route"><span>{view.route.products.join("、")}</span><ArrowRight size={14}/><span>{view.route.factoryName}</span><ArrowRight size={14}/><span>{view.route.connectionName}</span><small>{view.route.profile.mode==="quote"?"只询价":view.route.profile.mode==="purchase"?"审核后自动购单":"已停用"}</small></div>}
    {!!view?.reasons.length && <p className="oc-hint">{view.stage==="exception"&&<CircleAlert size={14}/>} {view.reasons.join("；")}</p>}
    {error&&<p className="oc-error" role="alert">{error}</p>}
    <div className="oc-flow-links">
      <Link href="/fulfillment-routes">产品与发货规则</Link>
      {view?.logisticsTaskId&&<Link href={`/logistics?orderId=${orderId}`}>查看面单与费用</Link>}
      {view?.productionExportId&&<a href={`/api/logistics/documents/exports/${view.productionExportId}/file`}>下载工厂 ERP 表</a>}
      {view?.deliveryPackageIds.map((id,index)=><a key={id} href={`/api/order-centers/deliveries/${id}/file`}>下载生产文件包{view.deliveryPackageIds.length>1?index+1:""}</a>)}
      {!!view?.deliveryPackageIds.length&&<Link href={`/production?order=${orderId}&delivery=${view.deliveryPackageIds[0]}`}>工厂交付文件</Link>}
      {view?.route&&(!view.id||view.stage==="exception"||view.stage==="paused")&&<button className="oc-button" disabled={disabled||busy} onClick={()=>void resume()}>{busy?"正在核对":"按规则继续"}</button>}
    </div>
  </section>;
}
