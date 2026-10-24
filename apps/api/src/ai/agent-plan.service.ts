import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { HarnessContractError, type SecretVault } from "@yummyai/ai-core";
import { authorize, erpPermissionContext, intersectPermissionContexts, Permission, type PermissionValue } from "@yummyai/authz";
import { createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import {
  AGENT_PLAN_VERSION, AgentPlanPinnedInputSchema, AgentPlanReceiptQuerySchema,
  AgentPlanReceiptSchema, AgentPlanResultSchema, AgentPlanViewSchema, AgentPlanWorkspaceSchema, AgentPlanItemReceiptSchema, PrepareAgentPlanItemSchema,
  CreateAgentPlanSchema, StopAgentPlanSchema, maximumAgentPlanLimits, AgentPlanCommandKeySchema,
  type AgentPlanView, type AgentPlanReceipt, type AgentPlanWorkspace,
} from "@yummyai/contracts/ai/agent-plan";
import { AgentLoopCollectionSchema } from "@yummyai/contracts/ai/agent-loop";
import { AGENT_READ_VERSION, AgentReadPageViewSchema } from "@yummyai/contracts/ai/agent-read";
import { AGENT_COMMAND_VERSION, canonicalAgentCommandRequest } from "@yummyai/contracts/ai/agent-command";
import {
  agentPlanRuns as runs, agentPlanSteps as steps, agentPlanItems as items, agentCommandRequests, aiAssistRuns, aiAssistExecutions, aiBudgetLedger, aiBudgetPolicies,
  modelBillingReconciliations, modelRoutes, loadCurrentMembershipContext, readModelExecutionRouteFingerprint,
  recordAuditInTransaction, withTenant, type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { agentPlanChecksum, agentPlanHarness, agentPlanMicros, agentPlanSkill, readAgentPlanModel, agentPlanCheckDomains, resolveAgentPlanResult } from "@yummyai/workflow-core";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { AI_ASSIST_VAULT, DATABASE_CONNECTION } from "../platform.tokens.js";
import { AgentReadService } from "./agent-read.service.js";
import { AgentCommandService } from "./agent-command.service.js";
import { AgentCommandOwnerAdapter } from "./agent-command-owner.js";
import { createHash } from "node:crypto";
import { configuredAssistModels } from "./configured-assist-models.js";

type Run = typeof runs.$inferSelect;
const Id = z.uuidv7();
const isTerminal = (status: Run["status"]) => ["completed", "partial", "failed", "uncertain", "stopped", "expired"].includes(status);
const authority = (context: TenantContext) => erpSessionAuthority(erpPermissionContext(context));

export abstract class AgentPlanDispatcher {
  abstract enqueue(input: { id: string; tenantId: string; userId: string; expiresAt: Date }): Promise<void>;
}
export const AGENT_PLAN_RETENTION_SECONDS = Symbol("AGENT_PLAN_RETENTION_SECONDS");

/** Independent paid intent owner. GET and receipt never dispatch or reserve. */
@Injectable()
export class AgentPlanService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AI_ASSIST_VAULT) private readonly vault: SecretVault,
    @Inject(AgentReadService) private readonly reads: Pick<AgentReadService, "workspace" | "call">,
    @Inject(AgentCommandService) private readonly commands: AgentCommandService,
    @Inject(AgentCommandOwnerAdapter) private readonly owner: AgentCommandOwnerAdapter,
    @Inject(AgentPlanDispatcher) private readonly dispatcher: AgentPlanDispatcher,
    @Optional() @Inject(AGENT_PLAN_RETENTION_SECONDS) private readonly retentionSeconds = 86400,
  ) {}

  private async current(tx: TenantTransaction, ceiling: TenantContext, permission: PermissionValue = Permission.WorkflowRead): Promise<TenantContext> {
    const current = TenantContextSchema.parse(intersectPermissionContexts(ceiling, await loadCurrentMembershipContext(tx, ceiling, { lock: true })));
    authorize(current, permission, { ownerId: ceiling.userId });
    return current;
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

  async workspace(context: TenantContext): Promise<AgentPlanWorkspace> {
    const initial = await withTenant(this.database.db, context, tx => this.current(tx, context));
    const readWorkspace = await this.reads.workspace(initial);
    return withTenant(this.database.db, initial, async tx => {
      const current = await this.current(tx, initial);
      if (authority(current) !== readWorkspace.contextAuthority) throw new ConflictException({ code: "authority_changed" });
      const models = await this.models(tx, current.userId);
      const recent = await tx.select({ id: runs.id, requestId: runs.requestId, status: runs.status, createdAt: runs.createdAt })
        .from(runs).where(and(eq(runs.ownerId, current.userId),eq(runs.version,AGENT_PLAN_VERSION))).orderBy(desc(runs.createdAt), desc(runs.id)).limit(21);
      return AgentPlanWorkspaceSchema.parse({ version: AGENT_PLAN_VERSION, contextAuthority: authority(current),
        executionContract: agentPlanHarness.pin(agentPlanSkill), readWorkspace, models, commandCapabilities: this.owner.capabilities(current), limits: maximumAgentPlanLimits(),
        canStart: current.permissions.includes(Permission.WorkflowRun)
          && models.length > 0 && this.owner.capabilities(current).some(tool => tool.available),
        recent: recent.slice(0, 20).map(row => ({ ...row, createdAt: row.createdAt.toISOString() })),
        recentLimit: 20, recentHasMore: recent.length > 20, mcpState: "not_connected" });
    });
  }

  async start(context: TenantContext, raw: unknown): Promise<AgentPlanView> {
    const parsed = CreateAgentPlanSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ code: "agent_input_invalid" });
    const request = parsed.data, checksum = agentPlanChecksum(request);
    try { agentPlanHarness.assertCurrent(request.executionContract, agentPlanSkill); }
    catch (error) { if (!(error instanceof HarnessContractError)) throw error; throw new ConflictException({ code: error.code }); }
    const readWorkspace = await this.reads.workspace(context);
    const outcome = await withTenant(this.database.db, context, async tx => {
      const current = await this.current(tx, context, Permission.WorkflowRun);
      agentPlanCheckDomains(current, request);
      if(request.allowedCommands.some(key=>!this.owner.capabilities(current).some(item=>item.domain===key.domain&&item.kind===key.kind&&item.available)))throw new ForbiddenException({code:'agent_plan_command_unavailable'});
      if (authority(current) !== readWorkspace.contextAuthority) throw new ConflictException({ code: "authority_changed" });
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${context.userId}:agent-plan:${request.requestId}`},0))`);
      const [original] = await tx.select().from(runs).where(and(eq(runs.ownerId, context.userId), eq(runs.requestId, request.requestId)));
      if (original) {
        if (original.version!==AGENT_PLAN_VERSION||original.requestChecksum !== checksum) throw new ConflictException({ code: "agent_request_conflict" });
        return { run: original, created: false };
      }
      if (request.allowedReads.some(key => !readWorkspace.tools.some(tool => tool.key === key && tool.available)))
        throw new ForbiddenException({ code: "agent_tool_not_available" });
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`model-configuration:${context.tenantId}`},0))`);
      // Share the original organization-wide reservation lock with Assist.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:ai-assist-budget`},0))`);
      const model = (await this.models(tx, current.userId)).find(value => value.id === request.modelId);
      const [route] = await tx.select().from(modelRoutes).where(eq(modelRoutes.id, request.modelId));
      const fingerprint = await readModelExecutionRouteFingerprint(tx, request.modelId);
      if (!model || !route || route.targets.length !== 1 || !fingerprint) throw new ConflictException({ code: "agent_model_unavailable" });
      const pinnedModel = { ...model, providerConfigId: route.targets[0]!.providerConfigId, routeFingerprint: fingerprint };
      const selected = await readAgentPlanModel(tx, pinnedModel);
      const [policy] = await tx.select().from(aiBudgetPolicies);
      const policyCap = policy ? Math.min(policy.taskCapsUsd.erp_agent_plan ?? Infinity,policy.taskCapsUsd.erp_agent ?? Number(policy.defaultTaskCapUsd)) : 100;
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
        if (agentPlanMicros(total?.value ?? "0") + agentPlanMicros(cap) > agentPlanMicros(policy.monthlyCapUsd))
          throw new ConflictException({ code: "agent_monthly_budget_limit" });
      }
      const [active] = await tx.execute<{ count: string }>(sql`select (
        (select count(*) from agent_plan_runs where tenant_id=${current.tenantId}::uuid and status in('queued','running','stopping') and expires_at>clock_timestamp())+
        (select count(*) from agent_loop_runs where tenant_id=${current.tenantId}::uuid and status in('queued','running','stopping') and expires_at>clock_timestamp())+
        (select count(*) from ai_assist_runs where tenant_id=${current.tenantId}::uuid and status in('queued','running') and expires_at>clock_timestamp())
      )::text as count`);
      if (Number(active?.count ?? 4) >= 4) throw new ConflictException({ code: "agent_active_limit" });
      const input = AgentPlanPinnedInputSchema.parse({ version: AGENT_PLAN_VERSION, request, ceiling: current, model: pinnedModel,
        readExecutionContract: readWorkspace.executionContract });
      const id = createEntityId(), ledgerId = createEntityId();
      await tx.insert(aiBudgetLedger).values({ id: ledgerId, tenantId: current.tenantId, requestId: id, taskType: "erp_agent_plan",
        modelKey: model.model, provider: selected.provider.provider, amountUsd: cap, state: "reserved" });
      const [run] = await tx.insert(runs).values({ id, tenantId: current.tenantId, ownerId: current.userId, requestId: request.requestId,
        requestChecksum: checksum, inputChecksum: agentPlanChecksum(input), encryptedInput: this.vault.encrypt(JSON.stringify(input)),
        originCeiling: current, executionContract: request.executionContract, readExecutionContract: input.readExecutionContract,
        modelSnapshot: pinnedModel, allowedReads: request.allowedReads, allowedCommands: request.allowedCommands, limits: request.limits, budgetLedgerId: ledgerId, capUsd: cap,
        deadlineAt: sql`clock_timestamp()+${request.limits.deadlineSeconds}*interval '1 second'`,
        expiresAt: sql`clock_timestamp()+${Math.max(request.limits.deadlineSeconds + 1, Math.min(86400, Math.floor(this.retentionSeconds)))}*interval '1 second'`,
      }).returning();
      if (!run) throw new ConflictException({ code: "agent_intent_unavailable" });
      await recordAuditInTransaction(tx, current, { action: "agent.plan.create", resourceType: "agent_plan_run", resourceId: id,
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
      if (agentPlanChecksum(value) !== checksum) throw new Error("checksum");
      return value;
    }); } catch { throw new ConflictException({ code: "agent_checkpoint_invalid" }); }
  }

  private privateAvailable(run:Run,current:TenantContext,now=new Date()){
    if(!run.encryptedInput||run.expiresAt<=now)return false;
    try{agentPlanCheckDomains(current,{allowedReads:run.allowedReads,allowedCommands:run.allowedCommands.map(value=>AgentPlanCommandKeySchema.parse(value))},false);return true;}catch{return false;}
  }

  async get(context: TenantContext, id: string): Promise<AgentPlanView> {
    if (!Id.safeParse(id).success) throw new BadRequestException({ code: "agent_id_invalid" });
    return withTenant(this.database.db, context, async tx => {
      const [run] = await tx.select().from(runs).where(and(eq(runs.id, id), eq(runs.ownerId, context.userId),eq(runs.version,AGENT_PLAN_VERSION))).for("share");
      if (!run) throw new NotFoundException();
      const session = await this.current(tx, context);
      const current = await this.current(tx, intersectPermissionContexts(session, run.originCeiling));

      const databaseNow=await this.now(tx);
      const privateAvailable = this.privateAvailable(run, current,databaseNow);
      const input = privateAvailable ? this.open(run.encryptedInput, run.inputChecksum, AgentPlanPinnedInputSchema) : null;
      if (input && (agentPlanChecksum(input.request) !== run.requestChecksum || agentPlanChecksum(input.ceiling) !== agentPlanChecksum(run.originCeiling)))
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
      if (!ledger || ledger.requestId !== run.id || ledger.taskType !== "erp_agent_plan") throw new ConflictException({ code: "agent_budget_invalid" });
      const itemRecords=await tx.select().from(items).where(eq(items.runId,run.id)).orderBy(asc(items.position));
      const commandIds=itemRecords.flatMap(item=>item.agentCommandId?[item.agentCommandId]:[]);
      const commandRecords=commandIds.length?await tx.select().from(agentCommandRequests).where(inArray(agentCommandRequests.id,commandIds)):[];
      for(const item of itemRecords)if(item.agentCommandId){
        const command=commandRecords.find(value=>value.id===item.agentCommandId);
        if(!command||!command.ownerCommandId||command.ownerId!==run.ownerId||command.requestId!==item.id||command.requestChecksum!==item.preparationRequestChecksum||command.originalChecksum!==item.originalChecksum)
          throw new ConflictException({code:"agent_plan_item_original_mismatch"});
      }
      const result = privateAvailable && run.encryptedResult ? this.checkedResult(run) : null;
      const missingCost = records.some(step => step.kind === "model" && step.submissionState !== "not_submitted" && (step.submissionState !== "received" || step.costUsd === null));
      return AgentPlanViewSchema.parse({ version: AGENT_PLAN_VERSION, id: run.id, requestId: run.requestId, requestChecksum: run.requestChecksum,
        contextAuthority: authority(session), revision: run.revision, status: run.status, goal: input?.request.goal ?? null,
        contextText:input?.request.contextText??null, modelLabel: run.modelSnapshot.label, allowedReads: run.allowedReads,allowedCommands:run.allowedCommands, executionContract: run.executionContract, limits: run.limits,
        cost: { capUsd: run.capUsd, knownCostUsd: run.knownCostUsd, reservedUsd: ledger.state === "reserved" ? ledger.amountUsd : "0.000000",
          coverage: missingCost || run.unknownCost ? agentPlanMicros(run.knownCostUsd) > 0n ? "partial" : "unknown" : "known", modelTurns: run.modelTurns },
        toolCalls: run.toolCalls, observedRows: run.observedRows, stopRequestedAt: run.stopRequestedAt?.toISOString() ?? null, errorCode: run.errorCode,
        createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(), deadlineAt: run.deadlineAt.toISOString(), expiresAt: run.expiresAt.toISOString(),
        privateAvailable, stepsComplete: true, steps: privateAvailable ? records.map(step => ({ id: step.id, sequence: step.sequence, kind: step.kind, phase: step.phase,
          label: privateAvailable ? step.label : step.kind === "model" ? "模型步骤" : "读取步骤", tool: step.tool, inputChecksum: step.inputChecksum,
          outputChecksum: step.outputChecksum, submissionState: step.submissionState, providerRequestId: step.providerRequestId,
          inputTokens: step.inputTokens, outputTokens: step.outputTokens, costUsd: step.costUsd, errorCode: step.errorCode,
          createdAt: step.createdAt.toISOString(), completedAt: step.completedAt?.toISOString() ?? null })) : [], collections, result,
        items:itemRecords.map(item=>{const proposal=result?.proposals.find(value=>value.id===item.id);const readable=!!proposal&&privateAvailable;
          const nativeAvailable=current.permissions.includes(Permission.WorkflowRun)&&!!proposal?.draft.original&&this.owner.capabilities(current).some(cap=>cap.domain===proposal.draft.capability.domain&&cap.kind===proposal.draft.capability.kind&&cap.available);
          const blockReason=!readable?'input_unavailable':run.expiresAt<=databaseNow?'expired':run.stopRequestedAt?'plan_stopped':!proposal?.draft.original?'missing_information':!nativeAvailable?'permission_denied':!["completed","partial"].includes(run.status)?'planning_incomplete':null;
          return{id:item.id,position:item.position,proposalChecksum:item.proposalChecksum,originalChecksum:item.originalChecksum,preparationRequestChecksum:item.preparationRequestChecksum,preparationRequestedAt:item.preparationRequestedAt?.toISOString()??null,
            agentCommandId:item.agentCommandId,ownerCommandId:commandRecords.find(command=>command.id===item.agentCommandId)?.ownerCommandId??null,preparationState:item.agentCommandId?'known':item.preparationRequestedAt?'requested_unknown':item.originalChecksum?'not_requested':'blocked',canPrepare:blockReason===null&&!item.agentCommandId,blockReason};}),
        businessExecution:'separate_original_confirmation',verification: result && ["completed", "partial"].includes(run.status) ? "cited_fields_and_collection_versions_only" : isTerminal(run.status) ? "not_adopted" : "pending" });
    });
  }

  private receiptView(run: Run, current: TenantContext, session: TenantContext = current): AgentPlanReceipt {
    return AgentPlanReceiptSchema.parse({ version: AGENT_PLAN_VERSION, requestId: run.requestId, requestChecksum: run.requestChecksum,
      disposition: "known", runId: run.id, status: run.status, contextAuthority: authority(session), privateAvailable: this.privateAvailable(run, current) });
  }

  async receipt(context: TenantContext, raw: unknown): Promise<AgentPlanReceipt> {
    const parsed = AgentPlanReceiptQuerySchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ code: "agent_receipt_invalid" });
    return withTenant(this.database.db, context, async tx => {
      const session = await this.current(tx, context);
      const [run] = await tx.select().from(runs).where(and(eq(runs.ownerId, context.userId), eq(runs.requestId, parsed.data.requestId),eq(runs.version,AGENT_PLAN_VERSION)));
      if (!run) return AgentPlanReceiptSchema.parse({ version: AGENT_PLAN_VERSION, ...parsed.data, disposition: "not_found", runId: null,
        status: null, contextAuthority: authority(session), privateAvailable: false });
      const current = await this.current(tx, intersectPermissionContexts(session, run.originCeiling));
      if (run.requestChecksum !== parsed.data.requestChecksum) throw new ConflictException({ code: "agent_request_conflict" });
      return this.receiptView(run, current, session);
    });
  }

  async stop(context: TenantContext, id: string, raw: unknown): Promise<AgentPlanReceipt> {
    const parsed = StopAgentPlanSchema.safeParse(raw);
    if (!parsed.success || !Id.safeParse(id).success) throw new BadRequestException({ code: "agent_stop_invalid" });
    return withTenant(this.database.db, context, async tx => {
      const [run] = await tx.select().from(runs).where(and(eq(runs.id, id), eq(runs.ownerId, context.userId),eq(runs.version,AGENT_PLAN_VERSION))).for("update");
      if (!run) throw new NotFoundException();
      const session = await this.current(tx, context, Permission.WorkflowRun);
      const current = await this.current(tx, intersectPermissionContexts(session, run.originCeiling), Permission.WorkflowRun);
      if (run.requestId !== parsed.data.requestId) throw new ConflictException({ code: "agent_request_conflict" });
      if (run.stopRequestedAt || isTerminal(run.status)&&!['completed','partial'].includes(run.status)) return this.receiptView(run, current, session);
      const [stopped] = await tx.update(runs).set({ stopRequestedAt: sql`clock_timestamp()`, status: isTerminal(run.status)?run.status:"stopping", revision: sql`${runs.revision}+1`, updatedAt: sql`clock_timestamp()` })
        .where(eq(runs.id, id)).returning();
      await recordAuditInTransaction(tx, current, { action: "agent.plan.stop", resourceType: "agent_plan_run", resourceId: id, result: "success",
        metadata: { requestChecksum: run.requestChecksum } });
      return this.receiptView(stopped!, current, session);
    });
  }

  private async now(tx:TenantTransaction){
    const [row]=await tx.execute<{milliseconds:string}>(sql`select floor(extract(epoch from clock_timestamp())*1000)::text as milliseconds`);
    const value=Number(row?.milliseconds);if(!Number.isSafeInteger(value))throw new ConflictException({code:"agent_clock_unavailable"});return new Date(value);
  }

  private checkedResult(run:Run){
    const result=this.open(run.encryptedResult,run.resultChecksum,AgentPlanResultSchema);
    const expected=resolveAgentPlanResult(run.id,{summary:result.summary,claims:result.claims,missingInformation:result.missingInformation,proposals:result.proposals.map(item=>item.draft)},run.allowedCommands.map(value=>AgentPlanCommandKeySchema.parse(value)),run.limits.maxProposals);
    if(agentPlanChecksum(expected)!==run.resultChecksum)throw new ConflictException({code:"agent_plan_original_invalid"});return result;
  }

  private async originalItem(context:TenantContext,runId:string,itemId:string,raw:unknown,write=false){
    const parsed=PrepareAgentPlanItemSchema.safeParse(raw);
    if(!parsed.success||!Id.safeParse(runId).success||!Id.safeParse(itemId).success)throw new BadRequestException({code:"agent_plan_item_invalid"});
    return withTenant(this.database.db,context,async tx=>{
      const [run]=await tx.select().from(runs).where(and(eq(runs.id,runId),eq(runs.ownerId,context.userId),eq(runs.version,AGENT_PLAN_VERSION))).for("share");if(!run)throw new NotFoundException();
      const session=await this.current(tx,context),current=await this.current(tx,intersectPermissionContexts(session,run.originCeiling),write?Permission.WorkflowRun:Permission.WorkflowRead);
      const [item]=await tx.select().from(items).where(and(eq(items.runId,run.id),eq(items.id,itemId)));
      if(!item)throw new NotFoundException();
      if(run.requestId!==parsed.data.requestId||item.proposalChecksum!==parsed.data.proposalChecksum)throw new ConflictException({code:"agent_plan_item_original_mismatch"});
      return{run,item,current,session,now:await this.now(tx)};
    });
  }

  private async validateCollections(context:TenantContext,run:Run){
    const records=await withTenant(this.database.db,context,tx=>tx.select().from(steps).where(and(eq(steps.runId,run.id),eq(steps.kind,"read"),eq(steps.phase,"completed"))).orderBy(asc(steps.sequence)));
    for(const step of records){
      const collection=this.open(step.encryptedOutput,step.outputChecksum,AgentLoopCollectionSchema);
      const input=collection.tool==="orders.exceptions.page"?{pageSize:1,cursor:null,status:collection.query.status,...(collection.query.orderId?{orderId:collection.query.orderId}:{})}
        :{pageSize:1,cursor:null,...(collection.query.stockItemId?{stockItemId:collection.query.stockItemId}:{}),...(collection.query.locationId?{locationId:collection.query.locationId}:{})};
      const call={version:AGENT_READ_VERSION,executionContract:run.readExecutionContract,tool:collection.tool,input};
      const page=AgentReadPageViewSchema.parse(await this.reads.call(context,call));
      if(page.tool!==collection.tool||agentPlanChecksum(page.query)!==agentPlanChecksum(input)||page.collectionFingerprint!==collection.collectionFingerprint||page.total!==collection.total)
        throw new ConflictException({code:"agent_plan_read_sources_changed"});
    }
  }

  private async linkItem(context:TenantContext,runId:string,itemId:string,commandId:string){
    return withTenant(this.database.db,context,async tx=>{
      const [run]=await tx.select().from(runs).where(and(eq(runs.id,runId),eq(runs.ownerId,context.userId),eq(runs.version,AGENT_PLAN_VERSION))).for("update");if(!run)throw new NotFoundException();
      const current=await this.current(tx,intersectPermissionContexts(context,run.originCeiling));
      const [item]=await tx.select().from(items).where(and(eq(items.runId,run.id),eq(items.id,itemId))).for("update");if(!item)throw new NotFoundException();
      if(item.agentCommandId){if(item.agentCommandId!==commandId)throw new ConflictException({code:"agent_plan_item_original_mismatch"});return;}
      await tx.update(items).set({agentCommandId:commandId}).where(eq(items.id,item.id));
      await recordAuditInTransaction(tx,current,{action:"agent.plan.item.link",resourceType:"agent_plan_item",resourceId:item.id,result:"success",metadata:{runId:run.id,proposalChecksum:item.proposalChecksum,agentCommandId:commandId}});
    });
  }

  /** Explicitly stages the frozen proposal. This does not execute a native business command. */
  async prepareItem(context:TenantContext,runId:string,itemId:string,raw:unknown){
    const initial=await this.originalItem(context,runId,itemId,raw,true);
    if(initial.item.agentCommandId)return this.itemReceipt(context,runId,itemId,raw);
    if(initial.run.expiresAt<=initial.now||!initial.run.encryptedInput||!initial.run.encryptedResult)throw new ConflictException({code:"agent_plan_expired"});
    if(initial.run.stopRequestedAt||!["completed","partial"].includes(initial.run.status))throw new ConflictException({code:"agent_plan_not_preparable"});
    agentPlanCheckDomains(initial.current,{allowedReads:initial.run.allowedReads,allowedCommands:initial.run.allowedCommands.map(value=>AgentPlanCommandKeySchema.parse(value))});
    const result=this.checkedResult(initial.run),proposal=result.proposals.find(value=>value.id===initial.item.id);
    if(!proposal?.draft.original||proposal.originalChecksum!==initial.item.originalChecksum||proposal.preparationRequestChecksum!==initial.item.preparationRequestChecksum||proposal.proposalChecksum!==initial.item.proposalChecksum)
      throw new ConflictException({code:"agent_plan_original_invalid"});
    if(!this.owner.capabilities(initial.current).some(cap=>cap.domain===proposal.draft.capability.domain&&cap.kind===proposal.draft.capability.kind&&cap.available))throw new ForbiddenException({code:"agent_plan_permission_denied"});
    const request={version:AGENT_COMMAND_VERSION,requestId:proposal.id,original:proposal.draft.original};
    const checksum=createHash("sha256").update(canonicalAgentCommandRequest("prepare",request)).digest("hex");
    if(checksum!==initial.item.preparationRequestChecksum)throw new ConflictException({code:"agent_plan_original_invalid"});
    await this.validateCollections(initial.current,initial.run);
    const staged=await withTenant(this.database.db,context,async tx=>{
      const [run]=await tx.select().from(runs).where(and(eq(runs.id,runId),eq(runs.ownerId,context.userId),eq(runs.version,AGENT_PLAN_VERSION))).for("update");if(!run)throw new NotFoundException();
      const current=await this.current(tx,intersectPermissionContexts(context,run.originCeiling),Permission.WorkflowRun),now=await this.now(tx);
      agentPlanCheckDomains(current,{allowedReads:run.allowedReads,allowedCommands:run.allowedCommands.map(value=>AgentPlanCommandKeySchema.parse(value))});
      if(authority(current)!==authority(initial.current)||run.resultChecksum!==initial.run.resultChecksum)throw new ConflictException({code:"authority_changed"});
      if(run.expiresAt<=now||run.stopRequestedAt||!["completed","partial"].includes(run.status))throw new ConflictException({code:"agent_plan_not_preparable"});
      const [item]=await tx.select().from(items).where(and(eq(items.runId,run.id),eq(items.id,itemId))).for("update");
      if(!item||item.proposalChecksum!==initial.item.proposalChecksum||item.preparationRequestChecksum!==checksum)throw new ConflictException({code:"agent_plan_item_original_mismatch"});
      if(!item.preparationRequestedAt){
        await tx.update(items).set({preparationRequestedAt:sql`clock_timestamp()`}).where(eq(items.id,item.id));
        await recordAuditInTransaction(tx,current,{action:"agent.plan.item.prepare",resourceType:"agent_plan_item",resourceId:item.id,result:"success",metadata:{runId:run.id,proposalChecksum:item.proposalChecksum}});
      }
      return{current,alreadyLinked:!!item.agentCommandId};
    });
    if(!staged.alreadyLinked){
      // The saved original request and the native owner retain their idempotency boundaries.
      const actual=await this.commands.prepare(staged.current,request);
      if(actual.ownerCommandId)await this.linkItem(staged.current,runId,itemId,actual.id);
    }
    return this.itemReceipt(context,runId,itemId,raw);
  }

  /** Receipt recovery never calls prepare or execute, including an unknown dispatch. */
  async itemReceipt(context:TenantContext,runId:string,itemId:string,raw:unknown){
    const initial=await this.originalItem(context,runId,itemId,raw);
    let commandId=initial.item.agentCommandId,ownerCommandId:string|null=null;
    let disposition:"not_requested"|"unknown"|"known"|"blocked"=initial.item.originalChecksum?initial.item.preparationRequestedAt?"unknown":"not_requested":"blocked";
    if(initial.item.preparationRequestedAt&&initial.item.preparationRequestChecksum){
      const receipt=await this.commands.receipt(initial.current,{requestId:initial.item.id,requestChecksum:initial.item.preparationRequestChecksum});
      if(receipt.disposition==="known"&&receipt.id&&receipt.ownerCommandId){
        if(commandId&&commandId!==receipt.id)throw new ConflictException({code:"agent_plan_item_original_mismatch"});
        commandId=receipt.id;ownerCommandId=receipt.ownerCommandId;
        await this.linkItem(initial.current,runId,itemId,commandId);disposition="known";
      }
    }
    const fresh=await this.originalItem(context,runId,itemId,raw);
    if(authority(initial.session)!==authority(fresh.session))throw new ConflictException({code:"authority_changed"});
    return AgentPlanItemReceiptSchema.parse({version:AGENT_PLAN_VERSION,runId,itemId,proposalChecksum:initial.item.proposalChecksum,preparationRequestChecksum:initial.item.preparationRequestChecksum,
      disposition,agentCommandId:disposition==="known"?commandId:null,ownerCommandId:disposition==="known"?ownerCommandId:null,contextAuthority:authority(fresh.session)});
  }
}
