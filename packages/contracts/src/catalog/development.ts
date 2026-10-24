import type { ProductionProductType } from "@yummyai/contracts/pod/production-editor";
import { z } from "zod";
import { SpecificationFactsSchema } from "@yummyai/contracts/catalog/specification-facts";
export { SpecificationFactsSchema, SpecificationDimensionBases, specificationFactProblems, specificationFactsReady, normalizeSpecificationFactDisplay } from "@yummyai/contracts/catalog/specification-facts";
import {
  PrintBindingsSchema,
  CustomChoiceSchema,
  type ResolvedPrintBinding,
} from "@yummyai/contracts/catalog/composition";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { CustomizationSchema } from "@yummyai/contracts/catalog/product";
import {
  ArtworkModeSchema,
  ArtworkMaterialInputSchema,
  ArtworkLayoutSchema,
  type ArtworkMaterial,
  type ArtworkLayout,
} from "@yummyai/contracts/catalog/artwork";
export { ArtworkModeSchema } from "@yummyai/contracts/catalog/artwork";

const code = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "编号只使用字母、数字、点、横线和下划线");
const requestKey = z.uuid();
export const SpuCapabilitiesSchema = z
  .object({
    processes: z.string().max(3000).default(""),
    customizationScope: z.string().max(3000).default(""),
    packaging: z.string().max(2000).default(""),
  })
  .strict();
export const CreateProductSpuSchema = z
  .object({
    teamId: Id.nullable().optional(),
    code,
    name: z.string().trim().min(1).max(160),
    description: z.string().max(3000).default(""),
    capabilities: SpuCapabilitiesSchema.optional(),
    idempotencyKey: requestKey,
  })
  .strict();
export const UpdateProductSpuSchema = CreateProductSpuSchema.extend({
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ProductSpuView = {
  legacyPlanAmbiguous?: boolean;
  ownerUserId?: string;
  teamId?: string;
  id: string;
  code: string;
  name: string;
  productPlanId: string;
  description: string;
  revision: string;
  capabilities?: z.infer<typeof SpuCapabilitiesSchema>;
};
export const RegisterArtworkSchema = z
  .object({
    teamId: Id.nullable().optional(),
    code,
    name: z.string().trim().min(1).max(160),
    mode: ArtworkModeSchema,
    creativeVersionId: Id.nullable().default(null),
    researchItemIds: z.array(Id).max(50).default([]),
    tags: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
    customization: CustomizationSchema.default({ version: 1, fields: [] }),
    instructions: z.string().max(5000).default(""),
    materials: z.array(ArtworkMaterialInputSchema).max(30).default([]),
    layout: ArtworkLayoutSchema.default([]),
    expectedVersion: z.int().nonnegative(),
    idempotencyKey: requestKey,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      !value.creativeVersionId &&
      (value.mode === "fixed" ||
        !value.customization.fields.some(
          (field) => field.required && ["image", "short_text", "long_text"].includes(field.type),
        ))
    )
      ctx.addIssue({
        code: "custom",
        path: ["creativeVersionId"],
        message: "无固定主图的定制方案须配置必填图片或文字字段",
      });
    if (!value.creativeVersionId && !value.instructions.trim())
      ctx.addIssue({
        code: "custom",
        path: ["instructions"],
        message: "请填写来图或文字定制的制作说明",
      });
  });
export const ArchiveArtworkSchema = z
  .object({
    archived: z.boolean(),
    expectedVersion: z.int().positive(),
    reason: z.string().trim().min(1).max(1000),
    idempotencyKey: requestKey,
  })
  .strict();
export const SaveProductSpecificationSchema = z
  .object({
    spuId: Id,
    code,
    name: z.string().trim().min(1).max(160),
    attributes: z.record(z.string().trim().min(1).max(80), z.string().trim().min(1).max(200)),
    facts: SpecificationFactsSchema,
    processProfileVersionId: Id.nullable().default(null),
    canvasPrintSpecVersionId: Id.nullable().default(null),
    stockItemId: Id.nullable().default(null),
    expectedVersion: z.int().nonnegative(),
    idempotencyKey: requestKey,
  })
  .strict();
export const MAX_SPECIFICATION_COMBINATIONS = 50;
export function specificationAttributesKey(attributes: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(attributes)
      .map(([key, value]) => [key.trim(), value.trim()] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}
export const CreateProductSpecificationsSchema = z
  .object({
    spuId: Id,
    items: z
      .array(
        SaveProductSpecificationSchema.omit({
          spuId: true,
          expectedVersion: true,
          idempotencyKey: true,
        }),
      )
      .min(1)
      .max(MAX_SPECIFICATION_COMBINATIONS),
    idempotencyKey: requestKey,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.items.map((item) => item.code.toLowerCase())).size !== value.items.length)
      ctx.addIssue({ code: "custom", path: ["items"], message: "规格编号不可重复" });
    if (
      value.items.some((item) => !Object.keys(item.attributes).length) ||
      new Set(value.items.map((item) => specificationAttributesKey(item.attributes))).size !==
        value.items.length
    )
      ctx.addIssue({ code: "custom", path: ["items"], message: "每个规格必须有不重复的属性组合" });
  });
