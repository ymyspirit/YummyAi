import { isFinanceProfitVerified, type FinanceFactView } from "@yummyai/contracts/finance";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { createHash } from "node:crypto";
import type { OrderReviewLine, OrderReviewView, OrderSkuReview } from "@yummyai/contracts/order/review";
import type { OrderFinanceEvidence } from "../finance/finance.service.js";

export function effectiveOrderFacts(facts: FinanceFactView[]) {
  const reversed = new Set(facts.filter(fact => fact.correctionKind === "reversal").map(fact => fact.correctsFactId));
  return facts.filter(fact => fact.correctionKind !== "reversal" && !reversed.has(fact.id));
}

/** Reuse a pinned calculation only when it still includes every booked fact. */
export function orderReviewProfit(
  orderId: string, lines: Array<Pick<OrderReviewLine, "id" | "skuId">>, evidence: OrderFinanceEvidence | null,
  operationalBlockers: string[],
): OrderReviewView["profit"] {
  const allocation = evidence?.allocationCalculations?.find(entry => ["order", "order_line"].includes(entry.run.dimension)
    && entry.slices.some(slice => slice.target?.orderId === orderId));
  if (allocation) return allocatedOrderReviewProfit(orderId, lines, evidence!, allocation, operationalBlockers);
  const selected = evidence?.calculations.find(entry => entry.run.contributions.some(row => row.orderId === orderId));
  const run = selected?.run;
  const blockers = [...operationalBlockers];
  if (!evidence) blockers.push("财务证据无法读取或无读取权限");
  if (evidence?.truncated) blockers.push("财务证据超过读取上限，请缩小期间");
  if (!run || !selected) blockers.push("尚无关联本单的利润计算，请在财务口径下补齐费用并计算");
  const facts = evidence?.facts.filter(fact => fact.orderId === orderId) ?? [];
  const contributions = run?.contributions.filter(row => row.orderId === orderId) ?? [];
  if (run && selected) {
    if (!isFinanceProfitVerified(run) || !["order", "order_line"].includes(run.diagnostics.coverage?.dimension ?? ""))
      blockers.push("关联计算未通过逐单完整性核验（缺费用、汇率、归属或分类）");
    const required = ["sale_revenue", "production_cost", "carrier_cost", "marketplace_commission"] as const;
    if (required.some(type => !selected.metric.requiredFactTypes.includes(type))) blockers.push("所选口径须逐单要求收入、生产、运费和平台佣金；已知免收也须有零金额证据");
    const currentIds = new Set(facts.map(fact => fact.id));
    const calculatedIds = new Set(contributions.map(row => row.factId));
    if (currentIds.size !== calculatedIds.size || [...currentIds].some(id => !calculatedIds.has(id)))
      blockers.push("计算后本单费用已补录或更正，旧利润不能代表现有账本，请重新计算");
    if (contributions.some(row => row.reportingAmountMinor === null || row.bucket === "unclassified")) blockers.push("本单含未换算或未分类金额");
  }
  const sum = (bucket: "revenue" | "cost", entries = contributions) => safeMinor(entries.filter(row => row.bucket === bucket)
    .reduce((total, row) => total + BigInt(row.effectSign) * BigInt(row.reportingAmountMinor ?? 0), 0n));
  const revenueMinor = sum("revenue"), costMinor = sum("cost");
  const profitMinor = revenueMinor !== null && costMinor !== null ? safeMinor(BigInt(revenueMinor) - BigInt(costMinor)) : null;
  if ([revenueMinor, costMinor, profitMinor].includes(null)) blockers.push("本单金额超过安全计算范围");
  const verified = !!run && !blockers.length;
  // Order-level costs never get spread across SKU lines by quantity or guesswork.
  const allocated = verified && contributions.length > 0 && contributions.every(row => row.orderLineId
    && lines.some(line => line.id === row.orderLineId && line.skuId && line.skuId === row.skuId));
  const lineProfits = allocated ? lines.flatMap(line => {
    const entries = contributions.filter(row => row.orderLineId === line.id);
    const present = new Set(effectiveOrderFacts(facts).filter(fact => fact.orderLineId === line.id).map(fact => fact.factType));
    if (!entries.length || selected!.metric.requiredFactTypes.some(type => !present.has(type))) return [];
    const revenueMinor = sum("revenue", entries), costMinor = sum("cost", entries);
    const profitMinor = revenueMinor !== null && costMinor !== null ? safeMinor(BigInt(revenueMinor) - BigInt(costMinor)) : null;
    return revenueMinor === null || costMinor === null || profitMinor === null ? [] : [{ lineId: line.id, revenueMinor, costMinor, profitMinor }];
  }) : [];
  return { status: !evidence ? "unavailable" : verified ? "verified" : "incomplete",
    runId: run?.id ?? null, metricVersionId: run?.metricVersionId ?? null, metricVersion: run?.metricVersion ?? null,
    allocationRunId: null, allocationVersionSetChecksum: null, allocationDimension: null,
    calculatedAt: run?.calculatedAt ?? null, currency: run?.reportingCurrency ?? null,
    revenueMinor: verified ? revenueMinor : null, costMinor: verified ? costMinor : null, profitMinor: verified ? profitMinor : null,
    blockers: [...new Set(blockers)], lines: lineProfits };
}

