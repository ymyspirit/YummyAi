import { specificationProductionFactsReady } from "@yummyai/contracts/catalog/development";
import { ConflictException, NotFoundException } from "@nestjs/common";
import {
  amazonOrderReportBatches,
  amazonOrderReportBatchItems,
  orders,
  orderLines,
  orderSourceSnapshots,
  salesChannelBindings,
  salesPackageVersions,
  salesRecipeVersions,
  artworkMasterVersions,
  artworkMasters,
  type TenantTransaction,
} from "@yummyai/database";
import { and, desc, eq, lte, isNull, or, sql } from "drizzle-orm";
import type { TenantContext } from "@yummyai/contracts";
import { Permission } from "@yummyai/authz";
import { catalogOwnerFilter, catalogRecipeReadFilter } from "@yummyai/catalog-core";
import { isDeepStrictEqual } from "node:util";
import { matchesCustomChoice } from "@yummyai/contracts/catalog/composition";
import { OrderSalesDeliverySnapshotSchema } from "@yummyai/contracts/catalog/sales-plan-delivery";
import type { OrderIntakeCheck } from "@yummyai/contracts/order/workspace";
import type { OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import { orderSalesSiteIssue, resolveOrderSalesSite } from "./order-sales-site.js";
import {
  readArtwork,
  readRecipe,
  readSpecification,
  currentSpecificationIds,
  assertSpecificationProcess,
  readArtworkMaterials,
} from "./development-data.js";

export async function readOrderSalesSite(
  tx: TenantTransaction,
  order: Pick<typeof orders.$inferSelect, "id" | "accountId" | "platform" | "externalOrderId">,
) {
  // Updates append immutable sources while orders.sourceSnapshotId retains the
  // initial source. Read the exact order identity, including later deliveries,
  // and project only the adapter-owned, non-private site fields.
  const siteSources = order.platform === "amazon" ? await tx
    .select({
      marketplaceId: sql<unknown>`${orderSourceSnapshots.redactedPayload}->'marketplaceId'`,
      apiVersion: sql<unknown>`${orderSourceSnapshots.redactedPayload}->'apiVersion'`,
      source: sql<unknown>`${orderSourceSnapshots.redactedPayload}->'source'`,
      orderId: sql<unknown>`${orderSourceSnapshots.redactedPayload}->'orderId'`,
    })
    .from(orderSourceSnapshots)
    .where(and(
      eq(orderSourceSnapshots.normalizedOrderId, order.id),
      eq(orderSourceSnapshots.accountId, order.accountId),
      eq(orderSourceSnapshots.platform, order.platform),
      eq(orderSourceSnapshots.externalOrderId, order.externalOrderId),
    )) : [];
  const reportSites = order.platform === "amazon" ? await tx
    .select({ site: amazonOrderReportBatches.marketplaceId })
    .from(amazonOrderReportBatchItems)
    .innerJoin(
      amazonOrderReportBatches,
      eq(amazonOrderReportBatches.id, amazonOrderReportBatchItems.batchId),
    )
    .where(and(
      eq(amazonOrderReportBatchItems.orderId, order.id),
      eq(amazonOrderReportBatchItems.externalOrderId, order.externalOrderId),
      eq(amazonOrderReportBatches.accountId, order.accountId),
      or(
        eq(amazonOrderReportBatchItems.status, "imported"),
        eq(amazonOrderReportBatchItems.status, "duplicate"),
      ),
    )) : [];
  return resolveOrderSalesSite(
    order.platform,
    order.externalOrderId,
    siteSources,
    reportSites.map((row) => row.site),
  );
}

export async function resolveOrderSalesBasis(
  tx: TenantTransaction,
  lineId: string,
  customChoice: Record<string, string> = {},
) {
  const [source] = await tx
    .select({ order: orders, line: orderLines })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(eq(orderLines.id, lineId));
  if (!source) throw new NotFoundException("订单商品不存在");
  const site = await readOrderSalesSite(tx, source.order);
  const matches = source.line.skuCode && site.status === "resolved"
    ? await tx
        .select({ binding: salesChannelBindings, pack: salesPackageVersions })
        .from(salesChannelBindings)
        .innerJoin(
          salesPackageVersions,
          eq(salesPackageVersions.id, salesChannelBindings.packageId),
        )
        .where(
          and(
            eq(salesChannelBindings.accountId, source.order.accountId),
            eq(salesChannelBindings.marketplaceId, site.marketplaceId),
            eq(salesChannelBindings.externalSku, source.line.skuCode),
            source.line.externalListingId
              ? eq(salesChannelBindings.externalListingId, source.line.externalListingId)
              : undefined,
            lte(salesChannelBindings.effectiveFrom, source.order.placedAt),
            eq(salesPackageVersions.platform, source.order.platform),
          ),
        )
        .orderBy(desc(salesChannelBindings.effectiveFrom))
    : [];
  // Unknown/conflicting sites cannot produce candidates. Keep only an internal
  // existence check so removing a package cannot bypass a controlled channel.
  const controlledSiteUnknown = source.line.skuCode && site.status !== "resolved"
    ? await tx
        .select({ exists: sql<boolean>`true` })
        .from(salesChannelBindings)
        .innerJoin(
          salesPackageVersions,
          eq(salesPackageVersions.id, salesChannelBindings.packageId),
        )
        .where(and(
          eq(salesChannelBindings.accountId, source.order.accountId),
          eq(salesChannelBindings.externalSku, source.line.skuCode),
          source.line.externalListingId
            ? eq(salesChannelBindings.externalListingId, source.line.externalListingId)
            : undefined,
          lte(salesChannelBindings.effectiveFrom, source.order.placedAt),
          eq(salesPackageVersions.platform, source.order.platform),
          sql`${salesPackageVersions.snapshot} ? 'salesPlanDelivery'`,
        ))
        .limit(1)
    : [];
  const identities = new Map<string, (typeof matches)[number]>();
  for (const m of matches) {
    const key = `${m.binding.marketplaceId}:${m.binding.externalListingId}:${m.binding.customChoiceKey}`;
    if (!identities.has(key)) identities.set(key, m);
  }
  const active = [...identities.values()];
  const hasChoices = active.some((m) => Object.keys(m.binding.customChoice).length);
  const candidates = active.filter(
    (m) =>
      matchesCustomChoice(m.binding.customChoice, customChoice) &&
      (!hasChoices || Object.keys(m.binding.customChoice).length > 0),
  );
  const picked = candidates.length === 1 ? candidates[0]! : null;
  const recipe = picked ? await readRecipe(tx, picked.pack.recipeId) : null;
  return {
    site,
    status: picked
      ? ("matched" as const)
      : candidates.length > 1
        ? ("ambiguous" as const)
        : ("unmatched" as const),
    packageId: picked?.pack.id ?? null,
    controlledDelivery: controlledSiteUnknown.length > 0 || matches.some(
      (match) => match.pack.snapshot.salesPlanDelivery !== undefined,
    ),
    matchingPackageIds: matches
      .filter(
        (m) =>
          matchesCustomChoice(m.binding.customChoice, customChoice) &&
          (!hasChoices || Object.keys(m.binding.customChoice).length > 0),
      )
      .map((match) => match.pack.id),
    recipe,
    customChoice: picked?.binding.customChoice ?? {},
  };
}

export async function validateOrderSalesBasis(
  tx: TenantTransaction,
  draft: OrderWorkDraft,
  allowPartial = false,
  lineId?: string,
  historicalPackageId?: string | null,
  requireNewFacts = false,
) {
  const recipe = draft.salesRecipeVersionId
    ? await readRecipe(tx, draft.salesRecipeVersionId)
    : null;
  if (!recipe && !draft.artworkVersionId && !draft.specificationVersionId && !draft.salesPackageId)
    return null;
  if (!recipe && allowPartial && (!draft.artworkVersionId || !draft.specificationVersionId)) {
    if (draft.salesPackageId) throw new ConflictException("请先匹配资料包对应的制作版本");
    if (draft.artworkVersionId) await readArtwork(tx, draft.artworkVersionId);
    if (draft.specificationVersionId) await readSpecification(tx, draft.specificationVersionId);
    return null;
  }
  if (
    recipe &&
    !(
      (recipe.status === "approved" && recipe.editorProjectId && recipe.editorVersionId) ||
      (recipe.status === "approved" &&
        recipe.designVersionId &&
        !recipe.artwork.assetId &&
        ["personalized_text", "customer_image", "customer_photo"].includes(recipe.artwork.mode)) ||
      (recipe.status === "ready_for_customization" &&
        !recipe.artwork.assetId &&
        !recipe.editorProjectId &&
        !recipe.editorVersionId)
    )
  )
    throw new ConflictException("订单必须引用已审核的销售 SKU 制作版本");
  const specificationId = draft.specificationVersionId ?? recipe?.specification.versionId;
  const artworkId = draft.artworkVersionId ?? recipe?.artwork.versionId;
  if (!specificationId || !artworkId)
    throw new ConflictException("请为本单匹配印花 SKU、产品 SPU 和具体规格");
  const specification = await readSpecification(tx, specificationId);
  assertSpecificationProcess(specification);
  if (recipe && recipe.specification.versionId !== specificationId)
    throw new ConflictException("所选规格与销售 SKU 制作版本不一致，请重新匹配");
  if (!specificationProductionFactsReady(specification.facts) && (requireNewFacts || !specification.facts.factsConfirmed))
    throw new ConflictException("产品规格生产资料尚未确认 新匹配须补齐尺寸口径 结构与核验依据");
  if (draft.printProfileVersionId !== specification.processProfileVersionId)
    throw new ConflictException("订单工艺应与所选产品规格保持一致");
  let pack: typeof salesPackageVersions.$inferSelect | undefined;
  if (draft.salesPackageId) {
    [pack] = await tx
      .select()
      .from(salesPackageVersions)
      .where(eq(salesPackageVersions.id, draft.salesPackageId));
    if (!pack || pack.recipeId !== recipe?.id)
      throw new ConflictException("资料包与制作版本不一致");
  }
  const overridden = recipe && recipe.artwork.versionId !== artworkId;
  if (
    overridden &&
    (pack?.snapshot.salesPlanDelivery !== undefined ||
      recipe.printBindings?.length !== 1 ||
      !isDeepStrictEqual(
        { ...recipe.printBindings[0]!, artwork: undefined },
        {
          ...recipe.printBindings[0]!,
          key: "primary",
          surface: "front",
          region: "whole",
          area: { xPercent: 0, yPercent: 0, widthPercent: 100, heightPercent: 100 },
          fieldMappings: [],
          artwork: undefined,
        },
      ))
  )
    throw new ConflictException("组合或受控刊登的印花须与固定配方一致；变更请新建并审核配方");
  const artwork = overridden
    ? await readArtwork(tx, artworkId)
    : (recipe?.artwork ?? (await readArtwork(tx, artworkId)));
  const materials = await readArtworkMaterials(tx, artwork);
  const asset = artwork.assetId ? materials.find((m) => m.id === artwork.assetId) : undefined;
  if (artwork.assetId && !asset) throw new ConflictException("印花主文件未包含在素材包中");
  const deliveryIssues: OrderIntakeCheck["issues"] = [];
  const delivery =
    pack?.snapshot.salesPlanDelivery === undefined
      ? null
      : OrderSalesDeliverySnapshotSchema.safeParse(pack.snapshot.salesPlanDelivery);
  if (delivery && !delivery.success)
    deliveryIssues.push({
      code: "invalid_delivery",
      fieldKey: null,
      message: "封存资料的定制核对记录不完整",
      action: "回上架工作台核对并创建新的资料包；不得补写历史核对",
    });
  const pinned = delivery?.success ? delivery.data : null;
  // Choice values route the order; they are not production content. Strip only
  // the exact, immutable choice for this SKU and reject duplicates/mismatches.
  const productionDraft = structuredClone(draft);
  const routingFields: OrderWorkDraft["fields"] = [];
  if (pinned?.patternChoices && recipe) {
    const choice = pinned.patternChoices;
    const option = choice.options.find((o) => o.skuId === recipe.skuId);
    const supplied = draft.fields.filter((f) => f.key === choice.fieldKey);
    if (
      !option ||
      supplied.length !== 1 ||
      supplied[0]!.value !== option.value ||
      artwork.customization.fields.some((f) => f.key === choice.fieldKey)
    )
      deliveryIssues.push({
        code: "custom_choice_mismatch",
        fieldKey: choice.fieldKey,
        message: "顾客选款与封存销售 SKU 不一致或存在重复",
        action: "按买家原始选款核对下单时的渠道映射，不能代选图案",
      });
    else {
      routingFields.push(supplied[0]!);
      productionDraft.fields = productionDraft.fields.filter((f) => f.key !== choice.fieldKey);
    }
  }
  if (pinned && pack && recipe) {
    const skuPin = pinned.skuMapping.find((m) => m.skuId === recipe.skuId);
    if (
      pinned.review.fingerprint !== pinned.fingerprint ||
      pinned.review.revision !== pinned.revision ||
      pinned.review.listingVersionId !== pack.listingVersionId ||
      !pinned.skuMapping.some(
        (mapping) =>
          mapping.skuId === pack.skuId &&
          mapping.recipeId === recipe.id &&
          mapping.skuCode === recipe.skuCode &&
          mapping.specificationVersionId === specification.versionId,
      )
    )
      deliveryIssues.push({
        code: "delivery_version_mismatch",
        fieldKey: null,
        message: "封存核对与本单 SKU 制作版本不一致",
        action: "核对 SKU 映射与资料包版本，重新匹配本单制作依据",
      });
    const fields = (definition: typeof artwork.customization) =>
      [...definition.fields].sort((a, b) => a.key.localeCompare(b.key));
    if (
      !isDeepStrictEqual(
        fields(skuPin?.customization ?? pinned.customization),
        fields(artwork.customization),
      )
    )
      deliveryIssues.push({
        code: "delivery_fields_mismatch",
        fieldKey: null,
        message: "封存定制字段与制作版本不一致",
        action: "核对实际定制配置与印花字段；修订并审核一致的新版本后重新封存",
      });
    if (!isDeepStrictEqual(skuPin?.layout ?? pinned.layout, artwork.layout))
      deliveryIssues.push({
        code: "delivery_layout_mismatch",
        fieldKey: null,
        message: "封存定制区域与制作版本不一致",
        action: "核对定制区域映射，修订并审核一致的新版本后重新封存",
      });
  }
  if (lineId) {
    const resolved = await resolveOrderSalesBasis(
      tx,
      lineId,
      Object.fromEntries(draft.fields.map((f) => [f.key, f.value])),
    );
    const siteIssue = orderSalesSiteIssue(resolved.site);
    if (siteIssue && (delivery || resolved.controlledDelivery)) deliveryIssues.push(siteIssue);
    // A legacy package cannot bypass a controlled channel's delivery checks.
    // Preserve genuine legacy/manual flows and the immutable pin of a saved order.
    if (pack && (delivery || resolved.controlledDelivery)) {
      const historicalMatch =
        historicalPackageId === pack.id && resolved.matchingPackageIds.includes(pack.id);
      if (resolved.packageId !== pack.id && !historicalMatch)
        deliveryIssues.push({
          code: "channel_package_mismatch",
          fieldKey: null,
          message:
            resolved.status === "ambiguous"
              ? "下单时的店铺 SKU 映射存在多个候选"
              : "本单未匹配到下单时生效的封存资料包",
          action: "核对店铺、站点、平台 SKU 和映射生效时间；不要套用其他商品的资料包",
        });
    }
    if (!pack && resolved.controlledDelivery)
      deliveryIssues.push({
        code: "missing_delivery_reference",
        fieldKey: null,
        message: "本单渠道已有封存定制资料，请保留对应资料包引用",
        action: "按下单时生效的店铺 SKU 映射重新匹配，不能移除资料包绕过核对",
      });
  }
  return {
    recipe,
    specification,
    artwork,
    asset,
    materials,
    deliveryIssues,
    productionDraft,
    routingFields,
    delivery: pinned,
    package: pack
      ? {
          id: pack.id,
          version: pack.versionNumber,
          planId: pinned?.planId ?? null,
          planRevision: pinned?.revision ?? null,
          reviewId: pinned?.review.id ?? null,
          reviewedAt: pinned?.review.occurredAt ?? null,
          fingerprint: pinned?.fingerprint ?? null,
        }
      : null,
  };
}

export async function orderSalesChoices(
  tx: TenantTransaction,
  context: TenantContext,
  pinnedSpecificationId?: string | null,
  pinnedArtworkId?: string | null,
  pinnedRecipeId?: string | null,
) {
  const rows = await tx
    .select({ id: salesRecipeVersions.id })
    .from(salesRecipeVersions)
    .where(
      or(
        context.permissions.includes(Permission.ProductRead) &&
          context.permissions.includes(Permission.DesignRead)
          ? and(
              or(
                eq(salesRecipeVersions.status, "approved"),
                eq(salesRecipeVersions.status, "ready_for_customization"),
              ),
              catalogRecipeReadFilter(context, salesRecipeVersions.id),
            )
          : sql`false`,
        pinnedRecipeId ? eq(salesRecipeVersions.id, pinnedRecipeId) : undefined,
      ),
    )
    .orderBy(desc(salesRecipeVersions.createdAt));
  const recipes = (await Promise.all(rows.map((r) => readRecipe(tx, r.id)))).filter(
    (r) => r.id === pinnedRecipeId || (!r.artwork.archived && specificationProductionFactsReady(r.specification.facts)),
  );
  const artworkIds = await tx
    .select({
      id: artworkMasterVersions.id,
      code: artworkMasters.code,
      name: artworkMasterVersions.name,
      version: artworkMasterVersions.versionNumber,
    })
    .from(artworkMasterVersions)
    .innerJoin(artworkMasters, eq(artworkMasters.id, artworkMasterVersions.artworkId))
    .where(
      or(
        context.permissions.includes(Permission.DesignRead)
          ? and(
              isNull(artworkMasters.archivedAt),
              catalogOwnerFilter(
                context,
                Permission.DesignRead,
                artworkMasters.createdBy,
                artworkMasters.teamId,
              ),
            )
          : sql`false`,
        pinnedArtworkId ? eq(artworkMasterVersions.id, pinnedArtworkId) : undefined,
      ),
    )
    .orderBy(artworkMasters.code, desc(artworkMasterVersions.versionNumber));
  const artworks = await Promise.all(artworkIds.map((a) => readArtwork(tx, a.id)));
  const specificationIds = new Set(
    (context.permissions.includes(Permission.ProductRead)
      ? await currentSpecificationIds(tx, context)
      : []
    ).map((s) => s.id),
  );
  for (const recipe of recipes) specificationIds.add(recipe.specification.versionId);
  if (pinnedSpecificationId) specificationIds.add(pinnedSpecificationId);
  const specifications = await Promise.all(
    [...specificationIds].map((id) => readSpecification(tx, id)),
  );
  return {
    recipes: recipes.map((r) => ({
      id: r.id,
      skuId: r.skuId,
      skuCode: r.skuCode,
      version: r.version,
      printSku: r.artwork.code,
      artworkVersionId: r.artwork.versionId,
      processProfileVersionId: r.specification.processProfileVersionId,
      spuCode: r.specification.spuCode,
      specification: r.specification.name,
      specificationVersionId: r.specification.versionId,
    })),
    artworks: artworks.map((a) => ({
      id: a.versionId,
      code: a.code,
      name: a.name,
      version: a.version,
      mode: a.mode,
      materials: a.materials,
      customization: a.customization,
      layout: a.layout,
      instructions: a.instructions,
    })),
    specifications: specifications
      .filter(
        (s): s is typeof s & { processProfileVersionId: string } =>
          !!s.processProfileVersionId && (specificationProductionFactsReady(s.facts) || (s.versionId === pinnedSpecificationId && s.facts.factsConfirmed)),
      )
      .map((s) => ({
        id: s.versionId,
        spuId: s.spuId,
        spuCode: s.spuCode,
        spuName: s.spuName,
        name: s.name,
        version: s.version,
        processProfileVersionId: s.processProfileVersionId,
        processName: s.processName,
        dimensions: s.facts.dimensions,
      })),
  };
}
