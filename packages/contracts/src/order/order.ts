import { z } from "zod";

import { EntityIdSchema } from "../common/ids.js";
import { MarketplacePlatformSchema } from "../marketplace/store.js";

export const OrderWorkflowStateSchema = z.enum([
  "pending", "awaiting_customization", "awaiting_design", "awaiting_customer_approval", "awaiting_routing",
  "in_production", "awaiting_quality_control", "awaiting_shipment", "shipped", "completed",
]);
export const OrderSideStateSchema = z.enum(["on_hold", "cancelled"]);
export const OrderExceptionCategorySchema = z.enum([
  "address", "customization_missing", "design_overdue", "customer_timeout", "sourcing", "production",
  "quality", "logistics", "cancellation_requested", "refund", "remake", "reshipment",
]);
export const OrderMoneySchema = z.object({ amountMinor: z.number().int().safe(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
export const OrderAddressReferenceSchema = z.object({ status: z.enum(["missing", "protected", "anonymized"]), countryCode: z.string().regex(/^[A-Z]{2}$/).nullable() }).strict();

export const OrderCustomizationValueSchema = z.discriminatedUnion("type", [
  z.object({ key: z.string().trim().min(1).max(160), label: z.string().trim().min(1).max(240), type: z.literal("text"), value: z.string().max(10_000) }).strict(),
  z.object({ key: z.string().trim().min(1).max(160), label: z.string().trim().min(1).max(240), type: z.literal("choice"), values: z.array(z.string().max(500)).min(1).max(50) }).strict(),
  z.object({ key: z.string().trim().min(1).max(160), label: z.string().trim().min(1).max(240), type: z.literal("file_reference"), externalReference: z.string().trim().min(1).max(1_000) }).strict(),
]);
export const OrderProtectedDetailsSchema = z.object({
  buyer: z.object({ name: z.string().trim().min(1).max(300).nullable(), email: z.email().max(320).nullable(), phone: z.string().trim().min(1).max(80).nullable() }).strict(),
  shippingAddress: z.object({
    recipient: z.string().trim().min(1).max(300).nullable(), lines: z.array(z.string().trim().min(1).max(500)).max(5),
    city: z.string().trim().min(1).max(200).nullable(), region: z.string().trim().min(1).max(200).nullable(),
    postalCode: z.string().trim().min(1).max(80).nullable(), countryCode: z.string().regex(/^[A-Z]{2}$/).nullable(),
  }).strict(),
  customizations: z.array(z.object({ externalLineId: z.string().trim().min(1).max(300), values: z.array(OrderCustomizationValueSchema).max(100) }).strict()).max(1_000),
}).strict();

export const OrderLineInputSchema = z.object({
  externalLineId: z.string().trim().min(1).max(300), externalListingId: z.string().trim().min(1).max(300).nullable().default(null),
  skuCode: z.string().trim().min(1).max(200).nullable().default(null), title: z.string().trim().min(1).max(1_000),
  quantity: z.number().int().positive().max(100_000), unitPrice: OrderMoneySchema,
  customizationCount: z.number().int().nonnegative().max(100).default(0),
}).strict();
export const NormalizeOrderInputSchema = z.object({
  accountId: EntityIdSchema, platform: MarketplacePlatformSchema, externalEventId: z.string().trim().min(1).max(500),
  externalOrderId: z.string().trim().min(1).max(500), providerStatus: z.string().trim().min(1).max(200),
  placedAt: z.iso.datetime(), orderTotal: OrderMoneySchema, lines: z.array(OrderLineInputSchema).min(1).max(5_000),
  redactedSource: z.record(z.string(), z.unknown()), protectedDetails: OrderProtectedDetailsSchema.nullable().default(null),
}).strict();

export const OrderLineViewSchema = z.object({
  id: EntityIdSchema, externalLineId: z.string(), externalListingId: z.string().nullable(), skuCode: z.string().nullable(),
  title: z.string(), quantity: z.number().int().positive(), unitPrice: OrderMoneySchema, customizationCount: z.number().int().nonnegative(),
}).strict();
export const OrderViewSchema = z.object({
  id: EntityIdSchema, accountId: EntityIdSchema, platform: MarketplacePlatformSchema, externalOrderId: z.string(),
  providerStatus: z.string(), workflowState: OrderWorkflowStateSchema, sideState: OrderSideStateSchema.nullable(),
  orderTotal: OrderMoneySchema, lineCount: z.number().int().positive(), address: OrderAddressReferenceSchema,
  latestEventSequence: z.number().int().positive(), placedAt: z.iso.datetime(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  lines: z.array(OrderLineViewSchema),
}).strict();
export const OrderPiiAccessPurposeSchema = z.enum(["fulfillment", "customer_support", "fraud_review", "legal", "retention"]);
export const OrderFulfillmentViewSchema = z.object({
  order: OrderViewSchema, purpose: OrderPiiAccessPurposeSchema, protectedDetails: OrderProtectedDetailsSchema.nullable(), accessedAt: z.iso.datetime(),
}).strict();
export const AnonymizeOrderProtectedDetailsCommandSchema = z.object({
  expectedSequence: z.number().int().positive(), expectedEnvelopeVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(8).max(200), reason: z.string().trim().min(1).max(1_000),
}).strict();
export const ListOrdersInputSchema = z.object({
  workflowState: OrderWorkflowStateSchema.optional(), sideState: z.union([OrderSideStateSchema, z.literal("none")]).optional(),
  platform: MarketplacePlatformSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const OrderIngestionRunStatusSchema = z.enum(["running", "completed", "partial", "failed"]);
export const OrderIngestionRiskCodeSchema = z.enum([
  "duplicate_delivery", "address_gap", "customization_missing", "unsupported_mapping", "cancellation_requested", "stale_provider_data",
]);
export const OrderIngestionRiskSeveritySchema = z.enum(["blocker", "warning", "info"]);
export const OrderIngestionRiskInputSchema = z.object({
  code: OrderIngestionRiskCodeSchema, severity: OrderIngestionRiskSeveritySchema,
  externalOrderId: z.string().trim().min(1).max(500), externalLineId: z.string().trim().min(1).max(300).nullable(),
  message: z.string().trim().min(1).max(500),
}).strict();
export const CompleteOrderIngestionRunInputSchema = z.object({
  collectedCount: z.number().int().nonnegative(), reportedCount: z.number().int().nonnegative().nullable(),
  duplicateCount: z.number().int().nonnegative(), sourceVersion: z.string().trim().min(1).max(200),
  nextCursor: z.string().trim().min(1).max(4_000).nullable(), highWaterAt: z.iso.datetime(),
  risks: z.array(OrderIngestionRiskInputSchema).max(10_000), status: z.enum(["completed", "partial"]),
}).strict();
export const OrderConnectorCheckpointViewSchema = z.object({
  accountId: EntityIdSchema, platform: MarketplacePlatformSchema, stream: z.string(), cursor: z.string().nullable(),
  highWaterAt: z.iso.datetime().nullable(), version: z.number().int().positive(), updatedAt: z.iso.datetime(),
}).strict();
export const OrderIngestionRiskViewSchema = OrderIngestionRiskInputSchema.extend({
  id: EntityIdSchema, ingestionRunId: EntityIdSchema, orderId: EntityIdSchema.nullable(), createdAt: z.iso.datetime(),
}).strict();
export const OrderIngestionRunViewSchema = z.object({
  id: EntityIdSchema, accountId: EntityIdSchema, platform: MarketplacePlatformSchema, stream: z.string(), status: OrderIngestionRunStatusSchema,
  collectedCount: z.number().int().nonnegative(), reportedCount: z.number().int().nonnegative().nullable(),
  duplicateCount: z.number().int().nonnegative(), riskCount: z.number().int().nonnegative(), sourceVersion: z.string(),
  checkpointVersionStart: z.number().int().positive(), checkpointVersionEnd: z.number().int().positive().nullable(),
  highWaterAt: z.iso.datetime().nullable(), errorCode: z.string().nullable(), startedAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(),
  risks: z.array(OrderIngestionRiskViewSchema),
}).strict();

export const OrderTransitionCommandSchema = z.object({
  toState: OrderWorkflowStateSchema, expectedSequence: z.number().int().positive(), idempotencyKey: z.string().trim().min(8).max(200),
  reason: z.string().trim().min(1).max(1_000).optional(),
}).strict();
export const OrderSideStateCommandSchema = z.object({
  action: z.enum(["hold", "release", "cancel"]), expectedSequence: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(8).max(200), reason: z.string().trim().min(1).max(1_000),
}).strict();
export const OpenOrderExceptionCommandSchema = z.object({
  category: OrderExceptionCategorySchema, code: z.string().trim().min(1).max(160), message: z.string().trim().min(1).max(2_000),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();
export const ResolveOrderExceptionCommandSchema = z.object({ resolution: z.string().trim().min(1).max(2_000), idempotencyKey: z.string().trim().min(8).max(200) }).strict();

export const OrderEventTypeSchema = z.enum([
  "order_ingested", "provider_update_received", "workflow_transitioned", "side_state_changed", "exception_opened", "exception_resolved",
  "protected_details_accessed", "protected_details_anonymized",
]);
export const OrderEventViewSchema = z.object({
  id: EntityIdSchema, sequence: z.number().int().positive(), type: OrderEventTypeSchema,
  fromWorkflowState: OrderWorkflowStateSchema.nullable(), toWorkflowState: OrderWorkflowStateSchema.nullable(),
  fromSideState: OrderSideStateSchema.nullable(), toSideState: OrderSideStateSchema.nullable(),
  code: z.string().nullable(), message: z.string().nullable(), idempotencyKey: z.string(), occurredAt: z.iso.datetime(),
}).strict();
export const OrderExceptionViewSchema = z.object({
  id: EntityIdSchema, orderId: EntityIdSchema, category: OrderExceptionCategorySchema, code: z.string(), message: z.string(), status: z.enum(["open", "resolved"]),
  resolution: z.string().nullable(), openedAt: z.iso.datetime(), resolvedAt: z.iso.datetime().nullable(),
}).strict();

export type OrderWorkflowState = z.infer<typeof OrderWorkflowStateSchema>;
export type OrderSideState = z.infer<typeof OrderSideStateSchema>;
export type OrderExceptionCategory = z.infer<typeof OrderExceptionCategorySchema>;
export type OrderMoney = z.infer<typeof OrderMoneySchema>;
export type OrderCustomizationValue = z.infer<typeof OrderCustomizationValueSchema>;
export type OrderProtectedDetails = z.infer<typeof OrderProtectedDetailsSchema>;
export type NormalizeOrderInput = z.infer<typeof NormalizeOrderInputSchema>;
export type OrderView = z.infer<typeof OrderViewSchema>;
export type OrderFulfillmentView = z.infer<typeof OrderFulfillmentViewSchema>;
export type AnonymizeOrderProtectedDetailsCommand = z.infer<typeof AnonymizeOrderProtectedDetailsCommandSchema>;
export type ListOrdersInput = z.infer<typeof ListOrdersInputSchema>;
export type OrderTransitionCommand = z.infer<typeof OrderTransitionCommandSchema>;
export type OrderSideStateCommand = z.infer<typeof OrderSideStateCommandSchema>;
export type OpenOrderExceptionCommand = z.infer<typeof OpenOrderExceptionCommandSchema>;
export type ResolveOrderExceptionCommand = z.infer<typeof ResolveOrderExceptionCommandSchema>;
export type OrderEventView = z.infer<typeof OrderEventViewSchema>;
export type OrderExceptionView = z.infer<typeof OrderExceptionViewSchema>;
export type OrderPiiAccessPurpose = z.infer<typeof OrderPiiAccessPurposeSchema>;
export type OrderIngestionRunStatus = z.infer<typeof OrderIngestionRunStatusSchema>;
export type OrderIngestionRiskCode = z.infer<typeof OrderIngestionRiskCodeSchema>;
export type OrderIngestionRiskInput = z.infer<typeof OrderIngestionRiskInputSchema>;
export type CompleteOrderIngestionRunInput = z.infer<typeof CompleteOrderIngestionRunInputSchema>;
export type OrderConnectorCheckpointView = z.infer<typeof OrderConnectorCheckpointViewSchema>;
export type OrderIngestionRiskView = z.infer<typeof OrderIngestionRiskViewSchema>;
export type OrderIngestionRunView = z.infer<typeof OrderIngestionRunViewSchema>;
