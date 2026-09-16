import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import {
  assistFingerprint,
  compareProfitRuns,
  replenishmentAnalysis,
  type AssistContext,
} from "@yummyai/ai-core";
import type { TenantContext } from "@yummyai/contracts";
import {
  AssistBusinessSelectionSchema,
  businessAssistSelection,
  type AssistBasisView,
  type AssistBusinessSelection,
  type CreateAssist,
} from "@yummyai/contracts/ai/assist";
import type { FinanceProfitRunView } from "@yummyai/contracts/finance";
import { FinanceService } from "../finance/finance.service.js";
import { ProcurementService } from "../procurement/procurement.service.js";
import { OrderAfterSalesService } from "../orders/order-after-sales.service.js";
import { OrderWorkspaceService } from "../orders/order-workspace.service.js";

type BusinessRequest = Extract<CreateAssist, { expectedFingerprint: string }>;
type Packet = Omit<AssistBasisView, "fingerprint"> & {
  data: Record<string, unknown>;
  expiresAt?: string;
  sensitiveOrderLineId?: string;
};
export function authorizeBusinessAssist(
  context: TenantContext,
  kind: AssistBusinessSelection["kind"],
) {
  if (kind === "business_review") {
    authorize(context, Permission.FinanceRead);
    authorize(context, Permission.OrderRead);
  } else if (kind === "procurement_review") {
    authorize(context, Permission.ProcurementRead);
    authorize(context, Permission.InventoryRead);
  } else {
    authorize(context, Permission.OrderRead);
    authorize(context, Permission.OrderPiiRead);
  }
}

@Injectable()
export class AssistBusinessContextService {
  constructor(
    @Inject(FinanceService) private readonly finance: FinanceService,
    @Inject(ProcurementService) private readonly procurement: ProcurementService,
    @Inject(OrderAfterSalesService) private readonly afterSales: OrderAfterSalesService,
    @Inject(OrderWorkspaceService) private readonly orders: OrderWorkspaceService,
  ) {}

  async preview(context: TenantContext, raw: unknown): Promise<AssistBasisView> {
    const selection = AssistBusinessSelectionSchema.parse(raw);
    const packet = await this.read(context, selection);
    return {
      fingerprint: packetFingerprint(selection, packet),
      rows: packet.rows,
      sources: packet.sources,
      checks: packet.checks,
      diagnostics: packet.diagnostics,
    };
  }

  async prepare(context: TenantContext, request: BusinessRequest): Promise<AssistContext> {
    const selection = businessAssistSelection(request),
      expectedFingerprint = request.expectedFingerprint;
    const packet = await this.read(context, selection);
    if (packetFingerprint(selection, packet) !== expectedFingerprint)
      throw new ConflictException("分析依据已变化，请重新读取当前依据后再开始分析");
    return {
      request,
      data: packet.data,
      checks: packet.checks,
      sources: packet.sources,
      diagnostics: packet.diagnostics,
      images: [],
      allowedArtworkIds: [],
      allowedSpecificationIds: [],
      allowMatches: false,
      ...(packet.expiresAt ? { expiresAt: packet.expiresAt } : {}),
      ...(packet.sensitiveOrderLineId ? { sensitiveOrderLineId: packet.sensitiveOrderLineId } : {}),
    };
  }

  async stale(context: TenantContext, request: BusinessRequest) {
    try {
      await this.prepare(context, request);
      return false;
    } catch {
      return true;
    }
  }

