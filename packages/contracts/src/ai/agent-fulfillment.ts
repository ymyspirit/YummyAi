import { z } from "zod";
import { HarnessExecutionContractSchema } from "@yummyai/contracts/harness";
import { ListOrdersInputSchema } from "@yummyai/contracts/order/order";
import { ProductionManufacturingPinSchema } from "@yummyai/contracts/order/production-manufacturing";
import { ProductionQuantityBasisSchema } from "@yummyai/contracts/order/production-quantity";
import { QualityPhysicalGroupViewSchema } from "@yummyai/contracts/order/quality-groups";
import { FactoryErpStatusViewSchema } from "@yummyai/contracts/order/factory-erp-import";
import { FactoryErpVoidObservationIdentitySchema, FactoryErpVoidReviewResultSchema, FactoryErpVoidObservationViewSchema, FactoryErpVoidSummarySchema } from "@yummyai/contracts/order/factory-erp-void-review";
import { FactoryErpEvidenceSourceSchema } from "@yummyai/contracts/order/factory-erp-source-pin";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";

/** Independent source ABI: no historical tools/resources/native schema is widened. */
export const AGENT_FULFILLMENT_VERSION = "erp-agent-fulfillment-v1" as const;
export const AGENT_FULFILLMENT_TOOL = "orders.fulfillment" as const;
const Id = z.uuidv7().toLowerCase(), Hash = z.string().regex(/^[a-f0-9]{64}$/), Time = z.iso.datetime();
const Version = { version: z.literal(AGENT_FULFILLMENT_VERSION) }, Authority = z.string().min(1).max(65_536);
export const AgentFulfillmentKindSchema = z.enum(["production", "shipments", "logistics"]);
export const AgentFulfillmentInputSchema = z.object({ orderId: Id, expectedSequence: z.int().positive(),
  kind: AgentFulfillmentKindSchema, cursor: z.string().min(1).max(16_384).nullable(), pageSize: z.int().min(1).max(10).default(5) }).strict();
export const AgentFulfillmentCandidatesQuerySchema = z.object({ ...Version, filters: ListOrdersInputSchema }).strict();
export const AgentFulfillmentCandidatesSchema = z.object({ ...Version, contextAuthority: Authority, query: AgentFulfillmentCandidatesQuerySchema,
  inputChecksum: Hash, items: z.array(z.object({ id: Id, label: z.string().max(1000), expectedSequence: z.int().positive(),
    lineId: Id.nullable() }).strict()).max(100), coverage: z.object({ complete: z.literal(false), total: z.int().nonnegative().nullable(),
    returned: z.int().min(0).max(100), hasMore: z.boolean(), limitation: z.string().min(1).max(1000) }).strict(),
}).strict().superRefine((v, ctx) => { if (v.coverage.returned !== v.items.length || new Set(v.items.map(i => i.id)).size !== v.items.length) ctx.addIssue({ code: "custom", message: "Original order candidates must be unique and counted" }); });

export const AgentFulfillmentSourceSchema = z.object({ owner: z.enum(["orders", "production", "manufacturing", "factory_erp", "quality", "shipments", "logistics"]),
  kind: z.string().min(1).max(100), id: Id, versionId: Id.nullable(), revision: z.int().nonnegative().nullable(), checksum: Hash.nullable() }).strict();
export const AgentFulfillmentCoverageSchema = z.object({ complete: z.literal(false), kind: z.literal("original_owner_page_projection"),
  returned: z.int().min(0).max(10), indexedTotal: z.int().nonnegative(), hasMore: z.boolean(), nextCursor: z.string().max(16_384).nullable(),
  collectionChecksum: Hash, limitation: z.string().min(1).max(1600) }).strict();