function safeMinor(value: bigint): number | null {
  return value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
}

function allocatedOrderReviewProfit(orderId: string, lines: Array<Pick<OrderReviewLine, "id" | "skuId">>,
  evidence: OrderFinanceEvidence, selected: NonNullable<OrderFinanceEvidence["allocationCalculations"]>[number], operationalBlockers: string[]): OrderReviewView["profit"] {
  const { run, baseRun, metric } = selected, blockers = [...operationalBlockers];
  if (evidence.truncated) blockers.push("财务证据超过读取上限，请缩小期间");
  if (!isFinanceProfitVerified(baseRun) || baseRun.diagnostics.coverage?.dimension !== "aggregate" || run.baseRunId !== baseRun.id
    || run.baseInputChecksum !== baseRun.inputChecksum || run.status !== "complete")
    blockers.push("关联分摊尚未通过原汇总及逐目标完整性核验");
  if (run.basisProblems.length) blockers.push("分摊的来源、目标关系或规则版本已变化，请按当前依据明确重新计算");
  const required = ["sale_revenue", "production_cost", "carrier_cost", "marketplace_commission"] as const;
  if (required.some(type => !metric.requiredFactTypes.includes(type)))
    blockers.push("所选口径须逐单要求收入、生产、运费和平台佣金；已知免收也须有零金额证据");
  const currentIds = new Set(evidence.facts.filter(fact => fact.orderId === orderId).map(fact => fact.id));
  const calculatedIds = new Set(baseRun.contributions.filter(row => row.orderId === orderId).map(row => row.factId));
  if (currentIds.size !== calculatedIds.size || [...currentIds].some(id => !calculatedIds.has(id)))
    blockers.push("计算后本单费用已补录或更正，旧利润不能代表现有账本，请重新计算");
  const slices = selected.slices.filter(slice => slice.target?.orderId === orderId);
  if (!slices.length || slices.some(slice => slice.bucket === "unclassified")) blockers.push("本单归属金额未完整分类");
  const sum = (bucket: "revenue" | "cost", rows = slices) => safeMinor(rows.filter(row => row.bucket === bucket)
    .reduce((total, row) => total + BigInt(row.amountMinor) * BigInt(row.effectSign), 0n));
  const revenueMinor = sum("revenue"), costMinor = sum("cost");
  const profitMinor = revenueMinor !== null && costMinor !== null ? safeMinor(BigInt(revenueMinor) - BigInt(costMinor)) : null;
  if ([revenueMinor, costMinor, profitMinor].includes(null)) blockers.push("本单金额超过安全计算范围");
  const verified = blockers.length === 0;
  const lineAttribution = verified && run.dimension === "order_line" && slices.every(slice => slice.target?.orderLineId
    && lines.some(line => line.id === slice.target!.orderLineId && line.skuId && line.skuId === slice.target!.skuId));
  const effectiveIds = new Set(effectiveOrderFacts(selected.sourceFacts).map(fact => fact.id));
  const lineProfits = lineAttribution ? lines.flatMap(line => {
    const rows = slices.filter(slice => slice.target?.orderLineId === line.id);
    const present = new Set(rows.filter(slice => effectiveIds.has(slice.sourceFactId)).map(slice => slice.factType));
    if (!rows.length || metric.requiredFactTypes.some(type => !present.has(type))) return [];
    const revenueMinor = sum("revenue", rows), costMinor = sum("cost", rows);
    const profitMinor = revenueMinor !== null && costMinor !== null ? safeMinor(BigInt(revenueMinor) - BigInt(costMinor)) : null;
    return revenueMinor === null || costMinor === null || profitMinor === null ? [] : [{ lineId: line.id, revenueMinor, costMinor, profitMinor }];
  }) : [];
  return { status: verified ? "verified" : "incomplete", runId: baseRun.id, metricVersionId: baseRun.metricVersionId, metricVersion: baseRun.metricVersion,
    allocationRunId: run.id, allocationDimension: run.dimension,
    allocationVersionSetChecksum: createHash("sha256").update(canonicalJson({ dimension: run.dimension, versionPins: run.versionPins })).digest("hex"),
    calculatedAt: run.createdAt, currency: run.reportingCurrency, revenueMinor: verified ? revenueMinor : null,
    costMinor: verified ? costMinor : null, profitMinor: verified ? profitMinor : null, blockers: [...new Set(blockers)], lines: lineProfits };
}

