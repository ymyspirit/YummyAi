import type { DocumentOrderSource, DocumentProfileView } from "@yummyai/contracts/logistics/documents";
import { LogisticsPackageSchema } from "@yummyai/contracts/logistics";
import type { FulfillmentRouteView } from "@yummyai/contracts/order/fulfillment-flow";
import type { FactoryCapacityWorkspace } from "@yummyai/contracts/suppliers/factory-capacity";
import { planOrderDocument } from "@yummyai/logistics";

export function documentProfileCoversOrder(source: DocumentOrderSource, profile: DocumentProfileView["profile"]) {
  return profile.destinationCountries.includes(source.address.countryCode) && source.lines.length > 0 &&
    source.lines.every(line => line.specificationVersionId !== null && profile.specifications.some(spec => spec.specificationVersionId === line.specificationVersionId));
}

export function matchFulfillmentRoute(source: DocumentOrderSource, routes: FulfillmentRouteView[], profiles: DocumentProfileView[]) {
  const matches = routes.filter(route => route.profile.mode !== "disabled" && profiles.some(profile =>
    profile.id === route.profile.documentProfileVersionId
    && documentProfileCoversOrder(source, profile.profile)));
  if (matches.length === 1) return { route: matches[0]!, reasons: matches[0]!.blockers };
  return { route: null, reasons: [matches.length ? "有多条发货规则同时适用 请在产品与发货规则中消除重叠" : "整单商品与收货国家没有匹配的发货规则 请配置商品规格和承接工厂"] };
}

export function planFlowParcel(source: DocumentOrderSource, profile: DocumentProfileView, channelSelection?: "specification" | "compare_eligible") {
  const planned = planOrderDocument(profile.profile.route === "printeque" ? "printeque_shipping" : "yunexpress", source, profile.profile, undefined, "api");
  if (planned.blockers.length || !planned.parcel) throw new Error(planned.blockers.join("；") || "包裹数据缺失");
  const parcel = planned.parcel;
  if (!parcel.lengthIn || !parcel.widthIn || !parcel.heightIn) throw new Error("自动打单需要准确的包装长宽高 请补齐规格包裹数据");
  const declarations = new Map<string, ReturnType<typeof LogisticsPackageSchema.parse>["declarations"][number]>();
  for (const line of source.lines) {
    const spec = profile.profile.specifications.find(spec => spec.specificationVersionId === line.specificationVersionId)!;
    if (!line.skuCode) throw new Error("商品缺少可核对的销售 SKU");
    if (!spec.declaredUnitValueMinor) throw new Error("规格缺少申报价值");
    const grams = spec.weight * (spec.weightUnit === "kg" ? 1000 : spec.weightUnit === "lb" ? 453.59237 : 1);
    const existing = declarations.get(line.skuCode);
    if (existing) {
      if (existing.unitWeightGrams !== grams || existing.unitPriceMinor !== spec.declaredUnitValueMinor) throw new Error("同一 SKU 的规格数据不一致 请先核对订单");
      existing.quantity += line.quantity;
    } else declarations.set(line.skuCode, { sku: line.skuCode, nameEn: spec.nameEn, nameCn: spec.nameCn,
      quantity: line.quantity, unitPriceMinor: spec.declaredUnitValueMinor, currency: "USD", minorUnitDigits: 2,
      unitWeightGrams: grams, hsCode: spec.hsCode, originCountryCode: profile.profile.originCountryCode });
  }
  const pack = LogisticsPackageSchema.parse({ weightGrams: Math.ceil(parcel.weightKg * 1000),
    dimensionsMm: { length: parcel.lengthIn * 25.4, width: parcel.widthIn * 25.4, height: parcel.heightIn * 25.4 },
    evidence: profile.profile.evidence, containsBattery: false, declarations: [...declarations.values()] });
  return { packages: [pack], channelCode: channelSelection === "compare_eligible" ? undefined : parcel.channelCode ?? undefined };
}

/** Pick actual published calendar capacity. Never infer unlimited capacity from
 * a supplier quote, and reserve the whole batch again in the original owner. */
export function planFlowCapacity(workspace: FactoryCapacityWorkspace,
  items: Array<{ lineId: string; capabilityVersionId: string; quantity: number }>, latest: Date) {
  const used = new Map<string, number>(), plans = new Map<string, { allocations: Array<{ poolId: string; poolVersionId: string; localDate: string }> }>();
  let completion = 0;
  for (const item of items) {
    const pools = workspace.pools.filter(pool => pool.profile.status === "active" && pool.profile.bindings.some(binding => binding.capabilityVersionId === item.capabilityVersionId));
    if (!pools.length) throw new Error("工厂尚未配置此商品的承接日历 请在工厂能力中一次性设置");
    const allocations = [];
    for (const pool of pools) {
      const needed = pool.profile.bindings.find(binding => binding.capabilityVersionId === item.capabilityVersionId)!.unitsPerItem * item.quantity;
      const day = workspace.calendar.filter(day => day.poolId === pool.id && !day.blockers.length
        && day.intervals.length && day.intervals.every(interval => Date.parse(interval.end) <= latest.getTime())
        && day.availableUnits - (used.get(`${pool.id}:${day.localDate}`) ?? 0) >= needed)
        .sort((a,b) => a.localDate.localeCompare(b.localDate))[0];
      if (!day) throw new Error("工厂交期内没有足够的整单产能 请处理排期异常");
      const key = `${pool.id}:${day.localDate}`;
      used.set(key,(used.get(key) ?? 0) + needed);
      completion = Math.max(completion,...day.intervals.map(interval => Date.parse(interval.end)));
      allocations.push({ poolId: pool.id, poolVersionId: pool.versionId, localDate: day.localDate });
    }
    plans.set(item.lineId,{ allocations });
  }
  return { plans, expectedCompletionAt: new Date(completion).toISOString() };
}
