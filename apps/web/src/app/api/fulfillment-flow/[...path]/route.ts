import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
export const dynamic = "force-dynamic";
const id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
type Context = {params:Promise<{path:string[]}>};
export function GET(request:Request,context:Context) { return proxy(request,context,"GET"); }
export function POST(request:Request,context:Context) { return proxy(request,context,"POST"); }
async function proxy(request:Request,context:Context,method:"GET"|"POST") {
  const path=(await context.params).path.join("/");
  if (!new RegExp(method==="GET" ? `^(routes|orders|orders/${id})$` : `^(routes|orders/resume|orders/${id}/resume)$`,"i").test(path)) return failure(404);
  if (new URL(request.url).search) return failure(400);
  if (method==="POST" && (!isSameOriginRequest(request) || !request.headers.get("content-type")?.startsWith("application/json"))) return failure(403);
  const base=process.env.API_BASE_URL?.replace(/\/$/,""); if(!base)return failure(503);
  let body:string|undefined;
  if(method==="POST"){
    const reader=request.body?.getReader();if(!reader)return failure(400);
    const chunks:Uint8Array[]=[];let size=0;
    for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>16_384){await reader.cancel();return failure(413);}chunks.push(item.value);}
    body=Buffer.concat(chunks).toString("utf8");try{JSON.parse(body);}catch{return failure(400);}
  }
  try {
    const response=await apiFetch(`${base}/v1/fulfillment-flow/${path}`,{method,body,headers:body?{"content-type":"application/json"}:undefined,cache:"no-store",signal:AbortSignal.timeout(40_000)});
    if(!response.ok){const data=await response.json().catch(()=>null);return failure(response.status,[409,422].includes(response.status)&&typeof data?.message==="string"?data.message:undefined);}
    return new Response(response.body,{status:response.status,headers:{"content-type":"application/json","cache-control":"private, no-store","x-content-type-options":"nosniff"}});
  }catch{return failure(502);}
}
function failure(status:number,message?:string){return Response.json({message:message??(status===403?"当前账号没有此操作权限":status===401?"登录已失效 请重新登录":"履约规则读取或保存失败 请重试")},{status,headers:{"cache-control":"private, no-store"}});}
