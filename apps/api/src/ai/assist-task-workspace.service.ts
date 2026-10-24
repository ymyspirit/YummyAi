import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ForbiddenError, Permission, requireTenantOrderPermissions, intersectPermissionContexts } from "@yummyai/authz";
import { assistScope, type AssistContext } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  CreateAssistSchema,
  type AssistKind,
  type CreateAssist,
} from "@yummyai/contracts/ai/assist";
import {
  ASSIST_TASKS,
  assistTaskHref,
  AssistTaskBasisRequestSchema,
  AssistTaskInputSchema,
  AssistTaskQuerySchema,
  AssistTaskTargetQuerySchema,
  type AssistTaskBasis,
  type AssistTaskWorkspace,
} from "@yummyai/contracts/ai/task-workspace";
import {
  aiAssistRuns,
  creativeDesignBatches,
  creativeDesignBatchItems,
  listingVersions,
  withTenant,
  loadCurrentMembershipContext,
  type DatabaseConnection,
   type TenantTransaction,
} from "@yummyai/database";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { OrderWorkspaceService } from "../orders/order-workspace.service.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import { AssistContextService } from "./assist-context.service.js";
import { AssistService, authorizeAssist } from "./assist.service.js";
import { assistTaskFingerprint } from "./assist-task-fingerprint.js";
import { readLegacyAssistTargets } from "./assist-target-source.js";

