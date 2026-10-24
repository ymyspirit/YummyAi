import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {erpSessionAuthority} from "@yummyai/contracts/auth/session";
import {Permission} from "@yummyai/authz/permissions";
import type {AdHistoryPage,AdHistoryRecordResult} from "@yummyai/contracts/advertising/history";
const {upstream}=vi.hoisted(()=>({upstream:vi.fn()}));
vi.mock("../../../../server-api",()=>({apiFetch:upstream}));
import {GET} from "./route";
const id=(n:number)=>`019a0000-0000-7000-8000-${String(n).padStart(12,"0")}`,at="2026-10-01T00:00:00.000Z";
const authority=erpSessionAuthority({tenantId:id(90),userId:id(91),permissions:[Permission.CustomerIntelligenceRead],dataScope:"tenant"});
function page():AdHistoryPage{return{accountId:id(1),kind:"imports",parentId:null,contextAuthority:authority,accessMode:"read",rows:[{
 id:id(10),accountId:id(1),kind:"imports",parentId:null,title:"Original report.csv",status:"active",revision:null,createdAt:at,ownedByCurrentActor:true,
 periodStart:"2026-09-01",periodEnd:"2026-09-15",checksum:"a".repeat(64),runId:null}],count:1,pageSize:25,requestCursor:null,nextCursor:null,hasMore:false,upperBound:id(10),recordedBefore:at,order:"id_desc"};}
function record():AdHistoryRecordResult{return{accountId:id(1),recordId:id(10),parentId:null,contextAuthority:authority,accessMode:"read",actionContext:null,
 record:{kind:"imports",value:{id:id(10),accountId:id(1),fileName:"Original report.csv",checksum:"a".repeat(64),reportType:"campaign",
 periodStart:"2026-09-01",periodEnd:"2026-09-15",timezone:"UTC",attributionWindowDays:null,attributionBasis:"unknown",observedAt:at,recordedAt:at,
 sourceRowCount:1,acceptedRowCount:1,rejectedRowCount:0,diagnostics:[],archivedAt:null}}};}
const get=(path:string,query:string)=>GET(new Request(`http://localhost:3130/api/advertising/${path}?${query}`),{params:Promise.resolve({path:path.split("/")})});
const query=(tail="")=>`accountId=${id(1)}&kind=imports${tail}`;
const answer=(value:unknown)=>upstream.mockResolvedValue(Response.json(value));
describe("advertising complete history response binding",()=>{
 beforeEach(()=>{vi.stubEnv("API_BASE_URL","http://127.0.0.1:8130");upstream.mockReset();});afterEach(()=>vi.unstubAllEnvs());
 it("forwards normalized pagination defaults and returns the exact original summary without caching",async()=>{
  answer(page());const response=await get("history",query());expect(response.status).toBe(200);expect(await response.json()).toEqual(page());
  expect(response.headers.get("cache-control")).toBe("private, no-store");expect(upstream.mock.calls[0]![0]).toContain("pageSize=25");
 });
 it("binds account using the API's canonical lowercase identity",async()=>{answer(page());expect((await get("history",query().replace("019a","019A"))).status).toBe(200);});
 it("rejects a valid different account before exposing a history page",async()=>{const value=page();value.accountId=id(2);value.rows[0]!.accountId=id(2);answer(value);expect((await get("history",query())).status).toBe(502);});
 it("rejects a different valid record type",async()=>{const value=page();value.kind="goals";value.rows[0]!.kind="goals";answer(value);expect((await get("history",query())).status).toBe(502);});
 it("binds the actual requested page length",async()=>{const value=page();value.pageSize=50;answer(value);expect((await get("history",query())).status).toBe(502);});
 it("rejects a response for a different cursor instead of showing stale records",async()=>{const value=page();value.requestCursor="anotherCursor";answer(value);expect((await get("history",query("&cursor=originalCursor"))).status).toBe(502);});
 it("binds the event parent even when the returned page is valid",async()=>{const value=page();value.kind="action_events";value.parentId=id(30);value.rows[0]!.kind="action_events";value.rows[0]!.parentId=id(30);answer(value);expect((await get("history",`accountId=${id(1)}&kind=action_events&parentId=${id(31)}`)).status).toBe(502);});
 it("refuses own-review mode for import history",async()=>{const value=page();value.accessMode="own_review";answer(value);expect((await get("history",query())).status).toBe(502);});
 it("refuses duplicate and unknown history arguments without upstream access",async()=>{
  expect((await get("history",query(`&accountId=${id(2)}`))).status).toBe(400);
  expect((await get("history",query("&tenantId=caller"))).status).toBe(400);expect(upstream).not.toHaveBeenCalled();
 });
 it("requires a parent only for an event query",async()=>{expect((await get("history",`accountId=${id(1)}&kind=action_events`)).status).toBe(400);expect((await get("history",query(`&parentId=${id(30)}`))).status).toBe(400);expect(upstream).not.toHaveBeenCalled();});
 it("reads an original ID directly with no dependency on recent workspace arrays",async()=>{answer(record());const response=await get(`records/${id(10)}`,query());expect(response.status).toBe(200);expect(await response.json()).toEqual(record());expect(upstream).toHaveBeenCalledTimes(1);expect(upstream.mock.calls[0]![0]).toContain(`/records/${id(10)}?`);});
 it("rejects a different well-shaped record ID",async()=>{const value=record();value.recordId=id(11);value.record.value.id=id(11);answer(value);expect((await get(`records/${id(10)}`,query())).status).toBe(502);});
 it("rejects a different account on both envelope and original record",async()=>{const value=record();value.accountId=id(2);if(value.record.kind==="imports")value.record.value.accountId=id(2);answer(value);expect((await get(`records/${id(10)}`,query())).status).toBe(502);});
 it("binds the expected detail kind",async()=>{answer(record());expect((await get(`records/${id(10)}`,`accountId=${id(1)}&kind=analyses`)).status).toBe(502);});
 it("does not accept a raw private event payload",async()=>{answer({...record(),record:{kind:"import_events",value:{id:id(10),importId:id(30),accountId:id(1),status:"archived",reason:"Original archive",createdAt:at,data:{idempotencyKey:"private"}}},parentId:id(30)});expect((await get(`records/${id(10)}`,`accountId=${id(1)}&kind=import_events&parentId=${id(30)}`)).status).toBe(502);});
 it("preserves a current authority change as a public denial without returning upstream detail",async()=>{upstream.mockResolvedValue(Response.json({code:"authority_changed",private:"hidden"},{status:409}));const response=await get("history",query());expect(response.status).toBe(409);const body=await response.json();expect(body.code).toBe("authority_changed");expect(body.private).toBeUndefined();});
});
