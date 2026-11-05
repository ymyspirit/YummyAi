"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, Plus, Save, Settings2 } from "lucide-react";
import { FulfillmentRouteWorkspaceSchema, type FulfillmentRouteWorkspace, type FulfillmentRouteView } from "@yummyai/contracts/order/fulfillment-flow";
import { flowRequest } from "./order-flow-panel";
import { useOwnedViewTransition } from "../navigation/use-owned-view-transition";
import "./order-centers.css";
import "./fulfillment-flow.css";

export function FulfillmentRoutesWorkspace(){
  const transition=useOwnedViewTransition();
  const [view,setView]=useState<FulfillmentRouteWorkspace|null>(null),[error,setError]=useState(""),[notice,setNotice]=useState(""),
    [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[reload,setReload]=useState(0),[edit,setEdit]=useState<FulfillmentRouteView|null|undefined>(undefined);
  const [profileId,setProfileId]=useState(""),[connectionId,setConnectionId]=useState("");
  const request=useRef<{body:string;key:string}|null>(null);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError("");
    void flowRequest("routes",undefined,controller.signal).then(result=>setView(FulfillmentRouteWorkspaceSchema.parse(result)))
      .catch(error=>{if(!controller.signal.aborted)setError(error instanceof Error?error.message:"规则读取失败");})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[reload]);
  function select(route:FulfillmentRouteView|null){transition.change(()=>{setEdit(route);setProfileId(route?.profile.documentProfileVersionId??"");setConnectionId(route?.profile.connectionId??"");request.current=null;});}
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(!view)return;const form=new FormData(event.currentTarget);
    const input={...(edit?{id:edit.id}:{}),expectedVersion:edit?.version??0,profile:{name:String(form.get("name")??"").trim(),documentProfileVersionId:profileId,connectionId,
      mode:String(form.get("mode")),productionDays:Number(form.get("productionDays")),autoWriteback:form.get("autoWriteback")==="on"}};
    const body=JSON.stringify(input);if(request.current?.body!==body)request.current={body,key:crypto.randomUUID()};
    setBusy(true);setError("");setNotice("");
    try{
      await flowRequest("routes",{...input,idempotencyKey:request.current.key});
      const updated=FulfillmentRouteWorkspaceSchema.parse(await flowRequest("routes"));
      transition.change(()=>{setView(updated);setNotice("规则已保存 后续审核通过的订单将按规则继续");setEdit(undefined);request.current=null;});
    }
    catch(error){setError(error instanceof Error?error.message:"保存失败");}finally{setBusy(false);}
  }
  const selected=view?.profiles.find(profile=>profile.id===profileId);
  const connections=view?.connections.filter(connection=>connection.factoryId===selected?.factoryId)??[];
  return <main className="oc-page oc-routes-page" aria-busy={loading||busy}>
    <header className="oc-header"><div><h1>产品与发货规则</h1><p>按商品规格和收货国家确定工厂 共用工厂包裹数据与物流账户</p></div>
      <div className="oc-actions"><Link className="oc-button" href="/orders">返回订单工作台</Link>
        {view?.canConfigure&&<button className="oc-button primary" disabled={busy} onClick={()=>select(null)}><Plus size={16}/>新增规则</button>}</div></header>
    <div className="oc-route-setup"><Link href="/product-specifications">商品与规格</Link><ArrowRight size={14}/><Link href="/suppliers">工厂与承接工艺</Link><ArrowRight size={14}/><Link href="/logistics#documents">包裹与导单数据</Link><ArrowRight size={14}/><Link href="/logistics#connections">物流账户与费用规则</Link></div>
    <p className="oc-hint">管理员配置一次 运营审单时核对自动匹配结果 每单无需重新填写账户、地址和包裹数据</p>
    {error&&<div className="oc-error" role="alert">{error}<button className="oc-text-button" disabled={busy} onClick={()=>setReload(value=>value+1)}>重新读取</button></div>}
    {notice&&<p className="oc-notice" role="status">{notice}</p>}
    {loading&&!view?<p role="status">正在读取规则</p>:view&&!view.routes.length?<div className="oc-empty"><h2>建立第一条产品发货规则</h2><p>选择已保存的工厂包裹规则和物流连接 审核通过后由系统自动推进</p></div>:null}
    {!!view?.routes.length&&<div className="oc-route-table"><table><thead><tr><th>商品与收货国家</th><th>制作工厂</th><th>物流方式</th><th>审核后处理</th><th>配置状态</th><th>操作</th></tr></thead><tbody>{view.routes.map(route=><tr key={route.id}>
      <td><strong>{route.profile.name}</strong><small>{route.products.join("、")} · {route.countries.join(" / ")}</small></td><td>{route.factoryName}<small>{route.supplierName}</small></td><td>{route.connectionName}</td>
      <td>{({disabled:"暂停",quote:"自动询价",purchase:"自动购单并准备交付"})[route.profile.mode]}</td><td>{route.blockers.length?<span className="oc-route-warning">{route.blockers.join("；")}</span>:"已配置"}</td>
      <td><button className="oc-text-button" disabled={busy||!view.canConfigure} onClick={()=>select(route)}><Settings2 size={14}/>编辑</button></td></tr>)}</tbody></table></div>}
    {edit!==undefined&&view?.canConfigure&&<form className="oc-route-form" key={edit?.id??"new"} onSubmit={save}>
      <h2>{edit?"编辑规则":"新增规则"}</h2><fieldset disabled={busy}>
        <label>规则名称<input name="name" required maxLength={160} defaultValue={edit?.profile.name??""} placeholder="例如 美国异形抱枕"/></label>
        <label>工厂包裹规则<select aria-label="工厂包裹规则" required value={profileId} onChange={event=>{setProfileId(event.target.value);setConnectionId("");}}><option value="">选择已保存的规则</option>{view.profiles.map(profile=><option value={profile.id} key={profile.id}>{profile.factoryName} · {profile.name} · {profile.countries.join("/")}</option>)}</select></label>
        <label>物流连接<select aria-label="物流连接" required value={connectionId} onChange={event=>setConnectionId(event.target.value)}><option value="">选择该工厂的物流连接</option>{connections.map(connection=><option key={connection.id} value={connection.id}>{connection.name}</option>)}</select></label>
        <label>制作计划天数<input name="productionDays" type="number" required min={1} max={30} defaultValue={edit?.profile.productionDays??""}/></label>
        <label>平台物流回传<select name="autoWriteback" aria-label="平台物流回传" defaultValue={edit?.profile.autoWriteback?"on":"off"}><option value="off">先人工核对回传</option><option value="on">实际交运后自动回传至已授权店铺</option></select></label>
        <label>审图通过后<select name="mode" aria-label="审图通过后" defaultValue={edit?.profile.mode??"quote"}><option value="quote">自动询价 先不扣费</option><option value="purchase" disabled={!connections.find(connection=>connection.id===connectionId)?.autoPurchase}>自动购单并准备工厂文件</option><option value="disabled">暂停自动处理</option></select></label>
      </fieldset>
      <p className="oc-hint">同一规格和国家只能启用一条规则 自动购单沿用物流连接的费用规则 超过每件均价阈值或已设置的总额上限时进入异常处理</p>
      <div className="oc-actions"><button className="oc-button primary" disabled={busy} type="submit"><Save size={15}/>{busy?"正在保存":"保存规则"}</button><button className="oc-button" type="button" disabled={busy} onClick={()=>transition.change(()=>setEdit(undefined))}>取消</button></div>
    </form>}
  </main>;
}