  private async read(context: TenantContext, input: AssistBusinessSelection): Promise<Packet> {
    authorizeBusinessAssist(context, input.kind);
    const packet: Packet = {
      data: { kind: input.kind },
      rows: [],
      sources: [],
      checks: [],
      diagnostics: [],
    };
    const row = (label: string, value: string | number | null) =>
      packet.rows.push({ label, value: value === null ? "待补资料" : String(value) });
    const check = (code: string, message: string, severity: "warning" | "manual" = "manual") =>
      packet.checks.push({ code, message, severity, location: null });
    const source = (id: string, label: string, href: string) => {
      if (!packet.sources.some((s) => s.id === id)) packet.sources.push({ id, label, href });
    };

    if (input.kind === "business_review") {
      if (input.runId === input.comparisonRunId)
        throw new BadRequestException("请选择不同的比较计算");
      const current = await this.finance.getProfitRun(context, input.runId);
      const prior = input.comparisonRunId
        ? await this.finance.getProfitRun(context, input.comparisonRunId)
        : null;
      const calculations = compareProfitRuns(current, prior);
      source(
        current.id,
        `当前利润计算 · ${current.calculatedAt} · 口径 V${current.metricVersion}`,
        "/finance",
      );
      if (prior)
        source(
          prior.id,
          `比较利润计算 · ${prior.calculatedAt} · 口径 V${prior.metricVersion}`,
          "/finance",
        );
      packet.data.current = summarizeRun(current);
      packet.data.comparison = prior ? summarizeRun(prior) : null;
      packet.data.calculations = calculations;
      row(
        "本次口径",
        `V${current.metricVersion} · ${current.reportingCurrency} · ${current.status === "complete" ? "完整" : "缺证据"}`,
      );
      row("确认收入", money(current.revenueMinor, current.reportingCurrency));
      row("确认成本", money(current.costMinor, current.reportingCurrency));
      row("贡献利润", money(current.profitMinor, current.reportingCurrency));
      row(
        "利润差额",
        calculations.comparable
          ? money(calculations.profitDeltaMinor, current.reportingCurrency)
          : prior
            ? "口径、币种或完整性不一致，不能比较"
            : "未选择比较计算",
      );
      if (current.status !== "complete" || prior?.status === "incomplete")
        check("finance_incomplete", "存在未分类成本、缺失费用或汇率，不能把缺失值当作零计算利润");
      if (prior && !calculations.comparable)
        check("finance_incomparable", "比较计算的口径版本、币种或完整性不同，差额不计算");
      packet.diagnostics.push(
        "仅解释所选不可变计算；两次计算的差额不自动代表环比或同比，请核对单据期间与范围。金额以各币种最小单位保存。",
      );
      const orderIds = [
        ...new Set(current.contributions.flatMap((c) => (c.orderId ? [c.orderId] : []))),
      ].sort();
      if (orderIds.length > 1000)
        packet.diagnostics.push(
          "关联订单超过 1000 个，本次不分析订单流程与售后汇总，请缩小计算范围。",
        );
      else {
        const workflow = await this.orders.analysisSummary(context, orderIds);
        const cases = await this.afterSales.analysisSummary(context, orderIds);
        packet.data.workflow = {
          sourceId: "workflow",
          scope: "仅当前计算已关联订单的当前状态，不是本期发生量或历史时点状态",
          ...workflow,
        };
        packet.data.afterSales = {
          sourceId: "after-sales",
          scope: "仅上述订单的售后登记分类；不是退货率或实际退款事实",
          cases,
        };
        source("workflow", "当前计算关联订单的流程汇总", "/orders");
        source("after-sales", "当前计算关联订单的售后分类", "/after-sales");
        row("关联订单", workflow.orderCount);
        row(
          "关联订单的售后记录",
          cases.reduce((n, c) => n + c.count, 0),
        );
        if (!orderIds.length)
          check("orders_unlinked", "所选财务事实没有关联订单，无法分析生产瓶颈与售后原因");
      }
    } else if (input.kind === "procurement_review") {
      const basis = await this.procurement.analysisBasis(
        context,
        input.stockItemId,
        input.locationId,
      );
      const physical = sum(basis.balances.map((b) => b.physical)),
        reserved = sum(basis.balances.map((b) => b.reserved)),
        inTransit = sum(basis.balances.map((b) => b.inTransit));
      const open = basis.purchases.filter((p) => p.status !== "draft");
      const openPurchaseQuantity = sum(open.map((p) => p.remaining));
      const ambiguous = inTransit > 0 && openPurchaseQuantity > 0;
      const blocked =
        !basis.balances.length ||
        basis.stock.status !== "active" ||
        basis.location.status !== "active" ||
        ambiguous ||
        open.some(
          (p) =>
            p.status === "reconciliation_required" ||
            p.rejected > 0 ||
            p.units.some((u) => u !== basis.stock.unit),
        );
      const calculations = replenishmentAnalysis({
        physical,
        reserved,
        inTransit,
        openPurchaseQuantity,
        policy: basis.policy,
        blocked,
      });
      const now = new Date();
      const quotes = basis.quotes.map((q) => ({
        ...q,
        sourceId: q.id,
        usable:
          q.supplierStatus === "active" &&
          Date.parse(q.validUntil) > now.getTime() &&
          q.unit === basis.stock.unit,
      }));
      const purchases = basis.purchases.map((p) => ({
        ...p,
        sourceId: p.versionId,
        overdue:
          p.status !== "draft" && p.remaining > 0 && Date.parse(p.expectedAt) < now.getTime(),
      }));
      packet.data = {
        kind: input.kind,
        stock: basis.stock,
        location: basis.location,
        balanceSourceId: "inventory",
        policy: basis.policy,
        balances: basis.balances,
        calculations: { physical, reserved, inTransit, openPurchaseQuantity, ...calculations },
        purchases,
        quotes,
      };
      source("inventory", `${basis.stock.code} · ${basis.location.code} 当前库存`, "/inventory");
      source(basis.stock.id, `${basis.stock.code} · 采购与补货`, "/procurement");
      if (basis.policy)
        source(basis.policy.versionId, `补货规则 V${basis.policy.version}`, "/procurement");
      for (const p of purchases) source(p.versionId, `${p.code} · V${p.version}`, "/procurement");
      for (const q of quotes)
        source(q.id, `${q.supplierName} · 报价 V${q.version}`, "/procurement");
      row("货品 / 库位", `${basis.stock.name} / ${basis.location.name}`);
      row(
        "单位",
        { each: "件", pair: "对", set: "套", meter: "米", gram: "克", kilogram: "千克" }[
          basis.stock.unit
        ] ?? basis.stock.unit,
      );
      row("实物库存", basis.balances.length ? physical : null);
      row("已占用", basis.balances.length ? reserved : null);
      row("可用库存", basis.balances.length ? calculations.available : null);
      row("库存记录的在途", basis.balances.length ? inTransit : null);
      row("已审批采购未收数量", openPurchaseQuantity);
      row("规则建议补货数量", calculations.suggestedQuantity);
      row("有效报价行", quotes.filter((q) => q.usable).length);
      row("采购逾期单数", purchases.filter((p) => p.overdue).length);
      if (!basis.balances.length)
        check("inventory_missing", "该货品/库位没有库存记录，请先核实库存；不按零库存推断补货");
      if (!basis.policy)
        check("policy_missing", "尚无启用的补货规则，需要确认再订货点、安全库存、起订量及交期");
      if (ambiguous)
        check(
          "inbound_overlap",
          "在途库存与未收采购同时存在，请先核对是否重复，本轮不计算建议数量",
        );
      if (open.some((p) => p.status === "reconciliation_required" || p.rejected > 0))
        check("receipt_variance", "采购存在拒收或对账差异，需核实剩余到货数量后再补货");
      if (basis.stock.status !== "active" || basis.location.status !== "active")
        check("inactive_dimension", "货品或库位已停用，需要先核对业务状态");
      if (purchases.some((p) => p.units.some((u) => u !== basis.stock.unit)))
        check("unit_mismatch", "采购数量单位与货品单位不一致，需先确认换算");
      if (!quotes.some((q) => q.usable))
        check("quotes_missing", "没有有效且单位匹配的供应商报价，请先询价");
      if (new Set(quotes.filter((q) => q.usable).map((q) => q.currency)).size > 1)
        check("quote_currencies", "报价存在不同币种，未提供换算证据，不直接比较最低价");
      packet.diagnostics.push(
        "补货量按当前规则计算，计入可用库存、在途与已审批采购剩余；采购草稿不算预计到货。未提供销量预测、运费、税费和供应商产能，不预测缺货日期或完整到岸成本。分析不会创建申请、下单或付款。",
      );
    } else {
      const basis = await this.afterSales.analysisBasis(context, input.caseId);
      const { expiresAt, lineId, ...data } = basis;
      packet.data = {
        kind: input.kind,
        ...data,
        contextNotes: input.contextNotes,
        targetLocale: input.locale,
        notesSourceId: "operator-notes",
      };
      packet.expiresAt = expiresAt;
      packet.sensitiveOrderLineId = lineId;
      source(input.caseId, `售后记录 · 方案 V${basis.case.version}`, `/after-sales?line=${lineId}`);
      if (input.contextNotes.trim())
        source("operator-notes", "运营填写的问题说明（待核验）", `/after-sales?line=${lineId}`);
      row("售后状态", statusLabel(basis.case.status));
      row("问题分类", `${statusLabel(basis.case.type)} · ${basis.case.reasonCode}`);
      row("处理方案版本", basis.case.version);
      row("已登记沟通", basis.contactCount);
      row("退回物流记录", basis.returnCount);
      row("已关联补寄订单", basis.replacementCount);
      row("处理方案", basis.decision ? statusLabel(basis.decision.resolution) : "尚未登记");
      if (!input.contextNotes.trim())
        check("case_notes_missing", "尚未填写问题说明，本次只能按状态及分类给出核对建议");
      if (!basis.evidenceCount) check("case_evidence_missing", "尚无责任证据记录，不能确认责任方");
      if (basis.case.status === "approved")
        check("decision_not_execution", "方案已通过不等于退款或补寄已执行，需要核对实际凭证");
      if (["resolved", "cancelled"].includes(basis.case.status))
        check("case_closed", "售后已结束，本次用于复盘，不生成新的客户回复");
      packet.diagnostics.push(
        "仅发送状态、分类、方案和这里填写的问题说明；客户消息正文、原始问题摘要、联系方式、物流单号和附件不会自动发送。运营说明不是独立证据。回复草稿需要人工核对，不自动发送或登记为已沟通。",
      );
      if (basis.contactCount > 20 || basis.returnCount > 20)
        packet.diagnostics.push("沟通时间与退回状态各取最近 20 条，其他历史未纳入分析。");
    }
    if (Buffer.byteLength(JSON.stringify(packet), "utf8") > 70 * 1024)
      throw new BadRequestException("分析依据超过本次上限，请缩小记录范围后重试");
    return packet;
  }
}

