import { specificationFactsReady } from "@yummyai/contracts/catalog/development";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Permission, ForbiddenError } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { CreateAssistSchema, type CreateAssist } from "@yummyai/contracts/ai/assist";
import { CreativeRequirementsSchema } from "@yummyai/contracts/catalog/artwork";
import {
  LaunchBasisRequestSchema,
  LaunchAdoptRequestSchema,
  type SalesPlanLaunch,
  type LaunchStage,
  type LaunchAdoptField,
} from "@yummyai/contracts/catalog/sales-plan-launch";
import type { SalesPlanFields } from "@yummyai/contracts/catalog/sales-plan";
import {
  aiAssistRuns,
  developmentEvents,
  assetFiles,
  salesPackageVersions,
  withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { assistScope } from "@yummyai/ai-core";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { AssistService, authorizeAssist } from "../ai/assist.service.js";
import { AssistContextService } from "../ai/assist-context.service.js";
import { assistTaskFingerprint } from "../ai/assist-task-fingerprint.js";
import { assertAuthorizedAssets } from "../design/pod-batch-workflow.service.js";
import { ProductDevelopmentService } from "./product-development.service.js";
import { SalesPlanService } from "./sales-plan.service.js";
import { SalesPackageService } from "./sales-package.service.js";
import { AssistTaskInputSchema } from "@yummyai/contracts/ai/task-workspace";

const can = (context: TenantContext, kind: "creative" | "sku_package", write = false) => {
  try {
    authorizeAssist(context, kind, write);
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError) return false;
    throw error;
  }
};

/** Business-state projection and explicit commands over existing services. No
 * second execution engine, assistant queue, approval state or product facts. */
