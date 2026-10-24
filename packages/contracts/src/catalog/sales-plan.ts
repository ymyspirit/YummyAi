import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { CustomizationSchema, MoneySchema } from "@yummyai/contracts/catalog/product";
import { ArtworkLayoutSchema } from "@yummyai/contracts/catalog/artwork";
import type {
  ArtworkView,
  ProductSpuView,
  SpecificationView,
} from "@yummyai/contracts/catalog/development";

const note = z.string().trim().max(5000).default("");
const ids = z
  .array(Id)
  .max(100)
  .default([])
  .refine((value) => new Set(value).size === value.length, "关联记录不可重复");
export const SalesPlanFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    mode: z.enum(["custom", "standard"]),
    fulfillment: z.enum(["fbm", "fba"]),
    audience: note,
    scenario: note,
    positioning: note,
    researchConclusion: note,
    keywords: z.array(z.string().trim().min(1).max(160)).max(100).default([]),
    targetPrice: MoneySchema.nullable().default(null),
    researchItemIds: ids,
    specificationIds: ids,
    skuIds: ids,
    patternChoices: z
      .object({
        fieldKey: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
        options: z
          .array(
            z
              .object({
                skuId: Id,
                value: z.string().trim().min(1).max(120),
                label: z.string().trim().min(1).max(120),
              })
              .strict(),
          )
          .min(2)
          .max(100),
      })
      .strict()
      .optional(),
    artworkVersionIds: ids,
    creativeProjectId: Id.nullable().default(null),
    title: z.string().max(1000).default(""),
    bullets: z.array(z.string().max(2000)).max(10).default([]),
    description: z.string().max(20000).default(""),
    mainImageId: Id.nullable().default(null),
    mediaAssetIds: ids,
    customization: CustomizationSchema.default({ version: 1, fields: [] }),
    layout: ArtworkLayoutSchema.default([]),
    customInstructions: note,
    customMaterials: z
      .array(
        z
          .object({
            fieldKey: z.string().max(80),
            label: z.string().trim().min(1).max(160),
            assetId: Id,
            optionValue: z.string().max(120).default(""),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    customPage: z
      .object({
        status: z
          .enum(["not_configured", "needs_verification", "verified"])
          .default("not_configured"),
        evidence: z.string().trim().max(3000).default(""),
      })
      .strict()
      .default({ status: "not_configured", evidence: "" }),
    accountId: Id.nullable().default(null),
    marketplaceId: z.string().trim().max(80).default("ATVPDKIKX0DER"),
    locale: z.string().trim().min(2).max(20).default("en-US"),
    productType: z
      .string()
      .trim()
      .max(120)
      .regex(/^(|[A-Z0-9_]+)$/)
      .default(""),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.patternChoices) {
      if (value.mode !== "custom")
        ctx.addIssue({
          code: "custom",
          path: ["patternChoices"],
          message: "顾客选款使用 Amazon Custom 定制方案",
        });
      const options = value.patternChoices.options;
      if (
        new Set(options.map((o) => o.skuId)).size !== options.length ||
        new Set(options.map((o) => o.value)).size !== options.length ||
        options.some((o) => !value.skuIds.includes(o.skuId))
      )
        ctx.addIssue({
          code: "custom",
          path: ["patternChoices"],
          message: "每个选款须关联一个已选择的销售 SKU，选项值不可重复",
        });
    }
    if (value.mode === "custom" && value.fulfillment === "fba")
      ctx.addIssue({
        code: "custom",
        path: ["fulfillment"],
        message: "Amazon Custom 只能使用 FBM 自配送",
      });
    if (value.mainImageId && !value.mediaAssetIds.includes(value.mainImageId))
      ctx.addIssue({
        code: "custom",
        path: ["mainImageId"],
        message: "主图必须属于当前方案的刊登图片",
      });
    if (value.customPage.status === "verified" && !value.customPage.evidence)
      ctx.addIssue({
        code: "custom",
        path: ["customPage", "evidence"],
        message: "请记录 Custom 页面核验依据",
      });
    const keys = new Set(value.customization.fields.map((field) => field.key));
    for (const [index, placement] of value.layout.entries()) {
      if (!keys.has(placement.fieldKey))
        ctx.addIssue({
          code: "custom",
          path: ["layout", index, "fieldKey"],
          message: "版面区域必须关联当前定制字段",
        });
    }
    for (const [index, material] of value.customMaterials.entries()) {
      if (material.fieldKey && !keys.has(material.fieldKey))
        ctx.addIssue({
          code: "custom",
          path: ["customMaterials", index, "fieldKey"],
          message: "选项图片必须关联当前定制字段",
        });
      const field = value.customization.fields.find((field) => field.key === material.fieldKey);
      if (
        material.optionValue &&
        (!field ||
          !("options" in field) ||
          !field.options.some((option) => option.value === material.optionValue))
      )
        ctx.addIssue({
          code: "custom",
          path: ["customMaterials", index, "optionValue"],
          message: "选项图片的选项值不属于当前字段",
        });
    }
  });
