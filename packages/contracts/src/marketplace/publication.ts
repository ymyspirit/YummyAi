import { z } from "zod";

import { EntityIdSchema } from "../common/ids.js";
import { MarketplacePlatformSchema } from "./store.js";

export const CreateMarketplacePublicationInputSchema = z.object({
  accountId: EntityIdSchema,
  listingId: EntityIdSchema,
  listingVersionId: EntityIdSchema,
  marketplaceId: z.string().trim().min(1).max(80),
  variantSkuId: z.string().trim().min(1).max(160).optional(),
  scheduledFor: z.iso.datetime({ offset: true }).optional(),
}).strict();

export const MarketplacePublicationBatchItemInputSchema = z.object({
  listingId: EntityIdSchema,
  listingVersionId: EntityIdSchema,
  variantSkuId: z.string().trim().min(1).max(160).optional(),
}).strict();

export const CreateMarketplacePublicationBatchInputSchema = z.object({
  accountId: EntityIdSchema,
  marketplaceId: z.string().trim().min(1).max(80),
  items: z.array(MarketplacePublicationBatchItemInputSchema).min(2).max(100),
  scheduledFor: z.iso.datetime({ offset: true }).optional(),
}).strict().superRefine((input, context) => {
  const seen = new Set<string>();
  for (const [index, item] of input.items.entries()) {
    const key = `${item.listingId}:${item.listingVersionId}:${item.variantSkuId ?? ""}`;
    if (seen.has(key)) {
      context.addIssue({ code: "custom", message: "Batch publication items must be unique", path: ["items", index] });
    }
    seen.add(key);
  }
});

export const CancelMarketplacePublicationInputSchema = z.object({
  reason: z.string().trim().min(1).max(500),
}).strict();

export const ListMarketplacePublicationsInputSchema = z.object({
  accountId: EntityIdSchema.optional(),
  listingId: EntityIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const ListMarketplacePublicationBatchesInputSchema = z.object({
  accountId: EntityIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const MarketplacePublicationActionSchema = z.enum([
  "amazon_validation_preview",
  "amazon_submit",
  "amazon_feed_submit",
  "etsy_create_draft",
  "etsy_activate",
]);

export const MarketplacePublicationBatchActionSchema = z.enum(["initial", "continue"]);

export const MarketplacePublicationBatchStatusSchema = z.enum([
  "scheduled",
  "queued",
  "processing",
  "ready_to_continue",
  "completed",
  "partial",
  "failed",
  "reconciliation_required",
  "cancelled",
]);

export const MarketplacePublicationStatusSchema = z.enum([
  "scheduled",
  "queued",
  "processing",
  "validation_passed",
  "validation_failed",
  "draft_created",
  "configuration_applied",
  "submission_accepted",
  "media_uploaded",
  "activation_accepted",
  "sync_pending",
  "published",
  "publication_failed",
  "deactivated",
  "retry_pending",
  "reconciliation_required",
  "cancelled",
  "failed",
]);

export const MarketplacePublicationIssueSchema = z.object({
  code: z.string().min(1).max(200),
  message: z.string().min(1).max(2_000),
  path: z.string().max(500).optional(),
  severity: z.enum(["blocker", "warning", "info"]),
});

export const MarketplacePublicationEventViewSchema = z.object({
  id: EntityIdSchema,
  sequence: z.number().int().positive(),
  status: MarketplacePublicationStatusSchema,
  code: z.string().nullable(),
  message: z.string().nullable(),
  issues: z.array(MarketplacePublicationIssueSchema),
  externalListingId: z.string().nullable(),
  externalSubmissionId: z.string().nullable(),
  externalMediaIds: z.array(z.string()),
  externalState: z.string().nullable(),
  retryable: z.boolean(),
  occurredAt: z.iso.datetime(),
});

export const MarketplacePublicationRequestViewSchema = z.object({
  id: EntityIdSchema,
  accountId: EntityIdSchema,
  capabilitySnapshotId: EntityIdSchema,
  listingId: EntityIdSchema,
  listingVersionId: EntityIdSchema,
  platform: MarketplacePlatformSchema,
  marketplaceId: z.string(),
  action: MarketplacePublicationActionSchema,
  batchId: EntityIdSchema.nullable().default(null),
  parentRequestId: EntityIdSchema.nullable(),
  sourceExternalListingId: z.string().nullable(),
  idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/),
  payloadChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  targetLabel: z.string().min(1).max(500).nullable().default(null),
  assetCount: z.number().int().nonnegative(),
  scheduledFor: z.iso.datetime().nullable(),
  createdBy: EntityIdSchema.nullable(),
  createdAt: z.iso.datetime(),
  current: MarketplacePublicationEventViewSchema,
});

export const MarketplacePublicationBatchViewSchema = z.object({
  id: EntityIdSchema,
  accountId: EntityIdSchema,
  capabilitySnapshotId: EntityIdSchema,
  platform: MarketplacePlatformSchema,
  marketplaceId: z.string().min(1).max(80),
  action: MarketplacePublicationBatchActionSchema,
  parentBatchId: EntityIdSchema.nullable(),
  idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/),
  itemCount: z.number().int().min(2).max(100),
  scheduledFor: z.iso.datetime().nullable(),
  createdBy: EntityIdSchema.nullable(),
  createdAt: z.iso.datetime(),
  status: MarketplacePublicationBatchStatusSchema,
  counts: z.object({
    total: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    reconciliationRequired: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }).strict(),
  items: z.array(MarketplacePublicationRequestViewSchema),
});

export type CreateMarketplacePublicationInput = z.infer<typeof CreateMarketplacePublicationInputSchema>;
export type MarketplacePublicationBatchItemInput = z.infer<typeof MarketplacePublicationBatchItemInputSchema>;
export type CreateMarketplacePublicationBatchInput = z.infer<typeof CreateMarketplacePublicationBatchInputSchema>;
export type CancelMarketplacePublicationInput = z.infer<typeof CancelMarketplacePublicationInputSchema>;
export type ListMarketplacePublicationsInput = z.infer<typeof ListMarketplacePublicationsInputSchema>;
export type ListMarketplacePublicationBatchesInput = z.infer<typeof ListMarketplacePublicationBatchesInputSchema>;
export type MarketplacePublicationAction = z.infer<typeof MarketplacePublicationActionSchema>;
export type MarketplacePublicationBatchAction = z.infer<typeof MarketplacePublicationBatchActionSchema>;
export type MarketplacePublicationBatchStatus = z.infer<typeof MarketplacePublicationBatchStatusSchema>;
export type MarketplacePublicationBatchView = z.infer<typeof MarketplacePublicationBatchViewSchema>;
export type MarketplacePublicationStatus = z.infer<typeof MarketplacePublicationStatusSchema>;
export type MarketplacePublicationIssue = z.infer<typeof MarketplacePublicationIssueSchema>;
export type MarketplacePublicationEventView = z.infer<typeof MarketplacePublicationEventViewSchema>;
export type MarketplacePublicationRequestView = z.infer<typeof MarketplacePublicationRequestViewSchema>;