@Injectable()
export class SalesPlanLaunchService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(SalesPlanService) private readonly plans: SalesPlanService,
    @Inject(ProductDevelopmentService) private readonly products: ProductDevelopmentService,
    @Inject(AssistService) private readonly assists: AssistService,
    @Inject(AssistContextService) private readonly contexts: AssistContextService,
    @Inject(SalesPackageService) private readonly salesPackages: SalesPackageService,
  ) {}

  async get(context: TenantContext, id: string): Promise<SalesPlanLaunch> {
    const basis = await this.plans.assistBasis(context, id),
      detail = await this.plans.get(context, id);
    const f = basis.plan.fields,
      diagnostics: string[] = [];
    const linked = detail.listings.filter(
      (l) =>
        l.marketplaceId === f.marketplaceId && l.locale === f.locale && l.status !== "archived",
    );
    const listing = linked[0];
    const designAccess =
      context.permissions.includes(Permission.DesignRead) &&
      context.permissions.includes(Permission.AssetRead);
    const skuDetails = designAccess
      ? await Promise.all(f.skuIds.map((sku) => this.products.detail(context, sku)))
      : [];
    const productReady =
      basis.specifications.length > 0 && basis.specifications.every((s) => specificationFactsReady(s.facts));
    const researchReady =
      !!f.audience.trim() &&
      !!f.scenario.trim() &&
      !!f.researchConclusion.trim() &&
      f.researchItemIds.length > 0;
    let imagesReady = false;
    if (designAccess && f.mainImageId && f.mediaAssetIds.length) {
      const assets = await withTenant(this.database.db, context, (tx) =>
        tx.select().from(assetFiles).where(inArray(assetFiles.id, f.mediaAssetIds)),
      );
      try {
        assertAuthorizedAssets(f.mediaAssetIds, assets, "上新图片");
        imagesReady = assets.every((a) => !a.deletedAt);
      } catch {
        diagnostics.push("刊登图片已失效或权利待核验，请在图文步骤重新核对");
      }
    }
    const designReady =
      productReady &&
      imagesReady &&
      skuDetails.length > 0 &&
      skuDetails.every((s) => {
        const r = s.item.recipe;
        return (
          r &&
          r.status === "approved" &&
          !r.needsUpdate &&
          basis.specifications.some((spec) => spec.versionId === r.specification.versionId) &&
          f.artworkVersionIds.includes(r.artwork.versionId)
        );
      });
    const listingReady =
      designReady &&
      !!listing &&
      listing.status === "approved" &&
      listing.planRevision === basis.plan.revision &&
      listing.blockers.length === 0;
    const packageCandidates = skuDetails
      .flatMap((s) => s.packages)
      .filter(
        (p) =>
          p.listingId === listing?.id &&
          p.listingVersionId === listing.versionId &&
          p.marketplaceId === f.marketplaceId &&
          p.locale === f.locale &&
          skuDetails.some((s) => s.item.skuId === p.skuId && s.item.recipe?.id === p.recipeId),
      )
      .map((p) => ({ ...p, platform: p.platform as "amazon" | "etsy" }));
    const packageValidity = await Promise.all(
      packageCandidates.map((pack) =>
        this.salesPackages.isCurrent(context, pack.id, pack.recipeId, pack.listingVersionId),
      ),
    );
    const controlledDelivery =
      f.mode === "custom" &&
      f.fulfillment === "fbm" &&
      f.marketplaceId === "ATVPDKIKX0DER" &&
      f.locale === "en-US" &&
      basis.specifications.length > 0 &&
      basis.specifications.every((s) => s.productType === "shaped_pillow");
    const deliveryPackages =
      controlledDelivery && packageCandidates.length
        ? await withTenant(this.database.db, context, (tx) =>
            tx
              .select({ id: salesPackageVersions.id, snapshot: salesPackageVersions.snapshot })
              .from(salesPackageVersions)
              .where(
                inArray(
                  salesPackageVersions.id,
                  packageCandidates.map((p) => p.id),
                ),
              ),
          )
        : [];
    const packages = packageCandidates.filter(
      (pack, index) =>
        packageValidity[index] &&
        (!controlledDelivery ||
          deliveryPackages.some(
            (p) =>
              p.id === pack.id &&
              (p.snapshot.salesPlanDelivery as { planId?: string } | undefined)?.planId === id,
          )),
    );
    const packageReady =
      listingReady && f.skuIds.every((sku) => packages.some((p) => p.skuId === sku));
    const href = (step: number) => `/sales-plans?plan=${id}&step=${step}`;
    const stage = (
      key: LaunchStage["key"],
      label: string,
      ready: boolean,
      issues: string[],
      destination: string,
      action: string,
      available = true,
    ): LaunchStage => ({
      key,
      label,
      status: !available ? "unavailable" : ready ? "ready" : issues.length ? "blocked" : "pending",
      detail: ready
        ? "当前依据已齐备"
        : !available
          ? "当前账号没有此环节的读取权限"
          : (issues[0] ?? "待处理"),
      issues,
      href: destination,
      action,
    });
    const stages = [
      stage(
        "product",
        "商品事实",
        productReady,
        productReady ? [] : ["选择规格并确认材质、尺寸和包装等商品事实"],
        href(0),
        "核对商品资料",
      ),
      stage(
        "research",
        "竞品与定位",
        researchReady,
        researchReady ? [] : ["关联研究商品，记录人群、场景与调研结论"],
        href(1),
        "补齐调研依据",
        context.permissions.includes(Permission.ResearchRead),
      ),
      stage(
        "direction",
        "原创方向",
        !!f.positioning.trim(),
        f.positioning.trim() ? [] : ["分析并采纳原创方向，或记录人工确认的设计方向"],
        `/sales-plans?plan=${id}&view=tasks&kind=creative`,
        "分析原创方向",
        can(context, "creative"),
      ),
      stage(
        "design",
        "图稿与套图",
        designReady,
        designReady
          ? []
          : [
              !productReady
                ? "商品事实尚未确认"
                : !f.skuIds.length
                  ? "选择销售 SKU 并审核制作版本"
                  : !imagesReady
                    ? "补齐主图与已授权刊登图片"
                    : "所选 SKU 的制作版本、规格或印花已变化，需核对并重新审核",
            ],
        basis.specifications.length &&
          basis.specifications.every((s) => s.productType === "shaped_pillow")
          ? `/sales-plans?plan=${id}&view=tasks#product-visuals`
          : f.creativeProjectId
            ? `/content-projects?project=${f.creativeProjectId}`
            : href(3),
        "准备图稿与套图",
        designAccess,
      ),
      stage(
        "listing",
        "Listing 草稿与审核",
        listingReady,
        listingReady
          ? []
          : [
              !listing
                ? "创建本地刊登草稿"
                : listing.planRevision !== basis.plan.revision
                  ? "销售方案已更新，请核对差异并同步当前刊登草稿"
                  : !designReady
                    ? "制作与图片依据尚未齐备"
                    : listing.status !== "approved"
                      ? "完善文案和平台字段，再提交人工审核"
                      : (listing.blockers[0] ?? "核对刊登资料"),
            ],
        listing && listing.planRevision === basis.plan.revision
          ? `/listings/${listing.id}`
          : href(4),
        listing ? "继续刊登准备" : "创建刊登草稿",
        detail.listingAccess,
      ),
      stage(
        "package",
        "封存资料包",
        packageReady,
        packageReady
          ? []
          : [
              !listingReady
                ? "先完成当前刊登版本与制作依据的审核"
                : controlledDelivery
                  ? "逐项核对定制与图文，再为每个销售 SKU 封存当前交付包"
                  : "为每个销售 SKU 封存当前版本的上架资料包",
            ],
        controlledDelivery
          ? `/sales-plans?plan=${id}&view=tasks#sales-plan-delivery`
          : f.skuIds[0]
            ? `/product-development?sku=${f.skuIds[0]}`
            : href(3),
        "封存与下载资料包",
        designAccess && detail.listingAccess,
      ),
    ];
    const scopes = [`creative:${id}`, ...detail.listings.map((l) => `listing:${l.id}`)];
    const permittedKinds = (["creative", "sku_package"] as const).filter((kind) =>
      can(context, kind),
    );
    const rows = permittedKinds.length
      ? await withTenant(this.database.db, context, (tx) =>
          tx
            .select()
            .from(aiAssistRuns)
            .where(
              and(
                eq(aiAssistRuns.ownerId, context.userId),
                isNull(aiAssistRuns.benchmarkItemId),
                inArray(aiAssistRuns.kind, permittedKinds),
                inArray(aiAssistRuns.scope, scopes),
              ),
            )
            .orderBy(desc(aiAssistRuns.createdAt))
            .limit(101),
        )
      : [];
    const tasks: SalesPlanLaunch["tasks"] = [];
    for (const row of rows.slice(0, 100)) {
      try {
        const task = await this.assists.get(context, row.id);
        tasks.push({
          id: task.id,
          kind: task.kind,
          status: task.status,
          scope: task.scope,
          modelLabel: task.modelLabel,
          createdAt: task.createdAt,
          stale: task.stale,
          costUsd: task.costUsd,
          error: task.error,
        });
      } catch (error) {
        if (!(error instanceof ForbiddenError || error instanceof NotFoundException)) throw error;
      }
    }
    if (rows.length > 100)
      diagnostics.push(
        "本页显示最近 100 次分析，费用汇总仅覆盖这些记录；完整历史请到 AI 任务工作台查看",
      );
    const events = await withTenant(this.database.db, context, (tx) =>
      tx
        .select()
        .from(developmentEvents)
        .where(
          and(
            eq(developmentEvents.resourceId, id),
            eq(developmentEvents.action, "sales_plan.adopt_assist"),
            eq(developmentEvents.createdBy, context.userId),
          ),
        )
        .orderBy(desc(developmentEvents.createdAt))
        .limit(100),
    );
    const adoptions = events.flatMap((event) => {
      const value = event.result as {
        adoption?: Omit<SalesPlanLaunch["adoptions"][number], "createdAt">;
      };
      return value.adoption
        ? [{ ...value.adoption, createdAt: event.createdAt.toISOString() }]
        : [];
    });
    const known = tasks.filter((t) => t.costUsd !== null);
    const activeRows = rows.slice(0, 100).filter((r) => ["queued", "running"].includes(r.status));
    return {
      planId: id,
      revision: basis.plan.revision,
      stages,
      nextStage: stages.find((s) => s.status !== "ready") ?? null,
      tasks,
      hasMoreTasks: rows.length > 100,
      adoptions,
      packages,
      fees: {
        knownUsd: known.reduce((sum, t) => sum + t.costUsd!, 0),
        unknown: tasks.filter(
          (t) => t.costUsd === null && ["completed", "failed"].includes(t.status),
        ).length,
        active: activeRows.length,
        activeUpperUsd: activeRows.some((r) => r.modelSnapshot.maxTaskCostUsd == null)
          ? null
          : activeRows.reduce((sum, r) => sum + r.modelSnapshot.maxTaskCostUsd!, 0),
      },
      diagnostics,
      canAnalyze: {
        creative: can(context, "creative", true),
        sku_package: can(context, "sku_package", true),
      },
    };
  }

  async basis(context: TenantContext, id: string, raw: unknown) {
    const selection = LaunchBasisRequestSchema.parse(raw);
    authorizeAssist(context, selection.kind, true);
    const basis = await this.plans.assistBasis(context, id),
      f = basis.plan.fields;
    if (basis.plan.revision !== selection.expectedRevision)
      throw new ConflictException("销售方案已有新版本，请刷新后重新读取依据");
    let request: CreateAssist;
    const common = {
      requestId: "00000000-0000-4000-8000-000000000000",
      modelId: createEntityId(),
      salesPlan: { id, revision: basis.plan.revision },
      taskGoal: selection.taskGoal,
    };
    if (selection.kind === "creative") {
      if (
        !basis.specifications.length ||
        basis.specifications.some((spec) => !specificationFactsReady(spec.facts))
      )
        throw new ConflictException("请先选择销售规格并确认商品事实");
      if (!f.researchItemIds.length || f.researchItemIds.length > 8)
        throw new ConflictException("原创方向分析需选择 1–8 个研究来源，请在调研步骤调整");
      const imageField = f.customization.fields.some((field) => field.type === "image"),
        textField = f.customization.fields.some((field) =>
          ["short_text", "long_text"].includes(field.type),
        );
      request = CreateAssistSchema.parse({
        ...common,
        kind: "creative",
        scopeId: id,
        sources: f.researchItemIds.map((researchItemId) => ({ researchItemId })),
        prompt:
          "依据本次销售方案、已确认的商品事实和固定研究证据，提出可用于原创设计的方向。竞品素材仅作为研究参考，未知事实不得补造。",
        requirements: CreativeRequirementsSchema.parse({
          mode:
            f.mode === "standard"
              ? "fixed"
              : imageField
                ? textField
                  ? "mixed"
                  : "customer_image"
                : textField
                  ? "personalized_text"
                  : "mixed",
          audience: f.audience.slice(0, 500),
          occasion: f.scenario.slice(0, 500),
          researchItemIds: f.researchItemIds,
          specificationVersionIds: basis.specifications.map((spec) => spec.versionId),
          customization: f.mode === "custom" ? f.customization : undefined,
          layout: f.mode === "custom" ? f.layout : [],
        }),
      });
    } else {
      const detail = await this.plans.get(context, id),
        listing = detail.listings.find(
          (l) =>
            l.marketplaceId === f.marketplaceId && l.locale === f.locale && l.status !== "archived",
        );
      if (!listing) throw new ConflictException("请先为当前销售方案创建本地刊登草稿");
      if (listing.planRevision !== basis.plan.revision)
        throw new ConflictException("销售方案已变化，请先核对并同步刊登草稿");
      request = CreateAssistSchema.parse({
        ...common,
        kind: "sku_package",
        listingId: listing.id,
        expectedVersionId: listing.versionId,
      });
    }
    const prepared = await this.contexts.prepare(context, request),
      fingerprint = assistTaskFingerprint(prepared);
    const rawInput: Partial<CreateAssist> = { ...prepared.request };
    delete rawInput.requestId;
    delete rawInput.modelId;
    const input = AssistTaskInputSchema.parse(rawInput);
    return {
      input: { ...input, expectedTaskFingerprint: fingerprint },
      fingerprint,
      scope: assistScope(prepared.request),
      href: `/sales-plans?plan=${id}&view=tasks&kind=${selection.kind}`,
      rows: [
        { label: "销售方案", value: `${basis.plan.fields.name} · V${basis.plan.revision}` },
        { label: "目标站点", value: `${f.marketplaceId} · ${f.locale}` },
        { label: "可用图片", value: `${prepared.images.length} 张` },
      ],
      sources: prepared.sources,
      checks: prepared.checks,
      diagnostics: prepared.diagnostics,
    };
  }

  async adopt(context: TenantContext, id: string, raw: unknown) {
    const input = LaunchAdoptRequestSchema.parse(raw);
    authorizeAssist(context, input.kind, true);
    await this.assists.assertBusinessAdoptionAllowed(context, input.runId);
    return this.plans.adoptAssist(context, id, input, async () => {
      const task = await this.assists.get(context, input.runId);
      if (
        task.kind !== input.kind ||
        task.request?.salesPlan?.id !== id ||
        task.request.salesPlan.revision !== input.expectedRevision
      )
        throw new ConflictException("分析成果不属于当前销售方案版本");
      if (task.status !== "completed" || task.stale || !task.result)
        throw new ConflictException("分析尚未完成或依据已变化，请读取当前资料后再分析");
      const patch: Partial<Pick<SalesPlanFields, LaunchAdoptField>> = {};
      if (input.kind === "creative") {
        const direction = task.result.directions[input.directionIndex];
        if (!direction) throw new BadRequestException("请先选择一个原创方向");
        for (const field of input.fields) {
          if (field === "audience") patch.audience = direction.requirements.audience;
          else if (field === "scenario") patch.scenario = direction.requirements.occasion;
          else if (field === "positioning")
            patch.positioning = `${direction.title}\n${direction.rationale}`;
          else throw new BadRequestException("原创方向只能采纳人群、场景和设计定位");
        }
      } else {
        const copy = task.result.listingCopy;
        if (!copy) throw new BadRequestException("本次分析没有可采纳的刊登文案");
        const basis = await this.plans.assistBasis(context, id);
        for (const field of input.fields) {
          if (field === "title") patch.title = copy.title;
          else if (field === "bullets") patch.bullets = copy.bullets;
          else if (field === "description") patch.description = copy.description;
          else if (
            field === "customInstructions" &&
            basis.plan.fields.mode === "custom" &&
            basis.plan.fields.customization.fields.length
          )
            patch.customInstructions = copy.personalizationInstructions;
          else
            throw new BadRequestException("该字段不能用于当前方案；定制说明需要已配置的定制字段");
        }
      }
      return patch;
    });
  }
}