export function reviewDuration(label: string, from: string | null, to: string | null, now: string): OrderReviewLine["durations"][number] {
  if (!from) return { label, from, to, minutes: null, status: "unknown" };
  const end = to ?? now, elapsed = (Date.parse(end) - Date.parse(from)) / 60000;
  if (!Number.isFinite(elapsed) || elapsed < 0 || Date.parse(end) > Date.parse(now))
    return { label, from, to, minutes: null, status: "invalid" };
  return { label, from, to, minutes: elapsed, status: to ? "complete" : "pending" };
}

export function reviewDeadline(shipByAt: string | null, handedOverAt: string | null, quantity: number, now: string): OrderReviewLine["deadline"] {
  const lateMinutes = shipByAt ? Math.max(0, (Date.parse(handedOverAt ?? now) - Date.parse(shipByAt)) / 60000) : null;
  return { shipByAt, handedOverAt, handedOverQuantity: quantity, lateMinutes,
    status: !shipByAt ? "unknown" : handedOverAt ? (Date.parse(handedOverAt) <= Date.parse(shipByAt) ? "on_time" : "late") : Date.parse(now) > Date.parse(shipByAt) ? "overdue" : "pending" };
}

export function summarizeOrderReview(orders: OrderReviewView[]): OrderSkuReview[] {
  const groups = new Map<string, { value: OrderSkuReview; orders: Set<string> }>();
  const amounts = new Map<OrderSkuReview["profitTotals"][number], { revenue: bigint; cost: bigint; profit: bigint }>();
  const sumKnown = (left: number | null, right: number | null) => left === null || right === null ? null : left + right;
  for (const order of orders) for (const line of order.lines) {
    const key = JSON.stringify([line.skuId ?? line.skuCode, line.recipeVersionId, line.specificationVersionId, line.specification,
      line.profileVersionId, line.factoryId, line.factoryStatus]);
    if (!groups.has(key)) groups.set(key, { orders: new Set(), value: {
      skuCode: line.skuCode, skuId: line.skuId, recipeVersionId: line.recipeVersionId, recipeVersionNumber: line.recipeVersionNumber,
      specification: line.specification, specificationVersionId: line.specificationVersionId,
      specificationVersionNumber: line.specificationVersionNumber, profileVersionId: line.profileVersionId,
      factoryId: line.factoryId, factoryName: line.factoryName, factoryStatus: line.factoryStatus,
      orderCount: 0, lineCount: 0, quantity: 0, onTime: 0, late: 0, overdue: 0, pending: 0, unknownDeadline: 0, onTimeBps: null,
      reviewRejections: 0, factoryRejections: 0, remakeLineCount: 0, remakeCount: 0, remakeQuantity: 0, remakeBps: null,
      verifiedProfitLines: 0, unallocatedProfitLines: 0, profitTotals: [],
    } });
    const entry = groups.get(key)!, value = entry.value;
    entry.orders.add(order.orderId); value.lineCount++; value.quantity += line.quantity;
    value.reviewRejections = sumKnown(value.reviewRejections, line.reviewRejections);
    value.factoryRejections = sumKnown(value.factoryRejections, line.factoryRejections);
    value.remakeCount = sumKnown(value.remakeCount, line.remakeCount); value.remakeQuantity = sumKnown(value.remakeQuantity, line.remakeQuantity);
    value.remakeLineCount = sumKnown(value.remakeLineCount, line.remakeCount === null ? null : line.remakeCount > 0 ? 1 : 0);
    const deadlineField = ({ on_time: "onTime", late: "late", overdue: "overdue", pending: "pending", unknown: "unknownDeadline" })[line.deadline.status] as "onTime" | "late" | "overdue" | "pending" | "unknownDeadline";
    value[deadlineField]++;
    const profit = order.profit.status === "verified" ? order.profit.lines.find(row => row.lineId === line.id) : null;
    if (profit && order.profit.currency && order.profit.metricVersionId && order.profit.metricVersion && !["multiple", "unknown"].includes(line.factoryStatus)) {
      value.verifiedProfitLines++;
      let total = value.profitTotals.find(row => row.currency === order.profit.currency && row.metricVersionId === order.profit.metricVersionId
        && (row.allocationVersionSetChecksum ?? null) === (order.profit.allocationVersionSetChecksum ?? null)
        && (row.allocationDimension ?? null) === (order.profit.allocationDimension ?? null));
      if (!total) { total = { currency: order.profit.currency, metricVersionId: order.profit.metricVersionId, metricVersion: order.profit.metricVersion,
        allocationVersionSetChecksum: order.profit.allocationVersionSetChecksum ?? null, allocationDimension: order.profit.allocationDimension ?? null,
        revenueMinor: 0, costMinor: 0, profitMinor: 0, lineCount: 0 }; value.profitTotals.push(total); }
      const sum = amounts.get(total) ?? { revenue: 0n, cost: 0n, profit: 0n };
      sum.revenue += BigInt(profit.revenueMinor); sum.cost += BigInt(profit.costMinor); sum.profit += BigInt(profit.profitMinor);
      amounts.set(total, sum); total.lineCount++;
    } else value.unallocatedProfitLines++;
  }
  return [...groups.values()].map(({ value, orders }) => {
    value.profitTotals = value.profitTotals.filter(total => {
      const sum = amounts.get(total)!;
      const revenue = safeMinor(sum.revenue), cost = safeMinor(sum.cost), profit = safeMinor(sum.profit);
      if (revenue === null || cost === null || profit === null) { value.verifiedProfitLines -= total.lineCount; value.unallocatedProfitLines += total.lineCount; return false; }
      total.revenueMinor = revenue; total.costMinor = cost; total.profitMinor = profit; return true;
    });
    return { ...value, orderCount: orders.size,
    onTimeBps: value.onTime + value.late ? Math.round(value.onTime * 10000 / (value.onTime + value.late)) : null,
    remakeBps: value.lineCount && value.remakeLineCount !== null ? Math.round(value.remakeLineCount * 10000 / value.lineCount) : null,
    };
  }).sort((left, right) => (left.skuCode ?? "").localeCompare(right.skuCode ?? "") || (left.recipeVersionId ?? "").localeCompare(right.recipeVersionId ?? ""));
}
