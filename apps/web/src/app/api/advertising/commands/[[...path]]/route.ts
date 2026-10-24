import {z} from "zod";
import {AdCommandAccountQuerySchema,AdCommandDetailSchema,AdCommandEmptyBodySchema,AdCommandListSchema,AdCommandOriginalSchema,
  AdCommandQuerySchema,PrepareAdCommandSchema,adCommandScopeKey,type AdCommandQuery,type PrepareAdCommand} from "@yummyai/contracts/advertising/command";
import {apiFetch} from "../../../../../server-api";
import {isSameOriginRequest} from "../../../../../same-origin-request";
export const dynamic="force-dynamic";
type Context={params:Promise<{path?:string[]}>};
const Id=z.uuidv7().transform(value=>value.toLowerCase());
const headers={"cache-control":"private, no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer"};
function failure(status:number,code?:string){return Response.json({error:"广告原提交暂不可用",...(code?{code}:{})},{status,headers});}
async function jsonBody(body:ReadableStream<Uint8Array>|null,limit:number){
  if(!body)throw new SyntaxError("Missing body");const reader=body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit){await reader.cancel();throw new RangeError("Body too large");}chunks.push(part.value);}
    return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))) as unknown;
  }finally{reader.releaseLock();}
}
async function proxy(request:Request,context:Context,method:"GET"|"POST"){
  const path=(await context.params).path??[];let id:string|undefined,original=false,action:string|undefined;
  if(path.length){const result=Id.safeParse(path[0]);if(!result.success)return failure(404);id=result.data;}
  if(path.length===2){if(method==="GET"&&path[1]==="original")original=true;
    else if(method==="POST"&&["execute","cancel","acknowledge"].includes(path[1]!))action=path[1];else return failure(404);}
  if(path.length>2||method==="POST"&&path.length===1)return failure(404);
  const url=new URL(request.url),raw=Object.fromEntries(url.searchParams);
  if(new Set(url.searchParams.keys()).size!==[...url.searchParams.keys()].length)return failure(400);
  let query="",scope:AdCommandQuery|undefined,accountId:string|undefined;
  if(id){const result=AdCommandAccountQuerySchema.safeParse(raw);if(!result.success)return failure(400);accountId=result.data.accountId;query=new URLSearchParams({accountId}).toString();}
  else if(method==="GET"){
    const result=AdCommandQuerySchema.safeParse(raw);if(!result.success)return failure(400);scope=result.data;accountId=scope.accountId;
    query=new URLSearchParams(Object.entries(scope).map(([key,value])=>[key,value===null?"root":String(value)])).toString();
  }else if(url.search)return failure(400);
  let body:PrepareAdCommand|Record<string,never>|undefined;
  if(method==="POST"){
    if(!isSameOriginRequest(request))return failure(403);
    if(!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))return failure(400);
    try{const rawBody=await jsonBody(request.body,id?1024:28*1024*1024);body=id?AdCommandEmptyBodySchema.parse(rawBody):PrepareAdCommandSchema.parse(rawBody);}
    catch(error){return failure(error instanceof RangeError?413:400);}
  }
  const base=process.env.API_BASE_URL?.replace(/\/$/,"");if(!base)return failure(503);
  const suffix=id?`/${encodeURIComponent(id)}${original?"/original":action?`/${action}`:""}`:"";
  try{
    const response=await apiFetch(`${base}/v1/advertising/commands${suffix}${query?`?${query}`:""}`,{method,cache:"no-store",
      ...(body!==undefined?{body:JSON.stringify(body),headers:{"content-type":"application/json"}}:{}),
      signal:method==="POST"?AbortSignal.timeout(120_000):AbortSignal.any([request.signal,AbortSignal.timeout(30_000)])});
    if(!response.ok){const error=await jsonBody(response.body,8192).catch(()=>null),code=error&&typeof error==="object"&&"code"in error&&typeof error.code==="string"&&/^advertising_[a-z_]{1,110}$/.test(error.code)?error.code:undefined;
      return failure([400,401,403,404,409,413,422,429,503].includes(response.status)?response.status:502,code);}
    if(response.status!==(method==="POST"&&!id?201:200))return failure(502);
    const rawResponse=await jsonBody(response.body,original?36*1024*1024:512*1024);
    if(original){const value=AdCommandOriginalSchema.parse(rawResponse);if(value.id!==id||value.accountId!==accountId)return failure(502);return Response.json(value,{headers});}
    if(method==="GET"&&!id){const value=AdCommandListSchema.parse(rawResponse);
      if(!scope||value.accountId!==scope.accountId||value.items.some((item,index)=>scope!.kind&&item.kind!==scope!.kind
        ||scope!.targetId!==undefined&&item.targetId!==scope!.targetId||scope!.before&&item.id>=scope!.before
        ||scope!.view==="recorded"&&item.status!=="succeeded"||scope!.view!=="recorded"&&item.acknowledged
        ||index>0&&value.items[index-1]!.id<=item.id)||scope.before&&value.nextCursor&&value.nextCursor>=scope.before)return failure(502);
      return Response.json(value,{headers});}
    const value=AdCommandDetailSchema.parse(rawResponse);
    if(id){if(value.id!==id||value.accountId!==accountId)return failure(502);}
    else if(!body||!("kind"in body)||value.kind!==body.kind||value.accountId!==body.accountId||value.targetId!==body.targetId
      ||value.scopeKey!==adCommandScopeKey(body)||value.requestKey!==body.input.idempotencyKey)return failure(502);
    return Response.json(value,{status:method==="POST"&&!id?201:200,headers});
  }catch{return failure(502);}
}
export const GET=(request:Request,context:Context)=>proxy(request,context,"GET");
export const POST=(request:Request,context:Context)=>proxy(request,context,"POST");
