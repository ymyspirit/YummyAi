import { BadRequestException, ConflictException, Inject, Injectable, Optional } from "@nestjs/common";
import { assistFingerprint, assistTaskFingerprint, orderAssistChecks, orderRequirementSourceId, assistHarness, isBenchmarkAssist, assistUsesReviewedGuidance, HarnessContractError, type AssistContext } from "@yummyai/ai-core";
import { authorize, authorizeAssistRequest, Permission, requiredAssistPermissions, requiredAssistRequestPermissions, ASSIST_ACCESS_POLICY_VERSION } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import type { CreateAssist } from "@yummyai/contracts/ai/assist";
import { captureSnapshots, creativeDesignBatches, creativeDesignBatchItems, knowledgeEntries, withTenant, captureAssistInputAuthority, assertAssistInputAuthority, captureBusinessBenchmarkResources, assertBusinessBenchmarkResources, AssistInputChangedError, assistAuthorityResourceLabel, selectAgentMethod, assertAgentMethodSelection, AgentMethodAuthorityError, type BusinessTask, type TenantTransaction, type DatabaseConnection } from "@yummyai/database";
import { BUSINESS_BENCHMARK_ROLES, LEGACY_BUSINESS_BENCHMARK_ROLES } from "@yummyai/contracts/knowledge/benchmark";
import { CreativeRequirementsSchema } from "@yummyai/contracts/catalog/artwork";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { resolveResearchSources } from "../research/research-study.service.js";
import { fingerprint, readSpecification } from "../catalog/development-data.js";
import { OrderWorkspaceService } from "../orders/order-workspace.service.js";
import { AmazonOrderReportService } from "../orders/amazon-order-report.service.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import { AssistCatalogContextService } from "./assist-catalog-context.service.js";
import { AssistBusinessContextService } from "./assist-business-context.service.js";
import { prepareArtworkAudit } from "./artwork-audit-context.js";
import { KnowledgeAnswerContextService } from "../knowledge/knowledge-answer-context.service.js";
import { SalesPlanService } from "../catalog/sales-plan.service.js";
import { knowledgeExecutionAuthority, assertMethodKnowledge } from "@yummyai/knowledge-core";
import { BENCHMARK_RESEARCH_IMAGE_READER, freezeBenchmarkRoleMedia, type BenchmarkResearchImageReader } from "./benchmark-role-media.js";

async function assertCurrentAssistMethodInTransaction(tx: TenantTransaction, context: TenantContext, input: AssistContext,
  options: { admission?: boolean; lock?: boolean; lockKnowledge?: boolean } = {}) {
  const harness = assistHarness(input.request.kind, !!input.artworkAudit, requiredAssistPermissions(input.request.kind, "run"), ASSIST_ACCESS_POLICY_VERSION, isBenchmarkAssist(input));
  const method = await assertAgentMethodSelection(tx, harness.registry.describeSkill(harness.skill), input.methodSelection,
    { lock: options.lock, admission: options.admission });
  await assertMethodKnowledge(tx, context, method.definition, { lock: options.lockKnowledge });
}

/** Validate the original guidance pins without rebuilding business inputs or retrieving replacements. */
export async function isPinnedAssistGuidanceCurrentInTransaction(tx: TenantTransaction, context: TenantContext, input: AssistContext,
  options: { lock?: boolean } = {}): Promise<boolean> {
  try {
    await assertCurrentAssistMethodInTransaction(tx, context, input, { admission: false, lock: options.lock, lockKnowledge: options.lock });
  } catch (error) {
    if (error instanceof AgentMethodAuthorityError) return false;
    throw error;
  }
  if (options.lock) {
    for (const entryId of [...new Set((input.knowledge ?? []).map(reference => reference.entryId))].sort())
      await tx.select({ id: knowledgeEntries.id }).from(knowledgeEntries).where(eq(knowledgeEntries.id, entryId)).for("share");
  }
  return (await knowledgeExecutionAuthority(tx, context, input.knowledge,
    input.request.kind === "knowledge_answer" ? input.request.evidenceStoreId : null)).every(resource => resource.count === 1);
}

