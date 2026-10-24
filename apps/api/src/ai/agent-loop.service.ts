import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { HarnessContractError, type SecretVault } from "@yummyai/ai-core";
import { authorize, erpPermissionContext, intersectPermissionContexts, permissionScope, Permission, type PermissionValue } from "@yummyai/authz";
import { createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import {
  AGENT_LOOP_VERSION, AgentLoopCollectionSchema, AgentLoopPinnedInputSchema, AgentLoopReceiptQuerySchema,
  AgentLoopReceiptSchema, AgentLoopResultSchema, AgentLoopRunViewSchema, AgentLoopWorkspaceSchema,
  CreateAgentLoopSchema, StopAgentLoopSchema, maximumAgentLoopLimits,
  type AgentLoopRunView, type AgentLoopReceipt, type AgentLoopWorkspace,
} from "@yummyai/contracts/ai/agent-loop";
import type { AgentReadToolKey } from "@yummyai/contracts/ai/agent-read";
import {
  agentLoopRuns as runs, agentLoopSteps as steps, aiAssistRuns, aiAssistExecutions, aiBudgetLedger, aiBudgetPolicies,
  modelBillingReconciliations, modelRoutes, loadCurrentMembershipContext, readModelExecutionRouteFingerprint,
  recordAuditInTransaction, withTenant, type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { agentLoopChecksum, agentLoopHarness, agentLoopMicros, agentLoopSkill, readAgentLoopModel } from "@yummyai/workflow-core";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { AI_ASSIST_VAULT, DATABASE_CONNECTION } from "../platform.tokens.js";
import { AgentReadService } from "./agent-read.service.js";
import { configuredAssistModels } from "./configured-assist-models.js";

type Run = typeof runs.$inferSelect;
const Id = z.uuidv7();
const bit = (tool: AgentReadToolKey): PermissionValue => tool === "orders.exceptions.page" ? Permission.OrderRead : Permission.InventoryRead;
const isTerminal = (status: Run["status"]) => ["completed", "partial", "failed", "uncertain", "stopped", "expired"].includes(status);
const authority = (context: TenantContext) => erpSessionAuthority(erpPermissionContext(context));
const permits = (context: TenantContext, permission: PermissionValue) => context.permissions.includes(permission) && permissionScope(context, permission) === "tenant";

export abstract class AgentLoopDispatcher {
  abstract enqueue(input: { id: string; tenantId: string; userId: string; expiresAt: Date }): Promise<void>;
}
export const AGENT_LOOP_RETENTION_SECONDS = Symbol("AGENT_LOOP_RETENTION_SECONDS");

/** Independent paid intent owner. GET and receipt never dispatch or reserve. */
@Injectable()
export class AgentLoopService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AI_ASSIST_VAULT) private readonly vault: SecretVault,
    @Inject(AgentReadService) private readonly reads: Pick<AgentReadService, "workspace" | "call">,
    @Inject(AgentLoopDispatcher) private readonly dispatcher: AgentLoopDispatcher,
    @Optional() @Inject(AGENT_LOOP_RETENTION_SECONDS) private readonly retentionSeconds = 86400,
  ) {}

  private async current(tx: TenantTransaction, ceiling: TenantContext, permission: PermissionValue = Permission.WorkflowRead): Promise<TenantContext> {
    const current = TenantContextSchema.parse(intersectPermissionContexts(ceiling, await loadCurrentMembershipContext(tx, ceiling, { lock: true })));
    authorize(current, permission, { ownerId: ceiling.userId });
    return current;
  }

  private domains(context: TenantContext, tools: AgentReadToolKey[], write = false) {
    authorize(context, Permission.WorkflowRead, { ownerId: context.userId });
    if (write) authorize(context, Permission.WorkflowRun, { ownerId: context.userId });
    for (const permission of tools.map(bit)) {
      if (!permits(context, permission)) throw new ForbiddenException({ code: "agent_access_changed", message: "当前任务的权限或资料范围不可用" });
    }
  }

  private async models(tx: TenantTransaction, userId: string) {
    const configured = await configuredAssistModels(tx, userId);
    const routes = await tx.select().from(modelRoutes).where(inArray(modelRoutes.taskType, ["studio_text", "studio_analysis"]));
    return configured.filter(model => {
      const target = routes.find(route => route.id === model.id)?.targets[0];
      return target?.analysisPricing && model.maxTaskCostUsd !== null && model.maxTaskCostUsd >= 0.000001
        && model.inputUsdPerMillion !== null && model.outputUsdPerMillion !== null;
    }).slice(0, 200);
  }

  async workspace(context: TenantContext): Promise<AgentLoopWorkspace> {
    const initial = await withTenant(this.database.db, context, tx => this.current(tx, context));
    const readWorkspace = await this.reads.workspace(initial);
    return withTenant(this.database.db, initial, async tx => {
      const current = await this.current(tx, initial);
      if (authority(current) !== readWorkspace.contextAuthority) throw new ConflictException({ code: "authority_changed" });
      const models = await this.models(tx, current.userId);
      const recent = await tx.select({ id: runs.id, requestId: runs.requestId, status: runs.status, createdAt: runs.createdAt })
        .from(runs).where(eq(runs.ownerId, current.userId)).orderBy(desc(runs.createdAt), desc(runs.id)).limit(21);
      return AgentLoopWorkspaceSchema.parse({ version: AGENT_LOOP_VERSION, contextAuthority: authority(current),
        executionContract: agentLoopHarness.pin(agentLoopSkill), readWorkspace, models, limits: maximumAgentLoopLimits(),
        canStart: current.permissions.includes(Permission.WorkflowRun)
          && models.length > 0 && readWorkspace.tools.some(tool => tool.available),
        recent: recent.slice(0, 20).map(row => ({ ...row, createdAt: row.createdAt.toISOString() })),
        recentLimit: 20, recentHasMore: recent.length > 20, mcpState: "not_connected" });
    });
  }

  async start(context: TenantContext, raw: unknown): Promise<AgentLoopRunView> {
    const parsed = CreateAgentLoopSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ code: "agent_input_invalid" });
    const request = parsed.data, checksum = agentLoopChecksum(request);
    try { agentLoopHarness.assertCurrent(request.executionContract, agentLoopSkill); }
    catch (error) { if (!(error instanceof HarnessContractError)) throw error; throw new ConflictException({ code: error.code }); }
    const readWorkspace = await this.reads.workspace(context);
    const outcome = await withTenant(this.database.db, context, async tx => {
      const current = await this.current(tx, context, Permission.WorkflowRun);
      this.domains(current, request.allowedTools, true);
      if (authority(current) !== readWorkspace.contextAuthority) throw new ConflictException({ code: "authority_changed" });
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${context.userId}:agent-loop:${request.requestId}`},0))`);
      const [original] = await tx.select().from(runs).where(and(eq(runs.ownerId, context.userId), eq(runs.requestId, request.requestId)));
      if (original) {
        if (original.requestChecksum !== checksum) throw new ConflictException({ code: "agent_request_conflict" });
        return { run: original, created: false };
      }
      if (request.allowedTools.some(key => !readWorkspace.tools.some(tool => tool.key === key && tool.available)))
        throw new ForbiddenException({ code: "agent_tool_not_available" });
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`model-configuration:${context.tenantId}`},0))`);
      // Share the original organization-wide reservation lock with Assist.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:ai-assist-budget`},0))`);
      const model = (await this.models(tx, current.userId)).find(value => value.id === request.modelId);
      const [route] = await tx.select().from(modelRoutes).where(eq(modelRoutes.id, request.modelId));
      const fingerprint = await readModelExecutionRouteFingerprint(tx, request.modelId);
      if (!model || !route || route.targets.length !== 1 || !fingerprint) throw new ConflictException({ code: "agent_model_unavailable" });
      const pinnedModel = { ...model, providerConfigId: route.targets[0]!.providerConfigId, routeFingerprint: fingerprint };
      const selected = await readAgentLoopModel(tx, pinnedModel);
      const [policy] = await tx.select().from(aiBudgetPolicies);
      const policyCap = policy ? policy.taskCapsUsd.erp_agent ?? Number(policy.defaultTaskCapUsd) : 100;
      if (request.maxCostUsd > policyCap) throw new ConflictException({ code: "agent_budget_limit" });
      const cap = request.maxCostUsd.toFixed(6);
      if (policy) {
        const [unpriced] = await tx.select({ id: aiAssistRuns.id }).from(aiAssistRuns).where(and(
          sql`${aiAssistRuns.createdAt}>=date_trunc('month',clock_timestamp() at time zone 'UTC') at time zone 'UTC'`,
          sql`${aiAssistRuns.modelSnapshot}->>'maxTaskCostUsd' is null`, sql`${aiAssistRuns.startedAt} is not null`, sql`${aiAssistRuns.costUsd} is null`,
          sql`not exists(select 1 from ${aiAssistExecutions} e where e.run_id=${aiAssistRuns.id} and e.submission_state='not_submitted')`,
          sql`not exists(select 1 from ${modelBillingReconciliations} b where b.owner='assist' and b.assist_run_id=${aiAssistRuns.id})`,
        )).limit(1);
        if (unpriced) throw new ConflictException({ code: "agent_monthly_cost_unknown" });
        const [total] = await tx.select({ value: sql<string>`coalesce(sum(${aiBudgetLedger.amountUsd}),0)::text` }).from(aiBudgetLedger)
          .where(and(sql`${aiBudgetLedger.createdAt}>=date_trunc('month',clock_timestamp() at time zone 'UTC') at time zone 'UTC'`, inArray(aiBudgetLedger.state, ["reserved", "committed"])));
        if (agentLoopMicros(total?.value ?? "0") + agentLoopMicros(cap) > agentLoopMicros(policy.monthlyCapUsd))
          throw new ConflictException({ code: "agent_monthly_budget_limit" });
      }
      const [active] = await tx.execute<{ count: string }>(sql`select (
        (select count(*) from agent_loop_runs where tenant_id=${current.tenantId}::uuid and status in('queued','running','stopping') and expires_at>clock_timestamp())+
        (select count(*) from agent_plan_runs where tenant_id=${current.tenantId}::uuid and status in('queued','running','stopping') and expires_at>clock_timestamp())+
        (select count(*) from ai_assist_runs where tenant_id=${current.tenantId}::uuid and status in('queued','running') and expires_at>clock_timestamp())
      )::text as count`);
      if (Number(active?.count ?? 4) >= 4) throw new ConflictException({ code: "agent_active_limit" });
      const input = AgentLoopPinnedInputSchema.parse({ version: AGENT_LOOP_VERSION, request, ceiling: current, model: pinnedModel,
        readExecutionContract: readWorkspace.executionContract });
      const id = createEntityId(), ledgerId = createEntityId();
      await tx.insert(aiBudgetLedger).values({ id: ledgerId, tenantId: current.tenantId, requestId: id, taskType: "erp_agent",
        modelKey: model.model, provider: selected.provider.provider, amountUsd: cap, state: "reserved" });
      const [run] = await tx.insert(runs).values({ id, tenantId: current.tenantId, ownerId: current.userId, requestId: request.requestId,
        requestChecksum: checksum, inputChecksum: agentLoopChecksum(input), encryptedInput: this.vault.encrypt(JSON.stringify(input)),
        originCeiling: current, executionContract: request.executionContract, readExecutionContract: input.readExecutionContract,
        modelSnapshot: pinnedModel, allowedTools: request.allowedTools, limits: request.limits, budgetLedgerId: ledgerId, capUsd: cap,
        deadlineAt: sql`clock_timestamp()+${request.limits.deadlineSeconds}*interval '1 second'`,
        expiresAt: sql`clock_timestamp()+${Math.max(request.limits.deadlineSeconds + 1, Math.min(86400, Math.floor(this.retentionSeconds)))}*interval '1 second'`,
      }).returning();
      if (!run) throw new ConflictException({ code: "agent_intent_unavailable" });
      await recordAuditInTransaction(tx, current, { action: "agent.loop.create", resourceType: "agent_loop_run", resourceId: id,
        result: "success", metadata: { requestChecksum: checksum, inputChecksum: run.inputChecksum, budgetLedgerId: ledgerId } });
      return { run, created: true };
    });
    if (outcome.created) {
      try {
        await this.dispatcher.enqueue({ id: outcome.run.id, tenantId: context.tenantId, userId: context.userId, expiresAt: outcome.run.expiresAt });
        await withTenant(this.database.db, context, tx => tx.update(runs).set({ lastDispatchedAt: sql`clock_timestamp()`, dispatchCount: 1 })
          .where(and(eq(runs.id, outcome.run.id), eq(runs.dispatchCount, 0))));
      } catch { /* Original queued intent remains discoverable by the scheduler. Never create a replacement paid request. */ }
    }
    return this.get(context, outcome.run.id);
  }

  private open<T>(encrypted: string | null, checksum: string | null, schema: z.ZodType<T>): T {
    if (!encrypted || !checksum) throw new ConflictException({ code: "agent_checkpoint_unavailable" });
    try { return this.vault.withSecret(encrypted, raw => {
      if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error("size");
      const value = schema.parse(JSON.parse(raw));
      if (agentLoopChecksum(value) !== checksum) throw new Error("checksum");
      return value;
    }); } catch { throw new ConflictException({ code: "agent_checkpoint_invalid" }); }
  }

  private privateAvailable(run: Run, current: TenantContext) {
    return !!run.encryptedInput && run.expiresAt > new Date() && current.permissions.includes(Permission.WorkflowRead)
      && run.allowedTools.map(bit).every(value => permits(current, value));
  }

  async get(context: TenantContext, id: string): Promise<AgentLoopRunView> {
    if (!Id.safeParse(id).success) throw new BadRequestException({ code: "agent_id_invalid" });
    return withTenant(this.database.db, context, async tx => {
      const [run] = await tx.select().from(runs).where(and(eq(runs.id, id), eq(runs.ownerId, context.userId))).for("share");
      if (!run) throw new NotFoundException();
      const session = await this.current(tx, context);
      const current = await this.current(tx, intersectPermissionContexts(session, run.originCeiling));
      this.domains(current, run.allowedTools);
      const privateAvailable = this.privateAvailable(run, current);
      const input = privateAvailable ? this.open(run.encryptedInput, run.inputChecksum, AgentLoopPinnedInputSchema) : null;
      if (input && (agentLoopChecksum(input.request) !== run.requestChecksum || agentLoopChecksum(input.ceiling) !== agentLoopChecksum(run.originCeiling)))
        throw new ConflictException({ code: "agent_checkpoint_invalid" });
      const records = await tx.select().from(steps).where(eq(steps.runId, run.id)).orderBy(asc(steps.sequence)).limit(17);
      if (records.length > 16) throw new ConflictException({ code: "agent_step_chain_invalid" });
      let previous = run.inputChecksum;
      const collections = [];
      for (const [index, step] of records.entries()) {
        if (step.sequence !== index + 1 || step.previousChecksum !== previous) throw new ConflictException({ code: "agent_step_chain_invalid" });
        if (step.phase === "completed") previous = step.outputChecksum!;
        else if (index !== records.length - 1) throw new ConflictException({ code: "agent_step_chain_invalid" });
        if (privateAvailable && step.kind === "read" && step.phase === "completed") collections.push(this.open(step.encryptedOutput, step.outputChecksum, AgentLoopCollectionSchema));
      }
      const [ledger] = await tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.id, run.budgetLedgerId));
      if (!ledger || ledger.requestId !== run.id || ledger.taskType !== "erp_agent") throw new ConflictException({ code: "agent_budget_invalid" });
      const result = privateAvailable && run.encryptedResult ? this.open(run.encryptedResult, run.resultChecksum, AgentLoopResultSchema) : null;
      const missingCost = records.some(step => step.kind === "model" && step.submissionState !== "not_submitted" && (step.submissionState !== "received" || step.costUsd === null));
      return AgentLoopRunViewSchema.parse({ version: AGENT_LOOP_VERSION, id: run.id, requestId: run.requestId, requestChecksum: run.requestChecksum,
        contextAuthority: authority(session), revision: run.revision, status: run.status, goal: input?.request.goal ?? null,
        modelLabel: run.modelSnapshot.label, allowedTools: run.allowedTools, executionContract: run.executionContract, limits: run.limits,
        cost: { capUsd: run.capUsd, knownCostUsd: run.knownCostUsd, reservedUsd: ledger.state === "reserved" ? ledger.amountUsd : "0.000000",
          coverage: missingCost || run.unknownCost ? agentLoopMicros(run.knownCostUsd) > 0n ? "partial" : "unknown" : "known", modelTurns: run.modelTurns },
        toolCalls: run.toolCalls, observedRows: run.observedRows, stopRequestedAt: run.stopRequestedAt?.toISOString() ?? null, errorCode: run.errorCode,
        createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(), deadlineAt: run.deadlineAt.toISOString(), expiresAt: run.expiresAt.toISOString(),
        privateAvailable, stepsComplete: true, steps: records.map(step => ({ id: step.id, sequence: step.sequence, kind: step.kind, phase: step.phase,
          label: privateAvailable ? step.label : step.kind === "model" ? "模型步骤" : "读取步骤", tool: step.tool, inputChecksum: step.inputChecksum,
          outputChecksum: step.outputChecksum, submissionState: step.submissionState, providerRequestId: step.providerRequestId,
          inputTokens: step.inputTokens, outputTokens: step.outputTokens, costUsd: step.costUsd, errorCode: step.errorCode,
          createdAt: step.createdAt.toISOString(), completedAt: step.completedAt?.toISOString() ?? null })), collections, result,
        verification: result && ["completed", "partial"].includes(run.status) ? "field_values_and_collection_versions" : isTerminal(run.status) ? "not_adopted" : "pending" });
    });
  }

  private receiptView(run: Run, current: TenantContext, session: TenantContext = current): AgentLoopReceipt {
    return AgentLoopReceiptSchema.parse({ version: AGENT_LOOP_VERSION, requestId: run.requestId, requestChecksum: run.requestChecksum,
      disposition: "known", runId: run.id, status: run.status, contextAuthority: authority(session), privateAvailable: this.privateAvailable(run, current) });
  }

  async receipt(context: TenantContext, raw: unknown): Promise<AgentLoopReceipt> {
    const parsed = AgentLoopReceiptQuerySchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ code: "agent_receipt_invalid" });
    return withTenant(this.database.db, context, async tx => {
      const session = await this.current(tx, context);
      const [run] = await tx.select().from(runs).where(and(eq(runs.ownerId, context.userId), eq(runs.requestId, parsed.data.requestId)));
      if (!run) return AgentLoopReceiptSchema.parse({ version: AGENT_LOOP_VERSION, ...parsed.data, disposition: "not_found", runId: null,
        status: null, contextAuthority: authority(session), privateAvailable: false });
      const current = await this.current(tx, intersectPermissionContexts(session, run.originCeiling));
      if (run.requestChecksum !== parsed.data.requestChecksum) throw new ConflictException({ code: "agent_request_conflict" });
      return this.receiptView(run, current, session);
    });
  }

  async stop(context: TenantContext, id: string, raw: unknown): Promise<AgentLoopReceipt> {
    const parsed = StopAgentLoopSchema.safeParse(raw);
    if (!parsed.success || !Id.safeParse(id).success) throw new BadRequestException({ code: "agent_stop_invalid" });
    return withTenant(this.database.db, context, async tx => {
      const [run] = await tx.select().from(runs).where(and(eq(runs.id, id), eq(runs.ownerId, context.userId))).for("update");
      if (!run) throw new NotFoundException();
      const session = await this.current(tx, context, Permission.WorkflowRun);
      const current = await this.current(tx, intersectPermissionContexts(session, run.originCeiling), Permission.WorkflowRun);
      if (run.requestId !== parsed.data.requestId) throw new ConflictException({ code: "agent_request_conflict" });
      if (run.stopRequestedAt || isTerminal(run.status)) return this.receiptView(run, current, session);
      const [stopped] = await tx.update(runs).set({ stopRequestedAt: sql`clock_timestamp()`, status: "stopping", revision: sql`${runs.revision}+1`, updatedAt: sql`clock_timestamp()` })
        .where(eq(runs.id, id)).returning();
      await recordAuditInTransaction(tx, current, { action: "agent.loop.stop", resourceType: "agent_loop_run", resourceId: id, result: "success",
        metadata: { requestChecksum: run.requestChecksum } });
      return this.receiptView(stopped!, current, session);
    });
  }
}