export function fulfillmentSection<T extends z.ZodType>(schema: T) {
  return z.object({ state: z.enum(["read", "not_present", "unavailable"]),
    reason: z.enum(["permission_required", "source_expired", "owner_unavailable", "legacy_unknown"]).nullable(), data: schema.nullable(),
  }).strict().superRefine((v, ctx) => {
    const data: unknown = "data" in v ? v.data : undefined;
    if (data === undefined || (v.state === "read" ? data === null || v.reason !== null : data !== null || v.state === "unavailable" && v.reason === null))
      ctx.addIssue({ code: "custom", message: "Unavailable facts must never become invented empty or zero facts" });
  });
}
const LocalCoverage = z.object({ returned: z.int().nonnegative(), originalCount: z.int().nonnegative(), truncated: z.boolean() }).strict();
// Keep every original rule/refinement; use JSON-Schema-representable UUID normalization in the independent wire ABI.
const VoidIdentity = FactoryErpVoidObservationIdentitySchema.safeExtend({ id: Id, importId: Id });
const VoidReview = FactoryErpVoidReviewResultSchema.safeExtend({ id: Id, bindingId: Id, factoryId: Id, previousReviewId: Id.nullable(),
  observation: VoidIdentity, source: FactoryErpEvidenceSourceSchema.safeExtend({ importId: Id }) });
const VoidObservation = FactoryErpVoidObservationViewSchema.safeExtend({ id: Id, importId: Id, latestReview: VoidReview.nullable() });
const VoidSummary = FactoryErpVoidSummarySchema.safeExtend({ latest: VoidObservation.nullable(), nextPending: VoidObservation.nullable() });
export const AgentFulfillmentFactorySchema = FactoryErpStatusViewSchema.pick({ bindingId: true, status: true, exception: true,
  observationId: true, importId: true, rawStatus: true, updatedAtLocal: true, recordedAt: true, shippedQuantity: true,
  privateSourceExpired: true, bindingRevision: true, bindingReleased: true, bindingReleaseId: true, historicalStatus: true, voidSummary: true }).safeExtend({ voidSummary: VoidSummary.optional() }).strict();
const Quality = QualityPhysicalGroupViewSchema.pick({ id: true, inspectionId: true, productionOrderId: true, productionVersionId: true,
  parentGroupId: true, rootInspectionId: true, quantity: true, result: true, scoreBps: true, qualityStandardVersionId: true,
  inspectedAt: true, productionProjectionVersion: true, active: true, shippedQuantity: true, remakeQuantity: true, remainingRemakeQuantity: true,
  scrappedQuantity: true, reinspectableQuantity: true, scrapBasisFingerprint: true }).strict();