@Injectable()
export class AssistContextService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(OrderWorkspaceService) private readonly orders: OrderWorkspaceService,
    @Inject(AmazonOrderReportService) private readonly reports: AmazonOrderReportService,
    @Inject(ProductionEditorService) private readonly editor: ProductionEditorService,
    @Inject(AssistCatalogContextService) private readonly catalog: AssistCatalogContextService,
    @Inject(AssistBusinessContextService) private readonly business: AssistBusinessContextService,
    @Inject(KnowledgeAnswerContextService) private readonly knowledge?: KnowledgeAnswerContextService,
    @Inject(SalesPlanService) private readonly salesPlans?: SalesPlanService,
    @Optional() @Inject(BENCHMARK_RESEARCH_IMAGE_READER) private readonly benchmarkImageReader?: BenchmarkResearchImageReader,
  ) {}

  async prepareForExecution(context: TenantContext, request: CreateAssist, benchmark = false, legacyOutputPolicy = false): Promise<AssistContext> {
    const before = await withTenant(this.database.db, context, tx => captureAssistInputAuthority(tx, context, request), { isolationLevel: "repeatable read", accessMode: "read only" });
    const prepared = await this.prepare(context, request, benchmark);
    const after = await withTenant(this.database.db, context, async tx => captureAssistInputAuthority(tx, context, prepared.request,
      await knowledgeExecutionAuthority(tx, context, prepared.knowledge, request.kind === "knowledge_answer" ? request.evidenceStoreId : null)), { isolationLevel: "repeatable read", accessMode: "read only" });
    try { assertAssistInputAuthority(before, after, { admission: true }); }
    catch (error) {
      if (error instanceof AssistInputChangedError) throw new ConflictException(`任务依据已变化（${[...new Set(error.resources.map(assistAuthorityResourceLabel))].join("、")}），请重新读取后分析`, { cause: error });
      throw error;
    }
    const harness = assistHarness(prepared.request.kind, !!prepared.artworkAudit, requiredAssistPermissions(prepared.request.kind, "run"), ASSIST_ACCESS_POLICY_VERSION, isBenchmarkAssist(prepared));
    const executionContract = harness.registry.pin(harness.skill);
    try { harness.registry.checkInput(executionContract, harness.skill, harness.toolKey, prepared.request); }
    catch (error) { if (error instanceof HarnessContractError) throw new BadRequestException("分析输入不满足已注册工具契约"); throw error; }
    return { ...prepared, ...(!benchmark && !legacyOutputPolicy ? { outputTokenPolicy: "provider" as const } : {}), inputAuthority: after, executionContract };
  }

  async assertMethodCurrent(tx: TenantTransaction, context: TenantContext, input: AssistContext, admission=false) {
    try {
      await assertCurrentAssistMethodInTransaction(tx, context, input, { admission, lock: admission });
    } catch(error) {
      if(error instanceof AgentMethodAuthorityError)throw new ConflictException("方法版本或来源已不可用，请重新读取方法与业务依据",{cause:error});
      throw error;
    }
  }

  async assertPinnedGuidanceCurrentInTransaction(tx: TenantTransaction, context: TenantContext, input: AssistContext, options: { lock?: boolean } = {}) {
    if (!await isPinnedAssistGuidanceCurrentInTransaction(tx, context, input, options))
      throw new ConflictException("benchmark_guidance_unavailable");
  }

  async assertExecutionCurrent(context: TenantContext, input: AssistContext) {
    if (!input.inputAuthority) throw new ConflictException("旧任务缺少业务依赖快照，请基于当前资料新建任务");
    const harness = assistHarness(input.request.kind, !!input.artworkAudit, requiredAssistPermissions(input.request.kind, "run"), ASSIST_ACCESS_POLICY_VERSION, isBenchmarkAssist(input));
    try { harness.registry.checkInput(input.executionContract, harness.skill, harness.toolKey, input.request); }
    catch (error) { if (error instanceof HarnessContractError) throw new ConflictException("原任务工具或执行方法无法核验，请读取当前资料并新建任务"); throw error; }
    await withTenant(this.database.db, context, async tx => {
      await this.assertMethodCurrent(tx,context,input);
      const authority = await captureAssistInputAuthority(tx, context, input.request,
        await knowledgeExecutionAuthority(tx, context, input.knowledge, input.request.kind === "knowledge_answer" ? input.request.evidenceStoreId : null));
      try { assertAssistInputAuthority(input.inputAuthority!, authority); }
      catch (error) {
        if (error instanceof AssistInputChangedError) throw new ConflictException("原任务依据已变化，请读取当前资料并新建任务", { cause: error });
        throw error;
      }
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  /** Server-only fixed business basis. Keep the production prompt and harness. */
  async preparePinnedBusiness(context: TenantContext, request: CreateAssist): Promise<AssistContext> {
    if (!BUSINESS_BENCHMARK_ROLES.some(role => role === request.kind) || request.kind === "artwork_preflight" && (request.automaticAudit || request.retryAudit))
      throw new BadRequestException("benchmark_business_role_invalid");
    const prepared = LEGACY_BUSINESS_BENCHMARK_ROLES.some(role => role === request.kind) ? await this.prepareForExecution(context, request, false, true) : await this.prepareRoleBenchmark(context, request);
    if (prepared.benchmarkExecutionVersion || !request.expectedTaskFingerprint ||
      assistTaskFingerprint(prepared) !== request.expectedTaskFingerprint)
      throw new ConflictException("benchmark_task_changed");
    return prepared;
  }

  /** Server-only preview. Its fingerprint includes the frozen media and resource scope map. */
  async prepareRoleBenchmark(context: TenantContext, request: CreateAssist): Promise<AssistContext> {
    if (!BUSINESS_BENCHMARK_ROLES.some(role => role === request.kind) || LEGACY_BUSINESS_BENCHMARK_ROLES.some(role => role === request.kind) ||
      request.kind === "artwork_preflight" && (request.automaticAudit || request.retryAudit)) throw new BadRequestException("benchmark_business_role_invalid");
    let prepared = await this.prepareForExecution(context, request, false, true);
    prepared = await freezeBenchmarkRoleMedia(prepared, this.benchmarkImageReader);
    prepared.accessPolicy = { version: ASSIST_ACCESS_POLICY_VERSION, dataScope: context.dataScope,
      requiredPermissions: requiredAssistRequestPermissions(prepared.request, "run", { hasKnowledge: assistUsesReviewedGuidance(prepared) }) };
    prepared.benchmarkResources = await withTenant(this.database.db, context, tx => captureBusinessBenchmarkResources(tx, context, prepared),
      { isolationLevel: "repeatable read", accessMode: "read write" });
    await this.assertExecutionCurrent(context, prepared);
    return prepared;
  }

  async assertPinnedBusinessInTransaction(tx: TenantTransaction, context: TenantContext, input: AssistContext) {
    if (!BUSINESS_BENCHMARK_ROLES.some(role => role === input.request.kind) ||
      input.benchmarkExecutionVersion || !input.inputAuthority || !input.request.expectedTaskFingerprint ||
      assistTaskFingerprint(input) !== input.request.expectedTaskFingerprint)
      throw new ConflictException("benchmark_basis_unavailable");
    await assertBusinessBenchmarkResources(tx, context, [input.request as BusinessTask], input.benchmarkResources,
      LEGACY_BUSINESS_BENCHMARK_ROLES.some(role => role === input.request.kind) ? "metadata" : "run");
    const harness = assistHarness(input.request.kind, !!input.artworkAudit, requiredAssistPermissions(input.request.kind, "run"), ASSIST_ACCESS_POLICY_VERSION);
    try { harness.registry.checkInput(input.executionContract, harness.skill, harness.toolKey, input.request); }
    catch (error) {
      if (error instanceof HarnessContractError) throw new ConflictException("benchmark_basis_unavailable");
      throw error;
    }
    await this.assertMethodCurrent(tx, context, input, true);
    const authority = await captureAssistInputAuthority(tx, context, input.request,
      await knowledgeExecutionAuthority(tx, context, input.knowledge, null));
    try { assertAssistInputAuthority(input.inputAuthority, authority); }
    catch (error) {
      if (error instanceof AssistInputChangedError) throw new ConflictException("benchmark_basis_changed", { cause: error });
      throw error;
    }
  }

  async prepare(context: TenantContext, request: CreateAssist, benchmark = false): Promise<AssistContext> {
    const launch = request.salesPlan ? await this.launchBasis(context, request) : null;
    const prepared = await this.prepareInput(context, request);
    if (benchmark) {
      if (request.kind !== "knowledge_answer" || request.purpose !== "evaluation") throw new BadRequestException("固定评测执行入口无效");
      prepared.benchmarkExecutionVersion = "knowledge-benchmark-execution-v1";
    }
    if (launch) {
      const confirmed = await this.launchBasis(context, request);
      if (confirmed.fingerprint !== launch.fingerprint) throw new ConflictException("销售方案或商品事实在读取期间变化，请重新读取依据");
      prepared.data.salesPlanBasis = launch;
      prepared.data.salesPlanFingerprint = launch.fingerprint;
      prepared.sources.push({ id: launch.plan.id, label: `销售方案 ${launch.plan.fields.name} · V${launch.plan.revision}`, href: `/sales-plans?plan=${launch.plan.id}&view=tasks` });
      if (JSON.stringify(prepared.data).length > 100000) throw new BadRequestException("上新依据超过分析限制，请减少关联资料");
    }
    if (request.taskGoal) prepared.data.operatorGoal = { text: request.taskGoal, authority: "analysis_focus_only" };
    const harness=assistHarness(prepared.request.kind,!!prepared.artworkAudit,requiredAssistPermissions(prepared.request.kind,"run"),ASSIST_ACCESS_POLICY_VERSION,isBenchmarkAssist(prepared));
    try {
      const method=await withTenant(this.database.db,context,async tx=>{
        const selected=await selectAgentMethod(tx,harness.registry.describeSkill(harness.skill));
        await assertMethodKnowledge(tx,context,selected.definition);return selected;
      },{isolationLevel:"repeatable read",accessMode:"read only"});
      prepared.methodSelection=method.selection;
      if(method.definition)prepared.data.operatingMethod={notes:method.definition.notes,authority:"reviewed_working_guidance",methodKey:method.selection.methodKey,version:method.selection.mode==="published"?method.selection.version:null};
    } catch(error) {
      if(error instanceof AgentMethodAuthorityError)throw new ConflictException("方法已停用、版本不受支持或依据已失效，请核对方法后重试",{cause:error});
      throw error;
    }
    return prepared;
  }

  private async launchBasis(context: TenantContext, request: CreateAssist) {
    if (!this.salesPlans || !request.salesPlan || !["creative", "sku_package"].includes(request.kind))
      throw new BadRequestException("此任务不能关联销售方案");
    const basis = await this.salesPlans.assistBasis(context, request.salesPlan.id);
    if (basis.plan.revision !== request.salesPlan.revision) throw new ConflictException("销售方案已有新版本，请重新读取依据");
    if (request.kind === "creative") {
      const selected = basis.plan.fields.researchItemIds;
      if (request.scopeId !== basis.plan.id || request.sources.length !== selected.length || request.sources.some(source => !selected.includes(source.researchItemId)) || request.projectId)
        throw new ConflictException("原创方向必须使用当前销售方案的研究来源");
      if (request.requirements.specificationVersionIds.length !== basis.specifications.length || request.requirements.specificationVersionIds.some(id => !basis.specifications.some(spec => spec.versionId === id)))
        throw new ConflictException("原创方向的规格依据已变化，请重新读取");
      const references = await withTenant(this.database.db, context, tx => resolveResearchSources(tx, context, selected.map(researchItemId => ({ researchItemId }))));
      if (request.sources.some(source => {
        const current = references.find(reference => reference.researchItemId === source.researchItemId);
        return !current || source.snapshotId && (source.snapshotId !== current.snapshotId || (source.studyRevisionId ?? null) !== current.studyRevisionId);
      })) throw new ConflictException("原创方向的研究来源已变化，请重新读取");
      const researchPins = references.map(reference => ({ researchItemId: reference.researchItemId, snapshotId: reference.snapshotId, studyRevisionId: reference.studyRevisionId }));
      return { ...basis, researchPins, fingerprint: fingerprint({ plan: basis.fingerprint, researchPins }) };
    } else if (request.kind === "sku_package") {
      const detail = await this.salesPlans.get(context, basis.plan.id);
      if (!detail.listings.some(listing => listing.id === request.listingId && listing.versionId === request.expectedVersionId && listing.marketplaceId === basis.plan.fields.marketplaceId && listing.locale === basis.plan.fields.locale && listing.status !== "archived"))
        throw new ConflictException("Listing 不属于当前销售方案和目标站点，或已有新版本");
    }
    return basis;
  }

  private async prepareInput(context: TenantContext, request: CreateAssist): Promise<AssistContext> {
    if (request.kind === "knowledge_answer") {
      if (!this.knowledge) throw new BadRequestException("知识对话服务未配置");
      return this.knowledge.prepare(context, request);
    }
    if (request.kind === "artwork_preflight" && request.automaticAudit) return prepareArtworkAudit(context, request, this.orders, this.editor);
    if ("expectedFingerprint" in request) {
      const result = await this.business.prepare(context, request);
      return this.knowledge ? this.knowledge.attachBusiness(context, result) : result;
    }
    if (request.kind === "template_config" || request.kind === "sku_package")
      return this.catalog.prepare(context, request);
    const result: AssistContext = {
      request,
      data: {},
      sources: [],
      checks: [],
      diagnostics: [],
      images: [],
      allowedArtworkIds: [],
      allowedSpecificationIds: [],
      allowMatches: false,
    };
    if (request.kind === "creative") {
      authorize(context, Permission.DesignWrite);
      authorize(context, Permission.ResearchRead);
      if (request.projectId) {
        const project = await this.currentCreativeProject(context, request);
        if (!project) throw new ConflictException("创意项目需求、提示词或研究来源已变化，请重新读取本次依据");
        result.sources.push({ id: project.id, label: project.name, href: `/creative-designs/canvas?brief=${project.id}` });
      }
      const data = await withTenant(this.database.db, context, async (tx) => {
        const references = await resolveResearchSources(tx, context, request.sources);
        const snapshots = [];
        for (const source of references) {
          const [snapshot] = await tx
            .select()
            .from(captureSnapshots)
            .where(eq(captureSnapshots.id, source.snapshotId));
          if (!snapshot || snapshot.domain !== "research")
            throw new BadRequestException("请选择有效的研究快照");
          const textId = source.snapshotId;
          result.sources.push({
            id: textId,
            label: source.title,
            href: `/research?item=${source.researchItemId}`,
          });
          if (source.studyRevisionId)
            result.sources.push({
              id: source.studyRevisionId,
              label: `${source.title} · 研究结论 v${source.studyVersion}`,
              href: `/research?item=${source.researchItemId}`,
            });
          const media = snapshot.draft.media.filter((m) => m.kind === "image" && m.included);
          for (const [index, image] of media.slice(0, 2).entries()) {
            const sourceId = `${source.snapshotId}:image:${index}`;
            result.images.push({ sourceId, url: image.sourceUrl });
            result.sources.push({
              id: sourceId,
              label: `${source.title} · 图片 ${index + 1}`,
              href: `/research?item=${source.researchItemId}`,
            });
          }
          if (!media.length) result.diagnostics.push(`${source.title}：快照没有可分析的图片`);
          if (media.length > 2)
            result.diagnostics.push(`${source.title}：本次仅分析前 2 张图片，其余图片未发送`);
          snapshots.push({
            sourceId: textId,
            title: source.title,
            capturedAt: source.capturedAt,
            bullets: snapshot.draft.bullets.slice(0, 15),
            variants: snapshot.draft.variants.slice(0, 12),
            content: snapshot.draft.contentBlocks
              .filter((b) => b.kind !== "review")
              .slice(0, 8)
              .map((b) => ({ kind: b.kind, text: b.text.slice(0, 3000) })),
            study: source.content,
            studySourceId: source.studyRevisionId,
          });
        }
        const specifications = [];
        if (request.requirements.specificationVersionIds.length)
          authorize(context, Permission.ProductRead);
        for (const id of request.requirements.specificationVersionIds) {
          const spec = await readSpecification(tx, id);
          specifications.push({
            sourceId: id,
            name: spec.name,
            facts: spec.facts,
            attributes: spec.attributes,
          });
          result.sources.push({ id, label: spec.name, href: "/product-specifications" });
        }
        // Pin resolved versions; subsequent edits to research do not rewrite this input.
        result.request = {
          ...request,
          sources: references.map((s) => ({
            researchItemId: s.researchItemId,
            snapshotId: s.snapshotId,
            studyRevisionId: s.studyRevisionId,
          })),
        };
        return {
          kind: request.kind,
          research: snapshots,
          specifications,
          prompt: request.prompt,
          requirements: request.requirements,
        };
      });
      result.data = data;
    } else {
      authorize(context, Permission.OrderPiiRead);
      authorize(
        context,
        request.kind === "order_review" ? Permission.OrderWrite : Permission.DesignWrite,
      );
      let detail = await this.orders.detail(context, request.orderLineId);
      result.expiresAt = (
        await this.orders.analysisExpiresAt(context, request.orderLineId)
      ).toISOString();
      if (detail.line.sourceChanged)
        throw new ConflictException("导入资料已有新版本，请先核对并保存订单需求");
      if (
        detail.line.revision !== request.expectedRevision ||
        (request.kind === "order_review" &&
          (detail.report?.versionId ?? null) !== request.expectedSourceVersionId)
      )
        throw new ConflictException("订单资料已更新，请刷新后重新检查");
      if (request.kind === "order_review" && request.draft) {
        const checked = await this.orders.intakeCheck(context, request.orderLineId, {
          expectedRevision: request.expectedRevision, expectedSourceVersionId: request.expectedSourceVersionId,
          draft: request.draft,
        });
        detail = { ...detail, draft: checked.normalizedDraft,
          requirementSources: checked.requirements?.sources ?? detail.requirementSources,
          requirementInterpretation: checked.requirements ?? detail.requirementInterpretation };
      }
      result.checks = orderAssistChecks(detail);
      result.sources.push({
        id: "order",
        label: `订单资料 · 修订 ${detail.line.revision}`,
        href: `/orders?line=${request.orderLineId}`,
      });
      const artworks = [...(detail.catalog?.artworks ?? [])]
        .sort(
          (a, b) =>
            Number(b.id === detail.draft.artworkVersionId) -
            Number(a.id === detail.draft.artworkVersionId),
        )
        .slice(0, 50);
      const specifications = [...(detail.catalog?.specifications ?? [])]
        .sort(
          (a, b) =>
            Number(b.id === detail.draft.specificationVersionId) -
            Number(a.id === detail.draft.specificationVersionId),
        )
        .slice(0, 50);
      result.allowedArtworkIds = detail.draft.artworkVersionId
        ? artworks.filter((a) => a.id === detail.draft.artworkVersionId).map((a) => a.id)
        : artworks.map((a) => a.id);
      result.allowedSpecificationIds = detail.draft.specificationVersionId
        ? specifications
            .filter((s) => s.id === detail.draft.specificationVersionId)
            .map((s) => s.id)
        : specifications.map((s) => s.id);
      result.allowMatches =
        request.kind === "order_review" &&
        !["matched", "pinned"].includes(detail.catalog?.status ?? "") &&
        (!detail.draft.artworkVersionId || !detail.draft.specificationVersionId);
      result.sources.push(
        ...artworks.map((a) => ({
          id: a.id,
          label: `${a.code} · ${a.name} v${a.version}`,
          href: "/print-library",
        })),
        ...specifications.map((s) => ({
          id: s.id,
          label: `${s.spuCode} · ${s.name} v${s.version}`,
          href: `/product-specifications?spu=${s.spuId}`,
        })),
      );
      const requirementSources = detail.requirementInterpretation?.sources ?? detail.requirementSources ?? [];
      const requirementSourceIds = Object.fromEntries(requirementSources.map(source => [source.sourceFieldKey, orderRequirementSourceId(source.sourceFieldKey)]));
      if (request.kind === "order_review") result.sources.push(...requirementSources.map(source => ({
        id: requirementSourceIds[source.sourceFieldKey]!, label: `原始定制字段 · ${source.label}`.slice(0, 240), href: null,
      })));
      if (
        (detail.catalog?.artworks.length ?? 0) > 50 ||
        (detail.catalog?.specifications.length ?? 0) > 50
      )
        result.diagnostics.push(
          "候选库超过本次上限；本次仅对列表前 50 个印花、50 个规格提出建议，可在订单匹配区继续搜索",
        );
      result.data = {
        kind: request.kind,
        order: {
          sourceId: "order",
          sku: detail.line.skuCode,
          title: detail.line.title,
          quantity: detail.line.quantity,
          projectionVersion: detail.line.projectionVersion,
          ...(request.kind === "order_review" ? {
            requirementSources, requirementSourceIds,
            requirementInterpretation: detail.requirementInterpretation,
            customization: artworks.find(artwork => artwork.id === detail.draft.artworkVersionId)?.customization,
          } : {}),
          draft: {
            artworkVersionId: detail.draft.artworkVersionId,
            specificationVersionId: detail.draft.specificationVersionId,
            fields: detail.draft.fields,
            images: detail.draft.images.map((i) => ({ usage: i.usage })),
            instructions: detail.draft.instructions,
          },
        },
        catalog: {
          status: detail.catalog?.status,
          artworks: artworks.map((a) => ({
            id: a.id,
            code: a.code,
            name: a.name,
            version: a.version,
            mode: a.mode,
            customization: a.customization,
            layout: a.layout,
            instructions: a.instructions,
          })),
          specifications,
        },
        allowMatches: result.allowMatches,
      };
      for (const [index, image] of detail.draft.images.slice(0, 6).entries()) {
        const sourceId = `buyer-image:${index}`;
        try {
          const file =
            image.origin === "upload"
              ? await this.orders.image(context, request.orderLineId, image.key)
              : detail.report?.versionId && detail.line.reportLineId
                ? await this.reports.originalFromVersion(
                    context,
                    detail.line.reportLineId,
                    detail.report.versionId,
                    image.key,
                  )
                : null;
          if (!file) throw new Error("missing");
          result.images.push({ sourceId, dataUrl: await analysisImage(file.body) });
          result.sources.push({
            id: sourceId,
            label: `本单图片 ${index + 1} · ${image.usage}`,
            href: null,
          });
        } catch {
          result.diagnostics.push(`本单图片 ${index + 1} 无法读取，需人工检查`);
        }
      }
      if (detail.draft.images.length > 6)
        result.diagnostics.push("本单仅向模型发送前 6 张买家图片，其余图片需人工核对");
      if (request.kind === "artwork_preflight") {
        for (const material of (
          artworks.find((a) => a.id === detail.draft.artworkVersionId)?.materials ?? []
        )
          .filter(
            (m) =>
              ["master", "background", "decoration"].includes(m.role) &&
              ["image/png", "image/jpeg", "image/webp"].includes(m.mediaType),
          )
          .slice(0, 3)) {
          const sourceId = `artwork-material:${material.assetId}`;
          try {
            const file = await this.orders.artworkMaterial(
              context,
              request.orderLineId,
              material.assetId,
            );
            result.images.push({ sourceId, dataUrl: await analysisImage(file.body) });
            result.sources.push({
              id: sourceId,
              label: `本单印花素材 · ${material.usage}`,
              href: null,
            });
          } catch {
            result.diagnostics.push(`印花素材“${material.usage}”暂不可读取，需人工对照`);
          }
        }
        if (!detail.line.editorProjectId)
          throw new ConflictException("请先制作并保存该订单的生产稿");
        const preview = await this.editor.analysisPreview(
          context,
          detail.line.editorProjectId,
          request.expectedEditorVersionId,
        );
        result.checks.push(
          ...preview.preflight.issues.map((i) => ({
            code: i.code,
            severity: i.severity,
            message: i.message,
            location: i.layerId ?? null,
          })),
        );
        result.data.document = preview.document;
        result.sources.push({
          id: "document",
          label: `生产稿版本 ${request.expectedEditorVersionId}`,
          href: `/order-artwork?line=${request.orderLineId}`,
        });
        if (preview.preview) {
          result.images.push({
            sourceId: "production-preview",
            dataUrl: await analysisImage(preview.preview),
          });
          result.sources.push({ id: "production-preview", label: "本次生产稿预览", href: null });
        } else result.diagnostics.push("当前生产稿无法渲染，已保留规则检查；本次不能进行视觉预检");
        const texts = preview.document.layers.flatMap((l) =>
          l.kind === "text" && l.visible ? [l.text] : [],
        );
        for (const field of detail.draft.fields)
          if (field.value.trim() && !texts.some((t) => t.includes(field.value)))
            result.checks.push({
              code: "text_not_in_layers",
              severity: "manual",
              message: `“${field.label}”原文未在可见文字图层中找到，若已转为图片请人工对照`,
              location: field.key,
            });
      }
      result.data.allowedArtworkIds = result.allowedArtworkIds;
      result.data.allowedSpecificationIds = result.allowedSpecificationIds;
      // Recheck after private image reads to avoid combining two revisions.
      const current = await this.orders.detail(context, request.orderLineId);
      if (
        current.line.revision !== request.expectedRevision ||
        current.line.projectionVersion !== detail.line.projectionVersion ||
        (current.report?.versionId ?? null) !== (detail.report?.versionId ?? null)
      )
        throw new ConflictException("读取期间订单资料发生变化，请重试");
    }
    if (JSON.stringify(result.data).length > 70000)
      throw new BadRequestException("所选资料过多，请减少研究来源或缩短需求后分析");
    return request.kind === "creative" && this.knowledge ? this.knowledge.attachBusiness(context, result) : result;
  }

  private async currentCreativeProject(context: TenantContext, request: Extract<CreateAssist, { kind: "creative" }>) {
    return withTenant(this.database.db, context, async tx => {
      const [project] = await tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, request.projectId!));
      const workflow = project?.canvasWorkflow;
      if (!project || project.archivedAt || project.executionMode !== "infinite_canvas" || !workflow?.requirements || !workflow.researchReferences) return null;
      const [item] = await tx.select({ prompt: creativeDesignBatchItems.prompt }).from(creativeDesignBatchItems)
        .where(eq(creativeDesignBatchItems.batchId, project.id)).orderBy(creativeDesignBatchItems.ordinal).limit(1);
      const pins = (sources: typeof request.sources) => sources.map(source => ({ researchItemId: source.researchItemId, snapshotId: source.snapshotId, studyRevisionId: source.studyRevisionId ?? null }));
      // Parsing normalizes JSONB key order and defaults before comparing saved facts.
      const current = { scopeId: workflow.analysisScopeId ?? project.id, requirements: CreativeRequirementsSchema.parse(workflow.requirements), prompt: item?.prompt ?? "", sources: pins(workflow.researchReferences) };
      const expected = { scopeId: request.scopeId, requirements: request.requirements, prompt: request.prompt, sources: pins(request.sources) };
      return assistFingerprint(current) === assistFingerprint(expected) ? project : null;
    });
  }

  async assertKnowledgeReadAccess(context: TenantContext, snapshot: AssistContext) {
    if (snapshot.request.kind !== "knowledge_answer") return context;
    if (!this.knowledge) throw new BadRequestException("知识对话服务未配置");
    const current = await this.knowledge.currentReadContext(context, snapshot.request, snapshot.knowledge ?? []);
    authorizeAssistRequest(current, snapshot.request, "read", {
      hasKnowledge: assistUsesReviewedGuidance(snapshot), pinnedDataScope: snapshot.accessPolicy?.dataScope ?? "tenant",
    });
    return current;
  }
  async stale(
    context: TenantContext,
    input: CreateAssist,
    snapshot?: AssistContext,
  ): Promise<boolean> {
    if (input.salesPlan) {
      try {
        const current = await this.launchBasis(context, input);
        if (current.fingerprint !== snapshot?.data.salesPlanFingerprint) return true;
      } catch { return true; }
    }
    if (input.kind === "knowledge_answer") {
      if (!snapshot) return true;
      const current = await this.assertKnowledgeReadAccess(context, snapshot);
      return !await withTenant(this.database.db, current,
        tx => isPinnedAssistGuidanceCurrentInTransaction(tx, current, snapshot));
    }
    if ("expectedFingerprint" in input) return this.business.stale(context, input);
    if (input.kind === "template_config" || input.kind === "sku_package")
      return !snapshot || this.catalog.stale(context, snapshot);
    if (input.kind === "creative") {
      if (!input.projectId) return false;
      return !(await this.currentCreativeProject(context, input));
    }
    try {
      const detail = await this.orders.detail(context, input.orderLineId);
      if (detail.line.revision !== input.expectedRevision || detail.line.sourceChanged) return true;
      if (input.kind === "artwork_preflight" && input.automaticAudit && (detail.line.held || detail.line.archivedAt || (detail.sourceReport?.versionId ?? null) !== snapshot?.artworkAudit?.sourceVersionId)) return true;
      if (input.kind === "order_review")
        return (detail.report?.versionId ?? null) !== input.expectedSourceVersionId ||
          snapshot?.data.order !== undefined &&
          (snapshot.data.order as { projectionVersion?: number }).projectionVersion !== undefined &&
          (snapshot.data.order as { projectionVersion: number }).projectionVersion !== detail.line.projectionVersion;
      if (!detail.line.editorProjectId) return true;
      return (
        (await this.editor.get(context, detail.line.editorProjectId)).project.currentVersionId !==
        input.expectedEditorVersionId
      );
    } catch {
      return true;
    }
  }
  previewBusiness(context: TenantContext, input: unknown) {
    return this.business.preview(context, input);
  }
}
async function analysisImage(bytes: Uint8Array): Promise<string> {
  const body = await sharp(bytes, { limitInputPixels: 64_000_000 })
    .rotate()
    .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85 })
    .toBuffer();
  return `data:image/jpeg;base64,${body.toString("base64")}`;
}
