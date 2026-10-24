import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {Permission} from "@yummyai/authz";
import {erpSessionAuthority} from "@yummyai/contracts/auth/session";
import {apiFetch} from "../../../../../server-api";
import {GET,POST} from "./route";
vi.mock("../../../../../server-api",()=>({apiFetch:vi.fn()}));
const a="00000000-0000-7000-8000-000000000001",b="00000000-0000-7000-8000-000000000002",id="00000000-0000-7000-8000-000000000003";
const authority=erpSessionAuthority({tenantId:a,userId:b,permissions:[Permission.CustomerIntelligenceReview],dataScope:"tenant"});
const original={kind:"analysis_run",accountId:a,targetId:null,input:{accountId:a,periodStart:"2026-09-01",periodEnd:"2026-09-15",marketplace:null,currency:null,
  evidenceCutoffAt:"2026-10-01T12:00:00.000Z",idempotencyKey:"synthetic-command-request-key"}};
const detail={id,kind:"analysis_run",accountId:a,targetId:null,scopeKey:"root",status:"prepared",requestKey:original.input.idempotencyKey,
  createdAt:"2026-10-01T00:00:00.000Z",expiresAt:"2026-10-08T00:00:00.000Z",completedAt:null,acknowledged:false,originalRetained:true,result:null,
  contextAuthority:authority,blockReason:null,canExecute:true,canCancel:true,canAcknowledge:false};
const summary=()=>Object.fromEntries(Object.entries(detail).filter(([field])=>!["blockReason","canExecute","canCancel","canAcknowledge"].includes(field)));
const result=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});
const context=(path:string[]=[])=>({params:Promise.resolve({path})});
const request=(path="",body?:unknown,origin="http://localhost:3000")=>new Request(`http://localhost:3000/api/advertising/commands${path}`,body===undefined?{}
  :{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify(body)});
