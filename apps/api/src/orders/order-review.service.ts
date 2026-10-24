import { Inject, Injectable } from "@nestjs/common";
import { authorize, ForbiddenError, Permission } from "@yummyai/authz";
import type { SecretVault } from "@yummyai/ai-core";
import type { TenantContext } from "@yummyai/contracts";
import {
  OrderReviewViewSchema, OrderReviewWorkspaceSchema,
  type OrderReviewCostEvidence, type OrderReviewEvent, type OrderReviewRework, type OrderReviewView,
} from "@yummyai/contracts/order/review";
import type { DatabaseConnection } from "@yummyai/database";
import { OrderDesignRepository } from "@yummyai/order-design";
import { FinanceService, type OrderFinanceEvidence } from "../finance/finance.service.js";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";
import { OrderWorkspaceService } from "./order-workspace.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { OrderShipmentService } from "./order-shipment.service.js";
import { OrderAfterSalesService } from "./order-after-sales.service.js";
import { OrderProductionDeliveryService } from "./order-production-delivery.service.js";
import { readOrderSection as section } from "./order-read-section.js";
import { effectiveOrderFacts, orderReviewProfit, reviewDeadline, reviewDuration, summarizeOrderReview } from "./order-review-metrics.js";

type Sources = Awaited<ReturnType<OrderWorkspaceService["reviewSources"]>>;
const dispatchStates = new Set(["picked_up", "in_transit", "out_for_delivery", "delivered", "returned"]);
const workLabels: Record<string, [OrderReviewEvent["stage"], string]> = {
  save_draft: ["intake", "保存制作要求"], save: ["intake", "保存制作要求"], push: ["intake", "派发制作"],
  recall: ["intake", "撤回制作"], start_artwork: ["artwork", "开始制作"], submit_artwork: ["review", "提交审核"],
  approve_artwork: ["review", "审核通过"], reject_artwork: ["review", "审核驳回"],
  approve_proof: ["review", "客户校样通过"], reject_proof: ["review", "客户校样驳回"],
  hold: ["intake", "暂停"], resume: ["intake", "解除暂停"],
};

