import { z } from "zod";

import { EntityIdSchema } from "../common/ids.js";

export const SupplierKindSchema = z.enum(["manual", "printify", "printful"]);
export const SupplierStatusSchema = z.enum(["active", "suspended", "archived"]);

export const CreateFulfillmentSupplierInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: SupplierKindSchema,
  regionCode: z.string().trim().min(1).max(40),
  settlementCurrency: z.string().regex(/^[A-Z]{3}$/),
  externalConnectionRef: z.string().trim().min(1).max(300).nullable().default(null),
}).strict();

export const CreateSupplierCapabilitySnapshotInputSchema = z.object({
  supplierId: EntityIdSchema,
  supportedSkuIds: z.array(EntityIdSchema).max(10_000),
  processCodes: z.array(z.string().regex(/^[A-Z0-9_:-]{1,80}$/)).max(500),
  serviceCountryCodes: z.array(z.string().regex(/^[A-Z]{2}$/)).max(250),
  blockedRegionCodes: z.array(z.string().trim().min(1).max(120)).max(1_000).default([]),
  qualityScoreBps: z.number().int().min(0).max(10_000),
  effectiveAt: z.iso.datetime(),
  sourceVersion: z.string().trim().min(1).max(160),
}).strict();

export const CreateSupplierQuoteInputSchema = z.object({
  supplierId: EntityIdSchema,
  skuId: EntityIdSchema,
  unitCostMinor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  minimumOrderQuantity: z.number().int().positive().default(1),
  leadTimeDays: z.number().int().nonnegative().max(3_650),
  validFrom: z.iso.datetime(),
  validUntil: z.iso.datetime(),
  externalQuoteId: z.string().trim().min(1).max(300).nullable().default(null),
}).strict().refine((value) => value.validUntil > value.validFrom, { path: ["validUntil"], message: "Quote expiry must follow its start" });

export const CreateSupplierCapacityWindowInputSchema = z.object({
  supplierId: EntityIdSchema,
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  availableUnits: z.number().int().nonnegative(),
  reservedUnits: z.number().int().nonnegative().default(0),
  sourceVersion: z.string().trim().min(1).max(160),
}).strict().refine((value) => value.endsAt > value.startsAt, { path: ["endsAt"], message: "Capacity window end must follow its start" })
  .refine((value) => value.reservedUnits <= value.availableUnits, { path: ["reservedUnits"], message: "Reserved capacity cannot exceed available capacity" });

export const RoutingScoreDimensionSchema = z.enum(["capability", "region", "cost", "lead_time", "capacity", "quality", "priority"]);
export const RoutingPolicyWeightsSchema = z.object({
  capability: z.number().int().min(0).max(10_000),
  region: z.number().int().min(0).max(10_000),
  cost: z.number().int().min(0).max(10_000),
  leadTime: z.number().int().min(0).max(10_000),
  capacity: z.number().int().min(0).max(10_000),
  quality: z.number().int().min(0).max(10_000),
  priority: z.number().int().min(0).max(10_000),
}).strict().refine((value) => Object.values(value).reduce((total, weight) => total + weight, 0) === 10_000, {
  message: "Routing weights must total 10000 basis points",
});

export const CreateRoutingPolicyInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  weights: RoutingPolicyWeightsSchema,
  minimumQualityBps: z.number().int().min(0).max(10_000),
  maximumLeadTimeDays: z.number().int().nonnegative().max(3_650),
  maximumUnitCostMinor: z.number().int().nonnegative(),
  manualApprovalCostMinor: z.number().int().nonnegative(),
  manualApprovalRiskBps: z.number().int().min(0).max(10_000),
  tieBreaker: z.tuple([z.literal("total_score"), z.literal("unit_cost"), z.literal("lead_time"), z.literal("supplier_id")]).default(["total_score", "unit_cost", "lead_time", "supplier_id"]),
}).strict().refine((value) => value.manualApprovalCostMinor <= value.maximumUnitCostMinor, {
  path: ["manualApprovalCostMinor"], message: "Approval cost threshold cannot exceed the maximum cost",
});

