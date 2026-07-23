import { z } from "zod";

import { EntityIdSchema } from "../common/ids.js";
import { MarketplacePlatformSchema } from "./store.js";

export const CreateMarketplacePublicationInputSchema = z.object({
  accountId: EntityIdSchema,
  listingId: EntityIdSchema,
  listingVersionId: EntityIdSchema,
  marketplaceId: z.string().trim().min(1).max(80),
  variantSkuId: z.string().trim().min(1).max(160).optional(),
}).strict();

export const ListMarketplacePublicationsInputSchema = z.object({
  accountId: EntityIdSchema.optional(),
  listingId: EntityIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const MarketplacePublicationActionSchema = z.enum([
  "amazon_validation_preview",
  "amazon_submit",
  "etsy_create_draft",
  "etsy_activate",
]);

export const MarketplacePublicationStatusSchema = z.enum([
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
  parentRequestId: EntityIdSchema.nullable(),
  sourceExternalListingId: z.string().nullable(),
  idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/),
  payloadChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  assetCount: z.number().int().nonnegative(),
  createdBy: EntityIdSchema.nullable(),
  createdAt: z.iso.datetime(),
  current: MarketplacePublicationEventViewSchema,
});

export type CreateMarketplacePublicationInput = z.infer<typeof CreateMarketplacePublicationInputSchema>;
export type ListMarketplacePublicationsInput = z.infer<typeof ListMarketplacePublicationsInputSchema>;
export type MarketplacePublicationAction = z.infer<typeof MarketplacePublicationActionSchema>;
export type MarketplacePublicationStatus = z.infer<typeof MarketplacePublicationStatusSchema>;
export type MarketplacePublicationIssue = z.infer<typeof MarketplacePublicationIssueSchema>;
export type MarketplacePublicationEventView = z.infer<typeof MarketplacePublicationEventViewSchema>;
export type MarketplacePublicationRequestView = z.infer<typeof MarketplacePublicationRequestViewSchema>;
