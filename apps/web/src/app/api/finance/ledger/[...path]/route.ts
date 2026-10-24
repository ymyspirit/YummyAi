import { FinanceLedgerDetailInputSchema, FinanceLedgerDetailViewSchema, FinanceLedgerKindSchema,
  FinanceLedgerListInputSchema, FinanceLedgerPageViewSchema, financeLedgerDetailParentId, readFinanceLedgerCursorPosition } from "@yummyai/contracts/finance/ledger";
import { apiFetch } from "../../../../../server-api";
export const dynamic="force-dynamic";
type Context={params:Promise<{path:string[]}>};
const headers={"cache-control":"private, no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer"};
const failure=(status:number)=>Response.json({message:status===401?"身份会话无效 请重新登录 ERP":status===403?"当前没有财务读取权限":status===404?"当前无法读取这笔台账记录":status===400?"台账读取条件或游标无效 请重新核对":"暂时无法核对财务台账 请稍后重试"},{status,headers});
export async function GET(request:Request,context:Context){
  const {path}=await context.params;
  if(path.length!==1&&path.length!==2||!FinanceLedgerKindSchema.safeParse(path[0]).success)return failure(404);
  const query=new URL(request.url).searchParams,allowed=path.length===1?new Set(["limit","cursor","parentId"]):new Set(["parentId"]);
  const seen=new Set<string>();
  for(const[key]of query){if(!allowed.has(key)||seen.has(key))return failure(400);seen.add(key);}
  const input=path.length===1?FinanceLedgerListInputSchema.safeParse({kind:path[0],...Object.fromEntries(query)}):FinanceLedgerDetailInputSchema.safeParse({kind:path[0],id:path[1],...Object.fromEntries(query)});
  if(!input.success)return failure(400);
  const position="cursor"in input.data&&input.data.cursor?readFinanceLedgerCursorPosition(input.data.cursor):null;
  if("cursor"in input.data&&input.data.cursor&&!position)return failure(400);
  const base=process.env.API_BASE_URL?.replace(/\/$/,"");if(!base)return failure(503);
  const search=new URLSearchParams();if(input.data.parentId)search.set("parentId",input.data.parentId);
  if("limit"in input.data){search.set("limit",String(input.data.limit));if(input.data.cursor)search.set("cursor",input.data.cursor);}
  const url=`${base}/v1/finance/ledger/${input.data.kind}${"id"in input.data?"/"+input.data.id:""}${search.size?"?"+search.toString():""}`;
  try{
    const response=await apiFetch(url,{cache:"no-store",signal:AbortSignal.any([request.signal,AbortSignal.timeout(25_000)])});
    if(!response.ok){await response.body?.cancel();return failure([400,401,403,404].includes(response.status)?response.status:502);}
    const reader=response.body?.getReader();if(!reader)return failure(502);
    const chunks:Uint8Array[]=[];let size=0;
    try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>8*1024*1024){await reader.cancel();return failure(502);}chunks.push(part.value);}}
    finally{reader.releaseLock();}
    const raw:unknown=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if("id"in input.data){
      const result=FinanceLedgerDetailViewSchema.safeParse(raw);
      if(!result.success||result.data.kind!==input.data.kind||result.data.id!==input.data.id
        ||input.data.parentId&&financeLedgerDetailParentId(result.data)!==input.data.parentId)return failure(502);
      return Response.json(result.data,{headers});
    }
    const result=FinanceLedgerPageViewSchema.safeParse(raw);
    if(!result.success||result.data.kind!==input.data.kind||result.data.parentId!==(input.data.parentId??null)||result.data.limit!==input.data.limit
      ||result.data.nextCursor!==null&&result.data.nextCursor===input.data.cursor
      ||!input.data.cursor&&result.data.upperBoundId!==(result.data.items[0]?.id??null)
      ||position&&(result.data.upperBoundId!==position.upperId||result.data.items.some(row=>row.id>=position.id)))return failure(502);
    if(result.data.nextCursor){
      const next=readFinanceLedgerCursorPosition(result.data.nextCursor);
      if(!next||next.upperId!==result.data.upperBoundId||next.id!==result.data.items.at(-1)?.id
        ||position&&next.scope!==position.scope)return failure(502);
    }
    return Response.json(result.data,{headers});
  }catch{return failure(502);}
}
