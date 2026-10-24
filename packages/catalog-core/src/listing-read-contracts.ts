import type { Permission } from "@yummyai/authz";
import type { ListingDraft,ListingPlatform,ListingValidation } from "@yummyai/platform-rules";
import { z } from "zod";
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const publication = z.discriminatedUnion("platform", [
  z
    .object({
      platform: z.literal("amazon"),
      productType: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .regex(/^[A-Z0-9_]+$/),
      attributes: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      platform: z.literal("etsy"),
      price: z
        .object({ amount: z.number().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) })
        .strict(),
      quantity: z.number().int().positive().max(999),
      whoMade: z.enum(["i_did", "collective", "someone_else"]),
      whenMade: z.string().trim().min(1).max(120),
      taxonomyId: z.number().int().positive(),
      shippingProfileId: z.number().int().positive(),
      readinessStateId: z.number().int().positive(),
      shopSectionId: z.number().int().positive().optional(),
      isSupply: z.boolean().optional(),
      inventory: z
        .object({
          products: z
            .array(
              z
                .object({
                  sku: z.string().trim().min(1).max(160),
                  propertyValues: z
                    .array(
                      z
                        .object({
                          propertyId: z.number().int().positive(),
                          propertyName: z.string().trim().min(1).max(120),
                          scaleId: z.number().int().positive().optional(),
                          valueIds: z.array(z.number().int().positive()),
                          values: z.array(z.string().trim().min(1).max(200)),
                        })
                        .strict(),
                    )
                    .max(3),
                  offerings: z
                    .array(
                      z
                        .object({
                          price: z
                            .object({
                              amount: z.number().nonnegative(),
                              currency: z.string().regex(/^[A-Z]{3}$/),
                            })
                            .strict(),
                          quantity: z.number().int().nonnegative().max(999),
                          isEnabled: z.boolean(),
                          readinessStateId: z.number().int().positive().optional(),
                        })
                        .strict(),
                    )
                    .min(1),
                })
                .strict(),
            )
            .min(1)
            .max(500),
          priceOnProperty: z.array(z.number().int().positive()).max(3),
          quantityOnProperty: z.array(z.number().int().positive()).max(3),
          skuOnProperty: z.array(z.number().int().positive()).max(3),
          readinessStateOnProperty: z.array(z.number().int().positive()).max(3),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
export const ListingDraftSchema = z
  .object({
    platform: z.enum(["amazon", "etsy"]),
    locale: z.string().min(2).max(20),
    title: z.string(),
    description: z.string(),
    bullets: z.array(z.string()),
    tags: z.array(z.string()),
    mainImageId: z.string().optional(),
    mediaAssetIds: z.array(z.string()),
    variants: z.array(
      z.object({
        skuId: z.string().min(1),
        skuCode: z.string().min(1),
        optionValues: z.record(z.string(), z.string()),
      }),
    ),
    attributes: z.record(z.string(), scalar),
    compliance: z.record(z.string(), scalar),
    publication: publication.optional(),
    aPlusModules: z
      .array(
        z.object({
          type: z.string(),
          assetIds: z.array(z.string()),
          headline: z.string().optional(),
        }),
      )
      .optional(),
    mediaDescriptions: z.record(z.uuidv7(), z.string().max(500)).optional(),
    personalization: z
      .object({
        enabled: z.boolean(),
        instructions: z.string().optional(),
        required: z.boolean().optional(),
        maxAllowedCharacters: z.number().int().min(1).max(1_024).optional(),
      })
      .optional(),
  })
  .refine(
    (draft) =>
      Object.keys(draft.mediaDescriptions ?? {}).every((id) => draft.mediaAssetIds.includes(id)),
    { message: "图片说明必须关联当前媒体" },
  );

export interface ListingRecord {
  ownerUserId?: string;
  id: string;
  tenantId: string;
  spuId: string;
  styleId?: string;
  salesPlanId?: string;
  salesPlanRevision?: number;
  platform: ListingPlatform;
  marketplaceId?: string;
  locale: string;
  status: "draft" | "in_review" | "approved" | "archived";
  primaryVersionId?: string;
}

export interface ListingVersionRecord {
  id: string;
  tenantId: string;
  listingId: string;
  versionNumber: number;
  ruleVersion: string;
  status: "draft" | "approved" | "superseded";
  source: "human" | "ai";
  content: ListingDraft;
  validation: ListingValidation;
  createdAt: Date;
}

export const ListingCatalogQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  platform: z.enum(["amazon", "etsy"]).optional(),
  status: z.enum(["draft", "in_review", "approved", "archived"]).optional(),
  locale: z.string().trim().max(20).optional(),
  marketplaceId: z.string().trim().max(80).optional(),
  completeness: z.enum(["all", "low", "partial", "complete"]).default("all"),
  blockers: z.enum(["all", "with", "without"]).default("all"),
  sort: z.enum(["updatedAt", "title", "completeness", "versionNumber"]).default("updatedAt"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListingCatalogQuery = z.infer<typeof ListingCatalogQuerySchema>;

export interface ListingCatalogItem {
  ownerUserId?: string;
  productAccess?: boolean;
  id: string;
  spuId: string;
  spuCode: string;
  spuName: string;
  platform: ListingPlatform;
  marketplaceId?: string;
  locale: string;
  status: ListingRecord["status"];
  primaryVersionId?: string;
  versionId: string;
  versionNumber: number;
  title: string;
  hasMainImage: boolean;
  completeness: number;
  blockerCount: number;
  source: ListingVersionRecord["source"];
  updatedAt: string;
}

export type ListingAccessPermission =
  typeof Permission.ListingRead | typeof Permission.ListingWrite | typeof Permission.ListingReview;
