import {
  AdAnalysisResultSchema,
  normalizeAdTerm,
  type AdActionView,
  type AdAnalysisInput,
  type AdAnalysisResult,
  type AdDiagnostic,
  type AdGoalVersion,
  type AdMetrics,
  type AdObservation,
  type AdProductScope,
  type AdRecommendation,
  type AdStoredFact,
  type AdConversionBasis,
  type AdCurrencyBasis,
} from "@yummyai/contracts/advertising";
import { adHash, stableAdJson } from "./ad-csv-parser.js";

type Dated = AdStoredFact & {
  fact: AdStoredFact["fact"] & { periodStart: string; periodEnd: string };
};
const metricKeys = ["impressions", "clicks", "purchases", "spendMinor", "salesMinor"] as const;
export function adScopeKey(scope: AdProductScope): string {
  return stableAdJson(scope);
}
export function adDay(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  return ["year", "month", "day"]
    .map((key) => parts.find((part) => part.type === key)!.value)
    .join("-");
}
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
function elapsedDays(a: string, b: string): number {
  return Math.floor((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}
function ratio(n: number | null, d: number | null, scale: number): number | null {
  if (n === null || d === null || d === 0) return null;
  const result = (BigInt(n) * BigInt(scale) + BigInt(d) / 2n) / BigInt(d);
  return result > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(result);
}
export function adCpcAllowance(
  salesMinor: number,
  clicks: number,
  targetAcosBps: number,
): number | null {
  if (!clicks) return null;
  const denominator = BigInt(clicks) * 10000n;
  const result = (BigInt(salesMinor) * BigInt(targetAcosBps) + denominator / 2n) / denominator;
  return result > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(result);
}
export function adRatios(m: AdMetrics, conversion?: AdConversionBasis) {
  return {
    ctrBps:
      m.clicks !== null && m.impressions !== null && m.clicks <= m.impressions
        ? ratio(m.clicks, m.impressions, 10000)
        : null,
    cvrBps:
      conversion?.state === "resolved" && conversion.model === "click" &&
      m.purchases !== null && m.clicks !== null && m.purchases <= m.clicks
        ? ratio(m.purchases, m.clicks, 10000)
        : null,
    acosBps: ratio(m.spendMinor, m.salesMinor, 10000),
    roasBps: ratio(m.salesMinor, m.spendMinor, 10000),
    cpcMinor: ratio(m.spendMinor, m.clicks, 1),
  };
}
export function sumAdMetrics(rows: AdMetrics[]): AdMetrics {
  const result: AdMetrics = {
    impressions: null,
    clicks: null,
    purchases: null,
    spendMinor: null,
    salesMinor: null,
  };
  for (const key of metricKeys) {
    if (!rows.length || rows.some((m) => m[key] === null)) continue;
    const total = rows.reduce((acc, m) => acc + BigInt(m[key]!), 0n);
    if (total <= BigInt(Number.MAX_SAFE_INTEGER)) result[key] = Number(total);
  }
  return result;
}
function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}
function measurementKey(r: AdStoredFact): string {
  const measurement = r.fact.measurement;
  if (!measurement) return stableAdJson(["legacy_unpinned", r.importId, r.timezone, r.attributionWindowDays, r.attributionBasis]);
  return stableAdJson([measurement.adapterVersion, r.timezone, measurement.conversion.state,
    measurement.conversion.model, measurement.conversion.windowDays, measurement.monetaryBasis,
    measurement.conversion.state === "resolved" ? null : r.importId]);
}
function measurementLabel(r: AdStoredFact): string {
  const measurement = r.fact.measurement;
  if (!measurement) return `${r.timezone} · 原口径与精度未保存 · ${r.importId}`;
  const conversion = measurement.conversion;
  return `${r.timezone} · ${conversion.windowDays === null ? "未知" : conversion.windowDays}天 · ${conversion.model} · ${conversion.state}${conversion.state === "resolved" ? "" : ` · ${r.importId}`}`;
}
function cohortEvidence(r: AdStoredFact) {
  return { monetaryBasis: r.fact.measurement?.monetaryBasis ?? null,
    ...(r.fact.measurement ? { conversion: r.fact.measurement.conversion } : {}) };
}
function sameMonetaryBasis(a: AdCurrencyBasis | null | undefined, b: AdCurrencyBasis | null | undefined) {
  return a != null && b != null && a.schemaVersion === b.schemaVersion && a.currency === b.currency
    && a.minorDigits === b.minorDigits && a.currencyTableVersion === b.currencyTableVersion;
}
function clickMeasurement(r: AdStoredFact) {
  const conversion = r.fact.measurement?.conversion;
  return conversion?.state === "resolved" && conversion.model === "click" && conversion.windowDays !== null;
}
function observedMature(r: Dated) {
  const conversion = r.fact.measurement?.conversion;
  // periodEnd includes that entire local day. A date-only interval is mature
  // only after its final attribution day, including a zero-day window.
  return clickMeasurement(r) && conversion?.windowDays !== null && conversion?.windowDays !== undefined
    && elapsedDays(adDay(r.observedAt, r.timezone), r.fact.periodEnd) > conversion.windowDays;
}
function exactDifference(a: number, b: number) {
  const value = BigInt(a) - BigInt(b);
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}
function bidChangeBps(after: number, before: number) {
  const numerator = (BigInt(after) - BigInt(before)) * 10000n, denominator = BigInt(before);
  const absolute = numerator < 0n ? -numerator : numerator, remainder = absolute % denominator;
  // Match Math.round's historical half-toward-positive-infinity display without
  // an intermediate floating point division.
  const increment = numerator < 0n ? remainder * 2n > denominator : remainder * 2n >= denominator;
  const rounded = absolute / denominator + (increment ? 1n : 0n);
  return Number(numerator < 0n ? -rounded : rounded);
}
function objectKey(r: AdRecommendation): string {
  return stableAdJson([
    r.accountId,
    r.currency,
    r.marketplace,
    r.campaignId,
    r.adGroupId,
    r.targetId ?? normalizeAdTerm(r.term ?? ""),
  ]);
}
function evidenceKey(r: AdStoredFact) {
  return adHash([r.importId, r.fact.rowKey]);
}
function scopeOf(r: AdStoredFact): AdProductScope | null {
  const f = r.fact;
  return f.marketplace && f.currency && f.asin
    ? { accountId: r.accountId, marketplace: f.marketplace, currency: f.currency, asin: f.asin }
    : null;
}
export function boundedAdBid(
  current: number,
  ideal: number,
  maxChangeBps: number,
  direction: "lower" | "raise",
): number {
  if (
    !Number.isSafeInteger(current) ||
    current <= 0 ||
    !Number.isSafeInteger(ideal) ||
    ideal < 0 ||
    maxChangeBps < 1 ||
    maxChangeBps > 5000
  )
    throw new Error("Invalid bid bound");
  const value = BigInt(current),
    step = BigInt(maxChangeBps);
  const lower = Number((value * (10000n - step) + 9999n) / 10000n);
  const upperBig = (value * (10000n + step)) / 10000n;
  const upper =
    upperBig > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(upperBig);
  return direction === "lower"
    ? Math.max(1, lower, Math.min(current, ideal))
    : Math.min(upper, Math.max(current, ideal));
}
export function adEconomics(goal: AdGoalVersion) {
  const f = goal.fields;
  const raw =
    f.monetaryBasis?.currency === goal.scope.currency && f.unitPriceMinor !== null && f.unitCostMinor !== null
      ? ((BigInt(f.unitPriceMinor) - BigInt(f.unitCostMinor)) * 10000n) / BigInt(f.unitPriceMinor)
      : null;
  const breakEvenAcosBps =
    raw !== null && raw >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : null;
  const derived =
    breakEvenAcosBps !== null && breakEvenAcosBps > 0
      ? Number((BigInt(breakEvenAcosBps) * (10000n - BigInt(f.profitReserveBps))) / 10000n)
      : null;
  const target =
    f.mode === "rank_growth"
      ? f.targetAcosBps
      : f.targetAcosBps === null
        ? derived
        : raw !== null && raw <= 0n
          ? 0
          : breakEvenAcosBps === null
            ? f.targetAcosBps
            : Math.min(f.targetAcosBps, Math.max(0, breakEvenAcosBps));
  return { breakEvenAcosBps, targetAcosBps: target };
}
export function validAdTransition(
  from: AdActionView["status"],
  to: AdActionView["status"],
): boolean {
  const transitions: Record<AdActionView["status"], AdActionView["status"][]> = {
    pending: ["adopted", "rejected", "deferred", "stale"],
    adopted: ["executed", "rejected", "deferred", "stale"],
    executed: ["observing"],
    observing: ["reviewed"],
    reviewed: [],
    rejected: [],
    deferred: ["pending", "rejected", "stale"],
    stale: [],
  };
  return transitions[from].includes(to);
}

export function analyzeAdvertising(options: {
  input: AdAnalysisInput;
  facts: AdStoredFact[];
  goals: AdGoalVersion[];
  observations?: AdObservation[];
  actions?: AdActionView[];
}): AdAnalysisResult {
  const { input } = options,
    diagnostics: AdDiagnostic[] = [],
    recommendations: AdRecommendation[] = [];
  const diagnose = (
    code: string,
    message: string,
    severity: AdDiagnostic["severity"] = "warning",
  ) => diagnostics.push({ code, message, severity, row: null, column: null });
  const overflowMetrics = new Set<string>();
  const sum = (values: AdMetrics[]) => {
    const total = sumAdMetrics(values);
    for (const key of metricKeys)
      if (values.length && total[key] === null && values.every(value => value[key] !== null)) overflowMetrics.add(key);
    return total;
  };
  const eligible: Dated[] = [];
  let undated = 0,
    crossing = 0;
  for (const r of options.facts) {
    const f = r.fact;
    if (
      r.accountId !== input.accountId ||
      r.observedAt > input.evidenceCutoffAt ||
      r.recordedAt > input.evidenceCutoffAt ||
      r.sourceArchivedAt != null && r.sourceArchivedAt <= input.evidenceCutoffAt
    )
      continue;
    if (
      (input.marketplace && f.marketplace !== input.marketplace) ||
      (input.currency && f.currency !== input.currency)
    )
      continue;
    if (!f.periodStart || !f.periodEnd) {
      undated++;
      continue;
    }
    if (f.periodEnd < input.periodStart || f.periodStart > input.periodEnd) continue;
    if (f.periodStart < input.periodStart || f.periodEnd > input.periodEnd) {
      crossing++;
      continue;
    }
    if (f.periodEnd > adDay(r.observedAt, r.timezone)) {
      diagnose("OBSERVED_BEFORE_PERIOD", "部分证据的采集日期早于统计结束日期，已排除");
      continue;
    }
    eligible.push({ ...r, fact: { ...f } } as Dated);
  }
  if (undated) diagnose("UNDATED_EVIDENCE", `${undated} 行无日期来源已保留，不参与本次分析`);
  if (crossing)
    diagnose(
      "INTERVAL_CROSSES_WINDOW",
      `${crossing} 行区间超出所选窗口，不能按比例截取，请改用日报或选择完整窗口`,
    );
  const selected: Dated[] = [];
  let superseded = 0,
    overlaps = 0;
  for (const rows of groupBy(eligible, (r) =>
    stableAdJson([r.accountId, r.fact.entityKey, measurementKey(r)]),
  ).values()) {
    const accepted: Dated[] = [];
    rows.sort(
      (a, b) =>
        b.observedAt.localeCompare(a.observedAt) ||
        b.recordedAt.localeCompare(a.recordedAt) ||
        b.id.localeCompare(a.id),
    );
    for (const row of rows) {
      const overlapping = accepted.find(
        (other) =>
          row.fact.periodStart <= other.fact.periodEnd &&
          row.fact.periodEnd >= other.fact.periodStart,
      );
      if (overlapping) {
        superseded++;
        if (
          row.fact.periodStart !== overlapping.fact.periodStart ||
          row.fact.periodEnd !== overlapping.fact.periodEnd
        )
          overlaps++;
      } else accepted.push(row);
    }
    selected.push(...accepted);
  }
  if (overlaps)
    diagnose(
      "OVERLAPPING_INTERVALS",
      `${overlaps} 行与较新版本区间重叠；使用较新观察，未把重叠花费重复累加`,
    );
  const legacyCount = selected.filter(row => !row.fact.measurement).length;
  const unresolvedCount = selected.filter(row => row.fact.measurement && row.fact.measurement.conversion.state !== "resolved").length;
  const archivedCount = selected.filter(row => row.sourceArchivedAt != null).length;
  const unknownPrecisionCount = selected.filter(row => row.fact.measurement && row.fact.currency && !row.fact.measurement.monetaryBasis).length;
  if (legacyCount) diagnose("LEGACY_MEASUREMENT_UNPINNED", `${legacyCount} 行保留原存储数值；原适配版本、转化定义及币种精度未保存，不补今天的依据或生成转化操作；ACoS和ROAS仅按原数值展示，不证明跨口径可比或盈利`);
  if (unresolvedCount) diagnose("CONVERSION_MEASUREMENT_UNRESOLVED", `${unresolvedCount} 行的转化列、模型或窗口未核对或存在冲突；原值保留，点击转化率和转化操作不可用；ACoS和ROAS仅按原数值展示，不证明跨口径可比或盈利`);
  if (archivedCount) diagnose("SOURCE_ARCHIVED_NOW", `${archivedCount} 行在本次历史截止时仍有效，但来源现已归档；保留历史展示，仅可观察，不能生成新操作`);
  if (unknownPrecisionCount) diagnose("CURRENCY_PRECISION_UNKNOWN", `${unknownPrecisionCount} 行没有可核对的固定币种精度；金额未转换，不能作确定利润或预算判断`);
  // Pin source facts before the existing, uniquely supported Campaign join
  // enriches local display dimensions. Inferred currency is not source evidence.
  const pins = new Map<string, NonNullable<AdAnalysisResult["measurementPins"]>[number]>();
  for (const row of selected) {
    const key = stableAdJson([row.importId, row.fact.currency]);
    if (!pins.has(key)) pins.set(key, {
      importId: row.importId, currency: row.fact.currency, sourceChecksum: row.sourceChecksum ?? null,
      observedAt: row.observedAt, timezone: row.timezone, declaredWindowDays: row.attributionWindowDays,
      declaredBasis: row.attributionBasis, sourceArchivedAt: row.sourceArchivedAt ?? null,
      measurement: row.fact.measurement ?? null,
    });
  }
  const campaignSources = groupBy(
    selected.filter((r) => r.fact.reportType === "campaign" && r.fact.campaignId),
    (r) => stableAdJson([r.accountId, r.fact.advertiserId, r.fact.campaignId]),
  );
  for (const r of selected) {
    if (r.fact.reportType === "campaign" || !r.fact.campaignId) continue;
    const candidates = (
      campaignSources.get(stableAdJson([r.accountId, r.fact.advertiserId, r.fact.campaignId])) ?? []
    ).filter(
      (c) =>
        (!r.fact.currency || c.fact.currency === r.fact.currency) &&
        (!r.fact.marketplace || c.fact.marketplace === r.fact.marketplace),
    );
    const products = new Set(candidates.map((c) => c.fact.adProduct).filter(Boolean));
    const markets = new Set(candidates.map((c) => c.fact.marketplace).filter(Boolean));
    const currencies = new Set(candidates.map((c) => c.fact.currency).filter(Boolean));
    r.fact = {
      ...r.fact,
      adProduct: r.fact.adProduct ?? (products.size === 1 ? [...products][0]! : null),
      marketplace: r.fact.marketplace ?? (markets.size === 1 ? [...markets][0]! : null),
      currency: r.fact.currency ?? (currencies.size === 1 ? [...currencies][0]! : null),
    };
  }
  const controlType = selected.some((r) => r.fact.reportType === "campaign")
    ? "campaign"
    : selected.some((r) => r.fact.reportType === "advertised_product")
      ? "advertised_product"
      : null;
  if (controlType !== "campaign")
    diagnose(
      "CAMPAIGN_CONTROL_MISSING",
      "未找到 Campaign 控制表，产品报表只作为当前可用口径，其他明细不会加到总花费中",
    );
  const controlRows = selected.filter((r) => r.fact.reportType === controlType && r.fact.currency);
  const totals = [
    ...groupBy(controlRows, (r) =>
      stableAdJson([
        r.fact.currency,
        r.fact.marketplace,
        r.fact.advertiserId,
        r.fact.adProduct,
        measurementKey(r),
      ]),
    ).values(),
  ].map((rows) => {
    const row = rows[0]!,
      metrics = sum(rows.map((r) => r.fact.metrics));
    return {
      currency: row.fact.currency!,
      marketplace: row.fact.marketplace,
      advertiserId: row.fact.advertiserId,
      adProduct: row.fact.adProduct,
      measurementScope: measurementLabel(row),
      ...cohortEvidence(row),
      metrics,
      ratios: adRatios(metrics, row.fact.measurement?.conversion),
    };
  });
  let mismatches = 0;
  for (const control of groupBy(controlRows, (r) =>
    stableAdJson([
      r.fact.campaignId,
      r.fact.currency,
      r.fact.marketplace,
      r.fact.advertiserId,
      measurementKey(r),
    ]),
  ).values()) {
    const first = control[0]!;
    for (const type of ["advertised_product", "targeting", "search_term", "placement"]) {
      const detail = selected.filter(
        (r) =>
          r.fact.reportType === type &&
          r.fact.campaignId === first.fact.campaignId &&
          r.fact.currency === first.fact.currency &&
          r.fact.marketplace === first.fact.marketplace &&
          r.fact.advertiserId === first.fact.advertiserId &&
          measurementKey(r) === measurementKey(first),
      );
      const ranges = (rows: Dated[]) =>
        stableAdJson(
          [...new Set(rows.map((r) => `${r.fact.periodStart}/${r.fact.periodEnd}`))].sort(),
        );
      if (!detail.length || ranges(control) !== ranges(detail)) continue;
      const a = sum(control.map((r) => r.fact.metrics)),
        b = sum(detail.map((r) => r.fact.metrics));
      if (metricKeys.some((key) => a[key] !== null && b[key] !== null && a[key] !== b[key]))
        mismatches++;
    }
  }
  if (mismatches)
    diagnose(
      "BREAKDOWN_RECONCILIATION",
      `${mismatches} 组同口径、同活动、同日期的明细与控制表不同；请核查报表覆盖与归因更新，明细未重复加到总计`,
    );
  const observations = (options.observations ?? []).filter(
    (o) =>
      o.scope.accountId === input.accountId &&
      o.observedAt <= input.evidenceCutoffAt &&
      o.createdAt <= input.evidenceCutoffAt,
  );
  const availableGoals = groupBy(
    [...options.goals]
      .filter((g) => g.scope.accountId === input.accountId && g.createdAt <= input.evidenceCutoffAt)
      .sort(
        (a, b) =>
          a.fields.effectiveFrom.localeCompare(b.fields.effectiveFrom) || a.revision - b.revision,
      ),
    (g) => adScopeKey(g.scope),
  );
  const activeGoal = (scope: AdProductScope, timezone: string) =>
    (availableGoals.get(adScopeKey(scope)) ?? [])
      .filter((g) => g.fields.effectiveFrom <= adDay(input.evidenceCutoffAt, timezone))
      .at(-1) ?? null;
  const productRows = selected.filter(
    (r) => r.fact.reportType === "advertised_product" && scopeOf(r),
  );
  const products = [
    ...groupBy(productRows, (r) =>
      stableAdJson([scopeOf(r), r.fact.advertiserId, measurementKey(r)]),
    ).values(),
  ].map((rows) => {
    const first = rows[0]!,
      scope = scopeOf(first)!,
      key = adHash([scope, first.fact.advertiserId, measurementKey(first)]),
      goal = activeGoal(scope, first.timezone);
    const metrics = sum(rows.map((r) => r.fact.metrics)),
      goalMoneyKnown = goal && sameMonetaryBasis(goal.fields.monetaryBasis, first.fact.measurement?.monetaryBasis),
      economics = goal && goalMoneyKnown ? adEconomics(goal) : null;
    const periodStart = rows.map((r) => r.fact.periodStart).sort()[0]!,
      periodEnd = rows
        .map((r) => r.fact.periodEnd)
        .sort()
        .at(-1)!;
    const matchingObservations = observations.filter(
      (o) => adScopeKey(o.scope) === adScopeKey(scope),
    );
    const ambiguousCommerce =
      new Set(
        productRows
          .filter((r) => adScopeKey(scopeOf(r)!) === adScopeKey(scope))
          .map((r) => stableAdJson([r.fact.advertiserId, measurementKey(r)])),
      ).size > 1;
    const commerce = ambiguousCommerce
      ? undefined
      : matchingObservations
          .filter(
            (o) =>
              o.kind === "commerce" &&
              o.adsCoverageConfirmed &&
              o.periodStart === periodStart &&
              o.periodEnd === periodEnd,
          )
          .sort(
            (a, b) =>
              b.observedAt.localeCompare(a.observedAt) || b.createdAt.localeCompare(a.createdAt),
          )[0];
    const qualityCodes = [...new Set(rows.flatMap((r) => r.fact.qualityCodes))];
    if (!goal) qualityCodes.push("GOAL_NOT_CONFIGURED");
    if (goal && !goalMoneyKnown) qualityCodes.push("GOAL_MONETARY_BASIS_UNAVAILABLE");
    if (goal && (economics === null || economics.breakEvenAcosBps === null)) qualityCodes.push("ECONOMICS_UNAVAILABLE");
    if (!commerce) qualityCodes.push("COMMERCE_PERIOD_UNAVAILABLE");
    if (ambiguousCommerce) qualityCodes.push("COMMERCE_SCOPE_AMBIGUOUS");
    if (!first.fact.measurement) qualityCodes.push("LEGACY_MEASUREMENT_UNPINNED");
    else if (first.fact.measurement.conversion.state !== "resolved") qualityCodes.push("CONVERSION_MEASUREMENT_UNRESOLVED");
    else if (!clickMeasurement(first)) qualityCodes.push("CLICK_CONVERSION_NOT_APPLICABLE");
    if (rows.some(row => row.sourceArchivedAt != null)) qualityCodes.push("SOURCE_ARCHIVED_NOW");
    const moneyCommerce = commerce && sameMonetaryBasis(commerce.monetaryBasis, first.fact.measurement?.monetaryBasis) ? commerce : null;
    if (commerce && !moneyCommerce) qualityCodes.push("COMMERCE_MONETARY_BASIS_UNAVAILABLE");
    const postAd =
      moneyCommerce?.preAdContributionMinor !== null &&
      moneyCommerce?.preAdContributionMinor !== undefined &&
      metrics.spendMinor !== null
        ? exactDifference(moneyCommerce.preAdContributionMinor, metrics.spendMinor)
        : null;
    if (moneyCommerce?.preAdContributionMinor != null && metrics.spendMinor !== null && postAd === null) {
      qualityCodes.push("CONTRIBUTION_AMOUNT_OVERFLOW");
      diagnose("CONTRIBUTION_AMOUNT_OVERFLOW", "广告后贡献金额超过安全整数范围，未舍入或显示为确定利润");
    }
    return {
      key,
      scope,
      productName: first.fact.productName,
      measurementScope: measurementLabel(first),
      ...cohortEvidence(first),
      productId: goal?.productId ?? null,
      goal,
      metrics,
      ratios: adRatios(metrics, first.fact.measurement?.conversion),
      periodStart,
      periodEnd,
      reportCount: new Set(rows.map((r) => r.importId)).size,
      breakEvenAcosBps: economics?.breakEvenAcosBps ?? null,
      postAdContributionMinor: postAd,
      tacosBps: moneyCommerce ? ratio(metrics.spendMinor, moneyCommerce.totalSalesMinor, 10000) : null,
      observations: matchingObservations,
      qualityCodes,
    };
  });
  const mappings = groupBy(productRows, (r) =>
    stableAdJson([
      r.accountId,
      r.fact.advertiserId,
      r.fact.marketplace,
      r.fact.currency,
      r.fact.campaignId,
      r.fact.adGroupId,
      measurementKey(r),
    ]),
  );
  const existing = (options.actions ?? []).filter(
      (a) =>
        a.createdAt <= input.evidenceCutoffAt &&
        (!a.executedAt || a.executedAt <= input.evidenceCutoffAt),
    ),
    watchScopes = new Set<string>();
  function emit(base: Omit<AdRecommendation, "key">) {
    const key = adHash({
      ruleId: base.ruleId,
      object: objectKey(base as AdRecommendation),
      goalVersionId: base.goalVersionId,
      periodStart: base.periodStart,
      periodEnd: base.periodEnd,
      evidenceKeys: [...base.evidenceKeys].sort(),
      proposed: base.proposedBidMinor,
    });
    recommendations.push({ ...base, key });
  }
  const guardedProducts = new Set<string>();
  // Spend has no conversion window or model. Combine only fixed-money,
  // matching advertising scopes, then select each actual entity's latest
  // non-overlapping source across those conversion presentations. Purchases
  // and sales remain in the separate measurement groups above.
  const spendCohorts = groupBy(productRows.filter(row => row.fact.measurement?.monetaryBasis), row =>
    stableAdJson([scopeOf(row), row.fact.measurement!.monetaryBasis,
      row.fact.advertiserId, row.timezone]));
  for (const candidates of spendCohorts.values()) {
    const rows: Dated[] = [], ambiguousSpend = new Set<string>();
    let supersededSpend = 0, overlappingSpend = 0, conflictingSpend = 0;
    for (const sources of groupBy(candidates, row => row.fact.entityKey).values()) {
      const accepted: Dated[] = [];
      sources.sort((a, b) => b.observedAt.localeCompare(a.observedAt)
        || b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id));
      for (const row of sources) {
        const overlaps = accepted.filter(other => row.fact.periodStart <= other.fact.periodEnd
          && row.fact.periodEnd >= other.fact.periodStart);
        if (!overlaps.length) { accepted.push(row); continue; }
        supersededSpend++;
        if (overlaps.some(other => row.fact.periodStart !== other.fact.periodStart
          || row.fact.periodEnd !== other.fact.periodEnd)) overlappingSpend++;
        for (const other of overlaps) {
          if (row.fact.periodStart === other.fact.periodStart && row.fact.periodEnd === other.fact.periodEnd
            && row.observedAt === other.observedAt && row.recordedAt === other.recordedAt
            && row.fact.metrics.spendMinor !== other.fact.metrics.spendMinor) {
            ambiguousSpend.add(other.id);
            conflictingSpend++;
          }
        }
      }
      rows.push(...accepted);
    }
    if (supersededSpend) diagnose("SPEND_SOURCE_SUPERSEDED",
      `${supersededSpend} 行同一广告对象的花费来源按实际采集和保存时间择新；不同转化口径未重复累加花费`, "info");
    if (overlappingSpend) diagnose("SPEND_INTERVAL_COVERAGE_UNCLEAR",
      `${overlappingSpend} 行花费区间与较新来源部分重叠；只保留选中的完整区间，未比例拆分或声称覆盖完整`);
    if (conflictingSpend) diagnose("SPEND_SOURCE_CONFLICT",
      `${conflictingSpend} 组同一对象、同区间且采集保存时间相同的花费不一致；金额保持未知，不能据此确认预算上限`);
    const first = rows[0]!;
    const scope = scopeOf(first)!, monetaryBasis = first.fact.measurement!.monetaryBasis!;
    const goal = activeGoal(scope, first.timezone);
    if (!goal) continue;
    const g = goal.fields;
    if (rows.some(row => row.sourceArchivedAt != null)
      || !sameMonetaryBasis(g.monetaryBasis, monetaryBasis)) continue;
    const spendMetrics = (row: Dated): AdMetrics => ({ impressions: null, clicks: null, purchases: null,
      spendMinor: ambiguousSpend.has(row.id) ? null : row.fact.metrics.spendMinor, salesMinor: null });
    const metrics = sum(rows.map(spendMetrics));
    const today = adDay(input.evidenceCutoffAt, rows[0]!.timezone);
    const trial = sum(
      rows.filter((r) => r.fact.periodStart >= g.effectiveFrom).map(spendMetrics),
    );
    const rankLimit =
      g.mode === "rank_growth" &&
      (g.trialEndDate! < today ||
        (trial.spendMinor !== null && trial.spendMinor >= g.trialSpendLimitMinor!));
    const marginLimit =
      g.mode === "profit_defense" &&
      g.unitPriceMinor !== null &&
      g.unitCostMinor !== null &&
      g.unitCostMinor >= g.unitPriceMinor;
    if (!rankLimit && !marginLimit) continue;
    guardedProducts.add(stableAdJson([scope, monetaryBasis]));
    emit({
      ruleId: rankLimit ? "AD_RANK_TRIAL_LIMIT" : "AD_NONPOSITIVE_MARGIN",
      kind: "budget_guard",
      priority: "critical",
      productId: goal.productId,
      goalVersionId: goal.id,
      scope,
      accountId: scope.accountId,
      currency: scope.currency,
      marketplace: scope.marketplace,
      campaignId: null,
      adGroupId: null,
      targetId: null,
      term: null,
      title: rankLimit ? "复查排名试验并控制花费" : "先复核价格与成本",
      reason: marginLimit
        ? "广告前单件贡献利润非正，先复核经济性"
        : g.trialEndDate! < today
          ? "试验期限已结束，复盘后再设置下一阶段目标"
          : "已确认的产品试验花费达到上限，请先控制花费",
      currentBidMinor: null,
      proposedBidMinor: null,
      changeBps: null,
      periodStart: rows.map(row => row.fact.periodStart).sort()[0]!,
      periodEnd: rows.map(row => row.fact.periodEnd).sort().at(-1)!,
      metrics,
      monetaryBasis,
      evidenceKeys: rows.map(evidenceKey),
      constraints: ["核查此产品所有关联活动与实际预算", "花费和期限限制独立于转化口径、点击样本与成熟门槛", "仅汇总固定币种依据下选中的花费，不合并转化值或声称来源覆盖完整"],
      reviewAfter: addDays(today, g.cooldownDays),
    });
  }
  for (const rows of groupBy(
    selected.filter((r) => ["targeting", "search_term"].includes(r.fact.reportType)),
    (r) => stableAdJson([r.accountId, r.fact.entityKey, measurementKey(r)]),
  ).values()) {
    rows.sort((a, b) => b.fact.periodEnd.localeCompare(a.fact.periodEnd));
    const latest = rows[0]!,
      fact = latest.fact,
      today = adDay(input.evidenceCutoffAt, latest.timezone);
    const mappedRows =
      mappings.get(
        stableAdJson([
          latest.accountId,
          fact.advertiserId,
          fact.marketplace,
          fact.currency,
          fact.campaignId,
          fact.adGroupId,
          measurementKey(latest),
        ]),
      ) ?? [];
    const scopes = new Map(
      mappedRows.map((r) => {
        const s = scopeOf(r)!;
        return [adScopeKey(s), s];
      }),
    );
    const scope = scopes.size === 1 ? [...scopes.values()][0]! : null,
      goal = scope ? activeGoal(scope, latest.timezone) : null;
    const allMetrics = sum(rows.map((r) => r.fact.metrics));
    const base: Omit<AdRecommendation, "key"> = {
      ruleId: "AD_SAMPLE_REVIEW",
      kind: "watch",
      priority: "normal",
      productId: goal?.productId ?? null,
      goalVersionId: goal?.id ?? null,
      scope,
      accountId: latest.accountId,
      currency: fact.currency,
      marketplace: fact.marketplace,
      campaignId: fact.campaignId,
      adGroupId: fact.adGroupId,
      targetId: fact.targetId,
      term: fact.term,
      title: "继续观察",
      reason: "样本未达到产品设置的分析门槛",
      currentBidMinor: fact.bidMinor,
      proposedBidMinor: null,
      changeBps: null,
      periodStart: rows.map((r) => r.fact.periodStart).sort()[0]!,
      periodEnd: rows
        .map((r) => r.fact.periodEnd)
        .sort()
        .at(-1)!,
      metrics: allMetrics,
      ...cohortEvidence(latest),
      evidenceKeys: rows.map(evidenceKey),
      constraints: ["人工核对相关性和当前投放设置", "日期粒度需窗口末日之后"],
      reviewAfter: addDays(today, goal?.fields.cooldownDays ?? 7),
    };
    if (rows.some(row => row.sourceArchivedAt != null)) {
      emit({ ...base, ruleId: "AD_SOURCE_ARCHIVED", title: "原来源现已归档",
        reason: "保留截止时的历史报表数值；原依据现已归档，不能据此生成新调整" });
      continue;
    }
    if (!scope || !goal || fact.adProduct !== "SP" || !fact.campaignId || !fact.adGroupId) {
      const k = stableAdJson([
        latest.accountId,
        fact.campaignId,
        fact.adGroupId,
        fact.currency,
        measurementKey(latest),
      ]);
      if (!watchScopes.has(k)) {
        watchScopes.add(k);
        emit({
          ...base,
          ruleId: "AD_SCOPE_REVIEW",
          title: !goal && scope ? "先设置产品目标" : "确认广告与产品关联",
          reason:
            scopes.size > 1
              ? "同一广告组关联多个产品，不能把词级花费任意分配给一个 ASIN"
              : fact.adProduct !== "SP"
                ? "当前广告产品未确认或属于 SB/SD，保留分析证据并单独审阅"
                : "缺少唯一产品目标或明确投放 ID，需要先补充关联",
        });
      }
      continue;
    }
    if (!sameMonetaryBasis(goal.fields.monetaryBasis, latest.fact.measurement?.monetaryBasis)) {
      emit({ ...base, ruleId: "AD_GOAL_MONETARY_BASIS_UNAVAILABLE", title: "先核对原目标金额依据",
        reason: "报表与目标的币种精度依据未同时保存或不一致，不能比较预算、样本花费与竞价" });
      continue;
    }
    if (guardedProducts.has(stableAdJson([scope, latest.fact.measurement?.monetaryBasis]))) continue;
    if (!rows.every(clickMeasurement)) {
      emit({ ...base, ruleId: "AD_MEASUREMENT_UNRESOLVED", title: "先核对点击转化口径",
        reason: "只有已核对的点击模型、同窗口列对和已保存精度才能用于否词、迁词与调价；原值继续展示" });
      continue;
    }
    const mature = rows.filter(observedMature);
    if (!mature.length) {
      emit({
        ...base,
        ruleId: "AD_ATTRIBUTION_PENDING",
        title: "等待归因与样本成熟",
        reason:
          latest.fact.measurement?.conversion.windowDays == null
            ? "归因窗口尚未确认，不能把近期零购买量作为否词依据"
            : "原报表实际采集的本地日期须晚于统计末日加归因窗口；时间经过不会补齐旧快照，请补充成熟日报",
        constraints: [...base.constraints, "归因成熟后重新分析"],
      });
      continue;
    }
    const metrics = sum(mature.map((r) => r.fact.metrics)),
      ratios = adRatios(metrics, latest.fact.measurement?.conversion),
      g = goal.fields,
      economics = adEconomics(goal),
      target = economics.targetAcosBps;
    base.metrics = metrics;
    base.evidenceKeys = mature.map(evidenceKey);
    base.periodStart = mature.map((r) => r.fact.periodStart).sort()[0]!;
    base.periodEnd = mature
      .map((r) => r.fact.periodEnd)
      .sort()
      .at(-1)!;
    if (mature.length < rows.length) base.constraints.push("本次规则只使用归因成熟的完整事实区间");
    if (economics.breakEvenAcosBps === null)
      base.constraints.push("成本未确认，目标达标不证明广告订单盈利");
    const recent = existing.find(
      (a) =>
        objectKey(a.recommendation) === objectKey(base as AdRecommendation) &&
        a.executedAt &&
        Date.parse(input.evidenceCutoffAt) - Date.parse(a.executedAt) < g.cooldownDays * 86400000,
    );
    if (recent) {
      emit({
        ...base,
        ruleId: "AD_COOLDOWN",
        title: "调整后观察中",
        reason: `该对象近期已有执行记录，等待 ${g.cooldownDays} 天观察期结束`,
        constraints: [...base.constraints, "避免重复调价"],
        reviewAfter: adDay(
          new Date(Date.parse(recent.executedAt!) + g.cooldownDays * 86400000).toISOString(),
          latest.timezone,
        ),
      });
      continue;
    }
    if (
      metrics.clicks === null ||
      metrics.purchases === null ||
      metrics.spendMinor === null ||
      metrics.clicks < g.minimumClicks ||
      metrics.spendMinor < g.minimumSpendMinor
    )
      continue;
    const protectedTerm = [...g.protectedTerms, ...(g.mode === "rank_growth" ? g.coreKeywords : [])]
      .map(normalizeAdTerm)
      .includes(normalizeAdTerm(fact.term ?? ""));
    if (g.mode === "rank_growth") {
      const trialSource = productRows.filter(
        (r) =>
          adScopeKey(scopeOf(r)!) === adScopeKey(scope) &&
          measurementKey(r) === measurementKey(latest) && r.fact.advertiserId === fact.advertiserId,
      );
      const trialRows = trialSource.filter(
        (r) => r.fact.periodStart >= g.effectiveFrom && r.fact.periodEnd <= today,
      );
      const crossesTrial = trialSource.some(
        (r) => r.fact.periodStart < g.effectiveFrom && r.fact.periodEnd >= g.effectiveFrom,
      );
      const trialMetrics = sum(trialRows.map((r) => r.fact.metrics));
      let coveredUntil = addDays(g.effectiveFrom, -1);
      for (const row of [...trialRows].sort((a, b) =>
        a.fact.periodStart.localeCompare(b.fact.periodStart),
      )) {
        if (row.fact.periodStart <= addDays(coveredUntil, 1) && row.fact.periodEnd > coveredUntil)
          coveredUntil = row.fact.periodEnd;
      }
      if (
        g.trialEndDate! < today ||
        (trialMetrics.spendMinor !== null && trialMetrics.spendMinor >= g.trialSpendLimitMinor!)
      ) {
        emit({
          ...base,
          ruleId: "AD_RANK_TRIAL_LIMIT",
          kind: "budget_guard",
          priority: "critical",
          title: "复查排名试验并控制花费",
          reason:
            g.trialEndDate! < today
              ? "排名试验期限已结束，需要复盘后设置下一阶段目标"
              : "已确认的试验花费达到上限，需要先止损或重新批准预算",
        });
        continue;
      }
      if (
        !trialRows.length ||
        crossesTrial ||
        coveredUntil < (g.trialEndDate! < today ? g.trialEndDate! : addDays(today, -1))
      )
        base.constraints.push("试验花费覆盖不完整，禁止据此增加出价");
    }
    if (
      g.mode === "profit_defense" &&
      economics.breakEvenAcosBps !== null &&
      economics.breakEvenAcosBps <= 0
    ) {
      emit({
        ...base,
        ruleId: "AD_NONPOSITIVE_MARGIN",
        kind: "budget_guard",
        priority: "critical",
        title: "先复核价格与成本",
        reason: "广告前单件贡献利润非正，任何广告花费都会进一步减少利润",
      });
      continue;
    }
    if (fact.reportType === "search_term") {
      if (metrics.purchases === 0 && !protectedTerm)
        emit({
          ...base,
          ruleId: "AD_MATURE_ZERO_PURCHASE",
          kind: "negate_term",
          priority: "high",
          title: "审阅否定精准搜索词",
          reason: `成熟样本达到 ${g.minimumClicks} 次点击和花费门槛，仍无购买；请先核对购买意图`,
          constraints: [
            ...base.constraints,
            "该报告没有触发投放 ID，不能推断匹配类型",
            "执行前确认活动、广告组与否定范围",
          ],
        });
      else if (metrics.purchases === 0 && protectedTerm)
        emit({
          ...base,
          ruleId: "AD_PROTECTED_TERM",
          title: "保护词保留并复查",
          reason: "该词属于当前目标的核心或保护词；结合排名、转化与试验上限复查，不直接否定",
        });
      else if (
        metrics.purchases >= g.minimumPurchases &&
        target !== null &&
        ratios.acosBps !== null &&
        ratios.acosBps <= target
      )
        emit({
          ...base,
          ruleId: "AD_HARVEST_EXACT",
          kind: "harvest_exact",
          priority: "normal",
          title: "迁入精准投放候选",
          reason: "成熟成交样本达到门槛且 ACoS 在目标内；先检查是否已有精准投放",
          constraints: [
            ...base.constraints,
            "选择目标活动与广告组",
            "先验证新投放承接能力，再审阅原活动否定",
          ],
        });
      continue;
    }
    if (
      !fact.targetId ||
      !fact.bidMinor ||
      (fact.status && !["ENABLED", "ACTIVE"].includes(fact.status.toUpperCase()))
    )
      continue;
    if (!base.evidenceKeys.includes(evidenceKey(latest)))
      base.evidenceKeys.push(evidenceKey(latest));
    base.constraints.push(
      "竞价来自历史报表快照，执行前核对当前值",
      "动态竞价及广告位加价未知，历史 CPC 参考不代表基础竞价上限",
    );
    if (target === null || target <= 0) {
      emit({
        ...base,
        ruleId: "AD_TARGET_UNAVAILABLE",
        title: "补充目标或成本",
        reason: "尚无可用目标 ACoS，无法计算有依据的调价建议",
      });
      continue;
    }
    const ideal =
      metrics.salesMinor !== null && metrics.clicks > 0
        ? adCpcAllowance(metrics.salesMinor, metrics.clicks, target)
        : null;
    const lower = metrics.purchases === 0 || (ratios.acosBps !== null && ratios.acosBps > target);
    const raise =
      !lower &&
      metrics.purchases >= g.minimumPurchases &&
      ratios.acosBps !== null &&
      ratios.acosBps <= target * 0.8 &&
      (g.mode !== "profit_defense" || economics.breakEvenAcosBps !== null) &&
      !base.constraints.includes("试验花费覆盖不完整，禁止据此增加出价");
    if (lower && protectedTerm && g.mode === "rank_growth") {
      emit({
        ...base,
        ruleId: "AD_CORE_RANK_REVIEW",
        title: "复查核心词排名试验",
        reason: "核心词成本偏高，但仍在排名试验范围内；先结合实际自然排名进展与预算复查",
      });
      continue;
    }
    if ((!lower && !raise) || ideal === null) continue;
    const bid = boundedAdBid(fact.bidMinor, ideal, g.maxBidChangeBps, lower ? "lower" : "raise");
    if (bid === fact.bidMinor) continue;
    emit({
      ...base,
      ruleId: lower ? "AD_BOUNDED_BID_REDUCTION" : "AD_BOUNDED_BID_INCREASE",
      kind: lower ? "lower_bid" : "raise_bid",
      priority: lower ? "high" : "normal",
      proposedBidMinor: bid,
      changeBps: bidChangeBps(bid, fact.bidMinor),
      title: lower ? "小幅降低竞价候选" : "小幅提高竞价候选",
      reason: lower
        ? "成熟样本的成本超出产品目标，按允许幅度进行减费试验"
        : "成熟成交样本达到门槛且低于目标成本，提出受限放量试验",
    });
  }
  const dailyTrend = [
    ...groupBy(
      controlRows.filter((r) => r.fact.grain === "daily"),
      (r) =>
        stableAdJson([r.fact.periodStart, r.fact.currency, r.fact.marketplace, measurementKey(r)]),
    ).values(),
  ].map((rows) => ({
    date: rows[0]!.fact.periodStart,
    currency: rows[0]!.fact.currency!,
    marketplace: rows[0]!.fact.marketplace,
    measurementScope: measurementLabel(rows[0]!),
    ...cohortEvidence(rows[0]!),
    metrics: sum(rows.map((r) => r.fact.metrics)),
  }));
  if (controlRows.some((r) => r.fact.grain === "interval")) {
    dailyTrend.length = 0;
    diagnose(
      "DAILY_TREND_UNAVAILABLE",
      "控制表含区间汇总，本次只展示区间表现；日趋势需要同口径日报",
      "info",
    );
  }
  const priority = { critical: 0, high: 1, normal: 2 };
  recommendations.sort(
    (a, b) =>
      priority[a.priority] - priority[b.priority] ||
      (b.metrics.spendMinor ?? -1) - (a.metrics.spendMinor ?? -1) ||
      a.key.localeCompare(b.key),
  );
  if (recommendations.length > 500) {
    diagnose(
      "RECOMMENDATION_LIMIT",
      "本次保留优先级最高的 500 条建议，请按站点或币种缩小分析范围",
      "info",
    );
    recommendations.length = 500;
  }
  if (overflowMetrics.size)
    diagnose("METRIC_TOTAL_OVERFLOW", `汇总指标 ${[...overflowMetrics].sort().join("、")} 超过安全整数范围，已保留未知而非舍入数值`);
  return AdAnalysisResultSchema.parse({
    measurementVersion: 1,
    measurementPins: [...pins.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, pin]) => pin),
    controlType,
    totals,
    products,
    recommendations,
    diagnostics,
    evidenceImportIds: [...new Set(selected.map((r) => r.importId))].sort(),
    goalVersionIds: [...new Set(products.flatMap((p) => (p.goal ? [p.goal.id] : [])))].sort(),
    selectedFactCount: selected.length,
    supersededFactCount: superseded,
    dailyTrend,
  });
}
