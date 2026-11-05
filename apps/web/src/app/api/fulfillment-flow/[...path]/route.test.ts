import {createEntityId} from "@yummyai/contracts";
import {beforeEach,describe,it,expect,vi} from "vitest";
const {upstream}=vi.hoisted(()=>({upstream:vi.fn<typeof fetch>()}));
vi.mock("../../../../server-api",()=>({apiFetch:upstream}));
import {GET,POST} from "./route";
const context=(path:string[])=>({params:Promise.resolve({path})});
describe("fulfillment flow authenticated proxy",()=>{
  beforeEach(()=>{upstream.mockReset();process.env.API_BASE_URL="http://api.test";});
  it("rejects cross-origin commands, tenant selectors, invalid paths and oversized input",async()=>{
    const path=["orders",createEntityId(),"resume"],url=`http://web.test/api/fulfillment-flow/${path.join("/")}`;
    expect((await POST(new Request(url,{method:"POST",headers:{origin:"http://elsewhere.test","content-type":"application/json"},body:"{}"}),context(path))).status).toBe(403);
    expect((await GET(new Request("http://web.test/api/fulfillment-flow/routes?tenantId=caller"),context(["routes"]))).status).toBe(400);
    expect((await GET(new Request(url),context(["..","admin"]))).status).toBe(404);
    expect((await POST(new Request(url,{method:"POST",headers:{origin:"http://web.test","content-type":"application/json"},body:JSON.stringify({value:"x".repeat(17000)})}),context(path))).status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("uses server authentication and retains private no-store responses",async()=>{
    upstream.mockResolvedValue(Response.json({saved:true}));
    const response=await POST(new Request("http://web.test/api/fulfillment-flow/routes",{method:"POST",headers:{origin:"http://web.test","content-type":"application/json",authorization:"untrusted-browser"},body:"{}"}),context(["routes"]));
    expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(upstream).toHaveBeenCalledWith("http://api.test/v1/fulfillment-flow/routes",expect.objectContaining({method:"POST",body:"{}",headers:{"content-type":"application/json"}}));
  });
});