const prior=process.env.API_BASE_URL;
beforeEach(()=>{vi.mocked(apiFetch).mockReset();process.env.API_BASE_URL="http://isolated-api.invalid";});
afterEach(()=>{if(prior===undefined)delete process.env.API_BASE_URL;else process.env.API_BASE_URL=prior;});
describe("advertising retained-command private transport",()=>{
  it("prepares exactly the original owner input and returns a bound private201",async()=>{
    vi.mocked(apiFetch).mockResolvedValue(result(detail,201));const response=await POST(request("",original),context());
    expect(response.status).toBe(201);expect(response.headers.get("cache-control")).toBe("private, no-store");expect((await response.json()).id).toBe(id);
    const [url,init]=vi.mocked(apiFetch).mock.calls[0]!;expect(url).toBe("http://isolated-api.invalid/v1/advertising/commands");expect(JSON.parse(String(init?.body))).toEqual(original);
  });
  it("passes only the strict account-scoped list query and checks the returned scope",async()=>{
    vi.mocked(apiFetch).mockResolvedValue(result({accountId:a,items:[summary()],nextCursor:null,unavailableCount:0,contextAuthority:authority}));
    const response=await GET(request(`?accountId=${a}&kind=analysis_run`),context());expect(response.status).toBe(200);
    expect(String(vi.mocked(apiFetch).mock.calls[0]?.[0])).toContain(`accountId=${a}&kind=analysis_run`);
  });
  it.each([{...detail,id:b},{...detail,accountId:b}])("rejects an upstream exact-ID or account mismatch",async value=>{
    vi.mocked(apiFetch).mockResolvedValue(result(value));expect((await GET(request(`/${id}?accountId=${a}`),context([id]))).status).toBe(502);
  });
  it("separately retrieves a complete original and binds both record and account",async()=>{
    vi.mocked(apiFetch).mockResolvedValue(result({id,accountId:a,original,blockReason:null,contextAuthority:authority}));
    const response=await GET(request(`/${id}/original?accountId=${a}`),context([id,"original"]));expect(response.status).toBe(200);expect((await response.json()).original).toEqual(original);
    vi.mocked(apiFetch).mockResolvedValue(result({id,accountId:b,original:null,blockReason:"input_unavailable",contextAuthority:authority}));
    expect((await GET(request(`/${id}/original?accountId=${a}`),context([id,"original"]))).status).toBe(502);
  });
  it("refuses cross-origin preparation before forwarding a private body",async()=>{
    expect((await POST(request("",original,"https://foreign.invalid"),context())).status).toBe(403);expect(apiFetch).not.toHaveBeenCalled();
  });
  it.each([null,{confirm:true},{input:original.input},[]])("requires an explicit strict empty action body",async body=>{
    expect((await POST(request(`/${id}/execute?accountId=${a}`,body),context([id,"execute"]))).status).toBe(400);expect(apiFetch).not.toHaveBeenCalled();
  });
  it("executes the existing commandID with the original account and no replacement business body",async()=>{
    vi.mocked(apiFetch).mockResolvedValue(result(detail));expect((await POST(request(`/${id}/execute?accountId=${a}`,{}),context([id,"execute"]))).status).toBe(200);
    const [url,init]=vi.mocked(apiFetch).mock.calls[0]!;expect(String(url)).toContain(`/${id}/execute?accountId=${a}`);expect(init?.body).toBe("{}");
  });
  it.each([`/${id}`,`/${id}?accountId=${a}&accountId=${a}`,`/${id}?accountId=${a}&tenantId=${b}`,`/${id}?accountId=${a}&kind=analysis_run`])("rejects missing duplicate or caller-selected exact-ID query scope",async path=>{
    expect((await GET(request(path),context([id]))).status).toBe(400);expect(apiFetch).not.toHaveBeenCalled();
  });
  it("rejects private plaintext added to otherwise valid metadata",async()=>{
    vi.mocked(apiFetch).mockResolvedValue(result({...detail,original}));expect((await GET(request(`/${id}?accountId=${a}`),context([id]))).status).toBe(502);
  });
  it("rejects an upstream list with a wrong requested kind or an acknowledged active row",async()=>{
    vi.mocked(apiFetch).mockResolvedValue(result({accountId:a,items:[summary()],nextCursor:null,unavailableCount:0,contextAuthority:authority}));
    expect((await GET(request(`?accountId=${a}&kind=goal_save`),context())).status).toBe(502);
    vi.mocked(apiFetch).mockResolvedValue(result({accountId:a,items:[{...summary(),status:"cancelled",completedAt:"2026-10-01T00:00:01.000Z",originalRetained:false,acknowledged:true}],nextCursor:null,unavailableCount:0,contextAuthority:authority}));
    expect((await GET(request(`?accountId=${a}`),context())).status).toBe(502);
  });
  it("preserves allowed domain status while stripping internal SQL errors and keys",async()=>{
    vi.mocked(apiFetch).mockResolvedValue(result({code:"advertising_command_basis_changed",message:"PRIVATE SQL secret-body"},409));
    const response=await GET(request(`/${id}?accountId=${a}`),context([id]));expect(response.status).toBe(409);
    const value=await response.json();expect(value.code).toBe("advertising_command_basis_changed");expect(JSON.stringify(value)).not.toContain("PRIVATE");
  });
  it("rejects invalid UTF8, unexpected success status and unsupported paths",async()=>{
    vi.mocked(apiFetch).mockResolvedValue(new Response(new Uint8Array([255]),{status:200}));expect((await GET(request(`/${id}?accountId=${a}`),context([id]))).status).toBe(502);
    vi.mocked(apiFetch).mockResolvedValue(result(detail,202));expect((await POST(request("",original),context())).status).toBe(502);
    expect((await GET(request(`/${id}/execute?accountId=${a}`),context([id,"execute"]))).status).toBe(404);
  });
});