export const CreateProductCombinationSchema = z
  .object({
    artworkVersionId: Id.optional(),
    printBindings: PrintBindingsSchema.optional(),
    items: z
      .array(
        z
          .object({ specificationVersionId: Id, skuCode: code, existingSkuId: Id.optional() })
          .strict(),
      )
      .min(1)
      .max(50),
    idempotencyKey: requestKey,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.artworkVersionId && !value.printBindings)
      ctx.addIssue({ code: "custom", path: ["printBindings"], message: "请选择至少一个印花版本" });
    if (
      value.artworkVersionId &&
      value.printBindings &&
      value.artworkVersionId !== value.printBindings[0]?.artworkVersionId
    )
      ctx.addIssue({
        code: "custom",
        path: ["artworkVersionId"],
        message: "旧单印花编号须与首个绑定一致",
      });
    if (
      new Set(value.items.map((item) => item.specificationVersionId)).size !== value.items.length ||
      new Set(value.items.map((item) => item.skuCode.toLowerCase())).size !== value.items.length
    )
      ctx.addIssue({ code: "custom", path: ["items"], message: "规格和销售 SKU 不可重复" });
  });
export const ReviseSalesRecipeSchema = z
  .object({
    artworkVersionId: Id.optional(),
    printBindings: PrintBindingsSchema.optional(),
    specificationVersionId: Id,
    expectedVersion: z.int().positive(),
    reason: z.string().trim().min(1).max(2000),
    idempotencyKey: requestKey,
  })
  .strict()
  .refine((v) => !!v.artworkVersionId || !!v.printBindings, "请选择印花版本");
export const SalesRecipeActionSchema = z
  .object({
    action: z.enum([
      "start_adaptation",
      "approve_adaptation",
      "confirm_customization_plan",
      "reopen_adaptation",
    ]),
    expectedEditorVersionId: Id.optional(),
    renderId: Id.optional(),
    reason: z.string().trim().min(1).max(2000),
    idempotencyKey: requestKey,
  })
  .strict();
export const CreateSalesListingSchema = z
  .object({
    recipeIds: z.array(Id).min(1).max(50),
    platform: z.enum(["amazon", "etsy"]),
    marketplaceId: z.string().trim().min(1).max(80),
    locale: z.string().trim().min(2).max(20),
    title: z.string().trim().min(1).max(300),
    idempotencyKey: requestKey,
  })
  .strict();
