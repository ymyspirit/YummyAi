import { specificationFactsReady } from "@yummyai/contracts/catalog/development";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import {
  currentCatalogContext,
  assertCatalogSalesPlanAccess,
  assertCatalogRecipeRead,
  catalogOwnerFilter,
  catalogAssetReadFilter,
} from "@yummyai/catalog-core";
import {
  DeliveryChecksSchema,
  type DeliveryReview,
  type DeliveryEvidence,
  type DeliveryIssue,
} from "@yummyai/contracts/catalog/sales-plan-delivery";
import { type TenantContext } from "@yummyai/contracts";
import {
  assetFiles,
  designVersionFiles,
  designVersions,
  mockupBatchOutputs,
  mockupBatchItems,
  developmentEvents,
  listings,
  listingVersions,
  salesRecipeVersions,
  skus,
  visualDeliverySource,
  type TenantTransaction,
} from "@yummyai/database";
import { and, desc, eq, inArray } from "drizzle-orm";
import { amazonRules, validateListing, type ListingDraft } from "@yummyai/platform-rules";
import { assertAuthorizedAssets } from "../design/pod-batch-workflow.service.js";
import { fingerprint, lockDevelopment, readRecipe } from "./development-data.js";
import { ListingDraftSchema } from "../listings/listing.service.js";
import { listingRecipeVariant, listingSalesSkuIds } from "./listing-composition.js";
import { CustomSalesSkuMappingSchema } from "@yummyai/contracts/catalog/composition";

