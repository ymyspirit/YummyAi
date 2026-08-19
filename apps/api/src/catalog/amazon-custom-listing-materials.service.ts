import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  AmazonCustomListingMaterialsReadinessSchema,
  type AmazonCustomListingCopy,
  type AmazonCustomListingMaterialsReadiness,
  type AmazonCustomMaterialGroup,
  type AmazonCustomMaterialIssue,
  type CustomProductPackageAsset,
  type CustomProductProfileV1,
  type TenantContext,
} from "@yummyai/contracts";
import {
  assetFiles,
  listingVersions,
  listings,
  productPlans,
  skus,
  spus,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import {
  buildAmazonCustomListingMaterialsPackage,
  type AmazonCustomListingMaterialFile,
  type Storage,
} from "@yummyai/storage";
import { and, desc, eq, inArray } from "drizzle-orm";

import { DATABASE_CONNECTION, PRIVATE_STORAGE } from "../platform.tokens.js";
import { ListingDraftSchema } from "../listings/listing.service.js";
import { evaluateCompleteness } from "./custom-product-package.service.js";

const POLICY_VERSION = "amazon-custom-listing-materials-2026-08-04";
const GROUP_LABELS: Record<AmazonCustomMaterialGroup["key"], string> = {
  product_facts: "产品事实",
  sku: "SKU 与变体",
  listing_copy: "Listing 文案与类目属性",
  listing_images: "9 张 Listing 图片",
  a_plus: "A+ 内容",
  customizer: "Amazon Custom 配置",
  production: "设计校样与生产文件",
  compliance: "合规与最终校验",
};

@Injectable()
export class AmazonCustomListingMaterialsService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
  ) {}

  async readiness(context: TenantContext, planId: string) {
    const data = await this.load(context, planId);
    return evaluateListingMaterials(data);
  }

  async export(context: TenantContext, planId: string) {
    const data = await this.load(context, planId);
    const readiness = evaluateListingMaterials(data);
    if (
      readiness.status !== "ready" ||
      !data.profile ||
      !data.spu ||
      !data.listingVersion ||
      !data.listing
    ) {
      throw new UnprocessableEntityException({
        message: "Amazon Custom 上架资料尚未齐套，请先处理阻断项。",
        readiness,
      });
    }
    const readyData: ReadyMaterialsData = {
      ...data,
      profile: data.profile,
      spu: data.spu,
      listing: data.listing,
      listingVersion: data.listingVersion,
    };
    const listingCopy = toListingCopy(readyData);
    const materialFiles = await this.readMaterialFiles(context, readyData);
    const createdAt = new Date().toISOString();
    const built = await buildAmazonCustomListingMaterialsPackage({
      planId: data.plan.id,
      listingId: readyData.listing.id,
      listingVersionId: readyData.listingVersion.id,
      tenantId: context.tenantId,
      targetMarketplace:
        readyData.profile.targetMarketplace?.value ??
        readyData.listing.marketplaceId ??
        "amazon.com",
      policyVersion: POLICY_VERSION,
      createdBy: context.userId,
      createdAt,
      listingCopy,
      variants: readyData.listingDraft.variants,
      customization: {
        schemaVersion: "1.0",
        definition: readyData.plan.customization,
        surfaces: readyData.profile.surfaces,
      },
      claims: {
        verifiedClaims: readyData.profile.approvedClaims,
        provisionalClaims: [],
        prohibitedClaims: readyData.profile.prohibitedClaims,
        evidenceNotes: [
          "本资料包只包含已确认产品事实和已批准 Listing 版本。",
          "竞品原图、竞品文案和 reference_only 素材未进入本资料包。",
        ],
      },
      readiness,
      files: materialFiles,
    });
    const sku = safeName(readyData.listingDraft.variants[0]!.skuCode);
    return {
      bytes: built.bytes,
      sha256: built.sha256,
      fileName: `${sku}-amazon-custom-listing-materials.zip`,
      readiness,
    };
  }

  private async load(context: TenantContext, planId: string): Promise<MaterialsData> {
    const base = await withTenant(this.database.db, context, async (tx) => {
      const [plan] = await tx
        .select()
        .from(productPlans)
        .where(eq(productPlans.id, planId))
        .limit(1);
      if (!plan) throw new NotFoundException("Product plan not found");
      const [spu] = await tx.select().from(spus).where(eq(spus.productPlanId, planId)).limit(1);
      const skuRows = spu ? await tx.select().from(skus).where(eq(skus.spuId, spu.id)) : [];
      const [listingRow] = spu
        ? await tx
            .select({ listing: listings, version: listingVersions })
            .from(listings)
            .innerJoin(listingVersions, eq(listings.primaryVersionId, listingVersions.id))
            .where(
              and(
                eq(listings.spuId, spu.id),
                eq(listings.platform, "amazon"),
                eq(listingVersions.status, "approved"),
              ),
            )
            .orderBy(desc(listingVersions.createdAt))
            .limit(1)
        : [];
      return { plan, spu, skuRows, listingRow };
    });
    const profile = base.plan.customProductProfile ?? undefined;
    const listingDraft = base.listingRow
      ? ListingDraftSchema.parse(base.listingRow.version.content)
      : emptyListingDraft();
    const assetIds = [
      ...new Set([
        ...(profile?.assetAssignments.map((assignment) => assignment.assetId) ?? []),
        ...(listingDraft.mainImageId ? [listingDraft.mainImageId] : []),
        ...listingDraft.mediaAssetIds,
        ...(listingDraft.aPlusModules?.flatMap((module) => module.assetIds) ?? []),
      ]),
    ];
    const assets = assetIds.length
      ? await withTenant(this.database.db, context, (tx) =>
          tx.select().from(assetFiles).where(inArray(assetFiles.id, assetIds)),
        )
      : [];
    return {
      plan: base.plan,
      profile,
      spu: base.spu,
      skuRows: base.skuRows,
      listing: base.listingRow?.listing,
      listingVersion: base.listingRow?.version,
      listingDraft,
      assets,
    };
  }

  private async readMaterialFiles(context: TenantContext, data: ReadyMaterialsData) {
    const assetById = new Map(data.assets.map((asset) => [asset.id, asset]));
    const sku = safeName(data.listingDraft.variants[0]!.skuCode);
    const listingImageIds = unique([
      data.listingDraft.mainImageId!,
      ...data.listingDraft.mediaAssetIds,
    ]).slice(0, 9);
    const aPlusIds = unique(data.listingDraft.aPlusModules!.flatMap((module) => module.assetIds));
    const productionIds = unique(
      data.profile.assetAssignments
        .filter((assignment) => assignment.role === "print_template")
        .map((assignment) => assignment.assetId),
    );
    const descriptors = [
      ...listingImageIds.map((assetId, index) => ({
        assetId,
        role: index === 0 ? ("main" as const) : ("secondary" as const),
        path: `listing-images/${sku}_${index === 0 ? "MAIN" : `PT${String(index).padStart(2, "0")}`}${extensionFor(assetById.get(assetId)!)}`,
      })),
      ...aPlusIds.map((assetId, index) => ({
        assetId,
        role: "a_plus" as const,
        path: `a-plus-images/${sku}_APLUS_L${String(index + 1).padStart(2, "0")}${extensionFor(assetById.get(assetId)!)}`,
      })),
      ...productionIds.map((assetId, index) => ({
        assetId,
        role: "production" as const,
        path: `production-files/${sku}_PRODUCTION_${String(index + 1).padStart(2, "0")}${extensionFor(assetById.get(assetId)!)}`,
      })),
    ];
    return Promise.all(
      descriptors.map(async (descriptor): Promise<AmazonCustomListingMaterialFile> => {
        const asset = assetById.get(descriptor.assetId)!;
        const bytes = await this.storage.readPrivate(
          context,
          {
            id: asset.id,
            tenantId: asset.tenantId,
            assetDomain: "authorized",
            objectKey: asset.objectKey,
          },
          { requiredDomain: "authorized" },
        );
        return {
          ...descriptor,
          sourceFileName: asset.fileName,
          mediaType: asset.mediaType,
          bytes,
          sha256: asset.checksumSha256,
        };
      }),
    );
  }
}

