import { authorize, ForbiddenError, Permission, permissionScope } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { AGENT_COMMAND_VERSION } from "@yummyai/contracts/ai/agent-command";
import { AGENT_FULFILLMENT_COMMAND_VERSION, AgentCommandV2CatalogSchema, type AgentCommandV2Capability } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { FulfillmentCommandKindSchema, type FulfillmentCommandKind } from "@yummyai/contracts/order/fulfillment-command";
import { agentCommandCapabilities } from "./agent-command-catalog.js";

export const agentFulfillmentCommandLabels = {
  delivery_create: "创建原交付包", delivery_feedback: "登记工厂原回执", production_milestone: "登记生产进度",
  quality_inspection: "登记逐项质检", quality_group_inspection: "登记实物分组质检", production_recovery: "登记原生产补做",
  whole_production_milestone: "登记整单生产进度", whole_quality_inspection: "登记整单质检", shipment_create: "建立原包裹",
  whole_shipment_create: "建立整单包裹", shipment_version: "保存包裹新版本", shipment_review: "审核原包裹版本",
  shipment_dispatch: "登记实际出库", shipment_platform_confirmation: "登记人工平台确认",
} satisfies Record<FulfillmentCommandKind, string>;

function permitted(context: TenantContext, bits: Permission[], tenant: boolean) {
  try { for (const bit of bits) { authorize(context, bit, { ownerId: context.userId }); if (tenant && permissionScope(context, bit) !== "tenant") return false; } return true; }
  catch (error) { if (error instanceof ForbiddenError) return false; throw error; }
}
/** Descriptors indicate role eligibility only. Original source, input-dependent permissions and birth ceiling are checked by the owner at preparation and execution. */
export function agentCommandV2Capabilities(context: TenantContext): AgentCommandV2Capability[] {
  const workflow = permitted(context, [Permission.WorkflowRead, Permission.WorkflowRun], false);
  const old: AgentCommandV2Capability[] = agentCommandCapabilities(context).map(item => ({ ...item, protocol: AGENT_COMMAND_VERSION,
    available: workflow && item.available, blockReason: workflow ? item.blockReason : "workflow_run_required" }));
  const fulfillment: AgentCommandV2Capability[] = FulfillmentCommandKindSchema.options.map(kind => {
    const required = [Permission.OrderRead, Permission.OrderPiiRead, Permission.OrderWrite,
      ...(["delivery_create", "delivery_feedback"].includes(kind) ? [Permission.DesignRead, Permission.AssetRead] : [])];
    const available = workflow && permitted(context, required, true);
    return { domain: "fulfillment", kind, label: agentFulfillmentCommandLabels[kind], protocol: AGENT_FULFILLMENT_COMMAND_VERSION,
      effect: "prepare_original_command", preparation: "registered_original_owner", execution: "exact_operator_confirmation", externalEffect: "internal_record_only",
      available, blockReason: available ? null : !workflow ? "workflow_run_required" : "permission_denied" };
  });
  return AgentCommandV2CatalogSchema.parse([...old, ...fulfillment]);
}