export const AgentFulfillmentQualityGroupSchema = Quality;
export const AgentFulfillmentProductionSchema = z.object({ id: Id, orderId: Id, orderLineId: Id, status: z.string().max(100),
  projectionVersion: z.int().positive(), currentVersionNumber: z.int().positive(), currentVersionId: Id,
  quantity: z.int().positive(), expectedCompletionAt: Time, updatedAt: Time,
  manufacturing: ProductionManufacturingPinSchema.nullable(),
  milestones: z.array(z.object({ id: Id, sequence: z.int().positive(), type: z.string().max(100), evidenceCode: z.string().max(160), occurredAt: Time }).strict()).max(200),
  milestoneCoverage: LocalCoverage,
  quantityBasis: fulfillmentSection(ProductionQuantityBasisSchema),
  quality: fulfillmentSection(z.object({ productionOrderId: Id, orderId: Id, productionVersionId: Id, projectionVersion: z.int().positive(),
    rootInspectionId: Id.nullable(), groups: z.array(Quality).max(200), coverage: LocalCoverage }).strict()),
  delivery: fulfillmentSection(z.object({ packageId: Id, itemId: Id, status: z.enum(["pending", "submitted", "received", "accepted", "rejected"]),
    sequence: z.int().nonnegative(), productionVersionId: Id.nullable(), fileChecksum: Hash.nullable(), manufacturingContentChecksum: Hash.nullable(), manufacturingPlanChecksum: Hash.nullable(),
    packageChecksum: Hash, fileSourceAvailable: z.boolean() }).strict()),
  factory: fulfillmentSection(AgentFulfillmentFactorySchema),
}).strict();
export const AgentFulfillmentShipmentSchema = z.object({ id: Id, orderId: Id, status: z.string().max(100), currentVersionNumber: z.int().positive(),
  approvedVersionNumber: z.int().positive().nullable(), updatedAt: Time,
  versions: z.array(z.object({ id: Id, versionNumber: z.int().positive(), shipDate: z.string().max(100),
    productionSourceVersion: z.union([z.literal(1), z.literal(2)]).nullable() }).strict()).max(200),
  packages: z.array(z.object({ id: Id, shipmentVersionId: Id, trackingPresent: z.boolean() }).strict()).max(200),
  packageLines: z.array(z.object({ packageId: Id, orderLineId: Id, quantity: z.int().positive() }).strict()).max(1000),
  allocations: z.array(z.object({ packageId: Id, orderLineId: Id, shipmentVersionId: Id, productionOrderId: Id, productionVersionId: Id,
    qualityInspectionId: Id, qualityGroupId: Id.nullable(), quantity: z.int().positive() }).strict()).max(1000),
  tracking: z.array(z.object({ id: Id, status: z.string().max(100), occurredAt: Time, detailCode: z.string().max(500).nullable() }).strict()).max(200),
  writebacks: z.array(z.object({ id: Id, shipmentVersionId: Id, status: z.string().max(100) }).strict()).max(200),
  physicalHandover: z.object({ shipmentVersionId: Id.nullable(), packageCount: z.int().nonnegative(), dispatchedPackageCount: z.int().nonnegative(), allDispatched: z.boolean() }).strict(),
  historyCoverage: z.object({ versions: LocalCoverage, packages: LocalCoverage, packageLines: LocalCoverage, allocations: LocalCoverage, tracking: LocalCoverage, writebacks: LocalCoverage }).strict(),
}).strict();
export const AgentFulfillmentLogisticsSchema = z.object({ id: Id, orderId: Id, factoryId: Id, status: z.string().max(100),
  privateAvailable: z.boolean(), createdAt: Time, updatedAt: Time, expiresAt: Time, connectionVersionId: Id, ruleVersionId: Id,
  productionVersionIds: z.array(Id).max(50), snapshotChecksum: Hash, quotedCostMinor: z.int().safe().nonnegative().nullable(),
  actualCostMinor: z.int().safe().nonnegative().nullable(), quotedCurrency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  actualCurrency: z.string().regex(/^[A-Z]{3}$/).nullable(), minorUnitDigits: z.int().min(0).max(6),
  trackingCount: z.int().nonnegative().nullable(), labelCount: z.int().nonnegative().nullable(),
}).strict().superRefine((v, ctx) => { if (!v.privateAvailable && (v.trackingCount !== null || v.labelCount !== null)) ctx.addIssue({ code: "custom", message: "Expired private metadata is unavailable rather than zero" }); });
export const AgentFulfillmentOrderSchema = z.object({ id: Id, number: z.string().max(1000), sequence: z.int().positive(),
  mainState: z.string().max(100), sideState: z.string().max(100).nullable(),
  lines: z.array(z.object({ id: Id, quantity: z.int().positive(), sku: z.string().max(1000).nullable() }).strict()).max(1000) }).strict();
const Data = { order: AgentFulfillmentOrderSchema, coverage: AgentFulfillmentCoverageSchema };
export const AgentFulfillmentDataSchema = z.discriminatedUnion("kind", [
  z.object({ ...Data, kind: z.literal("production"), rows: z.array(AgentFulfillmentProductionSchema).max(10) }).strict(),
  z.object({ ...Data, kind: z.literal("shipments"), rows: z.array(AgentFulfillmentShipmentSchema).max(10) }).strict(),
  z.object({ ...Data, kind: z.literal("logistics"), rows: z.array(AgentFulfillmentLogisticsSchema).max(10) }).strict(),
]).superRefine((v, ctx) => {
  if (v.rows.length !== v.coverage.returned || new Set(v.rows.map(row => row.id)).size !== v.rows.length ||
    v.rows.some(row => row.orderId !== v.order.id) || v.coverage.hasMore !== (v.coverage.nextCursor !== null))
    ctx.addIssue({ code: "custom", message: "Every row and continuation must belong to the selected original order" });
});
export const AgentFulfillmentDefinitionRequestSchema = z.object({ ...Version, tool: z.literal(AGENT_FULFILLMENT_TOOL) }).strict();
export const AgentFulfillmentDefinitionSchema = z.object({ ...Version, tool: z.literal(AGENT_FULFILLMENT_TOOL), contextAuthority: Authority,
  label: z.string().min(1).max(120), available: z.boolean(), blockReason: z.string().max(160).nullable(),
  inputSchema: z.record(z.string(), z.unknown()), outputSchema: z.record(z.string(), z.unknown()), definitionChecksum: Hash,
  effect: z.literal("read"), execution: z.literal("original_owner_fulfillment_projection"), limitations: z.array(z.string().max(1600)).min(1).max(10) }).strict();
