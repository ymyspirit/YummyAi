import { describe, expect, it } from "vitest";
import type { TenantContext } from "@yummyai/contracts";
import { Permission } from "@yummyai/authz/permissions";
import { assertBusinessBenchmarkScope, benchmarkDomainMinimumScope } from "./business-benchmark-policy.js";
const actor:TenantContext={tenantId:"019f0000-0000-7000-8000-000000000001",userId:"019f0000-0000-7000-8000-000000000002",dataScope:"self",
 permissions:[Permission.WorkflowRead,Permission.ProcurementRead,Permission.InventoryRead,Permission.DesignRead,Permission.ResearchRead,Permission.OrderRead,Permission.OrderPiiRead],
 permissionScopes:{[Permission.WorkflowRead]:"self",[Permission.ProcurementRead]:"tenant",[Permission.InventoryRead]:"tenant",[Permission.DesignRead]:"self",[Permission.ResearchRead]:"team",[Permission.OrderRead]:"tenant",[Permission.OrderPiiRead]:"tenant"}};
describe("original domain minima for fixed role benchmarks",()=>{
 it("keeps aggregate tenant grants separate from a self Workflow scope",()=>{
  expect(()=>assertBusinessBenchmarkScope(actor,"self","procurement_review")).not.toThrow();
  expect(()=>assertBusinessBenchmarkScope({...actor,permissionScopes:{...actor.permissionScopes,[Permission.InventoryRead]:"self"}},"self","procurement_review")).toThrow("inventory:read");
 });
 it("allows scoped creative domains for later real object checks instead of requiring tenant everywhere",()=>{
  expect(()=>assertBusinessBenchmarkScope(actor,"self","creative")).not.toThrow();
  expect(()=>assertBusinessBenchmarkScope(actor,"tenant","creative")).not.toThrow();
  expect(()=>assertBusinessBenchmarkScope({...actor,permissions:actor.permissions.filter(bit=>bit!==Permission.ResearchRead)},"self","creative")).toThrow("research:read");
 });
 it("retains tenant order privacy even when design objects may be self scoped",()=>{
  expect(()=>assertBusinessBenchmarkScope(actor,"self","artwork_preflight")).not.toThrow();
  expect(()=>assertBusinessBenchmarkScope({...actor,permissionScopes:{...actor.permissionScopes,[Permission.OrderPiiRead]:"team"}},"self","artwork_preflight")).toThrow("order:pii:read");
  expect(benchmarkDomainMinimumScope("artwork_preflight",Permission.DesignRead)).toBe("self");
 });
});