/** Read composition: operational evidence never becomes a financial ledger write. */
@Injectable()
export class OrderReviewService {
  private readonly design: OrderDesignRepository;
  constructor(
    @Inject(OrderWorkspaceService) private readonly work: OrderWorkspaceService,
    @Inject(OrderProductionService) private readonly production: OrderProductionService,
    @Inject(OrderShipmentService) private readonly shipments: OrderShipmentService,
    @Inject(OrderAfterSalesService) private readonly cases: OrderAfterSalesService,
    @Inject(OrderProductionDeliveryService) private readonly delivery: OrderProductionDeliveryService,
    @Inject(FinanceService) private readonly finance: FinanceService,
    @Inject(DATABASE_CONNECTION) database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) vault: SecretVault,
  ) { this.design = new OrderDesignRepository(database, vault); }

  private access(context: TenantContext) {
    authorize(context, Permission.OrderRead); authorize(context, Permission.OrderPiiRead);
    if (context.dataScope !== "tenant") throw new ForbiddenError(Permission.OrderRead, "outside_data_scope");
  }

  async get(context: TenantContext, lineId: string) {
    this.access(context);
    const { orderId } = await this.work.orderItems(context, lineId);
    const source = await this.work.reviewSources(context, {}, orderId);
    const finance = await section(() => this.finance.orderEvidence(context, [orderId]), "财务证据");
    return this.compose(context, source, orderId, finance.data);
  }

  async workspace(context: TenantContext, raw: unknown) {
    this.access(context); authorize(context, Permission.FinanceRead);
    const source = await this.work.reviewSources(context, raw), builtAt = new Date().toISOString();
    const finance = await section(() => this.finance.orderEvidence(context, source.orders.map(row => row.id)), "财务证据");
    const views: OrderReviewView[] = [], failed: string[] = [];
    // Four concurrent order reads bound database and decryption work.
    for (let offset = 0; offset < source.orders.length; offset += 4) {
      const batch = await Promise.all(source.orders.slice(offset, offset + 4).map(order => section(
        () => this.compose(context, source, order.id, finance.data, builtAt), "订单复盘",
      )));
      for (const result of batch) if (result.data) views.push(result.data); else failed.push(result.error!);
    }
    return OrderReviewWorkspaceSchema.parse({
      from: source.from, to: source.to, builtAt, orderCount: views.length, totalOrderCount: source.total,
      truncated: source.truncated, failedOrderCount: failed.length,
      diagnostics: [...new Set([...(source.truncated ? ["期间超过 50 单或事件上限，当前只展示已读取范围；缩小期间后复盘"] : []),
        ...(finance.error ? [finance.error] : []), ...failed])],
      groups: summarizeOrderReview(views),
      orders: views.map(view => ({ orderId: view.orderId, lineId: view.lines[0]!.id, externalOrderId: view.externalOrderId,
        profitStatus: view.profit.status, reworkCount: view.rework.length, diagnostics: view.diagnostics })),
    });
  }

  private async compose(context: TenantContext, source: Sources, orderId: string, finance: OrderFinanceEvidence | null, builtAt = new Date().toISOString()) {
    const order = source.orders.find(order => order.id === orderId)!, sourceLines = source.lines.filter(line => line.orderId === orderId);
    const [production, shipments, cases, delivery, models, recovery] = await Promise.all([
      section(async () => Promise.all((await this.production.list(context, orderId)).map(row => this.production.get(context, row.id))), "生产记录"),
      section(async () => Promise.all((await this.shipments.list(context, orderId)).map(row => this.shipments.get(context, row.id))), "交运证据"),
      section(async () => Promise.all((await this.cases.list(context, orderId)).map(row => this.cases.getPrivate(context, row.id))), "售后记录"),
      section(() => this.delivery.workspace(context, { order: orderId }), "工厂回执"),
      section(() => this.design.costEvidence(context, sourceLines.map(line => line.id)), "模型费用"),
      section(() => this.production.reviewRecoveries(context, orderId), "返工记录"),
    ]);
    const diagnostics = [production.error, shipments.error, cases.error, delivery.error, models.error, recovery.error].filter((error): error is string => !!error);
    if (source.historyTruncated) diagnostics.push("订单事件读取不完整，请缩小范围");
    if (delivery.data?.truncated || models.data?.truncated || recovery.data?.truncated) diagnostics.push("履约证据超过读取上限，费用和返工情况待核对");
    const facts = finance?.facts.filter(fact => fact.orderId === orderId) ?? [], effective = effectiveOrderFacts(facts);
    const costs: OrderReviewCostEvidence[] = [], rework: OrderReviewRework[] = [];
    const referencedFacts = (reference: string, types: string[]) => effective.filter(fact => fact.externalReference === reference
      && types.includes(fact.factType) && fact.direction === "debit");
    const matchedFacts = (reference: string | null, types: string[], amount: number | null, currency: string | null) => effective.filter(fact => reference
      && fact.externalReference === reference && types.includes(fact.factType) && fact.direction === "debit"
      && amount !== null && fact.amountMinor === amount && fact.currency === currency).map(fact => fact.id);
    for (const run of models.data?.runs ?? []) {
      const reference = `order-design-run:${run.id}`, actualUsd = run.costStatus === "reported" && run.actualCostUsd !== null ? Number(run.actualCostUsd) : null;
      const minor = actualUsd !== null ? Math.round(actualUsd * 100) : null;
      const billed = referencedFacts(reference, ["other_fee"]).filter(fact => fact.currency === "USD" && (fact.orderLineId === null || fact.orderLineId === run.lineId));
      const billedUsd = billed.length ? billed.reduce((sum, fact) => sum + fact.amountMinor, 0) / 100 : null;
      if (run.costStatus === "not_required" && billedUsd !== null && billedUsd > 0) diagnostics.push("无付费模型任务与模型账单费用冲突，请核对费用归属");
      costs.push({ id: run.id, lineId: run.lineId, source: "model", current: true, basis: run.costStatus === "not_required" ? "not_required" : billedUsd !== null || actualUsd !== null ? "confirmed" : "unknown",
        amountMinor: null, amountUsd: run.costStatus === "not_required" ? 0 : billedUsd ?? actualUsd, currency: "USD", reference,
        ledgerFactIds: billed.length ? billed.map(fact => fact.id) : matchedFacts(reference, ["other_fee"], minor, "USD"),
        note: run.costStatus === "not_required" ? "本任务无付费模型步骤" : billedUsd !== null ? `已关联模型账单；提供方报告 ${actualUsd === null ? "未知" : `USD ${actualUsd}`}；保留所有历史任务费用`
          : actualUsd === null ? `实际费用未确认${run.estimatedCostUsd !== null ? `；预算估计 USD ${run.estimatedCostUsd}` : ""}` : "提供方报告费用，须凭账单入账；保留每次历史任务费用" });
    }
    for (const record of cases.data ?? []) {
      const decision = record.decisions.find(decision => decision.versionNumber === record.case.currentDecisionVersion);
      if (!decision || !["full_refund", "partial_refund", "return_and_refund"].includes(decision.resolution)) continue;
      const reference = `after-sales-decision:${decision.id}`;
      costs.push({ id: decision.id, lineId: null, source: "refund", current: true, basis: "confirmed", amountMinor: decision.refundAmountMinor,
        amountUsd: null, currency: decision.refundCurrency, reference, ledgerFactIds: matchedFacts(reference, ["refund"], decision.refundAmountMinor, decision.refundCurrency),
        note: "售后退款决定；实际退款账单单独入账" });
    }
    const packetEvents = new Map<string, { eventId: string; at: string; pickup: boolean }>();
    for (const record of shipments.data ?? []) {
      const version = record.versions.find(version => version.versionNumber === record.shipment.currentVersionNumber);
      for (const packet of record.packages) {
        const active = !!version && packet.shipmentVersionId === version.id && record.shipment.status !== "cancelled";
        const reference = `shipment-package:${packet.id}`;
        const billed = referencedFacts(reference, ["carrier_cost", "freight_cost"]), currencies = new Set(billed.map(fact => fact.currency));
        const hasBill = billed.length > 0 && currencies.size === 1;
        if (currencies.size > 1) diagnostics.push("同一运单账单含多种币种，请核对费用归属");
        costs.push({ id: packet.id, lineId: null, source: "shipment", current: active || hasBill || packet.externalLabelId !== null || packet.labelCostMinor !== null,
          basis: hasBill || packet.labelCostMinor !== null ? "confirmed" : "unknown",
          amountMinor: hasBill ? billed.reduce((sum, fact) => sum + fact.amountMinor, 0) : packet.labelCostMinor, amountUsd: null,
          currency: hasBill ? billed[0]!.currency : packet.labelCurrency, reference,
          ledgerFactIds: hasBill ? billed.map(fact => fact.id) : [],
          note: `${active ? "当前运单" : "历史 / 已取消运单；取消不代表费用免收或退款"}；${hasBill ? `已关联承运账单；原运单费用报告 ${packet.labelCostMinor === null ? "未知" : `${packet.labelCurrency} ${packet.labelCostMinor}（最小货币单位）`}` : "运单费用报告；实际承运账单尚未入账"}` });
        if (!active || record.shipment.approvedVersionNumber !== record.shipment.currentVersionNumber) continue;
        const events = record.tracking.filter(event => event.packageId === packet.id && dispatchStates.has(event.status)
          && event.occurredAt.getTime() <= Date.parse(builtAt)).toSorted((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
        const pickup = events.find(event => event.status === "picked_up"), first = pickup ?? events[0];
        if (first) packetEvents.set(packet.id, { eventId: first.id, at: first.occurredAt.toISOString(), pickup: !!pickup });
      }
    }
    const lines = sourceLines.map(line => {
      const events: OrderReviewEvent[] = [], ownWork = source.events.filter(event => event.lineId === line.id);
      for (const event of ownWork) {
        const label = workLabels[event.action];
        if (label) events.push({ id: event.id, stage: label[0], label: label[1], occurredAt: event.occurredAt,
          reference: event.action, versionId: null, versionNumber: event.revision, note: null });
        if (["reject_artwork", "reject_proof"].includes(event.action)) rework.push({ id: event.id, lineId: line.id, source: "review", kind: event.action,
          occurredAt: event.occurredAt, reference: event.action, reason: `${label?.[1] ?? event.action}；具体原因见原审核记录`,
          originalProductionOrderId: null, replacementProductionOrderId: null, originalVersionId: null, originalVersionNumber: null,
          replacementVersionId: null, replacementVersionNumber: null, affectedQuantity: null });
      }
      const ownProduction = (production.data ?? []).filter(record => record.productionOrder.orderLineId === line.id);
      const activeFactories = [...new Map(ownProduction.filter(record => record.productionOrder.status !== "cancelled")
        .flatMap(record => record.factoryPin ? [[record.factoryPin.factoryId, record.factoryPin] as const] : [])).values()];
      for (const record of ownProduction) for (const milestone of record.milestones) {
        const label: Record<string, string> = { acknowledged: "工厂确认生产单", started: "开始生产", completed: "完工", failed: "生产失败", cancelled: "取消生产" };
        if (label[milestone.type]) events.push({ id: milestone.id, stage: "production", label: label[milestone.type]!, occurredAt: milestone.occurredAt.toISOString(),
          reference: milestone.evidenceCode, versionId: null, versionNumber: null, note: null });
      }
      const seenFeedback = new Set<string>();
      for (const pack of delivery.data?.packages ?? []) for (const item of pack.items) {
        const pin = item.snapshot;
        if (!pin || pin.orderLineId !== line.id) continue;
        for (const feedback of item.feedback) {
          if (seenFeedback.has(feedback.id)) continue; seenFeedback.add(feedback.id);
          events.push({ id: feedback.id, stage: "factory", label: ({ submitted: "运营提交工厂 ERP", received: "工厂收到文件", accepted: "工厂接受文件", rejected: "工厂拒收文件", rework: "登记工厂返工" })[feedback.kind],
            occurredAt: feedback.occurredAt, reference: feedback.reference, versionId: pin.editorVersionId, versionNumber: pin.editorVersionNumber,
            note: pin.ruleSnapshotStatus === "legacy_missing" ? "原任务缺少规则快照，保持历史状态" : `原规则快照 ${pin.ruleSnapshotChecksum}` });
          if (["rejected", "rework"].includes(feedback.kind)) {
            rework.push({ id: feedback.id, lineId: line.id, source: "factory", kind: feedback.kind, occurredAt: feedback.occurredAt,
              reference: feedback.reference, reason: feedback.note, originalProductionOrderId: pin.productionOrderId,
              replacementProductionOrderId: feedback.replacementProductionOrderId, originalVersionId: pin.editorVersionId, originalVersionNumber: pin.editorVersionNumber,
              replacementVersionId: feedback.replacementEditorVersionId, replacementVersionNumber: feedback.replacementEditorVersionNumber, affectedQuantity: feedback.affectedQuantity });
            const latestCost = item.feedback.filter(event => ["rejected", "rework"].includes(event.kind)).at(-1);
            const reference = `production-feedback:${feedback.id}`;
            costs.push({ id: feedback.id, lineId: line.id, source: "factory", current: latestCost?.id === feedback.id, basis: feedback.cost?.basis ?? "unknown",
              amountMinor: feedback.cost?.amountMinor ?? null, amountUsd: null, currency: feedback.cost?.currency ?? null,
              reference, ledgerFactIds: matchedFacts(reference, ["production_cost"], feedback.cost?.amountMinor ?? null, feedback.cost?.currency ?? null),
              note: `${feedback.cost?.basis === "quote" ? "返工报价，尚未确认费用" : "工厂返工费用证据，独立于财务账本"}；工厂凭证 ${feedback.cost?.reference ?? "待提供"}` });
          }
        }
      }
      const ownRecoveries = (recovery.data?.rows ?? []).filter(record => ownProduction.some(production => production.productionOrder.id === record.originalProductionOrderId));
      for (const record of ownRecoveries) {
        const original = ownProduction.find(production => production.productionOrder.id === record.originalProductionOrderId);
        const replacement = ownProduction.find(production => production.productionOrder.idempotencyKey === `remake:${record.id}`);
        const originalVersion = original?.versions.find(version => version.versionNumber === original.productionOrder.currentVersionNumber);
        const replacementVersion = replacement?.versions.find(version => version.versionNumber === replacement.productionOrder.currentVersionNumber);
        rework.push({ id: record.id, lineId: line.id, source: "recovery", kind: record.type, occurredAt: record.openedAt.toISOString(),
          reference: record.status, reason: `生产恢复记录：${record.status}；原因以原回执及恢复记录为准`,
          originalProductionOrderId: record.originalProductionOrderId, replacementProductionOrderId: replacement?.productionOrder.id ?? null,
          originalVersionId: originalVersion?.sourceEditorVersionId ?? null, originalVersionNumber: null,
          replacementVersionId: replacementVersion?.sourceEditorVersionId ?? null, replacementVersionNumber: null,
          affectedQuantity: replacementVersion?.quantity ?? null });
      }
      const handed = new Map<string, { at: string | null; quantity: number }>();
      for (const record of shipments.data ?? []) for (const allocation of record.packageLines.filter(row => row.orderLineId === line.id)) {
        const event = packetEvents.get(allocation.packageId);
        if (event && !handed.has(allocation.packageId)) {
          handed.set(allocation.packageId, { at: event.pickup ? event.at : null, quantity: allocation.quantity });
          events.push({ id: event.eventId, stage: "handover", label: event.pickup ? "实际交运" : "物流已推进，交运时间待核对", occurredAt: event.at,
            reference: `shipment-package:${allocation.packageId}`, versionId: null, versionNumber: null, note: `${allocation.quantity} 件` });
        }
      }
      // Sum quantities along the physical timeline; a label or partial package never completes a line.
      const handovers = [...handed.values()].filter((row): row is { at: string; quantity: number } => row.at !== null)
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const total = [...handed.values()].reduce((sum, row) => sum + row.quantity, 0), missingPickup = [...handed.values()].some(row => row.at === null);
      let knownQuantity = 0, handedOverAt: string | null = null;
      for (const event of handovers) { knownQuantity += event.quantity; if (!handedOverAt && knownQuantity >= line.quantity) handedOverAt = event.at; }
      const first = (action: string) => ownWork.find(event => event.action === action)?.occurredAt ?? null;
      const acceptedAt = events.filter(event => event.stage === "factory" && event.label === "工厂接受文件").map(event => event.occurredAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
      const completedAt = events.filter(event => event.label === "完工").map(event => event.occurredAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
      const blockers = [...diagnostics, ...(missingPickup && !handedOverAt ? ["物流已推进，但缺少实际揽收时间，准时情况待核对"] : []),
        ...(order.sideState === "cancelled" ? ["已作废订单不纳入准时交运比例"] : []),
        ...(line.basisStatus !== "pinned" ? [line.basisStatus === "expired" ? "私有制作依据已到期" : "未固定制作版本，规格与配方待确认"] : [])];
      const deadline = reviewDeadline(shipments.error ? null : line.shipByAt, handedOverAt, Math.min(total, line.quantity), builtAt);
      if (order.sideState === "cancelled" || missingPickup && !handedOverAt) { deadline.status = "unknown"; deadline.lateMinutes = null; }
      return { id: line.id, skuCode: line.skuCode, title: line.title, quantity: line.quantity, skuId: line.skuId,
        recipeVersionId: line.recipeVersionId, recipeVersionNumber: line.recipeVersionNumber, specification: line.specification,
        specificationVersionId: line.specificationVersionId,
        specificationVersionNumber: line.specificationVersionNumber,
        profileVersionId: line.profileVersionId, basisStatus: line.basisStatus,
        factoryId: activeFactories.length === 1 ? activeFactories[0]!.factoryId : null,
        factoryName: activeFactories.length === 1 ? activeFactories[0]!.factoryProfile.name : null,
        factoryStatus: production.error ? "unknown" as const : activeFactories.length === 1 ? "pinned" as const : activeFactories.length > 1 ? "multiple" as const : "missing" as const,
        events: events.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id)),
        durations: [reviewDuration("承接至派发", line.createdAt, first("push"), builtAt),
          reviewDuration("派发至提交审核", first("push"), first("submit_artwork"), builtAt),
          reviewDuration("提交至首次审核通过", first("submit_artwork"), first("approve_artwork"), builtAt),
          reviewDuration("审核至工厂接受", first("approve_artwork"), acceptedAt, builtAt),
          reviewDuration("工厂接受至首次完工", acceptedAt, completedAt, builtAt),
          reviewDuration("首次完工至全量交运", completedAt, handedOverAt, builtAt)],
        deadline,
        reviewRejections: source.historyTruncated ? null : ownWork.filter(event => ["reject_artwork", "reject_proof"].includes(event.action)).length,
        factoryRejections: delivery.error || delivery.data?.truncated ? null : rework.filter(record => record.lineId === line.id && record.source === "factory" && record.kind === "rejected").length,
        remakeCount: production.error ? null : ownProduction.filter(record => record.productionOrder.source === "remake").length,
        remakeQuantity: production.error ? null : ownProduction.filter(record => record.productionOrder.source === "remake").reduce((sum, record) => sum + (record.versions.find(version => version.versionNumber === record.productionOrder.currentVersionNumber)?.quantity ?? 0), 0),
        blockers };
    });
    const costBlockers = costs.filter(cost => cost.current && cost.basis !== "not_required" && (cost.basis !== "confirmed" || !cost.ledgerFactIds.length))
      .map(cost => `${({ model: "模型", factory: "返工", refund: "退款", shipment: "运单" })[cost.source]}费用${cost.basis === "unknown" ? "未知" : cost.basis === "quote" ? "仍为报价" : "尚未与入账证据匹配"}（${cost.id.slice(-8)}）`);
    const profit = orderReviewProfit(orderId, lines, finance, [...diagnostics, ...costBlockers]);
    return OrderReviewViewSchema.parse({ orderId, externalOrderId: order.externalOrderId, placedAt: order.placedAt, builtAt,
      lines, facts, costs, profit, rework, diagnostics });
  }
}
