import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { PersonalSessionError } from "../../../../identity/core";
const mocks = vi.hoisted(() => ({ upstream: vi.fn(), identity: vi.fn(), current: vi.fn(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current, erpAuthFailure: mocks.failure }));
import { GET, POST } from "./route";

const factoryId=createEntityId(), poolId=createEntityId(), versionId=createEntityId(), factoryVersionId=createEntityId(), capabilityVersionId=createEntityId(), productionId=createEntityId();
const context:TenantContext={tenantId:createEntityId(),userId:createEntityId(),permissions:["order:read","order:write"],dataScope:"tenant"};
const at="2026-10-21T00:00:00.000Z", date="2026-10-22", stamp=erpSessionAuthority(context), origin="http://localhost:3130";
const profile={name:"Synthetic finite resource",status:"active",dailyCapacityUnits:10,
  weekly:Array.from({length:7},(_,index)=>({weekday:index+1,intervals:[{start:"08:00",end:"16:00"}]})),exceptions:[],cutoffTime:null,
  bindings:[{capabilityVersionId,unitsPerItem:1}],evidenceReference:"Synthetic confirmed capacity only",notes:""};
const pool=()=>({id:poolId,factoryId,code:"SYNTHETIC",timeZone:"UTC",unit:"each",factoryVersionId,versionId,versionNumber:1,profile,createdAt:at});
const authority={contextAuthority:stamp,access:{canRead:true,canWrite:true}};
const day=()=>({poolId,poolVersionId:versionId,localDate:date,timeZone:"UTC",unit:"each",intervals:[{start:date+"T08:00:00.000Z",end:date+"T16:00:00.000Z"}],cutoffAt:null,
  capacityUnits:10,allocatedUnits:0,committedUnits:0,releasedUnits:0,availableUnits:10,blockers:[]});
const workspace=()=>({...authority,factoryId,from:date,days:1,recordedAt:at,pools:[pool()],calendar:[day()]});
const create=()=>({factoryVersionId,code:"SYNTHETIC",timeZone:"UTC",unit:"each",profile,idempotencyKey:"33333333-3333-4333-8333-333333333333"});
const selection={poolId,poolVersionId:versionId,localDate:date};
const previewInput=()=>({items:[{reference:"original-line",factoryVersionId,capabilityVersionId,quantity:2,expectedCompletionAt:date+"T17:00:00.000Z",capacityPlan:{allocations:[selection]}}]});
const preview=()=>({...authority,factoryId,recordedAt:at,canReserve:true,blockers:[],items:[{reference:"original-line",quantity:2,expectedCompletionAt:date+"T17:00:00.000Z",blockers:[],
  allocations:[{selection,poolName:profile.name,unitsPerItem:1,requestedUnits:2,day:day()}]}]});
const path=(...segments:string[])=>({params:Promise.resolve({path:segments})});
const get=(suffix="capacity",query="?from="+date+"&days=1")=>new Request(`${origin}/api/factory-capacity/factories/${factoryId}/${suffix}${query}`);
const post=(suffix:string,body:unknown,requestOrigin=origin)=>new Request(`${origin}/api/factory-capacity/factories/${factoryId}/${suffix}`,{method:"POST",headers:{origin:requestOrigin,"content-type":"application/json"},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("API_BASE_URL","http://127.0.0.1:29000/");mocks.identity.mockReset().mockResolvedValue({view:context});mocks.current.mockReset().mockResolvedValue(undefined);mocks.upstream.mockReset();
  mocks.failure.mockImplementation((error:PersonalSessionError)=>Response.json({code:error.code},{status:error.status}));});
afterEach(()=>vi.unstubAllEnvs());

describe("factory capacity personal BFF binds identity and actual original receipts",()=>{
  it("uses the personal session and authenticated helper with private response headers",async()=>{
    mocks.upstream.mockResolvedValueOnce(Response.json(workspace()));const result=await GET(get(),path("factories",factoryId,"capacity"));
    expect(result.status).toBe(200);expect(await result.json()).toEqual(workspace());expect(mocks.identity).toHaveBeenCalledOnce();expect(mocks.current).toHaveBeenCalledTimes(2);
    const [url,init]=mocks.upstream.mock.calls[0]!;expect(url).toBe(`http://127.0.0.1:29000/v1/sourcing/factories/${factoryId}/capacity?from=${date}&days=1`);
    expect(init.cache).toBe("no-store");expect(init.redirect).toBe("error");expect(new Headers(init.headers).has("x-tenant-id")).toBe(false);expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(result.headers.get("cache-control")).toBe("private, no-store");expect(result.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("rejects absent personal identity before upstream I/O",async()=>{
    mocks.identity.mockRejectedValueOnce(new PersonalSessionError(401,"login_required"));const result=await GET(get(),path("factories",factoryId,"capacity"));
    expect(result.status).toBe(401);expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it.each(["?tenantId=caller","?days=1&days=1","?from=2026-02-30","?days=32"])("rejects unsupported or ambiguous query %s",async query=>{
    expect((await GET(get("capacity",query),path("factories",factoryId,"capacity"))).status).toBe(400);expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("enforces same origin and the bounded complete JSON body before writes",async()=>{
    expect((await POST(post("capacity-pools",create(),"https://example.invalid"),path("factories",factoryId,"capacity-pools"))).status).toBe(403);
    expect((await POST(post("capacity-pools",{...create(),profile:{...profile,notes:"x".repeat(263000)}}),path("factories",factoryId,"capacity-pools"))).status).toBe(413);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("permits an exact pure creation receipt for a write-only personal member without fabricating a read authority",async()=>{
    mocks.identity.mockResolvedValueOnce({view:{...context,permissions:["order:write"]}});mocks.upstream.mockResolvedValueOnce(Response.json(pool(),{status:201}));
    const result=await POST(post("capacity-pools",create()),path("factories",factoryId,"capacity-pools"));expect(result.status).toBe(201);expect(await result.json()).toEqual(pool());
    expect(JSON.parse(mocks.upstream.mock.calls[0]![1].body)).toEqual(create());expect(mocks.current).toHaveBeenCalledTimes(2);
  });
  it("rejects valid creation receipts with a substituted factory, profile or original factory version",async()=>{
    for(const replacement of [{...pool(),factoryId:createEntityId()},{...pool(),profile:{...profile,dailyCapacityUnits:999}},{...pool(),factoryVersionId:createEntityId()}]){
      mocks.upstream.mockResolvedValueOnce(Response.json(replacement));expect((await POST(post("capacity-pools",create()),path("factories",factoryId,"capacity-pools"))).status).toBe(502);
    }
  });
  it("rejects a valid revision receipt for another pool or revision number",async()=>{
    const body={expectedVersion:1,profile,idempotencyKey:create().idempotencyKey};
    for(const replacement of [{...pool(),id:createEntityId(),versionNumber:2},{...pool(),versionNumber:3}]){
      mocks.upstream.mockResolvedValueOnce(Response.json(replacement));expect((await POST(post(`capacity-pools/${poolId}/revisions`,body),path("factories",factoryId,"capacity-pools",poolId,"revisions"))).status).toBe(502);
    }
  });
  it("hides an upstream stamped result after a personal permission change",async()=>{
    mocks.upstream.mockResolvedValueOnce(Response.json({...workspace(),contextAuthority:erpSessionAuthority({...context,permissions:["order:read"]}),access:{canRead:true,canWrite:false}}));
    const result=await GET(get(),path("factories",factoryId,"capacity"));expect(result.status).toBe(409);expect((await result.json()).code).toBe("authority_changed");
  });
  it("rejects an identity change detected after I/O even when the original receipt is valid",async()=>{
    mocks.upstream.mockResolvedValueOnce(Response.json(pool()));mocks.current.mockRejectedValueOnce(new PersonalSessionError(409,"authority_changed"));
    const result=await POST(post("capacity-pools",create()),path("factories",factoryId,"capacity-pools"));expect(result.status).toBe(409);expect((await result.json()).code).toBe("authority_changed");
  });
  it("preserves only the known authority_changed error code without echoing upstream private details",async()=>{
    for(const code of ["authority_changed","different_code"]){mocks.upstream.mockResolvedValueOnce(Response.json({code,message:"SYNTHETIC-BFF-PRIVATE"},{status:409}));
      const result=await GET(get(),path("factories",factoryId,"capacity")),value=await result.json();expect(result.status).toBe(409);expect(value.code).toBe(code==="authority_changed"?code:undefined);expect(JSON.stringify(value)).not.toContain("SYNTHETIC-BFF-PRIVATE");}
  });
  it("binds resolved time to the actual requested factory version and wall clock",async()=>{
    const body={factoryVersionId,localDateTime:date+"T17:00"};
    for(const replacement of [{...authority,factoryId,factoryVersionId:createEntityId(),localDateTime:body.localDateTime,timeZone:"UTC",instant:date+"T17:00:00.000Z"},
      {...authority,factoryId,factoryVersionId,localDateTime:date+"T18:00",timeZone:"UTC",instant:date+"T18:00:00.000Z"}]){
      mocks.upstream.mockResolvedValueOnce(Response.json(replacement));expect((await POST(post("capacity/resolve-time",body),path("factories",factoryId,"capacity","resolve-time"))).status).toBe(502);
    }
  });
  it("binds a successful batch preview to every original item and exact allocation units",async()=>{
    mocks.upstream.mockResolvedValueOnce(Response.json(preview()));expect((await POST(post("capacity-preview",previewInput()),path("factories",factoryId,"capacity-preview"))).status).toBe(200);
    for(const replacement of [{...preview(),items:[{...preview().items[0]!,quantity:3}]},{...preview(),items:[{...preview().items[0]!,allocations:[{...preview().items[0]!.allocations[0]!,requestedUnits:1}]}]}]){
      mocks.upstream.mockResolvedValueOnce(Response.json(replacement));expect((await POST(post("capacity-preview",previewInput()),path("factories",factoryId,"capacity-preview"))).status).toBe(502);
    }
  });
  it("binds production reads to the original production ID and keeps unreserved legacy explicit",async()=>{
    const request=new Request(`${origin}/api/factory-capacity/production-orders/${productionId}/capacity`);
    mocks.upstream.mockResolvedValueOnce(Response.json({...authority,productionOrderId:productionId,status:"legacy_unreserved",reservations:[]}));expect((await GET(request,path("production-orders",productionId,"capacity"))).status).toBe(200);
    mocks.upstream.mockResolvedValueOnce(Response.json({...authority,productionOrderId:createEntityId(),status:"legacy_unreserved",reservations:[]}));expect((await GET(request,path("production-orders",productionId,"capacity"))).status).toBe(502);
  });
  it("rejects a missing day, altered day count or excessive upstream body without exposing it",async()=>{
    for(const replacement of [{...workspace(),calendar:[]},{...workspace(),days:2}]){
      mocks.upstream.mockResolvedValueOnce(Response.json(replacement));expect((await GET(get(),path("factories",factoryId,"capacity"))).status).toBe(502);
    }
    mocks.upstream.mockResolvedValueOnce(new Response(JSON.stringify({sentinel:"x".repeat(8_388_608)})));expect((await GET(get(),path("factories",factoryId,"capacity"))).status).toBe(502);
  });
});