export const AgentFulfillmentWorkspaceSchema = z.object({ ...Version, contextAuthority: Authority, executionContract: HarnessExecutionContractSchema,
  definition: AgentFulfillmentDefinitionSchema, sourcePermissions: z.object({ production: z.boolean(), shipments: z.boolean(), logistics: z.boolean(), factory: z.boolean() }).strict() }).strict();
export const AgentFulfillmentCallSchema = z.object({ ...Version, tool: z.literal(AGENT_FULFILLMENT_TOOL), executionContract: HarnessExecutionContractSchema,
  definitionChecksum: Hash, input: AgentFulfillmentInputSchema }).strict();
export const AgentFulfillmentResultSchema = z.object({ ...Version, tool: z.literal(AGENT_FULFILLMENT_TOOL), contextAuthority: Authority, callId: Id,
  checkedAt: Time, readStartedAt: Time, input: AgentFulfillmentInputSchema, definitionChecksum: Hash, inputChecksum: Hash, dataChecksum: Hash,
  sources: z.array(AgentFulfillmentSourceSchema).min(1).max(5000), data: AgentFulfillmentDataSchema,
  consistency: z.literal("owner_reads_fenced_not_single_transaction_snapshot"), modelCalled: z.literal(false), businessExecuted: z.literal(false),
}).strict().superRefine((v, ctx) => { if (v.data.order.id !== v.input.orderId || v.data.order.sequence !== v.input.expectedSequence || v.data.kind !== v.input.kind || v.data.rows.length > v.input.pageSize) ctx.addIssue({ code: "custom", message: "The result must match the exact original selected input" }); });
export const canonicalAgentFulfillmentCall = (raw: unknown) => canonicalJson(AgentFulfillmentCallSchema.parse(raw));
export function agentFulfillmentDefinitionPayload(v: z.infer<typeof AgentFulfillmentDefinitionSchema>) {
  const { version, tool, label, inputSchema, outputSchema, effect, execution, limitations } = v; return { version, tool, label, inputSchema, outputSchema, effect, execution, limitations };
}
export function agentFulfillmentDataPayload(v: z.infer<typeof AgentFulfillmentResultSchema>) {
  const { version, tool, input, sources, data, consistency, modelCalled, businessExecuted } = v; return { version, tool, input, sources, data, consistency, modelCalled, businessExecuted };
}
export const AgentFulfillmentMcpDefinitionSchema = z.object({ key: z.literal("fulfillment/orders.fulfillment") }).strict();
export const AgentFulfillmentMcpCandidatesSchema = z.object({ ...Version, kind: z.literal("candidates"), query: AgentFulfillmentCandidatesQuerySchema }).strict();
export type AgentFulfillmentInput = z.infer<typeof AgentFulfillmentInputSchema>;
export type AgentFulfillmentKind = z.infer<typeof AgentFulfillmentKindSchema>;
export type AgentFulfillmentProduction = z.infer<typeof AgentFulfillmentProductionSchema>;
export type AgentFulfillmentShipment = z.infer<typeof AgentFulfillmentShipmentSchema>;
export type AgentFulfillmentLogistics = z.infer<typeof AgentFulfillmentLogisticsSchema>;
export type AgentFulfillmentSource = z.infer<typeof AgentFulfillmentSourceSchema>;
export type AgentFulfillmentCall = z.infer<typeof AgentFulfillmentCallSchema>;
export type AgentFulfillmentData = z.infer<typeof AgentFulfillmentDataSchema>;
export type AgentFulfillmentResult = z.infer<typeof AgentFulfillmentResultSchema>;
export type AgentFulfillmentWorkspace = z.infer<typeof AgentFulfillmentWorkspaceSchema>;
export type AgentFulfillmentCandidates = z.infer<typeof AgentFulfillmentCandidatesSchema>;
