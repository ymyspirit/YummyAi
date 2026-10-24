import { erpPermissionContext, permissionScope, Permission, type PermissionValue } from "@yummyai/authz";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { IntegrationAgentCatalogSchema, type IntegrationAgentCapability, type IntegrationAgentCatalog, type TenantContext } from "@yummyai/contracts";
import { requiredAssistPermissions } from "@yummyai/authz/assist-policy";

type Entry = Pick<IntegrationAgentCapability, "key" | "domain" | "title" | "effect" | "requiredPermissions" | "minimumScope" | "ownerState">;
// These are versioned coverage descriptors, not installed executors. A real
// adapter must register its strict schemas and owner checks before being callable.
const entries: readonly Entry[] = [
  { key: "research.evidence.read", domain: "research", title: "研究证据读取", effect: "read", requiredPermissions: [Permission.ResearchRead], minimumScope: "self", ownerState: "existing" },
  { key: "catalog.product.read", domain: "catalog", title: "商品与版本读取", effect: "read", requiredPermissions: [Permission.ProductRead], minimumScope: "self", ownerState: "existing" },
  { key: "catalog.listing.read", domain: "catalog", title: "Listing 版本读取", effect: "read", requiredPermissions: [Permission.ListingRead], minimumScope: "self", ownerState: "existing" },
  { key: "catalog.listing.prepare", domain: "catalog", title: "Listing 资料准备", effect: "prepare", requiredPermissions: [Permission.ListingWrite, Permission.ProductRead], minimumScope: "self", ownerState: "existing" },
  { key: "creative.direction.analyze", domain: "creative", title: "原创方向分析", effect: "analyze", requiredPermissions: requiredAssistPermissions("creative", "run"), minimumScope: "self", ownerState: "existing" },
  { key: "creative.canvas.read", domain: "creative", title: "画布与设计版本读取", effect: "read", requiredPermissions: [Permission.DesignRead], minimumScope: "self", ownerState: "existing" },
  { key: "orders.order.read", domain: "orders", title: "订单与履约依据读取", effect: "read", requiredPermissions: [Permission.OrderRead], minimumScope: "tenant", ownerState: "existing" },
  { key: "orders.review.analyze", domain: "orders", title: "订单预审分析", effect: "analyze", requiredPermissions: requiredAssistPermissions("order_review", "run"), minimumScope: "tenant", ownerState: "existing" },
  { key: "manufacturing.production.prepare", domain: "manufacturing", title: "原生产命令准备", effect: "prepare", requiredPermissions: [Permission.OrderRead, Permission.OrderWrite], minimumScope: "tenant", ownerState: "existing" },
  { key: "manufacturing.production.execute", domain: "manufacturing", title: "原生产命令执行", effect: "execute", requiredPermissions: [Permission.OrderRead, Permission.OrderWrite], minimumScope: "tenant", ownerState: "existing" },
  { key: "manufacturing.production.result", domain: "manufacturing", title: "原生产回执读取", effect: "result", requiredPermissions: [Permission.OrderRead], minimumScope: "tenant", ownerState: "existing" },
  { key: "procurement.review.analyze", domain: "procurement", title: "采购分析", effect: "analyze", requiredPermissions: requiredAssistPermissions("procurement_review", "run"), minimumScope: "self", ownerState: "existing" },
  { key: "procurement.command.prepare", domain: "procurement", title: "原采购命令准备", effect: "prepare", requiredPermissions: [Permission.ProcurementRead, Permission.ProcurementWrite], minimumScope: "self", ownerState: "existing" },
  { key: "procurement.command.execute", domain: "procurement", title: "原采购命令执行", effect: "execute", requiredPermissions: [Permission.ProcurementRead, Permission.ProcurementWrite], minimumScope: "self", ownerState: "existing" },
  { key: "inventory.stock.read", domain: "inventory", title: "库存与预留读取", effect: "read", requiredPermissions: [Permission.InventoryRead], minimumScope: "self", ownerState: "existing" },
  { key: "logistics.shipment.read", domain: "logistics", title: "包裹与物流依据读取", effect: "read", requiredPermissions: [Permission.OrderRead], minimumScope: "tenant", ownerState: "existing" },
  { key: "logistics.label.result", domain: "logistics", title: "原面单请求与回执读取", effect: "result", requiredPermissions: [Permission.OrderRead], minimumScope: "tenant", ownerState: "existing" },
  { key: "finance.profit.read", domain: "finance", title: "原利润计算读取", effect: "read", requiredPermissions: [Permission.FinanceRead], minimumScope: "self", ownerState: "existing" },
  { key: "finance.command.prepare", domain: "finance", title: "原财务命令准备", effect: "prepare", requiredPermissions: [Permission.FinanceRead, Permission.FinanceWrite], minimumScope: "self", ownerState: "existing" },
  { key: "finance.command.result", domain: "finance", title: "原财务回执读取", effect: "result", requiredPermissions: [Permission.FinanceRead], minimumScope: "self", ownerState: "existing" },
  { key: "advertising.measurement.read", domain: "advertising", title: "广告测量与历史读取", effect: "read", requiredPermissions: [Permission.CustomerIntelligenceRead], minimumScope: "self", ownerState: "existing" },
  { key: "advertising.command.prepare", domain: "advertising", title: "原广告命令准备", effect: "prepare", requiredPermissions: [Permission.CustomerIntelligenceRead, Permission.CustomerIntelligenceWrite], minimumScope: "self", ownerState: "existing" },
  { key: "knowledge.published.read", domain: "knowledge", title: "已发布知识与规则读取", effect: "read", requiredPermissions: [Permission.WorkflowRead], minimumScope: "self", ownerState: "existing" },
  { key: "knowledge.answer.analyze", domain: "knowledge", title: "知识问答与来源核对", effect: "analyze", requiredPermissions: requiredAssistPermissions("knowledge_answer", "run"), minimumScope: "self", ownerState: "existing" },
];
const ranks = { self: 0, team: 1, tenant: 2 };
export function integrationAgentCatalog(context: TenantContext): IntegrationAgentCatalog {
  return IntegrationAgentCatalogSchema.parse({
    contextAuthority: erpSessionAuthority(erpPermissionContext(context)),
    version: "erp-agent-catalog-v1", mcpState: "not_connected",
    capabilities: entries.map(entry => ({ ...entry, version: "erp-agent-catalog-v1", callableViaAgent: false,
      agentState: entry.requiredPermissions.every(bit => context.permissions.includes(bit) &&
        ranks[permissionScope(context, bit as PermissionValue)] >= ranks[entry.minimumScope]) ? "adapter_pending" : "unauthorized" })),
  });
}