export const DELIVERY_REVIEW_ACTION = "sales_plan.delivery_review";
export async function readDelivery(tx: TenantTransaction, planId: string, context: TenantContext) {
  context = await currentCatalogContext(tx, context);
  await assertCatalogSalesPlanAccess(tx, context, planId, [Permission.ProductRead]);
  const source = await visualDeliverySource(tx, planId).catch((error: unknown) => {
    if (error instanceof Error && error.message === "visual_source_changed")
      throw new NotFoundException("销售方案或商品已归档、不可读取");
    throw error;
  });
  const f = source.fields,
    issues: DeliveryIssue[] = [],
    href = (step: number) => `/sales-plans?plan=${planId}&step=${step}`;
  const add = (path: string, message: string, link = href(4)) =>
    issues.push({ path, message, href: link });
  const supported =
    f.mode === "custom" &&
    f.fulfillment === "fbm" &&
    f.marketplaceId === "ATVPDKIKX0DER" &&
    f.locale === "en-US" &&
    !!source.specs.length &&
    source.specs.every((s) => s.process?.productType === "shaped_pillow");
  if (!supported) add("scope", "本轮交付支持异形抱枕、Amazon 美国站 Custom FBM", href(0));
  if (!f.skuIds.length) add("skuIds", "请选择本方案的销售 SKU", href(3));
  if (f.skuIds.length > 50) add("skuIds", "单次交付最多 50 个销售 SKU，请拆分销售方案", href(3));
  if (
    source.specs.length !== f.specificationIds.length ||
    source.specs.some(
      (s) =>
        !specificationFactsReady(s.version.facts) ||
        !s.process ||
        !s.template ||
        s.template.status !== "active" ||
        s.template.archivedAt ||
        s.template.currentVersionId !== s.process.sourceVersionId ||
        s.template.reviewedVersionId !== s.process.sourceVersionId,
    )
  )
    add("specifications", "规格事实或已审核工艺底稿已变化，请重新核对", href(0));
  const [row] = await tx
    .select({ listing: listings, version: listingVersions })
    .from(listings)
    .innerJoin(listingVersions, eq(listingVersions.listingId, listings.id))
    .where(
      and(
        eq(listings.salesPlanId, planId),
        catalogOwnerFilter(context, Permission.ListingRead, listings.createdBy),
        eq(listings.platform, "amazon"),
        eq(listings.marketplaceId, f.marketplaceId),
        eq(listings.locale, f.locale),
      ),
    )
    .orderBy(desc(listingVersions.versionNumber))
    .limit(1);
  const content = row ? (ListingDraftSchema.parse(row.version.content) as ListingDraft) : null;
  const listingHref = row ? `/listings/${row.listing.id}` : href(4);
  if (!row) add("listing", "创建并审核当前方案的刊登草稿");
  else {
    if (
      row.listing.status !== "approved" ||
      row.version.status !== "approved" ||
      row.listing.primaryVersionId !== row.version.id
    )
      add("listing.review", "请在刊登编辑器审核当前版本", listingHref);
    if (row.listing.salesPlanRevision !== source.revision)
      add(
        "listing.planRevision",
        "销售方案已更新，请在刊登编辑器建立修订草稿，再同步方案并重新审核",
        listingHref,
      );
    for (const issue of validateListing(amazonRules, content!).blockers)
      add(`listing.${issue.path}`, issue.message, listingHref);
    const variants = content!.variants;
    if (
      (!f.patternChoices && variants.length !== f.skuIds.length) ||
      new Set(variants.map((v) => v.skuId)).size !== variants.length ||
      variants.some((v) => !f.skuIds.includes(v.skuId)) ||
      fingerprint(listingSalesSkuIds(content!).sort()) !== fingerprint([...f.skuIds].sort())
    )
      add("listing.variants", "刊登变体与当前所选销售 SKU 不一致", listingHref);
    if (
      content!.mainImageId !== f.mainImageId ||
      fingerprint([...content!.mediaAssetIds].sort()) !== fingerprint([...f.mediaAssetIds].sort())
    )
      add("listing.images", "刊登图片与当前方案不一致，请核对并同步草稿");
  }
  const skuRows = f.skuIds.length
    ? await tx.select().from(skus).where(inArray(skus.id, f.skuIds))
    : [];
  const recipes: Array<{ skuId: string; recipe: Awaited<ReturnType<typeof readRecipe>> | null }> =
    [];
  for (const skuId of f.skuIds) {
    const [latest] = await tx
      .select({ id: salesRecipeVersions.id })
      .from(salesRecipeVersions)
      .where(eq(salesRecipeVersions.skuId, skuId))
      .orderBy(desc(salesRecipeVersions.versionNumber))
      .limit(1);
    if (latest) await assertCatalogRecipeRead(tx, context, latest.id);
    const recipe = latest
      ? await readRecipe(tx, latest.id).catch((error: unknown) => {
          if (error instanceof NotFoundException) return null;
          throw error;
        })
      : null;
    recipes.push({ skuId, recipe });
    const sku = skuRows.find((s) => s.id === skuId),
      path = `skus.${skuId}`,
      link = `/product-development?sku=${skuId}`;
    if (!sku || sku.spuId !== source.spu.id || sku.status === "archived")
      add(path, "销售 SKU 不属于当前商品或已归档", link);
    if (
      !recipe ||
      recipe.status !== "approved" ||
      recipe.needsUpdate ||
      recipe.artwork.archived ||
      !recipe.designVersionId ||
      !specificationFactsReady(recipe.specification.facts) ||
      !(
        recipe.printBindings?.every((b) => f.artworkVersionIds.includes(b.artworkVersionId)) ??
        f.artworkVersionIds.includes(recipe.artwork.versionId)
      ) ||
      !source.specs.some((s) => s.version.id === recipe.specification.versionId)
    )
      add(path, "制作版本、印花或规格尚未审核，或已发生变化", link);
    if (
      recipe &&
      row?.listing.styleId !== recipe.styleId &&
      !f.patternChoices?.options.some((o) => o.skuId === recipe.skuId)
    )
      add(path, "刊登款式与销售 SKU 不一致", link);
    const variant =
      content && recipe
        ? listingRecipeVariant(content, recipe)
        : content?.variants.find((v) => v.skuId === skuId);
    if (
      sku &&
      variant &&
      ((!f.patternChoices && variant.skuCode !== sku.code) ||
        fingerprint(variant.optionValues) !== fingerprint(sku.attributes))
    )
      add(`${path}.optionValues`, "刊登的 SKU 编码或规格选项与商品事实不一致", listingHref);
    if (recipe && fingerprint(recipe.artwork.customization) !== fingerprint(f.customization))
      add(`${path}.customization`, "方案定制字段与该 SKU 的来图方案不一致", href(3));
  }
  if (f.patternChoices && content) {
    const raw = content.attributes.custom_sales_sku_mapping;
    let mappings;
    try {
      mappings = CustomSalesSkuMappingSchema.parse(typeof raw === "string" ? JSON.parse(raw) : raw);
    } catch {
      add("listing.customChoices", "刊登缺少固定的选款与平台 SKU 映射", listingHref);
    }
    if (
      mappings &&
      (mappings.length !== f.skuIds.length ||
        new Set(mappings.map((m) => m.skuId)).size !== mappings.length ||
        mappings.some((m) => {
          const recipe = recipes.find((r) => r.skuId === m.skuId)?.recipe,
            option = f.patternChoices!.options.find((o) => o.skuId === m.skuId),
            variant = content!.variants.find(
              (v) => v.skuId === m.platformSkuId && v.skuCode === m.platformSkuCode,
            );
          return (
            !recipe ||
            !option ||
            !variant ||
            m.specificationId !== recipe.specification.id ||
            fingerprint(m.customChoice) !==
              fingerprint({ [f.patternChoices!.fieldKey]: option.value }) ||
            fingerprint(variant.optionValues) !== fingerprint(recipe.specification.attributes)
          );
        }) ||
        content.variants.length !== new Set(mappings.map((m) => m.specificationId)).size)
    )
      add(
        "listing.customChoices",
        "图案选款须对应 Custom 选项；平台变体只对应真实规格",
        listingHref,
      );
  }
  if (!f.customization.fields.length && !f.patternChoices)
    add("customization.fields", "请配置本商品实际支持的定制字段", href(3));
  if (!f.customInstructions.trim())
    add("customInstructions", "请填写与已配置字段一致的定制说明", href(3));
  // Manual platform configuration is explicit evidence, never inferred from a generated draft.
  if (f.customPage.status !== "verified" || !f.customPage.evidence.trim())
    add("customPage", "请记录实际 Custom 页面配置核验依据", href(4));
  const designIds = recipes.flatMap((r) =>
    r.recipe?.designVersionId ? [r.recipe.designVersionId] : [],
  );
  const productionSources = designIds.length
    ? await tx
        .select({ file: designVersionFiles, version: designVersions })
        .from(designVersionFiles)
        .innerJoin(designVersions, eq(designVersions.id, designVersionFiles.versionId))
        .where(
          and(
            inArray(designVersionFiles.versionId, designIds),
            eq(designVersionFiles.role, "production"),
          ),
        )
        .orderBy(designVersionFiles.id)
    : [];
  for (const r of recipes)
    if (
      r.recipe?.designVersionId &&
      !productionSources.some(
        (p) => p.file.versionId === r.recipe!.designVersionId && p.version.status === "approved",
      )
    )
      add(
        `skus.${r.skuId}.production`,
        "当前制作版本缺少已审核的生产文件",
        `/product-development?sku=${r.skuId}`,
      );
  const mockupSources = content?.mediaAssetIds.length
    ? await tx
        .select({ output: mockupBatchOutputs, item: mockupBatchItems })
        .from(mockupBatchOutputs)
        .innerJoin(mockupBatchItems, eq(mockupBatchItems.id, mockupBatchOutputs.itemId))
        .where(inArray(mockupBatchOutputs.assetId, content.mediaAssetIds))
        .orderBy(mockupBatchOutputs.id)
    : [];
  const ids = [
    ...new Set(
      [
        ...(content?.mediaAssetIds ?? f.mediaAssetIds),
        content?.mainImageId ?? f.mainImageId,
        ...f.customMaterials.map((m) => m.assetId),
        ...recipes.flatMap((r) => r.recipe?.artwork.materials.map((m) => m.assetId) ?? []),
        ...recipes.map((r) => r.recipe?.artwork.assetId),
        ...productionSources.map((p) => p.file.assetFileId),
      ].filter((id): id is string => !!id),
    ),
  ].sort();
  const assets = ids.length
    ? await tx
        .select()
        .from(assetFiles)
        .where(
          and(
            inArray(assetFiles.id, ids),
            catalogAssetReadFilter(context, assetFiles.ownerUserId, assetFiles.id),
          ),
        )
        .orderBy(assetFiles.id)
    : [];
  for (const id of ids) {
    const asset = assets.find((a) => a.id === id);
    try {
      assertAuthorizedAssets([id], asset ? [asset] : [], "交付素材");
      if (
        !asset ||
        asset.deletedAt ||
        !["image/png", "image/jpeg", "image/webp"].includes(asset.mediaType)
      )
        throw new Error("unavailable");
    } catch {
      add(`assets.${id}`, "图片缺失、类型不支持或授权已失效", href(3));
    }
    if (id === content?.mainImageId && asset?.aiGenerated)
      add(`assets.${id}`, "定制商品主图必须核对真实成品照片，不能使用 AI 候选", href(3));
  }
  const basis = JSON.parse(
    JSON.stringify({
      source,
      listing: row ?? null,
      recipes,
      skuRows: skuRows.sort((a, b) => a.id.localeCompare(b.id)),
      assets,
      productionSources,
      mockupSources,
    }),
  ) as Record<string, unknown>;
  return {
    source,
    row,
    content,
    recipes,
    skuRows,
    assets,
    issues,
    supported,
    fingerprint: fingerprint(basis),
    basis,
  };
}
export type DeliveryData = Awaited<ReturnType<typeof readDelivery>>;

