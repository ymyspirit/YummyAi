import { Permission } from "@yummyai/authz/permissions";
import type { Permission as PermissionValue } from "@yummyai/authz/permissions";
import { PrepareProductVisualImageSchema, ProductVisualImageAddressSchema, CommitProductVisualImageSchema, CancelProductVisualImageSchema,
  ProductVisualImageIndexSchema, ProductVisualImageLookupQuerySchema, ProductVisualImageOriginalSchema } from "@yummyai/contracts/catalog/product-visual-generation";
import { StudioPaidImageRequestSchema, StudioPaidImageLookupSchema, StudioPaidImagePageSchema, StudioPaidImageAbandonSchema } from "@yummyai/contracts/pod/studio-paid-image";
import { readStudioJson, requireStudioPersonalIdentity, studioPersonalCall, studioPersonalException, studioPersonalFailure } from "./creative-studio-personal-server";
import { isSameOriginRequest } from "./same-origin-request";

const id="[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const uuid="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const route=new RegExp(`^(${id})/launch/visuals/(${uuid})/(images(?:/(prepare|commit|cancel|abandon)|/by-request/(${uuid}))?|prepare-original)$`,"i");
export const isProductVisualGenerationPath=(path:string)=>route.test(path);

/** Personal, bounded proxy for the real paid-image owner. No opaque generic
 * JSON cast or stale-session streaming is allowed for original paid receipts. */
export async function productVisualGenerationProxy(request:Request,path:string,method:"GET"|"POST"){
  const match=route.exec(path);if(!match)return studioPersonalFailure(404);
  const [,planId,groupId,target,action,lookupId]=match;
  const read=target==="images"||!!lookupId;
  if((read?"GET":"POST")!==method)return studioPersonalFailure(404);
  if(request.headers.get("sec-fetch-site")==="cross-site"||method==="POST"&&!isSameOriginRequest(request))return studioPersonalFailure(403);
  const params=new URL(request.url).searchParams;
  if([...params.keys()].some(key=>params.getAll(key).length!==1)||method==="POST"&&params.size)return studioPersonalFailure(400);
  try{
    const required:PermissionValue[]=[Permission.ProductRead,Permission.DesignRead,Permission.AssetRead];
    if(method==="POST"&&target!=="prepare-original")required.push(Permission.DesignWrite,Permission.AssetWrite);
    const identity=await requireStudioPersonalIdentity(request,required);
    let body:unknown,slotKey:string,requestId:string|undefined,query="";
    if(method==="GET"){
      const parsed=(lookupId?ProductVisualImageLookupQuerySchema:ProductVisualImageIndexSchema).parse(Object.fromEntries(params));
      slotKey=parsed.slotKey;requestId=lookupId;query=`?${new URLSearchParams(Object.entries(parsed).map(([k,v])=>[k,String(v)]))}`;
    }else{
      const schema=action==="prepare"?PrepareProductVisualImageSchema:action==="commit"?CommitProductVisualImageSchema:action==="cancel"?CancelProductVisualImageSchema:ProductVisualImageAddressSchema;
      const parsed=schema.parse(await readStudioJson(request,8192));body=parsed;slotKey=parsed.slotKey;requestId=parsed.requestId;
    }
    const checkRequest=(raw:unknown)=>{
      const value=StudioPaidImageRequestSchema.parse(raw),visual=value.quote.visualDelivery;
      if(!visual||visual.salesPlanId!==planId||visual.groupId!==groupId||visual.slotKey!==slotKey||value.input.visualSlotKey!==slotKey
        ||requestId&&value.requestId!==requestId)throw Error("product_visual_original_changed");
      return value;
    };
    const schema={parse(raw:unknown){
      if(target==="prepare-original"){
        const result=ProductVisualImageOriginalSchema.parse(raw);
        if(result.slotKey!==slotKey||result.requestId!==requestId)throw Error("product_visual_original_changed");return result;
      }
      if(action==="abandon"){
        const result=StudioPaidImageAbandonSchema.parse(raw);if(result.requestId!==requestId)throw Error("product_visual_original_changed");return result;
      }
      if(lookupId){const result=StudioPaidImageLookupSchema.parse(raw);if(result.status==="found")checkRequest(result.request);
        else if(result.requestId!==requestId)throw Error("product_visual_original_changed");return result;}
      if(target==="images"){const page=StudioPaidImagePageSchema.parse(raw);page.items.forEach(checkRequest);return page;}
      return checkRequest(raw);
    }};
    return await studioPersonalCall(request,identity,`sales-plans/${path}${query}`,{method,
      ...(body?{body:JSON.stringify(body),headers:{"content-type":"application/json"}}:{})},schema,2*1024*1024);
  }catch(cause){return studioPersonalException(cause,request);}
}