type ProductPlanRow = typeof productPlans.$inferSelect;
type SpuRow = typeof spus.$inferSelect;
type SkuRow = typeof skus.$inferSelect;
type ListingRow = typeof listings.$inferSelect;
type ListingVersionRow = typeof listingVersions.$inferSelect;
type AssetRow = typeof assetFiles.$inferSelect;

interface MaterialsData {
  plan: ProductPlanRow;
  profile?: CustomProductProfileV1;
  spu?: SpuRow;
  skuRows: SkuRow[];
  listing?: ListingRow;
  listingVersion?: ListingVersionRow;
  listingDraft: ReturnType<typeof ListingDraftSchema.parse>;
  assets: AssetRow[];
}

type ReadyMaterialsData = MaterialsData & {
  profile: CustomProductProfileV1;
  spu: SpuRow;
  listing: ListingRow;
  listingVersion: ListingVersionRow;
};

export function evaluateListingMaterials(
  data: MaterialsData,
  now = new Date(),
): AmazonCustomListingMaterialsReadiness {
  const issues: AmazonCustomMaterialIssue[] = [];
  const checks = new Map<AmazonCustomMaterialGroup["key"], boolean[]>();
  const check = (
    group: AmazonCustomMaterialGroup["key"],
    ready: boolean,
    code: string,
    path: string,
    message: string,
  ) => {
    checks.set(group, [...(checks.get(group) ?? []), ready]);
    if (!ready) issues.push({ code, severity: "blocker", group, path, message });
  };
  const profile = data.profile;
  const assetById = new Map(data.assets.map((asset) => [asset.id, asset]));
  const packageAssets: CustomProductPackageAsset[] = (profile?.assetAssignments ?? []).map(
    (assignment) => {
      const asset = assetById.get(assignment.assetId);
      const approved =
        asset?.assetDomain === "authorized" &&
        asset.rightsStatus === "approved" &&
        !asset.deletedAt;
      return {
        id: assignment.assetId,
        fileName: asset?.fileName ?? assignment.assetId,
        role: assignment.role,
        rightsStatus: approved ? "owned" : "unverified",
        usePolicy: approved ? "generation_allowed" : "blocked",
        mediaType: asset?.mediaType ?? "application/octet-stream",
        ...(asset ? { sha256: asset.checksumSha256, byteSize: asset.byteSize } : {}),
        includedInPackage: approved,
      };
    },
  );
  const productCompleteness = profile
    ? evaluateCompleteness(profile, packageAssets, now)
    : undefined;
  check(
    "product_facts",
    Boolean(profile),
    "missing_profile",
    "product.profile",
    "缺少 Amazon Custom 产品事实。",
  );
  check(
    "product_facts",
    productCompleteness?.status === "ready",
    "product_facts_not_ready",
    "product.profile",
    "产品事实、权利状态或必填参数尚未全部确认。",
  );
  check(
    "product_facts",
    Boolean(profile?.targetMarketplace?.value),
    "missing_marketplace",
    "product.profile.targetMarketplace",
    "缺少目标 Amazon 站点。",
  );

  check("sku", Boolean(data.spu), "missing_spu", "spu", "缺少 SPU。");
  check("sku", data.skuRows.length > 0, "missing_sku", "skus", "至少需要一个实际销售 SKU。");

  const draft = data.listingDraft;
  const publication = draft.publication?.platform === "amazon" ? draft.publication : undefined;
  check(
    "listing_copy",
    Boolean(data.listingVersion),
    "missing_approved_listing",
    "listingVersion",
    "缺少已批准的 Amazon Listing 版本。",
  );
  check(
    "listing_copy",
    Boolean(draft.title.trim()),
    "missing_title",
    "listing.title",
    "缺少商品标题。",
  );
  check(
    "listing_copy",
    draft.bullets.filter((item) => item.trim()).length === 5,
    "incomplete_bullets",
    "listing.bullets",
    "需要完整的 5 条卖点。",
  );
  check(
    "listing_copy",
    Boolean(draft.description.trim()),
    "missing_description",
    "listing.description",
    "缺少商品描述。",
  );
  check(
    "listing_copy",
    Boolean(publication?.productType && Object.keys(publication.attributes).length),
    "missing_category_attributes",
    "listing.publication",
    "缺少 Amazon 产品类型或完整类目属性。",
  );
  const publicationAttributes = publication?.attributes ?? {};
  check(
    "listing_copy",
    hasAttribute(publicationAttributes, /purchasable_offer|standard_price|list_price/i),
    "missing_price",
    "listing.publication.attributes",
    "缺少销售价格资料。",
  );
  check(
    "listing_copy",
    hasAttribute(publicationAttributes, /fulfillment_availability|quantity|inventory/i),
    "missing_inventory",
    "listing.publication.attributes",
    "缺少可售库存资料。",
  );
  check(
    "listing_copy",
    hasAttribute(publicationAttributes, /condition_type|^condition$/i),
    "missing_condition",
    "listing.publication.attributes",
    "缺少商品状况。",
  );
  check(
    "listing_copy",
    hasAttribute(publicationAttributes, /merchant_shipping_group|shipping_template|handling_time/i),
    "missing_fbm_shipping",
    "listing.publication.attributes",
    "缺少 Amazon Custom 卖家配送模板或处理时间。",
  );

  const listingImageIds = unique([
    ...(draft.mainImageId ? [draft.mainImageId] : []),
    ...draft.mediaAssetIds,
  ]);
  check(
    "listing_images",
    Boolean(draft.mainImageId),
    "missing_main_image",
    "listing.mainImageId",
    "缺少 MAIN 主图。",
  );
  check(
    "listing_images",
    listingImageIds.length === 9,
    "incomplete_image_set",
    "listing.mediaAssetIds",
    "需要 MAIN + PT01–PT08 共 9 张 Listing 图片。",
  );
  check(
    "listing_images",
    listingImageIds.length === 9 && listingImageIds.every((id) => approvedImage(assetById.get(id))),
    "unapproved_listing_image",
    "listing.mediaAssetIds",
    "Listing 图片必须全部来自授权域且权利已批准。",
  );
  const mainAssignment = profile?.assetAssignments.find(
    (assignment) => assignment.assetId === draft.mainImageId,
  );
  check(
    "listing_images",
    Boolean(mainAssignment && ["real_product", "finished_sample"].includes(mainAssignment.role)),
    "main_image_not_real_product",
    "listing.mainImageId",
    "MAIN 主体必须关联自有实拍或完成品样例。",
  );

  const aPlusIds = unique(draft.aPlusModules?.flatMap((module) => module.assetIds) ?? []);
  check(
    "a_plus",
    Boolean(draft.aPlusModules?.length),
    "missing_a_plus",
    "listing.aPlusModules",
    "缺少 A+ 模块计划。",
  );
  check(
    "a_plus",
    aPlusIds.length > 0 && aPlusIds.every((id) => approvedImage(assetById.get(id))),
    "unapproved_a_plus_assets",
    "listing.aPlusModules",
    "A+ 必须包含已授权、已批准的图片。",
  );

  const fieldKeys = new Set(data.plan.customization.fields.map((field) => field.key));
  check(
    "customizer",
    data.plan.customization.fields.length > 0,
    "missing_custom_fields",
    "customization.fields",
    "缺少 Amazon Custom 定制字段。",
  );
  check(
    "customizer",
    Boolean(profile?.surfaces.length),
    "missing_custom_surfaces",
    "product.profile.surfaces",
    "缺少定制面。",
  );
  check(
    "customizer",
    Boolean(
      profile?.surfaces.every(
        (surface) =>
          surface.areaMm &&
          surface.fieldKeys.length &&
          surface.fieldKeys.every((key) => fieldKeys.has(key)),
      ),
    ),
    "invalid_surface_mapping",
    "product.profile.surfaces",
    "定制面必须填写加工区域并关联有效字段。",
  );

  const printTemplateIds =
    profile?.assetAssignments
      .filter((assignment) => assignment.role === "print_template")
      .map((assignment) => assignment.assetId) ?? [];
  const finishedSampleIds =
    profile?.assetAssignments
      .filter((assignment) => assignment.role === "finished_sample")
      .map((assignment) => assignment.assetId) ?? [];
  check(
    "production",
    printTemplateIds.length > 0 && printTemplateIds.every((id) => approvedAsset(assetById.get(id))),
    "missing_print_template",
    "assets.print_template",
    "缺少已授权的印刷或加工模板。",
  );
  check(
    "production",
    finishedSampleIds.length > 0 &&
      finishedSampleIds.every((id) => approvedImage(assetById.get(id))),
    "missing_finished_sample",
    "assets.finished_sample",
    "缺少已批准的完成品校样。",
  );

  check(
    "compliance",
    Boolean(data.listingVersion && data.listingVersion.validation.blockers.length === 0),
    "listing_validation_failed",
    "listing.validation",
    "Listing 版本仍存在平台校验阻断项。",
  );
  check(
    "compliance",
    Boolean(draft.compliance.countryOfOrigin),
    "missing_country_of_origin",
    "listing.compliance.countryOfOrigin",
    "缺少原产国/地区。",
  );
  check(
    "compliance",
    Boolean(profile?.prohibitedClaims.length && profile.prohibitedElements.length),
    "missing_compliance_boundaries",
    "product.profile.prohibitedClaims",
    "缺少禁用宣称或禁用元素清单。",
  );

  const groups = (Object.keys(GROUP_LABELS) as AmazonCustomMaterialGroup["key"][]).map((key) => {
    const results = checks.get(key) ?? [false];
    const groupIssues = issues.filter((issue) => issue.group === key);
    return {
      key,
      label: GROUP_LABELS[key],
      status: groupIssues.some((issue) => issue.severity === "blocker")
        ? ("blocked" as const)
        : groupIssues.length
          ? ("warning" as const)
          : ("ready" as const),
      completed: results.filter(Boolean).length,
      required: results.length,
    };
  });
  const completed = groups.reduce((sum, group) => sum + group.completed, 0);
  const required = groups.reduce((sum, group) => sum + group.required, 0);
  return AmazonCustomListingMaterialsReadinessSchema.parse({
    status: issues.some((issue) => issue.severity === "blocker")
      ? "blocked"
      : issues.length
        ? "partial"
        : "ready",
    score: Math.round((completed / required) * 100),
    planId: data.plan.id,
    ...(data.listing ? { listingId: data.listing.id } : {}),
    ...(data.listingVersion ? { listingVersionId: data.listingVersion.id } : {}),
    groups,
    issues,
    evaluatedAt: now.toISOString(),
  });
}