export async function assertDeliveryReview(
  tx: TenantTransaction,
  context: TenantContext,
  reviewId: string,
  recipeId?: string,
  listingId?: string,
  versionId?: string,
  evidence?: DeliveryEvidence,
) {
  const [event] = await tx
    .select()
    .from(developmentEvents)
    .where(
      and(eq(developmentEvents.id, reviewId), eq(developmentEvents.action, DELIVERY_REVIEW_ACTION)),
    );
  if (!event) throw new ConflictException("交付核对记录不存在");
  await lockDevelopment(tx, context, `sales-plan:${event.resourceId}`);
  const result = event.result as { review: DeliveryReview; basis: Record<string, unknown> };
  const data = await readDelivery(tx, event.resourceId, context);
  DeliveryChecksSchema.parse(result.review?.checks);
  if (
    !result.review ||
    result.review.fingerprint !== data.fingerprint ||
    data.issues.length ||
    !data.row ||
    (listingId && data.row.listing.id !== listingId) ||
    (versionId && data.row.version.id !== versionId) ||
    (recipeId && !data.recipes.some((r) => r.recipe?.id === recipeId)) ||
    (evidence && fingerprint(evidence) !== fingerprint(result.review.imageEvidence))
  )
    throw new ConflictException("交付依据已变化，请刷新、修正并重新核对");
  return { data, review: result.review, event, basis: result.basis };
}

