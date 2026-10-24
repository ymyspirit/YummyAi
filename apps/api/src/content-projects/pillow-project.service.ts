import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import type { SecretVault } from "@yummyai/ai-core";
import type { TenantContext, ProductionEditorDetailView } from "@yummyai/contracts";
import { SHAPED_PILLOW_FACTORY_STANDARD } from "@yummyai/contracts/pod/production-editor";
import {
  PillowProjectWorkspaceSchema,
  PillowProjectOrderSchema,
  type PillowProjectQuery,
} from "@yummyai/contracts/catalog/pillow-project";
import { OrderDesignRepository } from "@yummyai/order-design";
import type { DatabaseConnection } from "@yummyai/database";
import { ProductDevelopmentService } from "../catalog/product-development.service.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import { OrderWorkspaceService } from "../orders/order-workspace.service.js";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";
import { pillowOrderStages, pillowFormalFile } from "./pillow-project-stages.js";

@Injectable()
export class PillowProjectService {
  private readonly agent: OrderDesignRepository;
  constructor(
    @Inject(ProductDevelopmentService) private readonly catalog: ProductDevelopmentService,
    @Inject(OrderWorkspaceService) private readonly orders: OrderWorkspaceService,
    @Inject(ProductionEditorService) private readonly editor: ProductionEditorService,
    @Inject(DATABASE_CONNECTION) database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) vault: SecretVault,
  ) {
    this.agent = new OrderDesignRepository(database, vault);
  }

  async workspace(context: TenantContext, query: PillowProjectQuery) {
    authorize(context, Permission.DesignRead);
    const access = {
      catalog: context.permissions.includes(Permission.ProductRead),
      orders: context.permissions.includes(Permission.OrderRead),
      details:
        context.permissions.includes(Permission.OrderRead) &&
        context.permissions.includes(Permission.OrderPiiRead) &&
        context.permissions.includes(Permission.AssetRead),
    };
    const [options, orders] = await Promise.all([
      access.catalog ? this.catalog.options(context) : null,
      access.orders ? this.orders.list(context, { ...query, productType: "shaped_pillow" }) : null,
    ]);
    const diagnostics: string[] = [];
    const spus = new Set(
      options?.specifications.filter((s) => s.productType === "shaped_pillow").map((s) => s.spuId),
    );
    const specifications =
      options?.specifications.filter(
        (s) => s.productType === "shaped_pillow" || (s.productType === null && spus.has(s.spuId)),
      ) ?? [];
    const workspaces = await Promise.all(
      [...spus].map((spuId) => this.catalog.workspace(context, { spuId, pageSize: 50 })),
    );
    if (workspaces.some((w) => w.total > 50))
      diagnostics.push("部分产品超过 50 个销售 SKU，请在产品开发查看全部，当前配置仅显示前 50 条");
    const recipes = workspaces
      .flatMap((w) => w.items)
      .flatMap((item) =>
        item.recipe?.specification.productType === "shaped_pillow"
          ? [
              {
                skuId: item.skuId,
                skuCode: item.skuCode,
                recipeId: item.recipe.id,
                version: item.recipe.version,
                artworkVersionId: item.recipe.artwork.versionId,
                specificationVersionId: item.recipe.specification.versionId,
                status: item.recipe.status,
                needsUpdate: item.recipe.needsUpdate,
              },
            ]
          : [],
      );
    const artworkIds = new Set(
      workspaces
        .flatMap((w) => w.items)
        .filter((i) => i.recipe?.specification.productType === "shaped_pillow")
        .map((i) => i.recipe!.artwork.id),
    );
    return PillowProjectWorkspaceSchema.parse({
      access,
      specifications,
      recipes,
      artworks: options?.artworks.filter((a) => artworkIds.has(a.id)) ?? [],
      orders,
      diagnostics,
    });
  }

  async order(context: TenantContext, id: string) {
    authorize(context, Permission.DesignRead);
    authorize(context, Permission.AssetRead);
    authorize(context, Permission.OrderRead);
    authorize(context, Permission.OrderPiiRead);
    const detail = await this.orders.detail(context, id);
    if (detail.line.archivedAt || detail.profile?.productType !== "shaped_pillow")
      throw new NotFoundException("本单尚未绑定异形抱枕工艺，或已归档");
    const diagnostics: string[] = [];
    const loadEditor = async (projectId: string, versionId?: string) => {
      try {
        return await this.editor.get(context, projectId, versionId);
      } catch (error) {
        if (!(error instanceof NotFoundException || error instanceof ConflictException))
          throw error;
        diagnostics.push("部分固定底稿或制作版本暂不可读取，请在原模块核对资料期限与版本");
        return null;
      }
    };
    const [templateDetail, artworkDetail, agent] = await Promise.all([
      loadEditor(detail.profile.projectId, detail.profile.sourceVersionId),
      detail.line.editorProjectId ? loadEditor(detail.line.editorProjectId) : null,
      detail.line.revision > 0 ? this.agent.view(context, id) : Promise.resolve({ run: null }),
    ]);
    const template = processVersion(templateDetail),
      currentArtwork = processVersion(artworkDetail);
    const formalFile = pillowFormalFile(detail.line.artwork, artworkDetail);
    const basis = {
      pinned: detail.line.revision > 0,
      artworkVersionId: detail.draft.artworkVersionId ?? null,
      specificationVersionId: detail.draft.specificationVersionId ?? null,
      recipeVersionId: detail.draft.salesRecipeVersionId ?? null,
      artworkName:
        detail.catalog?.artworks.find((a) => a.id === detail.draft.artworkVersionId)?.name ?? null,
      specificationName:
        detail.catalog?.specifications.find((s) => s.id === detail.draft.specificationVersionId)
          ?.name ?? null,
      profile: detail.profile,
    };
    if (template && template.factoryStandardId !== SHAPED_PILLOW_FACTORY_STANDARD.id)
      diagnostics.push(
        "本单固定底稿未标注当前工厂 JPG 标准；历史版本保留，升级须按原流程创建并审核新版本",
      );
    if (currentArtwork && currentArtwork.factoryStandardId !== SHAPED_PILLOW_FACTORY_STANDARD.id)
      diagnostics.push("当前制作稿仍为旧工艺标识，需在制作流程中核对后创建新版本");
    if (currentArtwork && currentArtwork.minimumNeckBasis !== "cut_contour")
      diagnostics.push(
        "当前制作稿的细窄处仍采用历史口径；按最新要求核对两侧裁线间距，历史任务不自动改版",
      );
    if (agent.run && !agent.run.ruleSnapshot)
      diagnostics.push("历史自动任务没有可读取的规则快照，不能用今天的规则补填");
    if (!agent.run)
      diagnostics.push(
        detail.line.preparation === "pushed"
          ? "本单未记录无人设计任务规则快照，按人工或历史制作流程核对"
          : "派发时才固定无人设计任务规则，当前未生成任务快照",
      );
    const output = {
      line: detail.line,
      basis,
      template,
      currentArtwork,
      formalFile,
      agent,
      diagnostics,
    };
    return PillowProjectOrderSchema.parse({ ...output, stages: pillowOrderStages(output) });
  }
}

function processVersion(detail: ProductionEditorDetailView | null) {
  if (!detail || detail.version.document.productType !== "shaped_pillow") return null;
  const doc = detail.version.document;
  return {
    projectId: detail.project.id,
    versionId: detail.version.id,
    version: detail.version.versionNumber,
    reviewed: detail.version.reviewed,
    factoryStandardId: doc.spec.factoryStandardId ?? null,
    sizeBasis: doc.spec.sizeBasis,
    minimumNeckBasis: doc.spec.minimumNeckBasis,
    sideMode: doc.spec.sideMode,
    automationEnabled: !!doc.automation,
  };
}
