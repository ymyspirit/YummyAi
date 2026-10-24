import type { TenantContext } from "@yummyai/contracts";
import type { AssistKind, CreateAssist } from "@yummyai/contracts/ai/assist";
import { authorize, ForbiddenError } from "@yummyai/authz/authorize";
import { Permission } from "@yummyai/authz/permissions";

export const ASSIST_ACCESS_POLICY_VERSION = "assist-access-2026-10-16-v1";
export type AssistAccessMode = "read" | "run";
type AssistAttachments = { hasKnowledge?: boolean; pinnedDataScope?: TenantContext["dataScope"] };
type AssistPolicy = { read: readonly Permission[]; run: readonly Permission[] };

/** Shared by API admission, historical reads and worker execution. */
const policies = {
  creative: { read: [Permission.DesignRead, Permission.ResearchRead], run: [Permission.DesignWrite] },
  order_review: { read: [Permission.OrderRead, Permission.OrderPiiRead], run: [Permission.OrderWrite] },
  artwork_preflight: { read: [Permission.OrderRead, Permission.OrderPiiRead, Permission.DesignRead], run: [Permission.DesignWrite] },
  template_config: { read: [Permission.DesignRead], run: [Permission.DesignWrite] },
  sku_package: { read: [Permission.ListingRead, Permission.ProductRead, Permission.DesignRead], run: [Permission.ListingWrite] },
  business_review: { read: [Permission.FinanceRead, Permission.OrderRead], run: [] },
  procurement_review: { read: [Permission.ProcurementRead, Permission.InventoryRead], run: [] },
  after_sales_review: { read: [Permission.OrderRead, Permission.OrderPiiRead], run: [] },
  knowledge_answer: { read: [Permission.WorkflowRead], run: [Permission.WorkflowRun] },
} as const satisfies Record<AssistKind, AssistPolicy>;

export function requiredAssistPermissions(kind: AssistKind, mode: AssistAccessMode): Permission[] {
  const policy = policies[kind];
  return [...policy.read, ...(mode === "run" ? policy.run : [])];
}

export function requiredAssistRequestPermissions(
  request: CreateAssist,
  mode: AssistAccessMode,
  attachments: AssistAttachments = {},
): Permission[] {
  const required = new Set(requiredAssistPermissions(request.kind, mode));
  if (attachments.hasKnowledge) required.add(Permission.WorkflowRead);
  if (request.salesPlan) required.add(Permission.ProductRead);
  if (request.kind === "knowledge_answer") {
    if (request.search.spuIds.length) required.add(Permission.ProductRead);
    if (request.evidenceStoreId) {
      required.add(Permission.FinanceRead);
      required.add(Permission.StoreRead);
    }
    if (mode === "run" && request.purpose === "evaluation") required.add(Permission.WorkflowManage);
  }
  return [...required];
}

export function authorizeAssistRequest(
  context: TenantContext,
  request: CreateAssist,
  mode: AssistAccessMode,
  attachments: AssistAttachments = {},
): void {
  const required = requiredAssistRequestPermissions(request, mode, attachments);
  for (const permission of required) authorize(context, permission);
  const rank = { self: 0, team: 1, tenant: 2 };
  if (attachments.pinnedDataScope && rank[context.dataScope] < rank[attachments.pinnedDataScope])
    throw new ForbiddenError(required[0]!, "outside_data_scope");
}