export function deliveryChanges(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
) {
  const labels: Record<string, { label: string; effects: string[] }> = {
    source: {
      label: "销售方案、商品规格或工艺依据变化",
      effects: ["重新核对 SKU 与定制配置", "重新检查文案和图片", "重新封存当前资料包"],
    },
    listing: {
      label: "刊登版本、内容或审核状态变化",
      effects: ["重新核对文案、定制说明和图片", "重新封存当前资料包"],
    },
    recipes: {
      label: "销售 SKU 制作版本变化",
      effects: ["重新审核制作与套图来源", "重新核对 SKU 映射并封存"],
    },
    skuRows: {
      label: "SKU 编码或规格选项变化",
      effects: ["修正刊登变体与 SKU 映射", "重新核对并封存"],
    },
    assets: {
      label: "图片、文件版本或授权变化",
      effects: ["核对原图及使用权", "重新审核图片并封存"],
    },
    productionSources: {
      label: "生产文件或其审核状态变化",
      effects: ["重新核对制作来源与文件", "重新审核并封存资料包"],
    },
    mockupSources: {
      label: "套图来源或审核状态变化",
      effects: ["重新核对套图对应的 SKU 与制作版本", "重新审核图片并封存"],
    },
  };
  return Object.entries(labels)
    .filter(([key]) => fingerprint(previous[key]) !== fingerprint(current[key]))
    .map(([, value]) => value);
}
