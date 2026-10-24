import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
export const dynamic = "force-dynamic";
const id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const read = new RegExp(`^(connections|options|tasks|tasks/${id}(/labels/${id})?)$`, "i");
const write = new RegExp(`^(connections|rules|tasks|connections/${id}/verify|tasks/${id}/(dispatch|cancel))$`, "i");
type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: Request, context: Context) {return proxy(request,context,"GET");}
export async function POST(request: Request, context: Context) {return proxy(request,context,"POST");}
async function proxy(request: Request, context: Context, method: "GET"|"POST") {
  const target=(await context.params).path.join("/");
  if(!(method==="GET"?read:write).test(target))return failure(404);
  const url=new URL(request.url), allowed=target==="tasks"?["orderId","factoryId","limit"]:target==="options"?["orderId"]:[];
  if([...url.searchParams.keys()].some(k=>!allowed.includes(k)||url.searchParams.getAll(k).length!==1))return failure(400);
  if(method==="POST"&&(!isSameOriginRequest(request)||!request.headers.get("content-type")?.startsWith("application/json")))return failure(403);
  const base=process.env.API_BASE_URL?.replace(/\/$/,"");if(!base)return failure(503);
  let body: string|undefined;
  if(method==="POST") {
    const reader=request.body?.getReader();if(!reader)return failure(400);
    const chunks: Uint8Array[]=[];let size=0;
    while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>128*1024){await reader.cancel();return failure(413);}chunks.push(next.value);}
    body=Buffer.concat(chunks).toString("utf8");try{JSON.parse(body);}catch{return failure(400);}
  }
  try {
    const response=await apiFetch(`${base}/v1/logistics/${target}${url.search}`,{method,body,headers:body?{"content-type":"application/json"}:undefined,cache:"no-store",signal:AbortSignal.timeout(40_000)});
    if(!response.ok){const data=[409,422].includes(response.status)?await response.json().catch(()=>null):null;return failure(response.status,typeof data?.message==="string"&&data.message.length<400?data.message:undefined);}
    const headers=new Headers({"cache-control":"private, no-store","content-type":response.headers.get("content-type")??"application/json","x-content-type-options":"nosniff","referrer-policy":"no-referrer"});
    if(target.includes("/labels/")){headers.set("content-disposition",response.headers.get("content-disposition")??"attachment; filename=label.pdf");headers.set("content-security-policy","default-src 'none'; sandbox");}
    return new Response(response.body,{status:response.status,headers});
  }catch{return failure(502);}
}
function failure(status:number,message?:string){return Response.json({message:message??(status===403?"当前成员无权执行此物流操作":status===401?"登录已失效，请重新登录":status===413?"物流请求过大":"物流操作未完成，请核对输入及连接配置")},{status,headers:{"cache-control":"private, no-store"}});}