export type SalesPlanFields = z.infer<typeof SalesPlanFieldsSchema>;
export const CreateSalesPlanSchema = z
  .object({ spuId: Id, fields: SalesPlanFieldsSchema, idempotencyKey: z.uuid() })
  .strict();
export const SaveSalesPlanSchema = z
  .object({
    fields: SalesPlanFieldsSchema,
    expectedRevision: z.int().positive(),
    idempotencyKey: z.uuid(),
  })
  .strict();
export const SalesPlanActionSchema = z
  .object({ expectedRevision: z.int().positive(), idempotencyKey: z.uuid() })
  .strict();
export const SalesPlanDraftSchema = SalesPlanActionSchema.extend({
  expectedListingVersionId: Id.nullable().default(null),
});
export const SalesPlanQuerySchema = z
  .object({
    q: z.string().trim().max(200).default(""),
    spuId: Id.optional(),
    archived: z.enum(["0", "1"]).default("0"),
    page: z.coerce.number().int().min(1).default(1),
  })
  .strict();
export type SalesPlanView = {
  ownerUserId?: string;
  teamId?: string;
  id: string;
  spuId: string;
  spuCode: string;
  spuName: string;
  revision: number;
  fields: SalesPlanFields;
  archived: boolean;
  updatedAt: string;
};
export type SalesPlanList = {
  items: SalesPlanView[];
  total: number;
  page: number;
  pageSize: number;
};
export type SalesPlanListing = {
  ownerUserId?: string;
  id: string;
  versionId: string;
  version: number;
  status: string;
  title: string;
  marketplaceId: string | null;
  locale: string;
  planRevision: number | null;
  completeness: number;
  blockers: string[];
};
export type SalesPlanOptions = {
  contextAuthority: string;
  spus: ProductSpuView[];
  specifications: SpecificationView[];
  skus: Array<{ id: string; code: string; spuId: string; attributes: Record<string, string> }>;
  artworks: ArtworkView[];
  researchItems: Array<{ id: string; title: string }>;
  assets: Array<{ id: string; fileName: string; mediaType: string }>;
  projects: Array<{ id: string; name: string }>;
  accounts: Array<{ id: string; displayName: string; platform: string }>;
  access: {
    research: boolean;
    design: boolean;
    assets: boolean;
    listing: boolean;
    write: boolean;
    listingWrite: boolean;
  };
  preferenceScope: string;
};
/** Original server receipt references, checked again before a sync replay. */
export const SalesPlanDraftReferenceSchema = z.object({ listingId: Id, listingVersionId: Id });
export type SalesPlanDetail = {
  plan: SalesPlanView;
  listings: SalesPlanListing[];
  listingAccess: boolean;
};

/** Read-only selection resolution; contains IDs, never free-form prompts or permissions. */
export const SalesPlanReferenceSelectionSchema = z
  .object({
    specificationIds: ids,
    skuIds: ids,
    artworkVersionIds: ids,
    researchItemIds: ids,
    assetIds: z
      .array(Id)
      .max(201)
      .default([])
      .refine((value) => new Set(value).size === value.length),
    creativeProjectId: Id.nullable().default(null),
    accountId: Id.nullable().default(null),
  })
  .strict();
export type SalesPlanReferenceSelection = z.infer<typeof SalesPlanReferenceSelectionSchema>;
export type SalesPlanReferenceOptions = SalesPlanOptions & {
  planId: string;
  spuId: string;
  selection: SalesPlanReferenceSelection;
};