function packetFingerprint(selection: AssistBusinessSelection, p: Packet) {
  return assistFingerprint({
    selection,
    data: p.data,
    checks: p.checks,
    diagnostics: p.diagnostics,
    sources: p.sources,
  });
}
function sum(values: number[]) {
  const n = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(n))
    throw new BadRequestException("统计数量超出安全整数范围，请缩小分析范围");
  return n;
}
function money(n: number | null, currency: string) {
  if (n === null) return "待补资料";
  const format = new Intl.NumberFormat("zh-CN", { style: "currency", currency });
  const decimals = format.resolvedOptions().maximumFractionDigits ?? 2;
  return `${format.format(n / 10 ** decimals)} ${currency}（最小单位 ${n}）`;
}
function summarizeRun(run: FinanceProfitRunView) {
  const buckets = new Map<string, number | null>();
  for (const c of run.contributions) {
    const key = `${c.bucket}:${c.factType}`;
    const previous = buckets.get(key);
    buckets.set(
      key,
      c.reportingAmountMinor === null || previous === null
        ? null
        : sum([previous ?? 0, c.effectSign * c.reportingAmountMinor]),
    );
  }
  const breakdowns = run.breakdowns.filter(
    (b) => b.dimension !== "order" && b.dimension !== "order_line",
  );
  return {
    sourceId: run.id,
    metricVersionId: run.metricVersionId,
    metricVersion: run.metricVersion,
    reportingCurrency: run.reportingCurrency,
    status: run.status,
    revenueMinor: run.revenueMinor,
    costMinor: run.costMinor,
    profitMinor: run.profitMinor,
    marginBps: run.marginBps,
    inputChecksum: run.inputChecksum,
    calculatedAt: run.calculatedAt,
    statementCount: run.statementIds.length,
    diagnostics: run.diagnostics,
    buckets: [...buckets].map(([key, amountMinor]) => ({ key, amountMinor })),
    breakdowns: breakdowns.slice(0, 100),
    breakdownsTotal: breakdowns.length,
    breakdownsTruncated: breakdowns.length > 100,
  };
}

function statusLabel(value: string) {
  const labels: Record<string, string> = {
    open: "待处理",
    awaiting_customer: "等待客户",
    awaiting_internal: "等待内部处理",
    approved: "方案已通过",
    rejected: "方案已拒绝",
    resolved: "已结案",
    cancelled: "已取消",
    customer_contact: "客户咨询",
    refund_request: "退款申请",
    return_request: "退货申请",
    replacement_request: "补寄申请",
    delivery_issue: "物流问题",
    quality_issue: "质量问题",
    no_action: "无需处理",
    full_refund: "全额退款",
    partial_refund: "部分退款",
    return_and_refund: "退货退款",
    replacement: "补寄",
  };
  return labels[value] ?? value;
}
