import { specificationFactsReady } from "@yummyai/contracts/catalog/development";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import {
  ContentProjectListSchema,
  ContentProjectSchema,
  type ContentProject,
  type ContentProjectQuery,
} from "@yummyai/contracts/catalog/content-project";
import {
  assetFiles,
  artworkMasters,
  artworkMasterVersions,
  creativeDesignBatches,
  creativeDesignBatchItems,
  creativeDesignCandidates,
  creativeDesignVersions,
  listingVersions,
  listings,
  mockupBatches,
  mockupBatchItems,
  mockupBatchOutputs,
  mockupTemplateSlots,
  productPlans,
  salesPackageVersions,
  salesRecipeVersions,
  salesSkuDefinitions,
  skus,
  spus,
  withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { readRecipe } from "../catalog/development-data.js";
import { SalesPackageService } from "../catalog/sales-package.service.js";
import { CanvasBridgeService } from "../design/canvas-bridge.service.js";
import { CanvasWorkflowService } from "../design/canvas-workflow.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { contentProjectStages } from "./content-project-stages.js";

const relatedLimit = 100;
/** A read projection over existing immutable relations. Business services own every write. */
@Injectable()
export class ContentProjectService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(CanvasBridgeService) private readonly bridge: CanvasBridgeService,
    @Inject(CanvasWorkflowService) private readonly canvas: CanvasWorkflowService,
    @Inject(SalesPackageService) private readonly salesPackages: SalesPackageService,
  ) {}

  async list(context: TenantContext, query: ContentProjectQuery) {
    authorize(context, Permission.DesignRead);
    return withTenant(this.database.db, context, async (tx) => {
      const filter = and(
        eq(creativeDesignBatches.executionMode, "infinite_canvas"),
        isNull(creativeDesignBatches.archivedAt),
        or(
          sql`${creativeDesignBatches.canvasWorkflow} is null`,
          sql`${creativeDesignBatches.canvasWorkflow}->>'rootBatchId' = ${creativeDesignBatches.id}::text`,
        ),
        query.q
          ? sql`(${creativeDesignBatches.name} ilike ${`%${query.q.replace(/[\\%_]/g, "\\$&")}%`} or exists (
            select 1 from creative_design_batches as revised
            where revised.tenant_id = ${context.tenantId} and revised.archived_at is null
              and revised.canvas_workflow->>'rootBatchId' = ${creativeDesignBatches.id}::text
              and revised.name ilike ${`%${query.q.replace(/[\\%_]/g, "\\$&")}%`}
          ))`
          : undefined,
      );
      const [count] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(creativeDesignBatches)
        .where(filter);
      const roots = await tx
        .select()
        .from(creativeDesignBatches)
        .where(filter)
        .orderBy(desc(creativeDesignBatches.createdAt), desc(creativeDesignBatches.id))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      const ids = roots.map((r) => r.id);
      const steps = ids.length
        ? await tx
            .select()
            .from(creativeDesignBatches)
            .where(
              and(
                isNull(creativeDesignBatches.archivedAt),
                or(
                  inArray(creativeDesignBatches.id, ids),
                  inArray(
                    sql<string>`${creativeDesignBatches.canvasWorkflow}->>'rootBatchId'`,
                    ids,
                  ),
                ),
              ),
            )
        : [];
      return ContentProjectListSchema.parse({
        total: count?.total ?? 0,
        page: query.page,
        pageSize: query.pageSize,
        items: roots.map((root) => {
          const latest =
            steps
              .filter((s) => s.id === root.id || s.canvasWorkflow?.rootBatchId === root.id)
              .sort(
                (a, b) =>
                  (b.canvasWorkflow?.revision?.number ?? 1) - (a.canvasWorkflow?.revision?.number ?? 1) ||
                  (b.canvasWorkflow?.stepIndex ?? 0) - (a.canvasWorkflow?.stepIndex ?? 0) ||
                  b.createdAt.getTime() - a.createdAt.getTime(),
              )[0] ?? root;
          return {
            id: root.id,
            name: latest.canvasWorkflow?.revision?.projectName ?? root.name,
            briefId: latest.id,
            stepName:
              latest.canvasWorkflow?.template.steps[latest.canvasWorkflow.stepIndex]?.name ??
              "创作与审核",
            resultCount: latest.generatedCount,
            approvedCount: latest.approvedCount,
            createdAt: root.createdAt.toISOString(),
            updatedAt: latest.updatedAt.toISOString(),
          };
        }),
      });
    });
  }

  async get(context: TenantContext, requestedId: string): Promise<ContentProject> {
    authorize(context, Permission.DesignRead);
    authorize(context, Permission.AssetRead);
    const selected = await this.bridge.get(context, requestedId);
    const rootId = selected.workflow?.rootBatchId ?? selected.id;
    const root = rootId === selected.id ? selected : await this.bridge.get(context, rootId);
    const access = {
      research: context.permissions.includes(Permission.ResearchRead),
      catalog: context.permissions.includes(Permission.ProductRead),
      listing: context.permissions.includes(Permission.ListingRead),
      assets: context.permissions.includes(Permission.AssetRead),
    };
    const projection = await withTenant(this.database.db, context, async (tx) => {
      const batches = await tx
        .select()
        .from(creativeDesignBatches)
        .where(
          and(
            isNull(creativeDesignBatches.archivedAt),
            or(
              eq(creativeDesignBatches.id, rootId),
              sql`${creativeDesignBatches.canvasWorkflow}->>'rootBatchId' = ${rootId}`,
            ),
          ),
        )
        .orderBy(
          asc(sql`${creativeDesignBatches.canvasWorkflow}->>'stepIndex'`),
          asc(creativeDesignBatches.createdAt),
        );
      const rootRow = batches.find((b) => b.id === rootId);
      if (!rootRow) throw new NotFoundException("图文项目不存在");
      const latest = [...batches].sort(
        (a, b) =>
          (b.canvasWorkflow?.revision?.number ?? 1) - (a.canvasWorkflow?.revision?.number ?? 1) ||
          (b.canvasWorkflow?.stepIndex ?? 0) - (a.canvasWorkflow?.stepIndex ?? 0) ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      )[0]!;
      const revisionStart = [...batches].filter(b => (b.canvasWorkflow?.revision?.number ?? 1) === (latest.canvasWorkflow?.revision?.number ?? 1))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]!;
      const [revisionItem] = await tx.select({ prompt: creativeDesignBatchItems.prompt }).from(creativeDesignBatchItems)
        .where(eq(creativeDesignBatchItems.batchId, revisionStart.id)).limit(1);
      const versions = await tx
        .select({ id: creativeDesignVersions.id })
        .from(creativeDesignVersions)
        .innerJoin(
          creativeDesignCandidates,
          eq(creativeDesignCandidates.id, creativeDesignVersions.sourceCandidateId),
        )
        .innerJoin(
          creativeDesignBatchItems,
          eq(creativeDesignBatchItems.id, creativeDesignCandidates.itemId),
        )
        .where(
          inArray(
            creativeDesignBatchItems.batchId,
            batches.map((b) => b.id),
          ),
        );
      const versionIds = versions.map((v) => v.id),
        diagnostics: string[] = [];
      const artworks: ContentProject["artworks"] = [];
      const skuViews: ContentProject["skus"] = [];
      const mockupViews: ContentProject["mockups"] = [];
      const listingViews: ContentProject["listings"] = [];
      const packageViews: ContentProject["packages"] = [];
      function bounded<T>(rows: T[], name: string) {
        if (rows.length > relatedLimit)
          diagnostics.push(`关联记录超过 ${relatedLimit} 条：${name}，请在原工作台核对完整记录`);
        return rows.slice(0, relatedLimit);
      }
      if (access.catalog && versionIds.length) {
        const artRows = await tx
          .select({ master: artworkMasters, version: artworkMasterVersions })
          .from(artworkMasterVersions)
          .innerJoin(artworkMasters, eq(artworkMasters.id, artworkMasterVersions.artworkId))
          .where(inArray(artworkMasterVersions.creativeVersionId, versionIds))
          .orderBy(desc(artworkMasterVersions.createdAt))
          .limit(relatedLimit + 1);
        artworks.push(
          ...bounded(artRows, "印花版本").map(({ master, version }) => ({
            id: master.id,
            versionId: version.id,
            creativeVersionId: version.creativeVersionId!,
            code: master.code,
            name: version.name,
            version: version.versionNumber,
            current: master.versionNumber === version.versionNumber,
            archived: !!master.archivedAt,
          })),
        );
        const relatedSkus = await tx
          .selectDistinct({ id: salesRecipeVersions.skuId })
          .from(salesRecipeVersions)
          .innerJoin(
            artworkMasterVersions,
            eq(artworkMasterVersions.id, salesRecipeVersions.artworkVersionId),
          )
          .where(inArray(artworkMasterVersions.creativeVersionId, versionIds))
          .limit(relatedLimit + 1);
        const skuIds = bounded(relatedSkus, "销售 SKU").map((s) => s.id);
        const currentRecipes = skuIds.length
          ? await tx
              .select({ id: salesRecipeVersions.id, spuName: spus.name })
              .from(salesSkuDefinitions)
              .innerJoin(
                salesRecipeVersions,
                and(
                  eq(salesRecipeVersions.skuId, salesSkuDefinitions.skuId),
                  eq(salesRecipeVersions.versionNumber, salesSkuDefinitions.versionNumber),
                ),
              )
              .innerJoin(skus, eq(skus.id, salesSkuDefinitions.skuId))
              .innerJoin(spus, eq(spus.id, skus.spuId))
              .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
              .where(
                and(
                  inArray(salesSkuDefinitions.skuId, skuIds),
                  ne(skus.status, "archived"),
                  ne(spus.status, "archived"),
                  ne(productPlans.status, "archived"),
                ),
              )
          : [];
        for (const row of currentRecipes) {
          const r = await readRecipe(tx, row.id);
          skuViews.push({
            id: r.skuId,
            code: r.skuCode,
            spuName: row.spuName,
            recipeId: r.id,
            recipeVersion: r.version,
            artworkVersionId: r.artwork.versionId,
            specificationVersionId: r.specification.versionId,
            specificationName: r.specification.name,
            factsConfirmed: specificationFactsReady(r.specification.facts),
            material: r.specification.facts.material,
            dimensions: r.specification.facts.dimensions,
            packageContents: r.specification.facts.packageContents,
            status: r.status,
            designVersionId: r.designVersionId,
            needsUpdate: r.needsUpdate || !!r.artwork.archived,
            belongsToProject:
              !!r.artwork.creativeVersionId && versionIds.includes(r.artwork.creativeVersionId),
          });
        }
        const activeSkuIds = skuViews.map((s) => s.id);
        if (activeSkuIds.length) {
          const itemRows = await tx
            .selectDistinctOn([mockupBatchItems.skuId, mockupBatchItems.designVersionId], {
              item: mockupBatchItems,
              batch: mockupBatches,
            })
            .from(mockupBatchItems)
            .innerJoin(mockupBatches, eq(mockupBatches.id, mockupBatchItems.batchId))
            .where(inArray(mockupBatchItems.skuId, activeSkuIds))
            .orderBy(
              mockupBatchItems.skuId,
              mockupBatchItems.designVersionId,
              desc(mockupBatches.createdAt),
            )
            .limit(relatedLimit + 1);
          for (const { item, batch } of bounded(itemRows, "商品套图")) {
            const slots = await tx
              .select({ key: mockupTemplateSlots.slotKey })
              .from(mockupTemplateSlots)
              .where(
                and(
                  eq(mockupTemplateSlots.templatePackVersionId, batch.templatePackVersionId),
                  eq(mockupTemplateSlots.required, true),
                ),
              );
            const outputs = await tx
              .selectDistinctOn([mockupBatchOutputs.slotKey], {
                slotKey: mockupBatchOutputs.slotKey,
                status: mockupBatchOutputs.status,
                valid: sql<boolean>`coalesce(${assetFiles.assetDomain} = 'authorized' and ${assetFiles.rightsStatus} = 'approved' and ${assetFiles.deletedAt} is null and ${assetFiles.version} = ${mockupBatchOutputs.assetVersion} and ${assetFiles.checksumSha256} = ${mockupBatchOutputs.checksumSha256}, false)`,
              })
              .from(mockupBatchOutputs)
              .leftJoin(assetFiles, eq(assetFiles.id, mockupBatchOutputs.assetId))
              .where(eq(mockupBatchOutputs.itemId, item.id))
              .orderBy(mockupBatchOutputs.slotKey, desc(mockupBatchOutputs.attempt));
            const sku = skuViews.find((s) => s.id === item.skuId)!;
            mockupViews.push({
              itemId: item.id,
              batchId: batch.id,
              skuId: item.skuId,
              skuCode: sku.code,
              designVersionId: item.designVersionId,
              status: item.status,
              requiredCount: slots.length,
              approvedCount: outputs.filter(
                (o) => o.status === "approved" && o.valid && slots.some((s) => s.key === o.slotKey),
              ).length,
              failedCount: outputs.filter((o) => ["failed", "rejected"].includes(o.status)).length,
              current:
                sku.belongsToProject &&
                !sku.needsUpdate &&
                sku.status === "approved" &&
                sku.designVersionId === item.designVersionId,
            });
          }
        }
        if (access.listing && activeSkuIds.length) {
          const styles = await tx
            .select({ id: salesSkuDefinitions.styleId })
            .from(salesSkuDefinitions)
            .where(inArray(salesSkuDefinitions.skuId, activeSkuIds));
          const listingRows = await tx
            .selectDistinctOn([listings.id], { listing: listings, version: listingVersions })
            .from(listings)
            .innerJoin(listingVersions, eq(listingVersions.listingId, listings.id))
            .where(
              and(
                inArray(
                  listings.styleId,
                  styles.map((s) => s.id),
                ),
                ne(listings.status, "archived"),
              ),
            )
            .orderBy(listings.id, desc(listingVersions.versionNumber))
            .limit(relatedLimit + 1);
          for (const { listing, version } of bounded(listingRows, "Listing")) {
            const ids = version.content.variants
              .map((v) => v.skuId)
              .filter((id) => activeSkuIds.includes(id));
            if (!ids.length) continue;
            listingViews.push({
              id: listing.id,
              versionId: version.id,
              version: version.versionNumber,
              title: version.content.title,
              platform: listing.platform as "amazon" | "etsy",
              locale: listing.locale,
              status:
                listing.status === "approved" &&
                listing.primaryVersionId === version.id &&
                version.status === "approved"
                  ? "approved"
                  : "draft",
              blockers: version.validation.blockers.map((b) => b.message),
              skuIds: ids,
            });
          }
          const packageRows = await tx
            .select({
              package: salesPackageVersions,
              creativeVersionId: artworkMasterVersions.creativeVersionId,
            })
            .from(salesPackageVersions)
            .innerJoin(
              salesRecipeVersions,
              eq(salesRecipeVersions.id, salesPackageVersions.recipeId),
            )
            .innerJoin(
              artworkMasterVersions,
              eq(artworkMasterVersions.id, salesRecipeVersions.artworkVersionId),
            )
            .where(
              and(
                inArray(salesPackageVersions.skuId, activeSkuIds),
                inArray(artworkMasterVersions.creativeVersionId, versionIds),
              ),
            )
            .orderBy(desc(salesPackageVersions.createdAt))
            .limit(relatedLimit + 1);
          packageViews.push(
            ...bounded(packageRows, "封存资料包").map(({ package: p }) => {
              const sku = skuViews.find((s) => s.id === p.skuId)!,
                listing = listingViews.find((l) => l.id === p.listingId);
              return {
                id: p.id,
                skuId: p.skuId,
                skuCode: sku.code,
                recipeId: p.recipeId,
                listingId: p.listingId,
                listingVersionId: p.listingVersionId,
                version: p.versionNumber,
                platform: p.platform as "amazon" | "etsy",
                locale: p.locale,
                checksum: p.checksum,
                createdAt: p.createdAt.toISOString(),
                current:
                  sku.belongsToProject &&
                  !sku.needsUpdate &&
                  sku.factsConfirmed &&
                  sku.status === "approved" &&
                  sku.recipeId === p.recipeId &&
                  listing?.status === "approved" &&
                  listing.versionId === p.listingVersionId,
              };
            }),
          );
        }
      }
      return {
        id: rootId,
        name: latest.canvasWorkflow?.revision?.projectName ?? root.name,
        briefId: latest.id,
        prompt: revisionItem?.prompt ?? root.prompt,
        requirements: revisionStart.canvasWorkflow?.requirements ?? null,
        legacy: !root.workflow,
        createdAt: rootRow.createdAt.toISOString(),
        updatedAt: latest.updatedAt.toISOString(),
        access,
        researchSources: access.research ? (revisionStart.canvasWorkflow?.researchReferences ?? []) : [],
        steps: batches.map((b) => ({
          id: b.id,
          name: `${b.canvasWorkflow?.revision ? `需求 V${b.canvasWorkflow.revision.number} · ` : ""}${b.canvasWorkflow?.template.steps[b.canvasWorkflow.stepIndex]?.name ?? "创作与审核"}`,
          index: b.canvasWorkflow?.stepIndex ?? 0,
          resultCount: b.generatedCount,
          approvedCount: b.approvedCount,
        })),
        artworks,
        skus: skuViews,
        mockups: mockupViews,
        listings: listingViews,
        packages: packageViews,
        diagnostics,
        finalDesignStep:
          !latest.canvasWorkflow ||
          latest.canvasWorkflow.stepIndex === latest.canvasWorkflow.template.steps.length - 1,
      };
    });
    const { items: results } = await this.canvas.results(context, projection.briefId);
    for (const listing of projection.listings) {
      if (
        listing.skuIds.some((id) =>
          projection.skus.some((s) => s.id === id && (s.needsUpdate || !s.belongsToProject)),
        )
      )
        listing.blockers.push("SKU 来源已有新版本，请核对制作配方");
      try {
        await this.salesPackages.analysisBasis(context, listing.id, listing.versionId);
      } catch (error) {
        if (!(
          error instanceof ConflictException ||
          error instanceof NotFoundException ||
          error instanceof BadRequestException
        ))
          throw error;
        listing.blockers.push("刊登与当前商品事实或制作版本不一致，请进入 Listing 核对");
      }
    }
    for (const p of projection.packages)
      if (projection.listings.some((l) => l.id === p.listingId && l.blockers.length))
        p.current = false;
    return ContentProjectSchema.parse({
      ...projection,
      results,
      stages: contentProjectStages({ ...projection, results }),
    });
  }
}
