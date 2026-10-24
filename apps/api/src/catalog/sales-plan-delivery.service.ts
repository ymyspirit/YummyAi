import { withCatalogTenant as withTenant } from "./catalog-access.js";
import {
  currentCatalogContext,
  assertCatalogSalesPlanAccess,
  catalogRecipeReadFilter,
  catalogOwnerFilter,
} from "@yummyai/catalog-core";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { CustomizationDefinition } from "@yummyai/contracts/catalog/product";
import {
  DeliveryReviewSchema,
  DeliverySealSchema,
  DeliveryReadQuerySchema,
  DeliveryExportQuerySchema,
  type DeliveryReview,
  type SalesPlanPackageView,
  type SalesPlanDelivery,
} from "@yummyai/contracts/catalog/sales-plan-delivery";
import {
  developmentEvents,
  mockupBatchOutputs,
  salesPackageVersions,
  listings,
  type DatabaseConnection,
} from "@yummyai/database";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { SalesPackageService } from "./sales-package.service.js";
import { fingerprint, lockDevelopment, mutateDevelopment } from "./development-data.js";
import {
  DELIVERY_REVIEW_ACTION,
  deliveryChanges,
  readDelivery,
} from "./sales-plan-delivery-data.js";

const required = [
  Permission.ProductRead,
  Permission.DesignRead,
  Permission.AssetRead,
  Permission.ListingRead,
];
function fieldDetails(field: CustomizationDefinition["fields"][number]) {
  const parts: string[] = [];
  if (field.helpText) parts.push(field.helpText);
  if (field.type === "short_text" || field.type === "long_text") {
    if (field.validation?.minLength !== undefined)
      parts.push(`至少 ${field.validation.minLength} 字符`);
    if (field.validation?.maxLength !== undefined)
      parts.push(`最多 ${field.validation.maxLength} 字符`);
    if (field.validation?.pattern) parts.push(`输入格式：${field.validation.pattern}`);
  } else if (field.type === "image") {
    parts.push(
      `支持 ${field.validation.allowedMediaTypes.map((m) => m.replace("image/", "").toUpperCase()).join("、")}；最多 ${field.validation.maxFiles} 张；每张最多 ${(field.validation.maxBytes / 1024 / 1024).toFixed(1)} MiB`,
    );
  } else if (field.type === "single_choice" || field.type === "multiple_choice") {
    parts.push(`选项：${field.options.map((o) => `${o.label}（${o.value}）`).join("、")}`);
    if (field.type === "multiple_choice")
      parts.push(
        `至少选 ${field.minSelections} 项${field.maxSelections ? `，最多选 ${field.maxSelections} 项` : ""}`,
      );
  } else if (field.type === "color") parts.push(`颜色：${field.palette.join("、")}`);
  else if (field.type === "date")
    parts.push(`日期范围：${field.minDate ?? "不限"} 至 ${field.maxDate ?? "不限"}`);
  if (field.visibleWhen)
    parts.push(
      `显示条件：${field.visibleWhen.fieldKey} ${field.visibleWhen.operator}${"value" in field.visibleWhen ? ` ${field.visibleWhen.value}` : ""}`,
    );
  return parts.join("\n") || "按实际页面配置核对";
}
const allowed = (c: TenantContext, ps: string[]) =>
  ps.every((p) => c.permissions.includes(p as Permission));
