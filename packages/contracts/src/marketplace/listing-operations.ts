import { z } from "zod";

import { EntityIdSchema } from "../common/ids.js";
import { MarketplacePublicationIssueSchema } from "./publication.js";
import { MarketplacePlatformSchema } from "./store.js";

export const ListingReplicationOverridesSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(20_000).optional(),
  bullets: z.array(z.string().trim().min(1).max(1_000)).max(10).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  compliance: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
}).strict();

export const CreateListingReplicationInputSchema = z.object({
  sourceVersionId: EntityIdSchema,
  targetMarketplaceId: z.string().trim().min(1).max(80),
  targetLocale: z.string().trim().min(2).max(20),
  overrides: ListingReplicationOverridesSchema.default({}),
}).strict();

export const ListingReplicationViewSchema = z.object({
  id: EntityIdSchema,
  sourceListingId: EntityIdSchema,
  sourceVersionId: EntityIdSchema,
  targetListingId: EntityIdSchema,
  targetVersionId: EntityIdSchema,
  platform: MarketplacePlatformSchema,
  targetMarketplaceId: z.string(),
  targetLocale: z.string(),
  overrides: ListingReplicationOverridesSchema,
  createdBy: EntityIdSchema.nullable(),
  createdAt: z.iso.datetime(),
});

export const MarketplaceListingSyncActionSchema = z.enum(["read", "push_price_inventory"]);
export const MarketplaceListingSyncStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "drift_detected",
  "retry_pending",
  "reconciliation_required",
  "failed",
]);

export const CreateMarketplaceListingSyncInputSchema = z.object({
  accountId: EntityIdSchema,
  listingId: EntityIdSchema,
  listingVersionId: EntityIdSchema,
  sourcePublicationRequestId: EntityIdSchema,
  action: MarketplaceListingSyncActionSchema,
  requestKey: EntityIdSchema.optional(),
}).strict();

export const ListMarketplaceListingSyncsInputSchema = z.object({
  accountId: EntityIdSchema.optional(),
  listingId: EntityIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const MarketplaceOnlineListingSnapshotSchema = z.object({
  externalState: z.string().min(1).max(500),
  price: z.unknown().nullable(),
  inventory: z.unknown().nullable(),
  observedAt: z.iso.datetime(),
});

export const MarketplaceListingSyncEventViewSchema = z.object({
  id: EntityIdSchema,
  sequence: z.number().int().positive(),
  status: MarketplaceListingSyncStatusSchema,
  code: z.string().nullable(),
  message: z.string().nullable(),
  issues: z.array(MarketplacePublicationIssueSchema),
  snapshot: MarketplaceOnlineListingSnapshotSchema.nullable(),
  snapshotChecksum: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  retryable: z.boolean(),
  occurredAt: z.iso.datetime(),
});

export const MarketplaceListingSyncRequestViewSchema = z.object({
  id: EntityIdSchema,
  accountId: EntityIdSchema,
  sourcePublicationRequestId: EntityIdSchema,
  listingId: EntityIdSchema,
  listingVersionId: EntityIdSchema,
  platform: MarketplacePlatformSchema,
  marketplaceId: z.string(),
  externalListingId: z.string(),
  action: MarketplaceListingSyncActionSchema,
  idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/),
  desiredChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  createdBy: EntityIdSchema.nullable(),
  createdAt: z.iso.datetime(),
  current: MarketplaceListingSyncEventViewSchema,
});

export const MarketplaceAutomationTriggerSchema = z.literal("listing_approved");
export const MarketplaceAutomationConditionsSchema = z.object({
  listingId: EntityIdSchema.optional(),
  platform: MarketplacePlatformSchema.optional(),
  locale: z.string().trim().min(2).max(20).optional(),
  minimumCompleteness: z.number().int().min(0).max(100).default(100),
}).strict();

export const MarketplaceAutomationActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("queue_publication"),
    accountId: EntityIdSchema,
    marketplaceId: z.string().trim().min(1).max(80),
    variantSkuId: z.string().trim().min(1).max(160).optional(),
  }).strict(),
  z.object({
    type: z.literal("queue_listing_sync"),
    accountId: EntityIdSchema,
    sourcePublicationRequestId: EntityIdSchema,
    action: MarketplaceListingSyncActionSchema,
  }).strict(),
]);

export const CreateMarketplaceAutomationRuleInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  trigger: MarketplaceAutomationTriggerSchema.default("listing_approved"),
  conditions: MarketplaceAutomationConditionsSchema.default({ minimumCompleteness: 100 }),
  action: MarketplaceAutomationActionSchema,
  enabled: z.boolean().default(false),
}).strict();

export const UpdateMarketplaceAutomationRuleInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  conditions: MarketplaceAutomationConditionsSchema.optional(),
  action: MarketplaceAutomationActionSchema.optional(),
  enabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const MarketplaceAutomationRuleViewSchema = z.object({
  id: EntityIdSchema,
  name: z.string(),
  trigger: MarketplaceAutomationTriggerSchema,
  conditions: MarketplaceAutomationConditionsSchema,
  action: MarketplaceAutomationActionSchema,
  enabled: z.boolean(),
  createdBy: EntityIdSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const MarketplaceAutomationRunStatusSchema = z.enum(["skipped", "enqueued", "failed"]);
export const MarketplaceAutomationRunViewSchema = z.object({
  id: EntityIdSchema,
  ruleId: EntityIdSchema,
  listingId: EntityIdSchema,
  listingVersionId: EntityIdSchema,
  status: MarketplaceAutomationRunStatusSchema,
  outputType: z.string().nullable(),
  outputId: EntityIdSchema.nullable(),
  code: z.string().nullable(),
  message: z.string().nullable(),
  occurredAt: z.iso.datetime(),
});

export type ListingReplicationOverrides = z.infer<typeof ListingReplicationOverridesSchema>;
export type CreateListingReplicationInput = z.infer<typeof CreateListingReplicationInputSchema>;
export type ListingReplicationView = z.infer<typeof ListingReplicationViewSchema>;
export type MarketplaceListingSyncAction = z.infer<typeof MarketplaceListingSyncActionSchema>;
export type MarketplaceListingSyncStatus = z.infer<typeof MarketplaceListingSyncStatusSchema>;
export type CreateMarketplaceListingSyncInput = z.infer<typeof CreateMarketplaceListingSyncInputSchema>;
export type ListMarketplaceListingSyncsInput = z.infer<typeof ListMarketplaceListingSyncsInputSchema>;
export type MarketplaceOnlineListingSnapshot = z.infer<typeof MarketplaceOnlineListingSnapshotSchema>;
export type MarketplaceListingSyncEventView = z.infer<typeof MarketplaceListingSyncEventViewSchema>;
export type MarketplaceListingSyncRequestView = z.infer<typeof MarketplaceListingSyncRequestViewSchema>;
export type MarketplaceAutomationConditions = z.infer<typeof MarketplaceAutomationConditionsSchema>;
export type MarketplaceAutomationAction = z.infer<typeof MarketplaceAutomationActionSchema>;
export type CreateMarketplaceAutomationRuleInput = z.infer<typeof CreateMarketplaceAutomationRuleInputSchema>;
export type UpdateMarketplaceAutomationRuleInput = z.infer<typeof UpdateMarketplaceAutomationRuleInputSchema>;
export type MarketplaceAutomationRuleView = z.infer<typeof MarketplaceAutomationRuleViewSchema>;
export type MarketplaceAutomationRunStatus = z.infer<typeof MarketplaceAutomationRunStatusSchema>;
export type MarketplaceAutomationRunView = z.infer<typeof MarketplaceAutomationRunViewSchema>;