function allowed(context: TenantContext, kind: AssistKind, write = false) {
  try {
    authorizeAssist(context, kind, write);
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError) return false;
    throw error;
  }
}
@Injectable()
export class AssistTaskWorkspaceService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AssistService) private readonly assists: AssistService,
    @Inject(AssistContextService) private readonly contexts: AssistContextService,
    @Inject(OrderWorkspaceService) private readonly orderWorkspace: OrderWorkspaceService,
    @Inject(ProductionEditorService) private readonly editor: ProductionEditorService,
  ) {}

  async workspace(context: TenantContext, raw: unknown): Promise<AssistTaskWorkspace> {
    const query = AssistTaskQuerySchema.parse(raw);
    const capabilities = ASSIST_TASKS.filter((task) => allowed(context, task.kind)).map((task) => ({
      kind: task.kind,
      canStart: allowed(context, task.kind, true),
    }));
    if (query.kind) authorizeAssist(context, query.kind);
    const kinds = query.kind ? [query.kind] : capabilities.map((task) => task.kind);
    if (!kinds.length) return { capabilities, items: [], page: query.page, hasMore: false };
    const candidates = await withTenant(this.database.db, context, (tx) =>
      tx
        .select({ id: aiAssistRuns.id })
        .from(aiAssistRuns)
        .where(
          and(
            eq(aiAssistRuns.ownerId, context.userId),
            isNull(aiAssistRuns.benchmarkItemId),
            inArray(aiAssistRuns.kind, kinds),
            query.status ? eq(aiAssistRuns.status, query.status) : undefined,
          ),
        )
        .orderBy(desc(aiAssistRuns.createdAt), desc(aiAssistRuns.id))
        .limit(21)
        .offset((query.page - 1) * 20),
    );
    const items: AssistTaskWorkspace["items"] = [];
    for (const candidate of candidates.slice(0, 20)) {
      try {
        // Reuse owner, retention, source-permission and current-version checks.
        const view = await this.assists.get(context, candidate.id);
        if (view.request?.kind === "knowledge_answer" && view.request.purpose === "evaluation")
          continue;
        const task = ASSIST_TASKS.find((task) => task.kind === view.kind)!;
        items.push({
          id: view.id,
          kind: view.kind,
          scope: view.scope,
          status: view.status,
          createdAt: view.createdAt,
          completedAt: view.completedAt,
          modelLabel: view.modelLabel,
          stale: view.stale,
          costUsd: view.costUsd,
          inputTokens: view.inputTokens,
          outputTokens: view.outputTokens,
          error: view.error,
          title: view.sources.find((source) => source.href)?.label ?? task.label,
          goal: view.stale ? "" : (view.request?.taskGoal ?? ""),
          href: assistTaskHref(view.request, view.kind, view.sources, view.id),
        });
      } catch (error) {
        if (!(error instanceof ForbiddenError || error instanceof NotFoundException)) throw error;
      }
    }
    return { capabilities, items, page: query.page, hasMore: candidates.length > 20 };
  }

  async targets(context: TenantContext, raw: unknown, fixedRoleBenchmark = false, transaction?: TenantTransaction) {
    // Keep the legacy positional ABI; current object authorization is identical
    // for ordinary and benchmark searches.
    void fixedRoleBenchmark;
    const query = AssistTaskTargetQuerySchema.parse(raw);
    authorizeAssist(context, query.kind);
    if (query.kind === "knowledge_answer") return { items: [], hasMore: false };
    if (["order_review", "artwork_preflight", "after_sales_review"].includes(query.kind))
      requireTenantOrderPermissions(context, [Permission.OrderRead, Permission.OrderPiiRead]);
    const read = async (tx: TenantTransaction) => {
      context = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context, { lock: true }));
      authorizeAssist(context, query.kind);
      if (["order_review", "artwork_preflight", "after_sales_review"].includes(query.kind))
        requireTenantOrderPermissions(context, [Permission.OrderRead, Permission.OrderPiiRead]);
      return readLegacyAssistTargets(tx, context, query);
    };
    const items = transaction ? await read(transaction) : await withTenant(this.database.db, context, read, { isolationLevel: "repeatable read", accessMode: "read write" });
    return { items: items.slice(0, 40), hasMore: items.length > 40 };
  }

  async basis(context: TenantContext, raw: unknown, fixedRoleBenchmark = false, captured?: (prepared: AssistContext) => void): Promise<AssistTaskBasis> {
    const selection = AssistTaskBasisRequestSchema.parse(raw);
    authorizeAssist(context, selection.kind, true);
    const target = selection.targetId;
    let fields: Record<string, unknown>;
    let href = ASSIST_TASKS.find((task) => task.kind === selection.kind)!.destination as string;
    let rows: AssistTaskBasis["rows"] = [];
    if (selection.kind === "knowledge_answer") {
      if (!selection.taskGoal) throw new BadRequestException("请填写需要查证的知识问题");
      fields = {
        scopeId: createEntityId(),
        search: {
          query: selection.taskGoal,
          topic: "all",
          platform: "all",
          market: "ALL",
          spuIds: [],
        },
      };
      rows = [
        {
          label: "检索范围",
          value: "通用运营知识；平台、站点、商品及账户资料请在知识中心选择范围",
        },
      ];
    } else {
      if (!target) throw new BadRequestException("请先选择本次任务的业务对象");
      if (selection.kind === "procurement_review") {
        const parts = target.split(":");
        if (parts.length !== 2) throw new BadRequestException("请选择库存品与库位");
        fields = {
          stockItemId: z.uuidv7().parse(parts[0]),
          locationId: z.uuidv7().parse(parts[1]),
        };
      } else {
        const id = z.uuidv7().parse(target);
        if (selection.kind === "order_review" || selection.kind === "artwork_preflight") {
          const detail = await this.orderWorkspace.detail(context, id);
          fields = { orderLineId: id, expectedRevision: detail.line.revision };
          rows = [
            { label: "订单", value: detail.line.externalOrderId },
            { label: "商品", value: detail.line.title },
            { label: "本单数量", value: String(detail.line.quantity) },
            { label: "订单修订", value: `R${detail.line.revision}` },
          ];
          if (selection.kind === "order_review")
            fields.expectedSourceVersionId = detail.report?.versionId ?? null;
          else {
            if (!detail.line.editorProjectId)
              throw new BadRequestException("本单还没有已保存的生产稿，请先到制图中心制作");
            const editor = await this.editor.get(context, detail.line.editorProjectId);
            fields.expectedEditorVersionId = editor.version.id;
            rows.push({ label: "生产稿版本", value: `V${editor.version.versionNumber}` });
          }
          href = `${selection.kind === "order_review" ? "/orders" : "/order-artwork"}?line=${id}`;
        } else if (selection.kind === "sku_package") {
          const [version] = await withTenant(this.database.db, context, (tx) =>
            tx
              .select({ id: listingVersions.id, version: listingVersions.versionNumber })
              .from(listingVersions)
              .where(eq(listingVersions.listingId, id))
              .orderBy(desc(listingVersions.versionNumber))
              .limit(1),
          );
          if (!version) throw new NotFoundException("当前 Listing 版本不存在");
          fields = { listingId: id, expectedVersionId: version.id };
          href = `/listings/${id}`;
          rows = [{ label: "Listing 版本", value: `V${version.version}` }];
        } else if (selection.kind === "creative") {
          const [project] = await withTenant(this.database.db, context, (tx) =>
            tx
              .select()
              .from(creativeDesignBatches)
              .where(
                and(eq(creativeDesignBatches.id, id), isNull(creativeDesignBatches.archivedAt)),
              ),
          );
          const workflow = project?.canvasWorkflow;
          if (!workflow?.requirements || !workflow.researchReferences?.length)
            throw new BadRequestException("请先在创意项目保存需求并选择研究来源");
          if (workflow.researchReferences.length > 8)
            throw new BadRequestException("项目超过 8 个研究来源，请在创意项目缩小本次分析范围");
          const [item] = await withTenant(this.database.db, context, (tx) =>
            tx
              .select({ prompt: creativeDesignBatchItems.prompt })
              .from(creativeDesignBatchItems)
              .where(eq(creativeDesignBatchItems.batchId, id))
              .orderBy(creativeDesignBatchItems.ordinal)
              .limit(1),
          );
          fields = {
            scopeId: workflow.analysisScopeId ?? id,
            projectId: id,
            prompt: item?.prompt ?? "",
            requirements: workflow.requirements,
            sources: workflow.researchReferences.map((source) => ({
              researchItemId: source.researchItemId,
              snapshotId: source.snapshotId,
              studyRevisionId: source.studyRevisionId,
            })),
          };
          href = `/creative-designs/canvas?brief=${id}`;
          rows = [
            { label: "创意项目", value: project.name },
            { label: "固定研究来源", value: `${workflow.researchReferences.length} 项` },
          ];
        } else if (selection.kind === "template_config") fields = { inspectionId: id };
        else if (selection.kind === "business_review")
          fields = { runId: id, comparisonRunId: null };
        else fields = { caseId: id, locale: "en-US", contextNotes: selection.taskGoal };
      }
    }
    if (["business_review", "procurement_review", "after_sales_review"].includes(selection.kind)) {
      const preview = await this.assists.previewBusiness(context, {
        kind: selection.kind,
        ...fields,
      });
      fields.expectedFingerprint = preview.fingerprint;
      rows = preview.rows;
    }
    const request = CreateAssistSchema.parse({
      kind: selection.kind,
      ...fields,
      taskGoal: selection.taskGoal,
      modelId: createEntityId(),
      requestId: createEntityId(),
    });
    const prepared = fixedRoleBenchmark ? await this.contexts.prepareRoleBenchmark(context, request) : await this.contexts.prepare(context, request);
    captured?.(prepared);
    if (request.kind === "after_sales_review")
      href = assistTaskHref(prepared.request, request.kind, prepared.sources);
    const fingerprint = assistTaskFingerprint(prepared);
    const rawInput: Partial<CreateAssist> = { ...prepared.request };
    delete rawInput.modelId;
    delete rawInput.requestId;
    const input = AssistTaskInputSchema.parse(rawInput);
    return {
      input: { ...input, expectedTaskFingerprint: fingerprint },
      fingerprint,
      methodSelection: prepared.methodSelection ?? null,
      scope: assistScope(prepared.request),
      href,
      rows: [
        { label: "任务", value: ASSIST_TASKS.find((task) => task.kind === selection.kind)!.label },
        ...rows,
        { label: "可用图片", value: `${prepared.images.length} 张` },
        { label: "资料版本", value: "开始分析前由服务器再次核对；变化后需重新读取" },
      ],
      sources: prepared.sources,
      checks: prepared.checks,
      diagnostics: prepared.diagnostics,
    };
  }
}
