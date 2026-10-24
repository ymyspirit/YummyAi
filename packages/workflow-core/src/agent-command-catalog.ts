import { authorize, ForbiddenError, Permission, permissionScope } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import type { AgentCommandBinding, AgentCommandCapability } from "@yummyai/contracts/ai/agent-command";
import { ProcurementCommandKindSchema } from "@yummyai/contracts/procurement/procurement-command";
import { IncomingCommandKindSchema } from "@yummyai/contracts/procurement/incoming-command";
import { FinanceCommandKindSchema, type FinanceCommandKind } from "@yummyai/contracts/finance/finance-command";
import { AdCommandKindSchema, type AdCommandKind } from "@yummyai/contracts/advertising/command";
import { ProductionCommandKindSchema } from "@yummyai/contracts/order/production-command";
export function agentFinanceCommandPermission(kind:FinanceCommandKind):Permission {
 return kind==="statement_record"||kind==="fx_rate_record"||kind==="bill_record"||kind==="payment_record"?Permission.FinanceWrite:Permission.FinanceReview;
}
export function agentAdvertisingCommandPermission(kind:AdCommandKind){return ["import_commit","observation_record","import_archive"].includes(kind)?Permission.CustomerIntelligenceWrite:Permission.CustomerIntelligenceReview;}
const financeCommandPermission=agentFinanceCommandPermission,advertisingCommandPermission=agentAdvertisingCommandPermission;
const procurementLabels = {
  requisition_create: "新建采购申请", rfq_create: "新建询价", quote_record: "登记供应商报价",
  purchase_create: "新建采购草稿", supply_purchase_create: "从供货关联新建采购", purchase_revise: "修订采购单",
  purchase_review: "审核采购单", invoice_record: "登记采购发票", invoice_reconcile: "核对采购发票",
} satisfies Record<(typeof ProcurementCommandKindSchema.options)[number], string>;
const incomingLabels = {
  publish_standard: "发布来料检验标准", record_arrival: "登记到货", record_inspection: "登记来料检验",
  review_inspection: "核准来料检验", post_inspection: "登记检验入库", return_rejected: "登记拒收退回",
} satisfies Record<(typeof IncomingCommandKindSchema.options)[number], string>;
const productionLabels = {
  approved_design: "下达已批准设计生产", reviewed_line: "下达已审商品生产", reviewed_order: "下达已审整单生产",
} satisfies Record<(typeof ProductionCommandKindSchema.options)[number], string>;
const financeLabels = {
  statement_record: "登记财务报表", fx_rate_record: "登记汇率", metric_upsert: "保存利润指标版本",
  profit_calculate: "计算利润", bill_record: "登记应付账单", payment_record: "登记付款",
  payment_allocate: "登记付款核销", allocation_release: "释放付款核销", bill_adjustment_record: "登记账单调整",
  payment_adjustment_record: "登记付款调整", cost_version_approve: "批准费用分摊版本", allocated_profit_calculate: "计算归属利润",
} satisfies Record<(typeof FinanceCommandKindSchema.options)[number], string>;
const advertisingLabels = {
  import_commit: "提交广告报表导入", goal_save: "保存广告目标", observation_record: "登记广告观察",
  analysis_run: "运行广告分析", action_transition: "登记广告行动事件", import_archive: "归档广告导入", export_seal: "封存广告导出",
} satisfies Record<(typeof AdCommandKindSchema.options)[number], string>;

export function agentCommandCapabilities(context: TenantContext): AgentCommandCapability[] {
  const items: AgentCommandCapability[] = [];
  const add = (domain: AgentCommandBinding["domain"], kind: string, label: string, required: Permission[],
    tenant = false, alternatives: Permission[] = []) => {
    const available = permits(context, required, tenant) && (!alternatives.length || alternatives.some(bit => permits(context, [bit], tenant)));
    items.push({ domain, kind, label, effect: "prepare_original_command", preparation: "registered_original_owner",
      execution: "exact_operator_confirmation", externalEffect: domain === "production" ? "original_production_release" : "internal_record_only",
      available, blockReason: available ? null : "permission_denied" });
  };
  for (const kind of ProcurementCommandKindSchema.options) add("procurement", kind, procurementLabels[kind],
    kind === "invoice_reconcile" ? [Permission.ProcurementRead] : [Permission.ProcurementRead,
      kind === "purchase_review" ? Permission.ProcurementApprove : Permission.ProcurementWrite], false,
    kind === "invoice_reconcile" ? [Permission.ProcurementWrite, Permission.ProcurementApprove] : []);
  for (const kind of IncomingCommandKindSchema.options) add("incoming", kind, incomingLabels[kind], [Permission.ProcurementRead, Permission.InventoryRead,
    kind === "review_inspection" ? Permission.ProcurementApprove : Permission.ProcurementWrite,
    ...(kind === "post_inspection" ? [Permission.InventoryWrite] : [])]);
  for (const kind of ProductionCommandKindSchema.options) add("production", kind, productionLabels[kind],
    [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead], true);
  for (const kind of FinanceCommandKindSchema.options) add("finance", kind, financeLabels[kind], [financeCommandPermission(kind)], true);
  for (const kind of AdCommandKindSchema.options) add("advertising", kind, advertisingLabels[kind], [advertisingCommandPermission(kind)]);
  return items;
}

function permits(context: TenantContext, permissions: Permission[], tenant: boolean): boolean {
  try {
    for (const bit of permissions) {
      authorize(context, bit);
      if (tenant && permissionScope(context, bit) !== "tenant") return false;
    }
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError) return false;
    throw error;
  }
}
