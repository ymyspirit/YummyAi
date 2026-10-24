export const Permission = {
  AssetPromote: "asset:promote",
  AssetRead: "asset:read",
  AssetWrite: "asset:write",
  CaptureRead: "capture:read",
  CaptureWrite: "capture:write",
  ChannelInventoryRead: "channel_inventory:read",
  ChannelInventoryReconcile: "channel_inventory:reconcile",
  ChannelInventoryWrite: "channel_inventory:write",
  DashboardRead: "dashboard:read",
  DesignRead: "design:read",
  DesignReview: "design:review",
  DesignWrite: "design:write",
  FinanceRead: "finance:read",
  FinanceReview: "finance:review",
  FinanceWrite: "finance:write",
  FactoryTaskRead: "factory_task:read",
  FactoryTaskRespond: "factory_task:respond",
  InventoryRead: "inventory:read",
  InventoryWrite: "inventory:write",
  ListingRead: "listing:read",
  ListingReview: "listing:review",
  ListingWrite: "listing:write",
  ListingPublish: "listing:publish",
  JobRead: "job:read",
  MembershipManage: "membership:manage",
  ModelConfigure: "model:configure",
  ModelBillingReconcile: "model:billing_reconcile",
  NotificationRead: "notification:read",
  OrderPiiRead: "order:pii:read",
  OrderPiiAnonymize: "order:pii:anonymize",
  OrderRead: "order:read",
  OrderWrite: "order:write",
  OrderAssign: "order:assign",
  ProductRead: "product:read",
  ManufacturingReview: "manufacturing:review",
  ProductWrite: "product:write",
  ProcurementApprove: "procurement:approve",
  ProcurementAssign: "procurement:assign",
  ProcurementRead: "procurement:read",
  ProcurementWrite: "procurement:write",
  ResearchRead: "research:read",
  ResearchWrite: "research:write",
  StoreAuthorize: "store:authorize",
  StoreManage: "store:manage",
  StoreRead: "store:read",
  WorkflowRead: "workflow:read",
  WorkflowRun: "workflow:run",
  WorkflowAssign: "workflow:assign",
  WorkflowManage: "workflow:manage",
  WorkflowApprove: "workflow:approve",
  SupplierPerformanceRead: "supplier_performance:read",
  SupplierPerformanceReview: "supplier_performance:review",
  CustomerIntelligenceRead: "customer_intelligence:read",
  CustomerIntelligenceWrite: "customer_intelligence:write",
  CustomerIntelligenceReview: "customer_intelligence:review",
  ForecastRead: "forecast:read",
  ForecastWrite: "forecast:write",
  ForecastReview: "forecast:review",
  OperationsRead: "operations:read",
  OperationsWrite: "operations:write",
  OperationsReconcile: "operations:reconcile",
  IntegrationRead: "integration:read",
  IntegrationManage: "integration:manage",
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

const ordinaryErpPermissions = new Set<string>(
  Object.values(Permission).filter(
    (permission) =>
      permission !== Permission.FactoryTaskRead && permission !== Permission.FactoryTaskRespond,
  ),
);
/** The ordinary ERP session and object snapshots must use the same authority projection. */
export function erpPermissions(permissions: readonly string[]) {
  return permissions.filter((permission) => ordinaryErpPermissions.has(permission)).sort();
}
import type { TenantContext } from "@yummyai/contracts";


/** Presentation only; preserve the full context for every owner authorization. */
export function erpPermissionContext(context: TenantContext): TenantContext {
  const permissions = erpPermissions(context.permissions);
  return { ...context, permissions, ...(context.permissionScopes ? { permissionScopes:
    Object.fromEntries(permissions.map(permission => [permission, context.permissionScopes![permission]])) } : {}) };
}