export const SealSalesPackageSchema = z
  .object({
    recipeId: Id,
    listingId: Id,
    listingVersionId: Id,
    deliveryReviewId: Id.optional(),
    imageEvidence: z
      .array(
        z
          .object({
            assetId: Id,
            kind: z.enum(["finished_photo", "mockup", "detail", "size", "customization"]),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    reason: z.string().trim().min(1).max(2000),
    idempotencyKey: requestKey,
  })
  .strict();
export const BindSalesChannelSchema = z
  .object({
    packageId: Id,
    accountId: Id,
    externalSku: z.string().trim().min(1).max(200),
    externalListingId: z.string().trim().min(1).max(200),
    customChoice: CustomChoiceSchema.default({}),
    effectiveFrom: z.iso.datetime(),
    evidence: z.string().trim().min(1).max(2000),
    idempotencyKey: requestKey,
  })
  .strict();
export const SalesChannelPreviewSchema = BindSalesChannelSchema.omit({
  evidence: true,
  idempotencyKey: true,
});
export type SalesChannelPreview = {
  input: z.infer<typeof SalesChannelPreviewSchema>;
  package: {
    id: string;
    version: number;
    checksum: string;
    skuCode: string;
    listingVersionId: string;
  };
  account: { id: string; displayName: string; platform: string; marketplaceId: string };
  status: "ready" | "conflict";
  canBind: boolean;
  effectiveUntil: string | null;
  previous: { effectiveFrom: string; package: { id: string; version: number } | null } | null;
  next: { effectiveFrom: string; package: { id: string; version: number } | null } | null;
};
export const DevelopmentQuerySchema = z
  .object({
    q: z.string().trim().max(200).default(""),
    status: z
      .enum([
        "all",
        "unmapped",
        "pending_adaptation",
        "in_adaptation",
        "ready_for_customization",
        "approved",
        "packaged",
        "needs_update",
      ])
      .default("all"),
    artworkId: Id.optional(),
    spuId: Id.optional(),
    page: z.coerce.number().int().positive().max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type ArtworkMode = z.infer<typeof ArtworkModeSchema>;
export type SpecificationFacts = z.infer<typeof SpecificationFactsSchema>;
export type ArtworkView = {
  ownerUserId?: string;
  teamId?: string;
  id: string;
  code: string;
  name: string;
  mode: ArtworkMode;
  versionId: string;
  version: number;
  creativeVersionId: string | null;
  assetId: string | null;
  assetVersion: number | null;
  archived?: boolean;
  tags: string[];
  researchItemIds: string[];
  customization: z.infer<typeof CustomizationSchema>;
  instructions: string;
  materials: ArtworkMaterial[];
  layout: ArtworkLayout;
  createdAt: string;
};
export type SpecificationView = {
  id: string;
  spuId: string;
  spuCode: string;
  spuName: string;
  code: string;
  name: string;
  versionId: string;
  version: number;
  attributes: Record<string, string>;
  facts: z.infer<typeof SpecificationFactsSchema>;
  factVerification?: { confirmedByUserId: string; confirmedAt: string; reference: string } | null;
  processProfileVersionId: string | null;
  processName: string;
  productType: ProductionProductType | null;
  canvasPrintSpecVersionId: string | null;
  stockItemId: string | null;
  createdAt: string;
};
export type SalesRecipeView = {
  id: string;
  skuId: string;
  skuCode: string;
  styleId: string;
  version: number;
  artwork: ArtworkView;
  printBindings?: ResolvedPrintBinding[];
  specification: SpecificationView & {
    processProfileVersionId: string;
    productType: ProductionProductType;
  };
  status: "pending_adaptation" | "in_adaptation" | "ready_for_customization" | "approved";
  editorProjectId: string | null;
  editorVersionId: string | null;
  renderId: string | null;
  designVersionId: string | null;
  needsUpdate: boolean;
  createdAt: string;
};
export type SalesPackageView = {
  id: string;
  skuId: string;
  skuCode: string;
  recipeId: string;
  version: number;
  platform: "amazon" | "etsy";
  marketplaceId: string;
  locale: string;
  listingId: string;
  listingVersionId: string;
  title: string;
  checksum: string;
  createdAt: string;
};
export type ChannelBindingView = {
  id: string;
  packageId: string;
  accountId: string;
  accountName: string;
  externalSku: string;
  externalListingId: string;
  customChoice?: Record<string, string>;
  effectiveFrom: string;
  evidence: string;
};
export type DevelopmentItem = {
  ownerUserId?: string;
  teamId?: string;
  skuId: string;
  skuCode: string;
  spuId: string;
  spuCode: string;
  spuName: string;
  attributes: Record<string, string>;
  recipe: SalesRecipeView | null;
  packageCount: number;
  updatedAt: string;
};
export type DevelopmentWorkspace = {
  items: DevelopmentItem[];
  total: number;
  page: number;
  pageSize: number;
};
export type DevelopmentOptions = {
  contextAuthority?: string;
  artworks: ArtworkView[];
  archivedArtworks?: ArtworkView[];
  specifications: SpecificationView[];
  spus: Array<
    Pick<ProductSpuView, "id" | "code" | "name" | "productPlanId"> &
      Partial<
        Pick<ProductSpuView, "description" | "revision" | "capabilities" | "ownerUserId" | "teamId" | "legacyPlanAmbiguous">
      >
  >;
  creativeVersions: Array<{
    id: string;
    name: string;
    version: number;
    assetId: string;
    createdAt: string;
  }>;
  researchItems: Array<{ id: string; title: string }>;
  processes: Array<{ versionId: string; code: string; name: string; productType: string }>;
  canvasPrintSpecs: Array<{ id: string; name: string }>;
  stockItems: Array<{ id: string; code: string; name: string }>;
  accounts: Array<{ id: string; displayName: string; platform: string }>;
  preferenceScope: string;
  materialAssets: Array<{ id: string; fileName: string; mediaType: string; version: number }>;
};
export type SalesSkuDetail = {
  lifecycle: { active: boolean; archived: Array<"product_plan" | "spu" | "sku"> };
  access: { packageRead: boolean; channelRead: boolean };
  item: DevelopmentItem;
  recipes: SalesRecipeView[];
  relatedRecipes: SalesRecipeView[];
  packages: SalesPackageView[];
  channelBindings: ChannelBindingView[];
  listings: Array<{
    id: string;
    platform: string;
    locale: string;
    versionId: string;
    status: string;
    title: string;
    assetIds: string[];
  }>;
  events: Array<{ id: string; action: string; reason: string; actor: string; occurredAt: string }>;
};