export const RouteOrderLineInputSchema = z.object({
  orderLineId: EntityIdSchema,
  routingPolicyId: EntityIdSchema,
  processCodes: z.array(z.string().regex(/^[A-Z0-9_:-]{1,80}$/)).max(100).default([]),
  destinationCountryCode: z.string().regex(/^[A-Z]{2}$/),
  destinationRegionCode: z.string().trim().min(1).max(120).nullable().default(null),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

export const ManualRoutingOverrideInputSchema = z.object({
  supplierId: EntityIdSchema,
  expectedDecisionVersion: z.number().int().positive(),
  reasonCode: z.string().regex(/^[A-Z0-9_]{1,160}$/),
  reason: z.string().trim().min(1).max(2_000),
}).strict();

export const ReviewRoutingDecisionInputSchema = z.object({
  action: z.enum(["approve", "reject"]),
  expectedDecisionVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2_000),
}).strict();

export const SupplierRoutingCandidateSchema = z.object({
  supplierId: EntityIdSchema,
  quoteId: EntityIdSchema,
  capabilitySnapshotId: EntityIdSchema,
  capacityWindowId: EntityIdSchema,
  eligible: z.boolean(),
  exclusionCodes: z.array(z.enum(["supplier_inactive", "sku_unsupported", "process_unsupported", "region_unsupported", "region_blocked", "quote_invalid", "currency_mismatch", "moq_unmet", "cost_exceeded", "lead_time_exceeded", "quality_below_minimum", "capacity_insufficient"])),
  scores: z.object({ capability: z.number().int().min(0).max(10_000), region: z.number().int().min(0).max(10_000), cost: z.number().int().min(0).max(10_000), leadTime: z.number().int().min(0).max(10_000), capacity: z.number().int().min(0).max(10_000), quality: z.number().int().min(0).max(10_000), priority: z.number().int().min(0).max(10_000), total: z.number().int().min(0).max(10_000) }).strict(),
  unitCostMinor: z.number().int().nonnegative(),
  leadTimeDays: z.number().int().nonnegative(),
  availableUnits: z.number().int().nonnegative(),
  qualityScoreBps: z.number().int().min(0).max(10_000),
}).strict();

export const SupplierProductionOrderInputSchema = z.object({
  externalOrderId: z.string().trim().min(1).max(200),
  shippingMethod: z.string().trim().min(1).max(80).default("STANDARD"),
  recipient: z.object({
    firstName: z.string().trim().min(1).max(120), lastName: z.string().trim().min(1).max(120),
    company: z.string().trim().max(200).nullable().default(null),
    address1: z.string().trim().min(1).max(300), address2: z.string().trim().max(300).nullable().default(null),
    city: z.string().trim().min(1).max(160), region: z.string().trim().max(120).nullable().default(null),
    postalCode: z.string().trim().min(1).max(40), countryCode: z.string().regex(/^[A-Z]{2}$/),
    email: z.email().nullable().default(null), phone: z.string().trim().max(80).nullable().default(null),
  }).strict(),
  lines: z.array(z.object({
    externalLineId: z.string().trim().min(1).max(200), providerProductId: z.string().trim().min(1).max(200).nullable().default(null),
    providerVariantId: z.string().regex(/^\d+$/), quantity: z.number().int().positive(),
    fileUrls: z.array(z.url({ protocol: /^https$/ })).max(20).default([]),
  }).strict()).min(1).max(100),
}).strict();

export type SupplierKind = z.infer<typeof SupplierKindSchema>;
export type SupplierStatus = z.infer<typeof SupplierStatusSchema>;
export type CreateFulfillmentSupplierInput = z.infer<typeof CreateFulfillmentSupplierInputSchema>;
export type CreateSupplierCapabilitySnapshotInput = z.infer<typeof CreateSupplierCapabilitySnapshotInputSchema>;
export type CreateSupplierQuoteInput = z.infer<typeof CreateSupplierQuoteInputSchema>;
export type CreateSupplierCapacityWindowInput = z.infer<typeof CreateSupplierCapacityWindowInputSchema>;
export type CreateRoutingPolicyInput = z.infer<typeof CreateRoutingPolicyInputSchema>;
export type RouteOrderLineInput = z.infer<typeof RouteOrderLineInputSchema>;
export type ManualRoutingOverrideInput = z.infer<typeof ManualRoutingOverrideInputSchema>;
export type ReviewRoutingDecisionInput = z.infer<typeof ReviewRoutingDecisionInputSchema>;
export type SupplierRoutingCandidate = z.infer<typeof SupplierRoutingCandidateSchema>;
export type SupplierProductionOrderInput = z.infer<typeof SupplierProductionOrderInputSchema>;
