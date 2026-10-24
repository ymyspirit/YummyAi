import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { SealSalesPackageSchema } from "@yummyai/contracts/catalog/development";
import type { SpecificationFacts } from "@yummyai/contracts/catalog/development";
import { CustomizationSchema } from "@yummyai/contracts/catalog/product";
import { ArtworkLayoutSchema } from "@yummyai/contracts/catalog/artwork";
import { PrintBindingsSchema } from "@yummyai/contracts/catalog/composition";
import { SalesPlanFieldsSchema } from "@yummyai/contracts/catalog/sales-plan";

export const DeliveryReadQuerySchema = z
  .object({ packagePage: z.coerce.number().int().min(1).max(100000).default(1) })
  .strict();
export const DeliveryExportQuerySchema = z
  .object({ basis: z.enum(["current", "history"]).default("current") })
  .strict();

export const DeliveryChecksSchema = z
  .object({
    skuFacts: z.literal(true),
    customization: z.literal(true),
    images: z.literal(true),
    copyClaims: z.literal(true),
  })
  .strict();
export const DeliveryReviewSchema = z
  .object({
    expectedRevision: z.int().positive(),
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    listingVersionId: Id,
    imageEvidence: SealSalesPackageSchema.shape.imageEvidence,
    checks: DeliveryChecksSchema,
    note: z.string().trim().min(1).max(2000),
    idempotencyKey: z.uuid(),
  })
  .strict();
export const DeliverySealSchema = z
  .object({
    reviewId: Id,
    skuId: Id,
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.uuid(),
  })
  .strict();
// The immutable package can contain additional listing/material evidence. Order
// intake reads only these pinned fields, never today's mutable sales plan.
export const OrderSalesDeliverySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  planId: Id,
  revision: z.int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  review: z.object({
    id: Id,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.int().positive(),
    listingVersionId: Id,
    actor: z.string().min(1),
    occurredAt: z.iso.datetime(),
    checks: DeliveryChecksSchema,
  }),
  customization: CustomizationSchema,
  layout: ArtworkLayoutSchema,
  patternChoices: SalesPlanFieldsSchema.shape.patternChoices,
  skuMapping: z
    .array(
      z.object({
        skuId: Id,
        skuCode: z.string().min(1),
        recipeId: Id,
        specificationVersionId: Id,
        platformSkuId: Id.optional(),
        platformSkuCode: z.string().min(1).optional(),
        customChoice: z.record(z.string(), z.string()).optional(),
        printBindings: PrintBindingsSchema.optional(),
        customization: CustomizationSchema.optional(),
        layout: ArtworkLayoutSchema.optional(),
      }),
    )
    .min(1)
    .max(50),
});
export type DeliveryEvidence = z.infer<typeof SealSalesPackageSchema.shape.imageEvidence>;
export type DeliveryIssue = { path: string; message: string; href: string };
export type DeliveryReview = {
  id: string;
  fingerprint: string;
  revision: number;
  listingVersionId: string;
  actor: string;
  occurredAt: string;
  note: string;
  checks: z.infer<typeof DeliveryChecksSchema>;
  imageEvidence: DeliveryEvidence;
};
export type SalesPlanPackageView = {
  id: string;
  skuId: string;
  skuCode: string;
  version: number;
  checksum: string;
  current: boolean;
  reviewedDelivery: boolean;
  createdAt: string;
  downloadPath: string;
};
export type SalesPlanDelivery = {
  planId: string;
  revision: number;
  fingerprint: string;
  supported: boolean;
  access: { read: boolean; review: boolean; seal: boolean; download: boolean };
  listing: {
    id: string;
    versionId: string;
    version: number;
    status: string;
    title: string;
    href: string;
  } | null;
  issues: DeliveryIssue[];
  customization: Array<{
    key: string;
    label: string;
    type: string;
    required: boolean;
    details: string;
  }>;
  instructions: string;
  configurationEvidence: string;
  copy: { title: string; bullets: string[]; description: string; personalization: string } | null;
  skus: Array<{
    id: string;
    code: string;
    recipeId: string | null;
    specification: string;
    attributes: Record<string, string>;
    facts: SpecificationFacts | null;
    issues: DeliveryIssue[];
    href: string;
  }>;
  images: Array<{
    id: string;
    name: string;
    main: boolean;
    previewPath: string;
    suggestedKind: DeliveryEvidence[number]["kind"] | null;
    issues: DeliveryIssue[];
  }>;
  review:
    | (DeliveryReview & { current: boolean; changes: Array<{ label: string; effects: string[] }> })
    | null;
  packages: SalesPlanPackageView[];
  currentPackages: SalesPlanPackageView[];
  packageHistory: { page: number; pageSize: number; hasMore: boolean };
  diagnostics: string[];
};
