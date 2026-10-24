import type { ProductionReadOwner, ShipmentReadOwner, ProductionQuantityReadOwner, ProductionDeliveryReadOwner } from "@yummyai/order-core";
import type { z } from "zod";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { AgentFulfillmentFactorySchema, AgentFulfillmentQualityGroupSchema, AgentFulfillmentProductionSchema, AgentFulfillmentShipmentSchema,
  AgentFulfillmentLogisticsSchema, type AgentFulfillmentProduction, type AgentFulfillmentShipment, type AgentFulfillmentLogistics,
  type AgentFulfillmentSource } from "@yummyai/contracts/ai/agent-fulfillment";
import type { LogisticsTaskView } from "@yummyai/contracts/logistics";
import type { LogisticsTaskEvidence } from "@yummyai/logistics";

type Production = Awaited<ReturnType<ProductionReadOwner["get"]>>;
type Quality = Awaited<ReturnType<ProductionReadOwner["qualityGroups"]>>;
type Quantity = Awaited<ReturnType<ProductionQuantityReadOwner["workspace"]>>;
type Delivery = Awaited<ReturnType<ProductionDeliveryReadOwner["get"]>>;
type Shipment = Awaited<ReturnType<ShipmentReadOwner["get"]>>;
export type FulfillmentSection<T> = { state: "read" | "not_present" | "unavailable"; reason: "permission_required" | "source_expired" | "owner_unavailable" | "legacy_unknown" | null; data: T | null };
export const readSection = <T>(data: T): FulfillmentSection<T> => ({ state: "read", reason: null, data });
export const absentSection = <T>(): FulfillmentSection<T> => ({ state: "not_present", reason: null, data: null });
export const unavailableSection = <T>(reason: FulfillmentSection<T>["reason"]): FulfillmentSection<T> => ({ state: "unavailable", reason, data: null });
const iso = (value: Date | string) => typeof value === "string" ? value : value.toISOString();
const coverage = (originalCount: number, maximum: number) => ({ returned: Math.min(originalCount, maximum), originalCount, truncated: originalCount > maximum });
const invalid = (): never => { throw new OriginalOwnerError(502, { code: "agent_fulfillment_owner_invalid", message: "原履约对象或版本无法核对" }); };
function safePick<T extends z.ZodRawShape>(schema: z.ZodObject<T>, raw: unknown): z.infer<z.ZodObject<T>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
  const record = raw as Record<string, unknown>;
  return schema.parse(Object.fromEntries(Object.keys(schema.shape).filter(key => key in record).map(key => [key, record[key]])));
}
export function productionProjection(input: { source: Production; quantity: FulfillmentSection<Quantity>; quality: FulfillmentSection<Quality>;
  delivery: FulfillmentSection<Delivery>; factoryAllowed: boolean }): { row: AgentFulfillmentProduction; sources: AgentFulfillmentSource[] } {
  const { source } = input, p = source.productionOrder;
  const current = source.versions.find(version => version.versionNumber === p.currentVersionNumber); if (!current) return invalid();
  const sources: AgentFulfillmentSource[] = [{ owner: "production", kind: "production_projection", id: p.id, versionId: current.id, revision: p.projectionVersion, checksum: null }];
  if (current.manufacturing) sources.push({ owner: "manufacturing", kind: "production_manufacturing_pin", id: current.manufacturing.id, versionId: current.manufacturing.versionId, revision: current.manufacturing.versionNumber, checksum: current.manufacturing.contentChecksum });
  const quantityBasis = input.quantity.state === "read" && input.quantity.data ? readSection(input.quantity.data.basis) : { ...input.quantity, data: null };
  const quality = input.quality.state === "read" && input.quality.data ? readSection({ productionOrderId: input.quality.data.productionOrderId,
    orderId: input.quality.data.orderId, productionVersionId: input.quality.data.productionVersionId, projectionVersion: input.quality.data.projectionVersion,
    rootInspectionId: input.quality.data.rootInspectionId, groups: input.quality.data.groups.slice(0, 200).map(group => safePick(AgentFulfillmentQualityGroupSchema, group)),
    coverage: coverage(input.quality.data.groups.length, 200) }) : { ...input.quality, data: null };
  if (quality.data) for (const group of quality.data.groups) sources.push({ owner: "quality", kind: "physical_quality_group", id: group.id,
    versionId: group.productionVersionId, revision: group.productionProjectionVersion, checksum: group.scrapBasisFingerprint ?? null });
  let delivery: AgentFulfillmentProduction["delivery"] = { ...input.delivery, data: null };
  let factory: AgentFulfillmentProduction["factory"] = input.factoryAllowed ? absentSection() : unavailableSection("permission_required");
  if (input.delivery.state === "read" && input.delivery.data) {
    const item = input.delivery.data.items.find(row => row.id === source.deliveryReceipt?.itemId && row.productionOrderId === p.id);
    if (!item) return invalid();
    delivery = readSection({ packageId: input.delivery.data.id, itemId: item.id, status: item.status, sequence: item.sequence,
      productionVersionId: item.snapshot?.productionVersionId ?? null, fileChecksum: item.snapshot?.file.checksum ?? null,
      manufacturingContentChecksum: item.snapshot?.manufacturing?.sourceContentChecksum ?? null,
      manufacturingPlanChecksum: item.snapshot?.manufacturing?.plan.checksum ?? null,
      packageChecksum: input.delivery.data.checksum, fileSourceAvailable: item.snapshot !== null });
    sources.push({ owner: "production", kind: "delivery_package", id: input.delivery.data.id, versionId: item.snapshot?.productionVersionId ?? null, revision: item.sequence, checksum: input.delivery.data.checksum });
    if (item.factoryErp?.privateSourceExpired) factory = unavailableSection("source_expired");
    else if (item.factoryErp) {
      factory = readSection(safePick(AgentFulfillmentFactorySchema, item.factoryErp));
      sources.push({ owner: "factory_erp", kind: "factory_observation", id: item.factoryErp.observationId, versionId: item.factoryErp.importId,
        revision: item.factoryErp.bindingRevision ?? null, checksum: null });
      for (const observation of [item.factoryErp.voidSummary?.latest, item.factoryErp.voidSummary?.nextPending]) if (observation) {
        sources.push({ owner: "factory_erp", kind: "factory_void_observation", id: observation.id, versionId: observation.importId,
          revision: observation.sequence, checksum: observation.rowChecksum });
        if (observation.latestReview) sources.push({ owner: "factory_erp", kind: "factory_void_review", id: observation.latestReview.id,
          versionId: observation.id, revision: observation.latestReview.reviewRevision, checksum: observation.latestReview.requestChecksum });
      }
    } else if (!item.snapshot) factory = unavailableSection("source_expired");
  }
  const row = AgentFulfillmentProductionSchema.parse({ id: p.id, orderId: p.orderId, orderLineId: p.orderLineId, status: p.status,
    projectionVersion: p.projectionVersion, currentVersionNumber: p.currentVersionNumber, currentVersionId: current.id,
    quantity: current.quantity, expectedCompletionAt: iso(current.expectedCompletionAt), updatedAt: iso(p.updatedAt), manufacturing: current.manufacturing,
    milestones: source.milestones.slice(-200).map(m => ({ id: m.id, sequence: m.sequence, type: m.type, evidenceCode: m.evidenceCode, occurredAt: iso(m.occurredAt) })),
    milestoneCoverage: coverage(source.milestones.length, 200), quantityBasis, quality, delivery, factory });
  return { row, sources };
}