function access(c: TenantContext) {
  const read = allowed(c, required),
    review = read && allowed(c, [Permission.ListingReview]);
  return { read, review, seal: review && allowed(c, [Permission.ProductWrite]), download: read };
}
@Injectable()
export class SalesPlanDeliveryService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(SalesPackageService) private readonly packages: SalesPackageService,
  ) {}
  async get(
    context: TenantContext,
    planId: string,
    query: unknown = {},
  ): Promise<SalesPlanDelivery> {
    authorize(context, Permission.ProductRead);
    const { packagePage } = DeliveryReadQuerySchema.parse(query),
      pageSize = 25;
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      await assertCatalogSalesPlanAccess(tx, context, planId, [Permission.ProductRead]);
      const permissions = access(context);
      if (!permissions.read)
        return {
          planId,
          revision: 0,
          fingerprint: "",
          supported: false,
          access: permissions,
          listing: null,
          issues: [],
          customization: [],
          instructions: "",
          configurationEvidence: "",
          copy: null,
          skus: [],
          images: [],
          review: null,
          packages: [],
          currentPackages: [],
          packageHistory: { page: packagePage, pageSize, hasMore: false },
          diagnostics: ["读取交付核对需要商品、设计、素材和刊登读取权限"],
        };
      const d = await readDelivery(tx, planId, context),
        f = d.source.fields;
      const [last] = await tx
        .select()
        .from(developmentEvents)
        .where(
          and(
            eq(developmentEvents.resourceId, planId),
            eq(developmentEvents.action, DELIVERY_REVIEW_ACTION),
          ),
        )
        .orderBy(desc(developmentEvents.createdAt))
        .limit(1);
      const prior = last?.result as
        { review: DeliveryReview; basis: Record<string, unknown> } | undefined;
      // History belongs to the original Listing/plan, never today's selected SKUs.
      // Apply current parent/recipe/Listing scopes before the page boundary.
      const packageScope = and(
        eq(listings.salesPlanId, planId),
        catalogOwnerFilter(context, Permission.ListingRead, listings.createdBy),
        catalogRecipeReadFilter(context, salesPackageVersions.recipeId),
        or(
          sql`not (${salesPackageVersions.snapshot} ? 'salesPlanDelivery')`,
          sql`${salesPackageVersions.snapshot}->'salesPlanDelivery'->>'planId' = ${planId}`,
        ),
      );
      const rows = await tx
        .select({ pack: salesPackageVersions })
        .from(salesPackageVersions)
        .innerJoin(listings, eq(listings.id, salesPackageVersions.listingId))
        .where(packageScope)
        .orderBy(desc(salesPackageVersions.createdAt), desc(salesPackageVersions.id))
        .limit(pageSize + 1)
        .offset((packagePage - 1) * pageSize);
      const currentRows =
        d.row && f.skuIds.length && d.recipes.some((r) => r.recipe)
          ? await tx
              .selectDistinctOn([salesPackageVersions.skuId], { pack: salesPackageVersions })
              .from(salesPackageVersions)
              .innerJoin(listings, eq(listings.id, salesPackageVersions.listingId))
              .where(
                and(
                  packageScope,
                  eq(salesPackageVersions.listingId, d.row.listing.id),
                  eq(salesPackageVersions.listingVersionId, d.row.version.id),
                  inArray(salesPackageVersions.skuId, f.skuIds),
                  inArray(
                    salesPackageVersions.recipeId,
                    d.recipes.flatMap((r) => (r.recipe ? [r.recipe.id] : [])),
                  ),
                  sql`${salesPackageVersions.snapshot}->'salesPlanDelivery'->>'fingerprint' = ${d.fingerprint}`,
                ),
              )
              .orderBy(salesPackageVersions.skuId, desc(salesPackageVersions.versionNumber))
              .limit(50)
          : [];
      const outputs = d.content?.mediaAssetIds.length
        ? await tx
            .select()
            .from(mockupBatchOutputs)
            .where(
              and(
                inArray(mockupBatchOutputs.assetId, d.content.mediaAssetIds),
                eq(mockupBatchOutputs.status, "approved"),
              ),
            )
        : [];
      if (!d.issues.length && d.row && d.content) {
        const evidence = d.content.mediaAssetIds.map((assetId) => ({
          assetId,
          kind:
            assetId === d.content!.mainImageId
              ? ("finished_photo" as const)
              : outputs.some((o) => o.assetId === assetId)
                ? ("mockup" as const)
                : ("detail" as const),
        }));
        for (const r of d.recipes) {
          try {
            await this.packages.prepareSeal(tx, context, {
              recipeId: r.recipe!.id,
              listingId: d.row.listing.id,
              listingVersionId: d.row.version.id,
              imageEvidence: evidence,
              reason: "只读技术预检，不记录人工确认",
              idempotencyKey: createEntityId(),
            });
          } catch (error) {
            if (!(error instanceof ConflictException)) throw error;
            d.issues.push({
              path: `skus.${r.skuId}.package`,
              message: error.message,
              href: `/product-development?sku=${r.skuId}`,
            });
          }
        }
      }
      const projectPackage = async (
        p: typeof salesPackageVersions.$inferSelect,
        currentDownload = false,
      ): Promise<SalesPlanPackageView> => {
        const delivery = p.snapshot.salesPlanDelivery as
          { planId?: string; fingerprint?: string } | undefined;
        const recipe = p.snapshot.recipe as { skuCode?: unknown } | undefined;
        const eligible =
          fingerprint(p.snapshot) === p.checksum &&
          d.issues.length === 0 &&
          p.listingId === d.row?.listing.id &&
          p.recipeId === d.recipes.find((r) => r.skuId === p.skuId)?.recipe?.id &&
          p.listingVersionId === d.row?.version.id &&
          (!delivery || (delivery.planId === planId && delivery.fingerprint === d.fingerprint));
        const current =
          eligible &&
          (await this.packages.isCurrent(context, p.id, p.recipeId, p.listingVersionId));
        return {
          id: p.id,
          skuId: p.skuId,
          skuCode:
            typeof recipe?.skuCode === "string"
              ? recipe.skuCode
              : (d.skuRows.find((s) => s.id === p.skuId)?.code ?? "原 SKU 编码缺失"),
          version: p.versionNumber,
          checksum: p.checksum,
          current,
          reviewedDelivery: !!delivery,
          createdAt: p.createdAt.toISOString(),
          downloadPath: delivery
            ? `/api/sales-plans/${planId}/launch/delivery/packages/${p.id}/export?basis=${currentDownload ? "current" : "history"}`
            : `/api/product-development/packages/${p.id}/export`,
        };
      };
      const packages = await Promise.all(
        rows.slice(0, pageSize).map(({ pack }) => projectPackage(pack)),
      );
      const currentPackages = (
        await Promise.all(currentRows.map(({ pack }) => projectPackage(pack, true)))
      ).filter((pack) => pack.current && pack.reviewedDelivery);
      return {
        planId,
        revision: d.source.revision,
        fingerprint: d.fingerprint,
        supported: d.supported,
        access: permissions,
        listing: d.row
          ? {
              id: d.row.listing.id,
              versionId: d.row.version.id,
              version: d.row.version.versionNumber,
              status: d.row.listing.status,
              title: d.row.version.content.title,
              href: `/listings/${d.row.listing.id}`,
            }
          : null,
        issues: d.issues,
        customization: f.customization.fields.map((field) => ({
          key: field.key,
          label: field.label,
          type: field.type,
          required: field.required,
          details: fieldDetails(field),
        })),
        instructions: f.customInstructions,
        configurationEvidence: f.customPage.evidence,
        copy: d.content
          ? {
              title: d.content.title,
              bullets: d.content.bullets,
              description: d.content.description,
              personalization: d.content.personalization?.instructions ?? "",
            }
          : null,
        skus: d.recipes.map(({ skuId, recipe }) => ({
          id: skuId,
          code: d.skuRows.find((s) => s.id === skuId)?.code ?? "不可读取",
          recipeId: recipe?.id ?? null,
          specification: recipe
            ? `${recipe.specification.name} · 规格 V${recipe.specification.version}`
            : "制作依据缺失",
          attributes: recipe?.specification.attributes ?? {},
          facts: recipe?.specification.facts ?? null,
          issues: d.issues.filter((i) => i.path.startsWith(`skus.${skuId}`)),
          href: `/product-development?sku=${skuId}`,
        })),
        images: (d.content?.mediaAssetIds ?? []).map((id) => ({
          id,
          name: d.assets.find((a) => a.id === id)?.fileName ?? "图片不可用",
          main: id === d.content?.mainImageId,
          previewPath: `/api/product-development/assets/${id}/preview`,
          suggestedKind: outputs.some((o) => o.assetId === id) ? "mockup" : null,
          issues: d.issues.filter((i) => i.path === `assets.${id}`),
        })),
        review: prior
          ? {
              ...prior.review,
              current: prior.review.fingerprint === d.fingerprint && !d.issues.length,
              changes: deliveryChanges(prior.basis, d.basis),
            }
          : null,
        packages,
        currentPackages,
        packageHistory: { page: packagePage, pageSize, hasMore: rows.length > pageSize },
        diagnostics: [
          "文字承诺、图片保真及实际平台定制配置由运营逐项核对；本页不调用模型、不操作平台或工厂。",
          "历史资料包固定原审核与文件，不代表当前可交付；下载时仍核对当前读取权与原文件字节。",
        ],
      };
    });
  }
  async review(context: TenantContext, planId: string, body: unknown) {
    for (const p of [...required, Permission.ListingReview]) authorize(context, p);
    const input = DeliveryReviewSchema.parse(body),
      id = createEntityId();
    return mutateDevelopment(
      this.database,
      context,
      {
        access: {
          kind: "salesPlan",
          id: planId,
          permissions: [Permission.ProductRead],
          additional: [
            { kind: "create", permissions: [Permission.DesignRead, Permission.AssetRead] },
            {
              kind: "salesPlanListings",
              id: planId,
              permissions: [Permission.ListingRead, Permission.ListingReview],
            },
          ],
        },
        eventId: id,
        key: input.idempotencyKey,
        action: DELIVERY_REVIEW_ACTION,
        resourceId: planId,
        reason: input.note,
        input: { planId, ...input },
      },
      async (tx, currentContext) => {
        context = currentContext;
        await lockDevelopment(tx, context, `sales-plan:${planId}`);
        const d = await readDelivery(tx, planId, context);
        if (
          d.fingerprint !== input.expectedFingerprint ||
          d.source.revision !== input.expectedRevision ||
          d.row?.version.id !== input.listingVersionId
        )
          throw new ConflictException("核对依据已变化，请刷新后重新核对");
        if (d.issues.length || !d.row)
          throw new ConflictException(d.issues[0]?.message ?? "刊登资料未齐备");
        for (const r of d.recipes)
          await this.packages.prepareSeal(tx, context, {
            recipeId: r.recipe!.id,
            listingId: d.row.listing.id,
            listingVersionId: d.row.version.id,
            imageEvidence: input.imageEvidence,
            reason: input.note,
            idempotencyKey: input.idempotencyKey,
          });
        const review: DeliveryReview = {
          id,
          fingerprint: d.fingerprint,
          revision: d.source.revision,
          listingVersionId: d.row.version.id,
          actor: context.userId,
          occurredAt: new Date().toISOString(),
          note: input.note,
          checks: input.checks,
          imageEvidence: input.imageEvidence,
        };
        return {
          review,
          basis: d.basis,
          bindings: {
            listingId: d.row.listing.id,
            recipes: d.recipes.map((r) => ({ skuId: r.skuId, recipeId: r.recipe!.id })),
          },
        };
      },
    );
  }
  async seal(context: TenantContext, planId: string, body: unknown) {
    for (const p of [...required, Permission.ListingReview, Permission.ProductWrite])
      authorize(context, p);
    const input = DeliverySealSchema.parse(body);
    const [event] = await withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      await assertCatalogSalesPlanAccess(tx, context, planId, [Permission.ProductWrite]);
      return tx
        .select()
        .from(developmentEvents)
        .where(
          and(
            eq(developmentEvents.id, input.reviewId),
            eq(developmentEvents.resourceId, planId),
            eq(developmentEvents.action, DELIVERY_REVIEW_ACTION),
          ),
        );
    });
    if (!event) throw new NotFoundException("交付核对记录不存在");
    const { review, bindings } = event.result as {
      review: DeliveryReview;
      bindings: { listingId: string; recipes: Array<{ skuId: string; recipeId: string }> };
    };
    const binding = bindings.recipes.find((r) => r.skuId === input.skuId);
    if (!binding || review.fingerprint !== input.expectedFingerprint)
      throw new ConflictException("封存选择与核对版本不一致");
    return this.packages.seal(context, {
      recipeId: binding.recipeId,
      listingId: bindings.listingId,
      listingVersionId: review.listingVersionId,
      deliveryReviewId: input.reviewId,
      imageEvidence: review.imageEvidence,
      reason: review.note,
      idempotencyKey: input.idempotencyKey,
    });
  }
  async export(context: TenantContext, planId: string, packageId: string, query: unknown = {}) {
    for (const p of required) authorize(context, p);
    const { basis } = DeliveryExportQuerySchema.parse(query);
    const assertCurrent = () =>
      withTenant(this.database.db, context, async (tx) => {
        context = await currentCatalogContext(tx, context);
        for (const p of required) authorize(context, p);
        await assertCatalogSalesPlanAccess(tx, context, planId, [Permission.ProductRead]);
        const [row] = await tx
          .select({ pack: salesPackageVersions })
          .from(salesPackageVersions)
          .innerJoin(listings, eq(listings.id, salesPackageVersions.listingId))
          .where(and(eq(salesPackageVersions.id, packageId), eq(listings.salesPlanId, planId)));
        const pack = row?.pack;
        const delivery = pack?.snapshot.salesPlanDelivery as
          { planId?: string; fingerprint?: string } | undefined;
        if (!pack || delivery?.planId !== planId)
          throw new NotFoundException("本方案的交付资料包不存在");
        if (fingerprint(pack.snapshot) !== pack.checksum)
          throw new ConflictException("资料包校验失败");
        if (basis === "current") {
          const d = await readDelivery(tx, planId, context);
          if (d.issues.length || delivery.fingerprint !== d.fingerprint)
            throw new ConflictException(
              "资料包已不适用于当前版本，请重新核对并封存；可选择下载历史封存包",
            );
        }
      });
    await assertCurrent();
    const exported = await this.packages.export(context, packageId);
    // Byte reads can take time. Recheck the plan after the canonical file checks,
    // before returning a download described as the current handoff package.
    await assertCurrent();
    return basis === "history" ? { ...exported, name: `historical-${exported.name}` } : exported;
  }
}
