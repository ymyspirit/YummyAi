import { describe, expect, it } from "vitest";
import { erpReturnPath } from "./web-auth-mode";

describe("native AI settings login context", () => {
  const line = "019a0000-0000-7000-8000-000000000021", other = "019a0000-0000-7000-8000-000000000022";
  it("preserves the selected settings tab and valid order queue through repeated personal login", () => {
    const source = `/orders?line=${line}&queue=${line},${other}&detailMode=artwork`;
    const path = `/settings/ai?${new URLSearchParams({ settingsTab: "defaults", returnTo: source, token: "private" })}`;
    const first = erpReturnPath(path), result = new URL(erpReturnPath(first), "https://erp.invalid");
    expect(result.searchParams.get("settingsTab")).toBe("defaults");
    expect(result.searchParams.get("returnTo")).toBe(erpReturnPath(source));
    expect(result.searchParams.has("token")).toBe(false); expect(erpReturnPath(first)).toBe(first);
  });
  it("preserves a typed embedded-billing selection without granting authority", () => {
    expect(erpReturnPath(`/settings/ai?settingsTab=usage&owner=assist&id=${line}&tenantId=private`))
      .toBe(`/settings/ai?settingsTab=usage&owner=assist&id=${line}`);
    expect(erpReturnPath(`/settings/ai?owner=unknown&id=${line}`)).toBe("/settings/ai");
    expect(erpReturnPath(`/settings/ai?owner=assist&id=${line}&id=${other}`)).toBe("/settings/ai");
  });
  it("rejects ambiguous or wrong-route tab selectors and external or recursive return paths", () => {
    for (const query of ["settingsTab=defaults&settingsTab=models", "settingsTab=unknown", "settingsTab=https://outside.invalid"])
      expect(erpReturnPath(`/settings/ai?${query}`)).toBe("/settings/ai");
    expect(erpReturnPath("/orders?settingsTab=defaults")).toBe("/orders");
    for (const target of ["https://outside.invalid", "//outside.invalid", "/api/creative-studio/configuration", "/settings/ai?settingsTab=usage"])
      expect(new URL(erpReturnPath(`/settings/ai?${new URLSearchParams({ returnTo: target })}`), "https://erp.invalid").searchParams.has("returnTo")).toBe(false);
  });
  it("drops malformed, duplicate or oversized order queues and unrelated detail modes", () => {
    for (const queue of ["not-an-id", `${line},${line}`, Array.from({ length: 51 }, () => line).join(",")])
      expect(new URL(erpReturnPath(`/orders?${new URLSearchParams({ queue })}`), "https://erp.invalid").searchParams.has("queue")).toBe(false);
    expect(erpReturnPath(`/orders?queue=${line}&queue=${other}&detailMode=artwork`)).toBe("/orders");
    expect(erpReturnPath(`/products?queue=${line}&detailMode=artwork`)).toBe("/products");
    expect(erpReturnPath(`/orders?line=${line}&detailMode=unknown`)).toBe(`/orders?line=${line}`);
  });
});

describe("native v4 original-form login recovery",()=>{
  const run="0198fbef-4a10-7000-8000-000000000904",item="0198fbef-4a10-7000-8000-000000000905",order="0198fbef-4a10-7000-8000-000000000906";
  it("keeps only original recovery coordinates across repeated login and removes operator bodies and tokens",()=>{
    const parent="/ai-tasks?agentNativeV4="+run;
    const path="/production?"+new URLSearchParams({agentNativeV4:run.toUpperCase(),agentNativeV4Item:item,order,line:item,returnTo:parent,
      confirmationToken:"private",completion:'{"verifiedByOperator":true}',prompt:"private"});
    const result=new URL(erpReturnPath(erpReturnPath(path)),"https://erp.invalid");
    expect(result.searchParams.get("agentNativeV4")).toBe(run);expect(result.searchParams.get("agentNativeV4Item")).toBe(item);
    expect(result.searchParams.get("order")).toBe(order);expect(result.searchParams.get("returnTo")).toBe(parent);
    expect([...result.searchParams.keys()].sort()).toEqual(["agentNativeV4","agentNativeV4Item","line","order","returnTo"]);
  });
  it("rejects duplicate or missing parent identities and references on unrelated pages",()=>{
    expect(erpReturnPath(`/production?agentNativeV4=${run}&agentNativeV4=${run}&agentNativeV4Item=${item}`)).toBe("/production");
    expect(erpReturnPath(`/shipments?agentNativeV4Item=${item}&agentFulfillmentCommand=${item}`)).toBe("/shipments");
    expect(erpReturnPath(`/catalog?agentNativeV4=${run}&agentNativeV4Item=${item}`)).toBe("/catalog");
  });
  it("preserves the exact original intent on the AI page through login without form or delivery residue",()=>{
    const raw="/ai-tasks?"+new URLSearchParams({agentNativeV4:run.toUpperCase(),agentFulfillmentCommand:item.toUpperCase(),order,
      agentNativeV4Item:item,delivery:item,confirmationToken:"private",completion:"private"});
    const result=new URL(erpReturnPath(erpReturnPath(raw)),"https://erp.invalid");
    expect(result.searchParams.get("agentNativeV4")).toBe(run);
    expect(result.searchParams.get("agentFulfillmentCommand")).toBe(item);
    expect(result.searchParams.get("order")).toBe(order);
    expect([...result.searchParams.keys()].sort()).toEqual(["agentFulfillmentCommand","agentNativeV4","order"]);
    expect(erpReturnPath(`/ai-tasks?agentFulfillmentCommand=${item}`)).toBe("/ai-tasks");
    expect(erpReturnPath(`/ai-tasks?agentNativeV4=${run}&agentFulfillmentCommand=${item}&agentFulfillmentCommand=${item}`)).toBe(`/ai-tasks?agentNativeV4=${run}`);
  });
});

