import {z} from "zod";
import {FinanceCommandDetailSchema,FinanceCommandEmptyBodySchema,FinanceCommandListSchema,FinanceCommandOriginalSchema,
  FinanceCommandQuerySchema,PrepareFinanceCommandSchema,type FinanceCommandQuery,type PrepareFinanceCommand} from "@yummyai/contracts/finance/finance-command";
import {apiFetch} from "../../../../../server-api";
import {FINANCE_COMMAND_RESULT_MAX_RESPONSE_BYTES,FINANCE_COMMAND_RESULT_PAGE_MAX_RESPONSE_BYTES,FinanceCommandRecordedResultSchema,
  FinanceCommandResultPageQuerySchema,FinanceCommandResultPageSchema,readFinanceCommandResultCursorPosition,
  type FinanceCommandResultPage,type FinanceCommandResultPageQuery} from "@yummyai/contracts/finance/finance-command-result";
import {isSameOriginRequest} from "../../../../../same-origin-request";
export const dynamic="force-dynamic";
type Context={params:Promise<{path:string[]}>};
const Id=z.uuidv7().transform(value=>value.toLowerCase());
const headers={"cache-control":"private, no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer"};
function failure(status:number,code?:string){return Response.json({error:"财务原提交暂不可用",...(code?{code}:{})},{status,headers});}
function lastResultAnchor(page:FinanceCommandResultPage){
  switch(page.section){
    case "cost_sources":{const last=page.items.at(-1);return last?`source:${page.offset+page.items.length-1}:${last.contributionId}`:null;}
    case "cost_shares":{const last=page.items.at(-1);return last?`share:${last.sourceIndex}:${last.shareIndex}:${last.source.contributionId}:${last.share.target.key}`:null;}
    default:return page.items.at(-1)?.id??null;
  }
}
async function jsonBody(body:ReadableStream<Uint8Array>|null,limit:number){
  if(!body)throw new Error("Missing body");const reader=body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const value=await reader.read();if(value.done)break;size+=value.value.byteLength;if(size>limit){await reader.cancel();throw new RangeError("Body too large");}chunks.push(value.value);}
    return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))) as unknown;
  }finally{reader.releaseLock();}
}
async function proxy(request:Request,context:Context,method:"GET"|"POST"){
  const {path}=await context.params;let id:string|undefined,original=false,result=false,entries=false,action:string|undefined;
  if(path.length){const parsed=Id.safeParse(path[0]);if(!parsed.success)return failure(404);id=parsed.data;}
  if(path.length===2){if(method==="GET"&&path[1]==="original")original=true;
    else if(method==="GET"&&path[1]==="result")result=true;
    else if(method==="POST"&&["execute","cancel","acknowledge"].includes(path[1]!))action=path[1];else return failure(404);}
  if(path.length===3){if(method!=="GET"||path[1]!=="result"||path[2]!=="entries")return failure(404);entries=true;}
  if(path.length>3||method==="POST"&&path.length===1)return failure(404);
  const url=new URL(request.url),raw=Object.fromEntries(url.searchParams);
  if(new Set(url.searchParams.keys()).size!==[...url.searchParams.keys()].length)return failure(400);
  if(path.length&&url.search&&!entries)return failure(400);
  let query:string="",scope:FinanceCommandQuery={},pageScope:FinanceCommandResultPageQuery|undefined;
  if(!path.length&&method==="GET"){
    const result=FinanceCommandQuerySchema.safeParse(raw);if(!result.success)return failure(400);
    scope=result.data;
    query=new URLSearchParams(Object.entries(result.data).map(([key,value])=>[key,value===null?"root":String(value)])).toString();
  }else if(entries){
    const parsed=FinanceCommandResultPageQuerySchema.safeParse(raw);if(!parsed.success||parsed.data.cursor&&!readFinanceCommandResultCursorPosition(parsed.data.cursor))return failure(400);
    pageScope=parsed.data;query=new URLSearchParams(Object.entries(parsed.data).map(([key,value])=>[key,String(value)])).toString();
  }else if(url.search)return failure(400);
  let body:PrepareFinanceCommand|Record<string,never>|undefined;
  if(method==="POST"){
    if(!isSameOriginRequest(request))return failure(403);
    if(!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))return failure(400);
    try{const rawBody=await jsonBody(request.body,path.length?1024:28*1024*1024);body=path.length?FinanceCommandEmptyBodySchema.parse(rawBody):PrepareFinanceCommandSchema.parse(rawBody);}
    catch(error){return failure(error instanceof RangeError?413:400);}
  }
  const base=process.env.API_BASE_URL?.replace(/\/$/,"");if(!base)return failure(503);
  const suffix=id?`/${encodeURIComponent(id)}${original?"/original":result?"/result":entries?"/result/entries":action?`/${action}`:""}`:"";
  try{
    const response=await apiFetch(`${base}/v1/finance/commands${suffix}${query?`?${query}`:""}`,{method,cache:"no-store",
      ...(body!==undefined?{body:JSON.stringify(body),headers:{"content-type":"application/json"}}:{}),
      signal:method==="POST"?AbortSignal.timeout(120_000):AbortSignal.any([request.signal,AbortSignal.timeout(30_000)])});
    if(!response.ok){const error=await jsonBody(response.body,8192).catch(()=>null),code=error&&typeof error==="object"&&"code"in error&&typeof error.code==="string"&&/^finance_[a-z_]{1,110}$/.test(error.code)?error.code:undefined;
      return failure([400,401,403,404,409,413,422,429,503].includes(response.status)?response.status:502,code);}
    if(response.status!==(method==="POST"&&!id?201:200))return failure(502);
    const rawResponse=await jsonBody(response.body,original?36*1024*1024:result?FINANCE_COMMAND_RESULT_MAX_RESPONSE_BYTES:entries?FINANCE_COMMAND_RESULT_PAGE_MAX_RESPONSE_BYTES:512*1024);
    if(result){const value=FinanceCommandRecordedResultSchema.parse(rawResponse);if(value.commandId!==id)return failure(502);return Response.json(value,{headers});}
    if(entries){const value=FinanceCommandResultPageSchema.parse(rawResponse),position=pageScope?.cursor?readFinanceCommandResultCursorPosition(pageScope.cursor):null;
      if(!pageScope||value.commandId!==id||value.section!==pageScope.section||value.limit!==pageScope.limit||value.offset!==(position?.offset??0))return failure(502);
      if(value.nextCursor){const next=readFinanceCommandResultCursorPosition(value.nextCursor);
        if(!next||next.offset!==value.offset+value.items.length||next.anchor!==lastResultAnchor(value)||position&&next.scope!==position.scope)return failure(502);}
      return Response.json(value,{headers});}
    if(original){const value=FinanceCommandOriginalSchema.parse(rawResponse);if(value.id!==id)return failure(502);return Response.json(value,{headers});}
    if(method==="GET"&&!id){const value=FinanceCommandListSchema.parse(rawResponse);
      if(value.items.some(item=>scope.kind&&item.kind!==scope.kind||scope.targetId!==undefined&&item.targetId!==scope.targetId
        ||scope.before&&item.id>=scope.before||item.contextAuthority!==value.contextAuthority||scope.view==="recorded"&&item.status!=="succeeded"
        ||scope.view!=="recorded"&&item.acknowledged)
        ||scope.before&&value.nextCursor&&value.nextCursor>=scope.before)return failure(502);
      return Response.json(value,{headers});}
    const value=FinanceCommandDetailSchema.parse(rawResponse);
    if(id?value.id!==id:body&&"kind"in body&&(value.kind!==body.kind||value.targetId!==body.targetId||value.requestKey!==body.input.idempotencyKey))return failure(502);
    return Response.json(value,{status:method==="POST"&&!id?201:200,headers});
  }catch{return failure(502);}
}
export const GET=(request:Request,context:Context)=>proxy(request,context,"GET");
export const POST=(request:Request,context:Context)=>proxy(request,context,"POST");
