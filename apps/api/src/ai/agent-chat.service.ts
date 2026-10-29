import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { setTimeout as delay } from "node:timers/promises";
import {
  createStreamingSummary,
  OpenAiCompatibleProvider,
  OpenAiProvider,
  type ModelProvider,
  type SecretVault,
} from "@yummyai/ai-core";
import {
  authorize,
  erpPermissionContext,
  intersectPermissionContexts,
  Permission,
} from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import type { AssistView } from "@yummyai/contracts/ai/assist";
import {
  AgentChatEventSchema,
  AgentChatHistorySchema,
  AgentChatStreamRequestSchema,
  AgentChatWorkspaceSchema,
  CreateAgentChatTurnSchema,
  agentChatAssistRequest,
  type AgentChatEvent,
} from "@yummyai/contracts/ai/agent-chat";
import {
  aiAssistRuns,
  modelRoutes,
  modelProviderConfigs,
  loadCurrentMembershipContext,
  withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import { redactKnowledgeText } from "@yummyai/knowledge-core";
import {
  DurableAssistExecution,
  selectAssistExecutionProvider,
  type AssistExecutionProviderRow,
  type AssistExecutionRun,
} from "@yummyai/workflow-core";
import { and, desc, eq, isNull, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { AI_ASSIST_VAULT, DATABASE_CONNECTION, MODEL_SECRET_VAULT } from "../platform.tokens.js";
import { KnowledgeAnswerContextService } from "../knowledge/knowledge-answer-context.service.js";
import { KnowledgeService } from "../knowledge/knowledge.service.js";
import { AssistService } from "./assist.service.js";

export const AGENT_CHAT_PROVIDER_FACTORY = Symbol("AGENT_CHAT_PROVIDER_FACTORY");
export type AgentChatProviderFactory = (
  provider: AssistExecutionProviderRow,
  key: string,
  run: AssistExecutionRun,
) => ModelProvider;
type Sink = (event: AgentChatEvent) => Promise<void>;
type Live = { listeners: Set<(text: string) => Promise<void>>; done: boolean };
const terminal = (run: AssistView) => ["completed", "failed", "cancelled"].includes(run.status);

/** Personal dialogue reuses original Assist inputs, leases, receipts and accounting. */
@Injectable()
export class AgentChatService {
  private readonly live = new Map<string, Live>();
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AI_ASSIST_VAULT) private readonly contentVault: SecretVault,
    @Inject(MODEL_SECRET_VAULT) private readonly modelVault: SecretVault,
    @Inject(AssistService) private readonly assists: AssistService,
    @Inject(KnowledgeAnswerContextService)
    private readonly knowledge: KnowledgeAnswerContextService,
    @Optional()
    @Inject(AGENT_CHAT_PROVIDER_FACTORY)
    private readonly factory?: AgentChatProviderFactory,
    @Optional() @Inject(KnowledgeService) private readonly knowledgeOwner?: KnowledgeService,
  ) {}

  private async current(ceiling: TenantContext, write = false, expected?: string) {
    return withTenant(this.database.db, ceiling, async (tx) => {
      const value = intersectPermissionContexts(
        ceiling,
        await loadCurrentMembershipContext(tx, ceiling, { lock: true }),
      );
      authorize(value, Permission.WorkflowRead);
      if (write) authorize(value, Permission.WorkflowRun);
      if (expected && erpSessionAuthority(erpPermissionContext(value)) !== expected)
        throw new ConflictException({ code: "authority_changed" });
      return value;
    });
  }

  async workspace(context: TenantContext) {
    const current = await this.current(context),
      authority = erpSessionAuthority(erpPermissionContext(current));
    const [models, conversations] = await Promise.all([
      this.assists.models(current),
      this.knowledge.conversations(current),
    ]);
    const products = current.permissions.includes(Permission.ProductRead) && this.knowledgeOwner
      ? await this.knowledgeOwner.productOptions(current, { q: "" }) : null;
    const streaming = models.length ? await withTenant(this.database.db, current, tx => tx.select({ id: modelRoutes.id })
      .from(modelRoutes).innerJoin(modelProviderConfigs, eq(modelProviderConfigs.id, sql`(${modelRoutes.targets}->0->>'providerConfigId')::uuid`))
      .where(and(inArray(modelRoutes.id, models.map(model => model.id)), eq(modelProviderConfigs.provider, "openai")))) : [];
    await this.current(context, false, authority);
    return AgentChatWorkspaceSchema.parse({ contextAuthority: authority, models, conversations,
      products: products?.items ?? [], productsHasMore: products?.hasMore ?? false, streamingModelIds: streaming.map(model => model.id) });
  }

  async history(context: TenantContext, rawScopeId: string) {
    const scopeId = z.uuid().parse(rawScopeId),
      current = await this.current(context);
    const authority = erpSessionAuthority(erpPermissionContext(current));
    const rows = await withTenant(this.database.db, current, (tx) =>
      tx
        .select({ id: aiAssistRuns.id })
        .from(aiAssistRuns)
        .where(
          and(
            eq(aiAssistRuns.ownerId, current.userId),
            eq(aiAssistRuns.kind, "knowledge_answer"),
            eq(aiAssistRuns.scope, `knowledge:${scopeId}`),
            isNull(aiAssistRuns.benchmarkItemId),
          ),
        )
        .orderBy(desc(aiAssistRuns.createdAt), desc(aiAssistRuns.id))
        .limit(41),
    );
    const turns: AssistView[] = [];
    for (const row of rows.slice(0, 40).reverse()) {
      const view = await this.assists.get(current, row.id, { purgeExpired: false });
      if (view.request?.kind === "knowledge_answer" && view.request.purpose === "dialogue")
        turns.push(view);
    }
    await this.current(context, false, authority);
    return AgentChatHistorySchema.parse({
      contextAuthority: authority,
      scopeId,
      turns,
      hasMore: rows.length > 40,
    });
  }

  async create(context: TenantContext, raw: unknown) {
    const parsed = CreateAgentChatTurnSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ code: "agent_chat_input_invalid" });
    if (redactKnowledgeText(parsed.data.message).text !== parsed.data.message)
      throw new BadRequestException({ code: "agent_chat_sensitive_input" });
    const current = await this.current(context, true);
    const authority = erpSessionAuthority(erpPermissionContext(current));
    const run = await this.assists.create(current, agentChatAssistRequest(parsed.data));
    await this.current(context, false, authority);
    return run;
  }

  private async original(context: TenantContext, id: string) {
    const run = await this.assists.get(context, z.uuidv7().parse(id), { purgeExpired: false });
    if (
      run.kind !== "knowledge_answer" ||
      run.request?.kind !== "knowledge_answer" ||
      run.request.purpose !== "dialogue"
    )
      throw new NotFoundException();
    return run;
  }

  /** POST executes the exact original. GET observes only and never dispatches. */
  async stream(
    context: TenantContext,
    id: string,
    raw: unknown | undefined,
    sink: Sink,
    signal: AbortSignal,
  ) {
    const write = raw !== undefined;
    const current = await this.current(context, write),
      authority = erpSessionAuthority(erpPermissionContext(current));
    const original = await this.original(current, id);
    const requestId = original.request!.requestId;
    if (write) {
      const proof = AgentChatStreamRequestSchema.safeParse(raw);
      if (
        !proof.success ||
        proof.data.requestId !== requestId ||
        proof.data.inputFingerprint !== original.inputFingerprint
      )
        throw new ConflictException({ code: "agent_chat_original_mismatch" });
    }
    const key = `${current.tenantId}:${current.userId}:${original.id}`;
    let sequence = 0,
      chain = Promise.resolve(),
      stopped = false;
    const send = (body: Record<string, unknown>) => {
      chain = chain.then(async () => {
        if (signal.aborted || stopped) return;
        const fresh = await this.current(context, false, authority);
        // Recheck the actual private owner, product scope and retention, not only membership.
        await this.original(fresh, id);
        await sink(
          AgentChatEventSchema.parse({
            version: "agent-chat-event-v1",
            runId: id,
            requestId,
            contextAuthority: authority,
            sequence: ++sequence,
            ...body,
          }),
        );
      });
      return chain;
    };
    let live = this.live.get(key);
    const owns = write && !terminal(original) && !live;
    if (owns) {
      live = { listeners: new Set(), done: false };
      this.live.set(key, live);
    }
    const preview = (text: string) => send({ type: "text_delta", text });
    live?.listeners.add(preview);
    try {
      await send({
        type: "status",
        text: terminal(original)
          ? "正在读取原任务结果"
          : owns
            ? "知识资料已固定 正在生成回复"
            : "正在观察原任务进度 不会重复调用模型",
      });
      if (owns) {
        const task = live!;
        let buffered = "",
          lastFlush = Date.now();
        let flushTimer: ReturnType<typeof setTimeout> | undefined;
        let flushing = Promise.resolve();
        const flush = async () => {
          clearTimeout(flushTimer);
          flushTimer = undefined;
          if (!buffered) return;
          const text = buffered;
          buffered = "";
          lastFlush = Date.now();
          flushing = flushing.then(async () => {
            await Promise.allSettled([...task.listeners].map((listener) => listener(text)));
          });
          await flushing;
        };
        const summary = createStreamingSummary(async (text) => {
          buffered += text;
          if (buffered.length >= 64 || Date.now() - lastFlush >= 80) await flush();
          else if (!flushTimer)
            flushTimer = setTimeout(() => {
              void flush();
            }, 80);
        });
        // Deliberately independent of the browser connection. Disconnect cannot
        // discard a paid receipt or turn into an automatic paid retry.
        void new DurableAssistExecution({
          database: this.database,
          contentVault: this.contentVault,
          readImage: async () => {
            throw new Error("agent_chat_images_not_supported");
          },
          provider: async (ctx, run, input) => {
            if (input.request.kind !== "knowledge_answer" || input.request.purpose !== "dialogue")
              throw new Error("agent_chat_scope_invalid");
            const provider = await selectAssistExecutionProvider(this.database, ctx, run, input);
            return this.modelVault.withSecret(provider.encryptedApiKey, (key) => {
              if (this.factory) return this.factory(provider, key, run);
              const pricing =
                run.modelSnapshot.inputUsdPerMillion !== null &&
                run.modelSnapshot.outputUsdPerMillion !== null
                  ? {
                      inputUsdPerMillion: run.modelSnapshot.inputUsdPerMillion,
                      outputUsdPerMillion: run.modelSnapshot.outputUsdPerMillion,
                    }
                  : null;
              return provider.provider === "openai"
                ? new OpenAiProvider({
                    apiKey: key,
                    endpoint: provider.endpoint ?? undefined,
                    pricing,
                  })
                : new OpenAiCompatibleProvider({
                    providerId: provider.id,
                    apiKey: key,
                    endpoint: provider.endpoint!,
                    pricing,
                  });
            });
          },
          onTextDelta: summary,
        })
          .process(current, id, "analyze")
          .catch(() => {
            // The original durable execution owns safe error and uncertain status.
            // Never include upstream bodies or resubmit here.
          })
          .finally(async () => {
            await flush();
            await flushing;
            task.done = true;
            this.live.delete(key);
          });
      }
      const deadline = Date.now() + 10 * 60_000;
      let lastStatus = original.status;
      for (;;) {
        if (signal.aborted) return;
        const fresh = await this.current(context, false, authority);
        const run = await this.original(fresh, id);
        if (terminal(run)) {
          await send({ type: "completed", run });
          return;
        }
        if (lastStatus !== run.status) {
          lastStatus = run.status;
          await send({ type: "status", text: "正在生成回复 完成后保存原结果与实际用量" });
        }
        if (Date.now() >= deadline || (!write && !this.live.has(key)) || (owns && live?.done)) {
          await send({ type: "error", code: "result_unknown" });
          return;
        }
        await delay(1000, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted) return;
      stopped = true;
      // Only an opaque error crosses a revoked/private boundary.
      const code = error instanceof ConflictException ? "authority_changed" : "read_unavailable";
      await sink(
        AgentChatEventSchema.parse({
          version: "agent-chat-event-v1",
          runId: id,
          requestId,
          contextAuthority: authority,
          sequence: ++sequence,
          type: "error",
          code,
        }),
      );
    } finally {
      live?.listeners.delete(preview);
    }
  }
}
