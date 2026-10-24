import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { assistUsesReviewedGuidance, type SecretVault, type AssistContext } from "@yummyai/ai-core";
import { authorize, authorizeAssistRequest, ForbiddenError, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import type { CreateAssist } from "@yummyai/contracts/ai/assist";
import { aiAssistRuns, withTenant, type DatabaseConnection } from "@yummyai/database";
import { redactKnowledgeText } from "@yummyai/knowledge-core";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { KnowledgeConversationSchema } from "@yummyai/contracts/knowledge/governance";
import { DATABASE_CONNECTION, AI_ASSIST_VAULT } from "../platform.tokens.js";
import { KnowledgeService } from "./knowledge.service.js";
import { KnowledgeImportService } from "./knowledge-import.service.js";

@Injectable()
export class KnowledgeAnswerContextService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AI_ASSIST_VAULT) private readonly vault: SecretVault,
    @Inject(KnowledgeService) private readonly knowledge: KnowledgeService,
    @Inject(KnowledgeImportService) private readonly imports: KnowledgeImportService,
  ) {}
  async conversations(context: TenantContext) {
    authorize(context, Permission.WorkflowRead);
    const rows = await withTenant(this.database.db, context, (tx) =>
      tx
        .select()
        .from(aiAssistRuns)
        .where(
          and(
            eq(aiAssistRuns.ownerId, context.userId),
            eq(aiAssistRuns.kind, "knowledge_answer"),
            isNotNull(aiAssistRuns.encryptedInput),
            sql`${aiAssistRuns.expiresAt}>now()`,
          ),
        )
        .orderBy(desc(aiAssistRuns.createdAt))
        .limit(200),
    );
    const seen = new Set<string>(),
      result = [];
    for (const row of rows) {
      if (seen.has(row.scope)) continue;
      const input = this.vault.withSecret(
        row.encryptedInput!,
        (v) => JSON.parse(v) as AssistContext,
      );
      if (input.request.kind !== "knowledge_answer" || input.request.purpose === "evaluation")
        continue;
      seen.add(row.scope);
      try {
        authorizeAssistRequest(context, input.request, "read", {
          hasKnowledge: assistUsesReviewedGuidance(input),
          pinnedDataScope: input.accessPolicy?.dataScope ?? "tenant",
        });
      } catch (error) {
        if (error instanceof ForbiddenError) continue;
        throw error;
      }
      result.push(
        KnowledgeConversationSchema.parse({
          scopeId: input.request.scopeId,
          question: input.request.search.query,
          updatedAt: row.createdAt.toISOString(),
          modelLabel: row.modelSnapshot.label,
        }),
      );
      if (result.length === 20) break;
    }
    return result;
  }
  async prepare(
    context: TenantContext,
    request: Extract<CreateAssist, { kind: "knowledge_answer" }>,
  ): Promise<AssistContext> {
    authorize(context, Permission.WorkflowRead);
    authorize(context, Permission.WorkflowRun);
    if (request.purpose === "evaluation") authorize(context, Permission.WorkflowManage);
    if (redactKnowledgeText(request.search.query).text !== request.search.query)
      throw new BadRequestException("问题含可识别的身份或凭证信息，请先移除");
    const search = await this.knowledge.search(context, request.search);
    const account = request.evidenceStoreId
      ? await this.imports.searchAccount(context, request.evidenceStoreId, request.search)
      : [];
    const references = [...search.references.slice(0, account.length ? 4 : 6), ...account];
    const conversation: Array<{ question: string; answer: string }> = [];
    if (request.previousRunId) {
      const [row] = await withTenant(this.database.db, context, (tx) =>
        tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, request.previousRunId!)),
      );
      if (
        !row ||
        row.ownerId !== context.userId ||
        row.kind !== "knowledge_answer" ||
        row.scope !== "knowledge:" + request.scopeId ||
        !row.encryptedInput ||
        !row.encryptedOutput ||
        row.expiresAt <= new Date()
      )
        throw new NotFoundException("前一轮对话不存在、已到保留期或不属于当前会话");
      const prior = this.vault.withSecret(
        row.encryptedInput,
        (value) => JSON.parse(value) as AssistContext,
      );
      if (
        prior.request.kind === "knowledge_answer" &&
        (prior.request.purpose === "evaluation" || request.purpose === "evaluation")
      )
        throw new BadRequestException("评测记录不能作为知识对话历史 请开始独立对话");
      if (
        prior.request.kind !== "knowledge_answer" ||
        prior.request.evidenceStoreId !== request.evidenceStoreId ||
        JSON.stringify({ ...prior.request.search, query: "" }) !==
          JSON.stringify({ ...request.search, query: "" })
      )
        throw new BadRequestException("检索范围已变化，请开始新会话");
      authorizeAssistRequest(context, prior.request, "read", {
        hasKnowledge: assistUsesReviewedGuidance(prior),
        pinnedDataScope: prior.accessPolicy?.dataScope ?? "tenant",
      });
      const output = this.vault.withSecret(
        row.encryptedOutput,
        (value) => JSON.parse(value) as { result?: { summary: string } },
      );
      conversation.push({
        question: prior.request.search.query,
        answer: output.result?.summary.slice(0, 4000) ?? "",
      });
    }
    return {
      request,
      data: {
        question: request.search.query,
        scope: request.search,
        conversation,
        operatingKnowledge: references.map((r) => ({
          sourceId: r.sourceId,
          title: r.title,
          content: r.excerpt,
          verifiedOn: r.verifiedOn,
          reviewDueOn: r.reviewDueOn,
          checksum: r.checksum,
        })),
        retrieval: { mode: search.mode, retrievedAt: search.retrievedAt },
      },
      sources: references.map((r) => ({
        id: r.sourceId,
        label: r.title + " · v" + r.version,
        href: r.href,
      })),
      checks: [],
      diagnostics: search.diagnostics,
      knowledge: references,
      images: [],
      allowedArtworkIds: [],
      allowedSpecificationIds: [],
      allowMatches: false,
      expiresAt: new Date(
        Date.now() + (request.evidenceStoreId ? 1 : 30) * 86400_000,
      ).toISOString(),
    };
  }
  async attachBusiness(context: TenantContext, result: AssistContext): Promise<AssistContext> {
    if (!context.permissions.includes(Permission.WorkflowRead)) return result;
    const kind = result.request.kind;
    const topic =
      kind === "after_sales_review"
        ? "after_sales"
        : kind === "business_review"
          ? "advertising"
          : kind === "creative"
            ? "research"
            : "operations";
    const query =
      kind === "after_sales_review"
        ? "客服 售后 退款 补寄"
        : kind === "business_review"
          ? "广告 运营 利润 复盘"
          : kind === "creative"
            ? "市场 研究 原创"
            : "采购 库存 补货 SOP";
    const search = await this.knowledge.search(context, {
      query,
      topic,
      platform: "all",
      market: "ALL",
      spuIds: [],
    });
    result.knowledge = search.references;
    result.sources.push(
      ...search.references.map((r) => ({
        id: r.sourceId,
        label: r.title + " · v" + r.version,
        href: r.href,
      })),
    );
    result.data.operatingKnowledge = search.references.map((r) => ({
      sourceId: r.sourceId,
      title: r.title,
      content: r.excerpt,
      checksum: r.checksum,
    }));
    result.diagnostics.push(...search.diagnostics);
    return result;
  }
}
