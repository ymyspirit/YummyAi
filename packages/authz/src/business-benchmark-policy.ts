import type { TenantContext } from "@yummyai/contracts";
import type { BusinessBenchmarkRole } from "@yummyai/contracts/knowledge/benchmark";
import { authorize, ForbiddenError, permissionScope } from "@yummyai/authz/authorize";
import { requiredAssistPermissions } from "@yummyai/authz/assist-policy";
import type { Permission } from "./permissions.js";
const rank={self:0,team:1,tenant:2};
/** Aggregate/order gates remain explicit; scoped domains require real resources. */
export function benchmarkDomainMinimumScope(role:BusinessBenchmarkRole,permission:Permission):TenantContext["dataScope"]{
 if((role==="procurement_review"||role==="business_review")&&requiredAssistPermissions(role,"read").includes(permission))return "tenant";
 if(["order_review","artwork_preflight","after_sales_review"].includes(role)&&permission.startsWith("order:"))return "tenant";
 return "self";
}
export function assertBusinessBenchmarkScope(context:TenantContext,pinned:TenantContext["dataScope"],role:BusinessBenchmarkRole){
 const aggregate=role==="procurement_review"||role==="business_review";
 for(const permission of requiredAssistPermissions(role,"read")){
  authorize(context,permission);const scope=permissionScope(context,permission);
  if(rank[scope]<Math.max(aggregate?rank[pinned]:0,rank[benchmarkDomainMinimumScope(role,permission)]))throw new ForbiddenError(permission,"outside_data_scope");
 }
}
export const businessBenchmarkRunPermissions=(role:BusinessBenchmarkRole)=>requiredAssistPermissions(role,"run");