export function shipmentProjection(source: Shipment): { row: AgentFulfillmentShipment; sources: AgentFulfillmentSource[] } {
  const s = source.shipment;
  const current = source.versions.find(version => version.versionNumber === s.currentVersionNumber); if (!current) return invalid();
  const row = AgentFulfillmentShipmentSchema.parse({ id: s.id, orderId: s.orderId, status: s.status, currentVersionNumber: s.currentVersionNumber,
    approvedVersionNumber: s.approvedVersionNumber, updatedAt: iso(s.updatedAt),
    versions: source.versions.slice(-200).map(v => ({ id: v.id, versionNumber: v.versionNumber, shipDate: iso(v.shipDate), productionSourceVersion: v.productionSourceVersion })),
    packages: source.packages.slice(0, 200).map(p => ({ id: p.id, shipmentVersionId: p.shipmentVersionId, trackingPresent: Boolean(p.trackingNumber) })),
    packageLines: source.packageLines.slice(0, 1000).map(p => ({ packageId: p.packageId, orderLineId: p.orderLineId, quantity: p.quantity })),
    allocations: source.productionAllocations.slice(0, 1000).map(p => ({ packageId: p.packageId, orderLineId: p.orderLineId, shipmentVersionId: p.shipmentVersionId,
      productionOrderId: p.productionOrderId, productionVersionId: p.productionVersionId, qualityInspectionId: p.qualityInspectionId, qualityGroupId: p.qualityGroupId, quantity: p.quantity })),
    tracking: source.tracking.slice(-200).map(t => ({ id: t.id, status: t.status, occurredAt: iso(t.occurredAt), detailCode: t.detailCode })),
    writebacks: source.writebacks.slice(-200).map(w => ({ id: w.id, shipmentVersionId: w.shipmentVersionId, status: w.status })),
    physicalHandover: source.physicalHandover, historyCoverage: { versions: coverage(source.versions.length, 200), packages: coverage(source.packages.length, 200),
      packageLines: coverage(source.packageLines.length, 1000), allocations: coverage(source.productionAllocations.length, 1000), tracking: coverage(source.tracking.length, 200), writebacks: coverage(source.writebacks.length, 200) } });
  const sources: AgentFulfillmentSource[] = [{ owner: "shipments", kind: "shipment_projection", id: s.id, versionId: current.id, revision: s.currentVersionNumber, checksum: null }];
  for (const a of row.allocations) sources.push({ owner: "production", kind: "shipment_production_allocation", id: a.productionOrderId, versionId: a.productionVersionId, revision: null, checksum: null });
  for (const r of source.reviews.slice(-200)) sources.push({ owner: "shipments", kind: "shipment_review_" + r.decision, id: r.id, versionId: r.shipmentVersionId, revision: null, checksum: r.reasonChecksum });
  for (const t of row.tracking) sources.push({ owner: "shipments", kind: "tracking_event", id: t.id, versionId: null, revision: null, checksum: null });
  for (const m of source.manualConfirmations.slice(-200)) sources.push({ owner: "shipments", kind: "manual_confirmation", id: m.id, versionId: m.shipmentVersionId, revision: null, checksum: null });
  return { row, sources };
}
export function logisticsProjection(view: LogisticsTaskView, evidence: LogisticsTaskEvidence): { row: AgentFulfillmentLogistics; sources: AgentFulfillmentSource[] } {
  if (view.id !== evidence.taskId || view.orderId !== evidence.orderId || view.factoryId !== evidence.factoryId || view.status !== evidence.status) return invalid();
  const row = AgentFulfillmentLogisticsSchema.parse({ id: view.id, orderId: view.orderId, factoryId: view.factoryId, status: view.status,
    privateAvailable: evidence.privateAvailable, createdAt: evidence.createdAt, updatedAt: evidence.updatedAt, expiresAt: evidence.expiresAt,
    connectionVersionId: evidence.connectionVersionId, ruleVersionId: evidence.ruleVersionId, productionVersionIds: evidence.productionVersionIds, snapshotChecksum: evidence.snapshotChecksum,
    quotedCostMinor: view.quotedCostMinor, actualCostMinor: view.actualCostMinor, quotedCurrency: view.quotedCurrency, actualCurrency: view.actualCurrency, minorUnitDigits: view.minorUnitDigits,
    trackingCount: evidence.privateAvailable ? view.trackingNumbers.length : null, labelCount: evidence.privateAvailable ? view.labelCount : null });
  return { row, sources: [{ owner: "logistics", kind: "logistics_task", id: row.id, versionId: row.connectionVersionId, revision: null, checksum: row.snapshotChecksum }] };
}