function toListingCopy(data: ReadyMaterialsData): AmazonCustomListingCopy {
  const publication = data.listingDraft.publication;
  if (!publication || publication.platform !== "amazon")
    throw new Error("Approved Amazon publication attributes are required");
  return {
    marketplace:
      data.profile.targetMarketplace?.value ?? data.listing.marketplaceId ?? "amazon.com",
    locale: data.listingDraft.locale,
    productType: publication.productType,
    title: data.listingDraft.title,
    bulletPoints: data.listingDraft.bullets.filter(Boolean),
    description: data.listingDraft.description,
    searchTerms: data.listingDraft.tags,
    attributes: publication.attributes,
    offerAndFulfillment: Object.fromEntries(
      Object.entries(publication.attributes).filter(([key]) =>
        /purchasable_offer|standard_price|list_price|fulfillment_availability|quantity|inventory|condition|merchant_shipping_group|shipping_template|handling_time/i.test(
          key,
        ),
      ),
    ),
    compliance: data.listingDraft.compliance,
  };
}

function approvedAsset(asset?: AssetRow) {
  return Boolean(
    asset &&
    asset.assetDomain === "authorized" &&
    asset.rightsStatus === "approved" &&
    !asset.deletedAt,
  );
}

function approvedImage(asset?: AssetRow) {
  return approvedAsset(asset) && Boolean(asset?.mediaType.startsWith("image/"));
}

function extensionFor(asset: AssetRow) {
  const match = /\.[a-z0-9]{2,8}$/i.exec(asset.fileName);
  if (match) return match[0].toLowerCase() === ".jpeg" ? ".jpg" : match[0].toLowerCase();
  return (
    (
      {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "application/pdf": ".pdf",
      } as Record<string, string>
    )[asset.mediaType] ?? ".bin"
  );
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function hasAttribute(attributes: Record<string, unknown>, pattern: RegExp) {
  return Object.keys(attributes).some((key) => pattern.test(key));
}

function safeName(input: string) {
  return (
    input
      .normalize("NFKC")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 160) || "SKU"
  );
}

function emptyListingDraft() {
  return ListingDraftSchema.parse({
    platform: "amazon",
    locale: "en-US",
    title: "",
    description: "",
    bullets: [],
    tags: [],
    mediaAssetIds: [],
    variants: [],
    attributes: {},
    compliance: {},
  });
}