describe("original Publication and Agent v3 login returns", () => {
  const listing = "0198fbef-4a10-7000-8000-000000000901", version = "0198fbef-4a10-7000-8000-000000000902", request = "0198fbef-4a10-7000-8000-000000000903", run = "0198fbef-4a10-7000-8000-000000000904", command = "0198fbef-4a10-7000-8000-000000000905";
  it("preserves exact immutable version, original preview and Agent context through repeated login sanitization", () => {
    const source = `/ai-tasks?agentNativeV3=${run}&agentCommand=${command}`;
    const canonicalSource = `/ai-tasks?agentCommand=${command}&agentNativeV3=${run}`;
    const path = `/listings/${listing}?${new URLSearchParams({ tab: "Publish", listingVersionId: version, publicationRequestId: request, returnTo: source, prompt: "private" })}`;
    const result = new URL(erpReturnPath(erpReturnPath(path)), "https://erp.invalid");
    expect(result.searchParams.get("listingVersionId")).toBe(version); expect(result.searchParams.get("publicationRequestId")).toBe(request);
    expect(result.searchParams.get("returnTo")).toBe(canonicalSource); expect(result.searchParams.has("prompt")).toBe(false);
    expect(erpReturnPath(`/ai-tasks?agentNativeV3=${run.toUpperCase()}&agentCommand=${command}`)).toBe(canonicalSource);
  });
  it("rejects duplicate, wrong-page and external return references without preserving arbitrary queries", () => {
    expect(erpReturnPath(`/ai-tasks?agentNativeV3=${run}&agentNativeV3=${run}`)).toBe("/ai-tasks");
    const result = new URL(erpReturnPath(`/listings/${listing}?listingVersionId=${version}&listingVersionId=${version}&returnTo=https://outside.invalid&token=private`), "https://erp.invalid");
    expect(result.searchParams.has("listingVersionId")).toBe(false); expect(result.searchParams.has("returnTo")).toBe(false);
    for (const path of [`/%2f%2fevil.invalid?returnTo=%2Fai-tasks`, `/listings/%2f${listing}?listingVersionId=${version}`])
      expect(erpReturnPath(path)).toBe("/");
    const foreign = new URL(erpReturnPath(`/listings/${listing}?returnTo=%2F%2Fevil.invalid`), "https://erp.invalid");
    expect(foreign.searchParams.has("returnTo")).toBe(false);
    expect(erpReturnPath(`/orders?publicationRequestId=${request}&agentNativeV3=${run}`)).toBe("/orders");
  });
});

