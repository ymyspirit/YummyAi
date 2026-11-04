"use client";
import { useEffect,useRef,useState,type FormEvent } from "react";
import { KeyRound,Save,Undo2,PlugZap } from "lucide-react";
import { SaveLogisticsAccountSchema,type LogisticsAccountView } from "@yummyai/contracts/logistics";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import { logisticsRequest,logisticsError } from "./logistics-client";

export function LogisticsAccountForm({accounts,onSaved}:{accounts:LogisticsAccountView[];onSaved():Promise<void>}){
  const [selected,setSelected]=useState(""),[provider,setProvider]=useState<"shipos"|"yunexpress">("shipos"),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState(""),[reset,setReset]=useState(0);
  const [protocol,setProtocol]=useState<"oms"|"openapi">("openapi");
  const key=useRef(crypto.randomUUID()),alive=useRef(true),version=useRef(0);
  const current=accounts.find(account=>account.id===selected);
  useLeaveGuard(dirty,busy);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  function choose(id:string){const next=accounts.find(a=>a.id===id);setSelected(id);setProvider(next?.profile.provider??"shipos");setProtocol(next?(next.profile.yunexpressProtocol??"oms"):"openapi");version.current=next?.version??0;setDirty(false);setError("");setNotice("");key.current=crypto.randomUUID();setReset(x=>x+1);}
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();const form=event.currentTarget,data=new FormData(form),v=(name:string)=>String(data.get(name)??"").trim();
    setBusy(true);setError("");setNotice("");
    try{
      if(!v("secret")&&(v("account")||v("appId")||v("sourceKey")))throw new Error("更换账户标识时请同时填写对应 API 密钥");
      const secret=v("secret"),credentials=secret?(provider==="shipos"?{provider,appKey:v("account"),appSecret:secret}:{provider,apiSecret:secret,...(v("account")?{customerCode:v("account")} : {}),...(protocol==="openapi"?{appId:v("appId"),sourceKey:v("sourceKey")}:{})}):undefined;
      const input=SaveLogisticsAccountSchema.parse({...(selected?{accountId:selected}:{}),expectedVersion:version.current,profile:{name:v("name"),provider,baseUrl:v("baseUrl")||null,...(provider==="yunexpress"?{yunexpressProtocol:protocol}:{})},...(credentials?{credentials}:{}),idempotencyKey:key.current});
      const result=await logisticsRequest("accounts",input);if(!alive.current)return;
      form.querySelector<HTMLInputElement>('input[name="secret"]')!.value="";form.querySelector<HTMLInputElement>('input[name="account"]')!.value="";
      version.current=result.version;setSelected(result.accountId);setDirty(false);key.current=crypto.randomUUID();await onSaved();
      if(alive.current){setReset(value=>value+1);setNotice("API 账户已加密保存 测试连接只读取渠道 补齐工厂资料后可绑定发货路线");}
    }catch(e){if(alive.current)setError(logisticsError(e));}finally{if(alive.current)setBusy(false);}
  }
  async function verify(){if(!current)return;setBusy(true);setError("");setNotice("");try{const result=await logisticsRequest(`accounts/${current.id}/verify`,{expectedVersion:current.version});await onSaved();if(alive.current)setNotice(`连接测试通过 已读取 ${result.channels.length} 个渠道 尚未创建物流订单`);}catch(e){if(alive.current)setError(logisticsError(e));}finally{if(alive.current)setBusy(false);}}
  return <section className="logistics-section logistics-api-accounts" aria-label="物流 API 账户">
    <h2><KeyRound size={18}/>物流 API 账户</h2>
    <p className="oc-muted">先保存账户并测试连接 工厂资料待补也可登记 每次修改保留版本 密钥不回显</p>
    <form className="logistics-form" onSubmit={event=>void save(event)} onChange={()=>{setDirty(true);key.current=crypto.randomUUID();}}>
      <label>选择 API 账户<select value={selected} disabled={busy||dirty} onChange={event=>{event.stopPropagation();choose(event.target.value);}}><option value="">新增 API 账户</option>{accounts.map(a=><option value={a.id} key={a.id}>{a.profile.name} · V{a.version}</option>)}</select></label>
      <fieldset className="logistics-fields" disabled={busy} key={`${selected}:${provider}:${reset}`}>
        <label>服务商<select aria-label="服务商" value={provider} disabled={!!current} onChange={event=>{setProvider(event.target.value as typeof provider);setProtocol("openapi");}}><option value="shipos">Printeque · ShipOS</option><option value="yunexpress">云途</option></select></label>
        {provider==="yunexpress"&&<label>接口版本<select aria-label="接口版本" value={protocol} onChange={event=>setProtocol(event.target.value as typeof protocol)}><option value="openapi">云途开放平台 OpenAPI</option><option value="oms">旧版 OMS</option></select></label>}
        <label>账户名称<input name="name" required maxLength={160} defaultValue={current?.profile.name??(provider==="shipos"?"Printeque 面单账户":"云途面单账户")}/></label>
        <label>正式 API 地址<input name="baseUrl" type="url" key={protocol} defaultValue={provider==="shipos"?(current?.profile.baseUrl??"https://api.shipos.cn"):protocol===(current?.profile.yunexpressProtocol??"oms")?(current?.profile.baseUrl??""):protocol==="openapi"?"https://openapi.yunexpress.cn":""} placeholder="待确认可留空保存"/></label>
        <label>{provider==="shipos"?"AppKey":protocol==="openapi"?"客户代码（可选）":"客户代码"}<input name="account" required={!current&&(provider==="shipos"||protocol==="oms")} autoComplete="off" maxLength={200} placeholder={current?"更换密钥时一起填写":""}/></label>
        <label>{provider==="shipos"||protocol==="openapi"?"AppSecret":"API 密钥"}<input name="secret" type="password" required={!current||provider==="yunexpress"&&protocol!==(current.profile.yunexpressProtocol??"oms")} autoComplete="new-password" maxLength={1000} placeholder={current?"留空保留已加密凭据":""}/></label>
        {provider==="yunexpress"&&protocol==="openapi"&&<><label>AppId<input name="appId" required={!current} autoComplete="off" maxLength={200}/></label><label>来源标识 sourceKey<input name="sourceKey" type="password" required={!current} autoComplete="new-password" maxLength={200}/></label></>}
      </fieldset>
      {provider==="yunexpress"&&<p className="oc-muted">{protocol==="openapi"?"AppId 和 AppSecret 来自开放平台应用 sourceKey 来自用户中心 测试连接只读取产品渠道":"旧版 OMS 使用客户代码与 API 密钥 切换到开放平台时须重新填写应用凭据"}</p>}
      <div className="oc-actions"><button className="oc-button primary" disabled={busy||!dirty}><Save size={15}/>保存账户</button><button className="oc-button" type="button" disabled={busy||!dirty} onClick={()=>choose(selected)}><Undo2 size={15}/>放弃本次修改</button><button className="oc-button" type="button" disabled={busy||dirty||!current?.profile.baseUrl} onClick={()=>void verify()}><PlugZap size={15}/>测试连接</button></div>
    </form>
    {notice&&<p role="status">{notice}</p>}{error&&<p className="logistics-error" role="alert">{error}</p>}
    {current&&<p className="oc-muted">{current.verifiedAt?"当前版本连接已验证":"当前版本待测试"} · 绑定工厂和启用购单需另行完成发货路线配置</p>}
    {!!current?.channels.length&&<details><summary>账户可用渠道 · {current.channels.length}</summary><ul>{current.channels.map(channel=><li key={channel.code}>{channel.name} · {channel.code}</li>)}</ul></details>}
  </section>;
}