describe("dependent original command login recovery", () => {
  const plan = "019d1710-b400-7000-8000-000000000001", command = "019d1710-b400-7000-8000-000000000002";
  it("keeps the exact dependency parent and original child across repeated login without private input", () => {
    const raw = `/ai-tasks?agentDependencyPlan=${plan.toUpperCase()}&agentCommand=${command}&invoiceNumber=private&confirmationToken=private`;
    expect(erpReturnPath(erpReturnPath(raw))).toBe(`/ai-tasks?agentCommand=${command}&agentDependencyPlan=${plan}`);
    for (const query of [`agentDependencyPlan=${plan}&agentDependencyPlan=${plan}`, "agentDependencyPlan=invalid"])
      expect(erpReturnPath(`/ai-tasks?${query}&agentCommand=${command}`)).toBe(`/ai-tasks?agentCommand=${command}`);
    expect(erpReturnPath(`/orders?agentDependencyPlan=${plan}`)).toBe("/orders");
  });
});
describe("catalog deep links through personal login", () => {
  it("retains an exact advertising history record through repeated personal login",()=>{
    const account="01900000-0000-7000-8000-000000000001",record="01900000-0000-7000-8000-000000000002";
    const path=`/customer-intelligence?account=${account}&tab=history&detail=history:actions:${record}`;
    const result=new URL(erpReturnPath(erpReturnPath(path)),"https://erp.invalid");
    expect(result.searchParams.get("detail")).toBe(`history:actions:${record}`);expect(result.searchParams.get("tab")).toBe("history");
  });
  it("retains a valid event parent while dropping ambiguous or unrelated history locators",()=>{
    const account="01900000-0000-7000-8000-000000000001",parent="01900000-0000-7000-8000-000000000002",record="01900000-0000-7000-8000-000000000003";
    const detail=`history:action_events:${parent}:${record}`,query=`account=${account}&detail=${detail}`;
    expect(new URL(erpReturnPath(`/customer-intelligence?${query}`),"https://erp.invalid").searchParams.get("detail")).toBe(detail);
    for(const path of[`/orders?${query}`,`/customer-intelligence?${query}&detail=${detail}`,`/customer-intelligence?detail=${detail}`,
      `/customer-intelligence?account=${account}&detail=history:unknown:${record}`,`/customer-intelligence?account=${account}&detail=history:imports:${parent}:${record}`])
      expect(new URL(erpReturnPath(path),"https://erp.invalid").searchParams.has("detail")).toBe(false);
  });
  it("retains the exact advertising account and report measurement scope across repeated login sanitization", () => {
    const id = "01900000-0000-7000-8000-000000000001", run = "01900000-0000-7000-8000-000000000002";
    const original = `/customer-intelligence?account=${id}&from=2026-09-01&to=2026-09-15&site=US&currency=USD&report=search_term&mode=profit_defense&run=${run}&tab=goals`;
    const result = new URL(erpReturnPath(original), "https://erp.invalid");
    expect(Object.fromEntries(result.searchParams)).toEqual({ account: id, from: "2026-09-01", to: "2026-09-15", site: "US", currency: "USD", report: "search_term", mode: "profit_defense", run, tab: "goals" });
    expect(erpReturnPath(erpReturnPath(erpReturnPath(original)))).toBe(erpReturnPath(original));
  });
  it("keeps advertising-only parameters out of unrelated return destinations", () => {
    const query = "account=01900000-0000-7000-8000-000000000001&from=2026-09-01&to=2026-09-15&site=US&currency=USD&report=campaign&mode=profit_defense";
    expect(erpReturnPath(`/orders?${query}`)).toBe("/orders");
    expect(erpReturnPath(`/api/advertising/workspace?${query}`)).toBe("/");
  });
  it("drops ambiguous or malformed advertising scope without admitting tenant or private data", () => {
    const id = "01900000-0000-7000-8000-000000000001";
    expect(erpReturnPath(`/customer-intelligence?account=${id}&account=${id}&run=wrong&from=2026-02-30&to=tomorrow&site=OTHER&currency=usd&report=unknown&mode=unsafe&tenantId=OTHER&search=private&token=private`)).toBe("/customer-intelligence");
    expect(erpReturnPath(`/customer-intelligence?account=wrong&currency=USDD`)).toBe("/customer-intelligence");
  });
  it("preserves valid leap-day scope and an exact trailing-slash advertising route", () => {
    const id = "01900000-0000-7000-8000-000000000001";
    expect(erpReturnPath(`/customer-intelligence/?account=${id}&from=2024-02-29&to=2024-03-01`)).toBe(`/customer-intelligence/?account=${id}&from=2024-02-29&to=2024-03-01`);
  });
  it("preserves the selected root and editor intent", () => {
    expect(erpReturnPath("/product-specifications?spu=SPU_A&editSpu=1")).toBe(
      "/product-specifications?spu=SPU_A&editSpu=1",
    );
    expect(erpReturnPath("/print-library?artwork=ART_A&artworkVersionId=VERSION_A&form=1")).toBe(
      "/print-library?artwork=ART_A&artworkVersionId=VERSION_A&form=1",
    );
    expect(erpReturnPath("/product-development?sku=SKU_A")).toBe("/product-development?sku=SKU_A");
  });
  it("drops duplicate IDs, malformed flags and private free text", () => {
    expect(
      erpReturnPath("/product-specifications?spu=A&spu=B&form=2&q=private&editSpu=1&editSpu=1"),
    ).toBe("/product-specifications");
  });
  it("retains bounded sales-plan creation and step intent without arbitrary parameters", () => {
    expect(
      erpReturnPath("/sales-plans?new=1&spuId=SPU_A&step=3&view=tasks&q=private&tenantId=OTHER"),
    ).toBe("/sales-plans?view=tasks&spuId=SPU_A&new=1&step=3");
    expect(erpReturnPath("/sales-plans?new=2&step=99&spuId=A&spuId=B")).toBe("/sales-plans");
    expect(erpReturnPath("/orders?new=1&step=3")).toBe("/orders");
  });
  it("keeps external destinations and authentication endpoints out of return paths", () => {
    for (const path of [
      "//evil.invalid",
      "https://evil.invalid",
      "/api/erp-auth/logout",
      "/login",
      "/%2f%2fevil.invalid",
    ])
      expect(erpReturnPath(path)).toBe("/");
  });
  it("returns to the exact production project and historical version after personal login", () => {
    const id = "01900000-0000-7000-8000-000000000001", version = "01900000-0000-7000-8000-000000000002";
    expect(erpReturnPath(`/pod-workbench/production-editor?projectId=${id}&versionId=${version}&kind=rectangular_print&q=private&tenantId=OTHER`))
      .toBe(`/pod-workbench/production-editor?projectId=${id}&versionId=${version}&kind=rectangular_print`);
    expect(erpReturnPath(`/pod-workbench/production-editor?reportLineId=${id}&kind=shaped_pillow`))
      .toBe(`/pod-workbench/production-editor?reportLineId=${id}&kind=shaped_pillow`);
  });
  it("rejects ambiguous production identity and version-only or foreign-route editor parameters", () => {
    const id = "01900000-0000-7000-8000-000000000001";
    expect(erpReturnPath(`/pod-workbench/production-editor?projectId=${id}&projectId=${id}&versionId=${id}&kind=unknown`)).toBe("/pod-workbench/production-editor");
    expect(erpReturnPath(`/products?projectId=${id}&versionId=${id}&reportLineId=${id}&kind=shaped_pillow`)).toBe("/products");
    expect(erpReturnPath("/pod-workbench/production-editor?projectId=private-name&reportLineId=private-text")).toBe("/pod-workbench/production-editor");
  });
  it("retains an exact manufacturing root or specification creation intent through login", () => {
    const id = "01900000-0000-7000-8000-000000000001", other = "01900000-0000-7000-8000-000000000002";
    expect(erpReturnPath(`/manufacturing-recipes?spuId=${id}&recipe=${other}&new=1&q=private`))
      .toBe(`/manufacturing-recipes?spuId=${id}&recipe=${other}`);
    expect(erpReturnPath(`/manufacturing-recipes?spuId=${id}&specificationId=${other}&new=1`))
      .toBe(`/manufacturing-recipes?spuId=${id}&specificationId=${other}&new=1`);
    expect(erpReturnPath(`/manufacturing-recipes?recipe=${id}&recipe=${other}&specificationId=private&new=2`))
      .toBe("/manufacturing-recipes");
    expect(erpReturnPath(`/products?recipe=${id}&specificationId=${other}&new=1`)).toBe("/products");
  });
  it("restores the exact private advertising command through repeated personal login sanitization",()=>{
    const account="019a0000-0000-7000-8000-000000000001",id="019a0000-0000-7000-8000-000000000002";
    for(const path of["/advertising/originals","/customer-intelligence"]){
      const expected=`${path}?${new URLSearchParams({account,detail:`command:${id}`})}`;
      expect(erpReturnPath(expected+"&q=private&tenantId=OTHER")).toBe(expected);
      expect(erpReturnPath(erpReturnPath(expected))).toBe(expected);
    }
  });
  it("drops malformed ambiguous unbound or unrelated command return identities",()=>{
    const id="019a0000-0000-7000-8000-000000000001";
    for(const query of[`detail=command:${id}`,`account=${id}&account=${id}&detail=command:${id}`,`account=${id}&detail=command:private`,
      `account=${id}&detail=command:${id}&detail=command:${id}`])
      expect(new URL(erpReturnPath(`/advertising/originals?${query}`),"https://erp.invalid").searchParams.has("detail")).toBe(false);
    expect(erpReturnPath(`/orders?account=${id}&detail=command:${id}`)).toBe("/orders");
  });
});
