import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { HarnessContractError, type SecretVault } from "@yummyai/ai-core";
import { authorize, erpPermissionContext, intersectPermissionContexts, Permission, type PermissionValue } from "@yummyai/authz";
import { createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AGENT_COMMAND_VERSION } from "@yummyai/contracts/ai/agent-command";
import { AGENT_FULFILLMENT_COMMAND_VERSION, PrepareAgentFulfillmentCommandSchema } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { agentPlanRuns as runs, agentPlanSteps as steps, agentPlanItems as items, aiAssistRuns, aiAssistExecutions, aiBudgetLedger, aiBudgetPolicies,
 modelBillingReconciliations, modelRoutes, loadCurrentMembershipContext, readModelExecutionRouteFingerprint, recordAuditInTransaction, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { agentNativeChecksum, agentNativeMicros, readAgentNativeModel, AgentNativeError,
 type NativeProtocol, type NativeFamily, type NativeV2Family, type NativePorts, type NativePinned, type NativeView, type NativeReceipt, type NativeWorkspace, type NativeEvidence as Evidence } from "@yummyai/workflow-core";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { configuredAssistModels } from "./configured-assist-models.js";
import type { AgentCommandService } from "./agent-command.service.js";
import type { AgentCommandOwnerAdapter } from "./agent-command-owner.js";
import type { AgentPlanDispatcher } from "./agent-plan.service.js";
import { LegacyNativeCommandPreparationPort, type NativeCommandPreparationPort, type NativeOriginalIdentity, type NativeOriginalLink } from "./agent-native-command-port.js";
type Run = typeof runs.$inferSelect;
type Item = typeof items.$inferSelect;
type Step = typeof steps.$inferSelect;
const Id=z.uuidv7();
const isTerminal=(status:Run["status"])=>["completed","partial","failed","uncertain","stopped","expired"].includes(status);
const authority=(context:TenantContext)=>erpSessionAuthority(erpPermissionContext(context));
/** Shared intent, budget and original-item owner. Exact public DTOs stay versioned. */
export class NativeServiceEngine<F extends NativeFamily = NativeV2Family> {
  private readonly ports: NativePorts;
  private readonly commandPreparation: NativeCommandPreparationPort;
  constructor(private readonly protocol: NativeProtocol<F>, private readonly database: DatabaseConnection, private readonly vault: SecretVault, tools: NativePorts["tools"], commands: AgentCommandService, owner: AgentCommandOwnerAdapter, private readonly dispatcher: AgentPlanDispatcher, private readonly retentionSeconds = 86400, resources?: NativePorts["resources"], fulfillment?: NativePorts["fulfillment"], commandPreparation?: NativeCommandPreparationPort, commandDefinitions?: NativePorts["commandDefinitions"]) {
    this.ports = {tools, ...(resources ? {resources} : {}), ...(fulfillment ? {fulfillment} : {}), ...(commandDefinitions ? {commandDefinitions} : {})};
    this.commandPreparation = commandPreparation ?? new LegacyNativeCommandPreparationPort(commands, owner);
  }

  private originalIdentity(run: Run, item: Item): NativeOriginalIdentity {
    return { itemId: item.id, ownerId: run.ownerId, originalProtocol: item.originalProtocol, originalOrderId: item.originalOrderId,
      originalChecksum: item.originalChecksum, preparationRequestChecksum: item.preparationRequestChecksum,
      agentCommandId: item.agentCommandId, fulfillmentIntentId: item.fulfillmentIntentId };
  }

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

  private async selectedModel(tx:TenantTransaction,userId:string,modelId:string){
    const model=(await this.models(tx,userId)).find(value=>value.id===modelId);
    const [route]=await tx.select().from(modelRoutes).where(eq(modelRoutes.id,modelId));
    const fingerprint=await readModelExecutionRouteFingerprint(tx,modelId);
    if(!model||!route||route.targets.length!==1||!fingerprint)throw new ConflictException({code:"agent_model_unavailable"});
    const pinnedModel={...model,providerConfigId:route.targets[0]!.providerConfigId,routeFingerprint:fingerprint};
    const selected=await readAgentNativeModel(tx,pinnedModel);return{model,pinnedModel,selected};
  }

  async workspace(context: TenantContext): Promise<NativeWorkspace> {
    const initial = await withTenant(this.database.db, context, tx => this.current(tx, context));
    const toolWorkspace = await this.protocol.workspace(initial, this.ports);
    return withTenant(this.database.db, initial, async tx => {
      const current = await this.current(tx, initial);
      if (authority(current) !== toolWorkspace.contextAuthority) throw new ConflictException({ code: "authority_changed" });
      const models = await this.models(tx, current.userId);
      const recent = await tx.select({ id: runs.id, requestId: runs.requestId, status: runs.status, createdAt: runs.createdAt })
        .from(runs).where(and(eq(runs.ownerId, current.userId),eq(runs.version,this.protocol.version))).orderBy(desc(runs.createdAt), desc(runs.id)).limit(21);
      return this.protocol.schemas.workspace.parse({ version: this.protocol.version, contextAuthority: authority(current),
        executionContract: this.protocol.harness.pin(this.protocol.skill), ...this.protocol.workspaceFields(toolWorkspace), models, limits: this.protocol.maximumLimits(),
        canStart: current.permissions.includes(Permission.WorkflowRun)
          && models.length > 0 && toolWorkspace.tools.some(tool => tool.available),
        recent: recent.slice(0, 20).map(row => ({ ...row, createdAt: row.createdAt.toISOString() })),
        recentLimit: 20, recentHasMore: recent.length > 20, mcpState: "not_connected" });
    });
  }

  async start(context: TenantContext, raw: unknown): Promise<NativeView<F>> {
    const parsed = this.protocol.schemas.request.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ code: "agent_input_invalid" });
    const request = parsed.data, checksum = agentNativeChecksum(request);
    try { this.protocol.harness.assertCurrent(request.executionContract, this.protocol.skill); }
    catch (error) { if (!(error instanceof HarnessContractError)) throw error; throw new ConflictException({ code: error.code }); }
    const replay = await withTenant(this.database.db, context, async tx => {
      await this.current(tx, context, Permission.WorkflowRun);
      await this.current(tx, context);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${context.userId}:agent-plan:${request.requestId}`},0))`);
      const [original] = await tx.select().from(runs).where(and(eq(runs.ownerId, context.userId), eq(runs.requestId, request.requestId)));
      if (original && (original.version !== this.protocol.version || original.requestChecksum !== checksum))
        throw new ConflictException({ code: "agent_request_conflict" });
      return original?.id ?? null;
    });
    if (replay) return this.get(context, replay);
    const readWorkspace = await this.protocol.workspace(context, this.ports);
    const admission = await withTenant(this.database.db, context, async tx => {
      const current=await this.current(tx,context,Permission.WorkflowRun);
      this.native(()=>this.protocol.checkDomains(current,request));
      if(authority(current)!==readWorkspace.contextAuthority)throw new ConflictException({code:"authority_changed"});
      if(request.allowedCommands.some(key=>!this.commandPreparation.capabilities(current).some(item=>item.domain===key.domain&&item.kind===key.kind&&item.available)))
        throw new ForbiddenException({code:"agent_plan_command_unavailable"});
      if(this.protocol.readKeys(request).some(key=>!readWorkspace.tools.some(tool=>tool.key===key&&tool.available)))
        throw new ForbiddenException({code:"agent_tool_not_available"});
      const {pinnedModel}=await this.selectedModel(tx,current.userId,request.modelId);
      return{current,input:this.protocol.schemas.pinned.parse({version:this.protocol.version,request,ceiling:current,model:pinnedModel,
        ...this.protocol.pinReads(readWorkspace)})};
    },{isolationLevel:"repeatable read",accessMode:"read write"});
    if(!await this.scopeAvailable(admission.current,admission.input,{definitions:[],observations:[]}))
      throw new ForbiddenException({code:"agent_native_binding_unavailable"});
    const outcome = await withTenant(this.database.db, context, async tx => {
      const current = await this.current(tx, context, Permission.WorkflowRun);
      this.native(()=>this.protocol.checkDomains(current, request));
      if(request.allowedCommands.some(key=>!this.commandPreparation.capabilities(current).some(item=>item.domain===key.domain&&item.kind===key.kind&&item.available)))throw new ForbiddenException({code:'agent_plan_command_unavailable'});
      if (authority(current) !== readWorkspace.contextAuthority) throw new ConflictException({ code: "authority_changed" });
      if (authority(current) !== authority(admission.current)) throw new ConflictException({ code: "authority_changed" });
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${context.userId}:agent-plan:${request.requestId}`},0))`);
      const [original] = await tx.select().from(runs).where(and(eq(runs.ownerId, context.userId), eq(runs.requestId, request.requestId)));
      if (original) {
        if (original.version!==this.protocol.version||original.requestChecksum !== checksum) throw new ConflictException({ code: "agent_request_conflict" });
        return { run: original, created: false };
      }
      if (this.protocol.readKeys(request).some(key => !readWorkspace.tools.some(tool => tool.key === key && tool.available)))
        throw new ForbiddenException({ code: "agent_tool_not_available" });
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`model-configuration:${context.tenantId}`},0))`);
      // Share the original organization-wide reservation lock with Assist.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:ai-assist-budget`},0))`);
      const {model,pinnedModel,selected}=await this.selectedModel(tx,current.userId,request.modelId);
      if(agentNativeChecksum(pinnedModel)!==agentNativeChecksum(admission.input.model))throw new ConflictException({code:"agent_model_changed"});
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
        if (agentNativeMicros(total?.value ?? "0") + agentNativeMicros(cap) > agentNativeMicros(policy.monthlyCapUsd))
          throw new ConflictException({ code: "agent_monthly_budget_limit" });
      }
      const [active] = await tx.execute<{ count: string }>(sql`select (
        (select count(*) from agent_plan_runs where tenant_id=${current.tenantId}::uuid and status in('queued','running','stopping') and expires_at>clock_timestamp())+
        (select count(*) from agent_loop_runs where tenant_id=${current.tenantId}::uuid and status in('queued','running','stopping') and expires_at>clock_timestamp())+
        (select count(*) from ai_assist_runs where tenant_id=${current.tenantId}::uuid and status in('queued','running') and expires_at>clock_timestamp())
      )::text as count`);
      if (Number(active?.count ?? 4) >= 4) throw new ConflictException({ code: "agent_active_limit" });
      const input = this.protocol.schemas.pinned.parse({ version: this.protocol.version, request, ceiling: current, model: pinnedModel,
        ...this.protocol.pinReads(readWorkspace) });
      const id = createEntityId(), ledgerId = createEntityId();
      await tx.insert(aiBudgetLedger).values({ id: ledgerId, tenantId: current.tenantId, requestId: id, taskType: "erp_agent_plan",
        modelKey: model.model, provider: selected.provider.provider, amountUsd: cap, state: "reserved" });
      const [run] = await tx.insert(runs).values({ id, version: this.protocol.version, tenantId: current.tenantId, ownerId: current.userId, requestId: request.requestId,
        requestChecksum: checksum, inputChecksum: agentNativeChecksum(input), encryptedInput: this.vault.encrypt(JSON.stringify(input)),
        originCeiling: current, executionContract: request.executionContract, readExecutionContract: input.readExecutionContract,
        modelSnapshot: pinnedModel, allowedReads: this.protocol.readKeys(request), allowedCommands: request.allowedCommands, limits: request.limits, budgetLedgerId: ledgerId, capUsd: cap,
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
      if (agentNativeChecksum(value) !== checksum) throw new Error("checksum");
      return value;
    }); } catch { throw new ConflictException({ code: "agent_checkpoint_invalid" }); }
  }

  private pinned(run: Run): NativePinned<F> {
    const input = this.open(run.encryptedInput, run.inputChecksum, this.protocol.schemas.pinned);
    if (run.version !== this.protocol.version || input.ceiling.tenantId !== run.tenantId || input.ceiling.userId !== run.ownerId
      || input.request.requestId !== run.requestId || input.request.modelId !== input.model.id
      || agentNativeChecksum(input.request) !== run.requestChecksum
      || agentNativeChecksum(input.ceiling) !== agentNativeChecksum(run.originCeiling)
      || agentNativeChecksum(input.model) !== agentNativeChecksum(run.modelSnapshot)
      || agentNativeChecksum(input.request.executionContract) !== agentNativeChecksum(run.executionContract)
      || agentNativeChecksum(input.readExecutionContract) !== agentNativeChecksum(run.readExecutionContract)
      || agentNativeChecksum(input.request.limits) !== agentNativeChecksum(run.limits)
      || agentNativeChecksum(this.protocol.readKeys(input.request)) !== agentNativeChecksum(run.allowedReads)
      || agentNativeChecksum(input.request.allowedCommands) !== agentNativeChecksum(run.allowedCommands)
      || agentNativeMicros(input.request.maxCostUsd.toFixed(6)) !== agentNativeMicros(run.capUsd))
      throw new ConflictException({ code: "agent_checkpoint_invalid" });
    return input;
  }

  private privateInput(run: Run, current: TenantContext, now: Date): NativePinned<F> | null {
    if (!run.encryptedInput || run.expiresAt <= now) return null;
    try { this.protocol.checkDomains(current, { allowedReads: run.allowedReads, allowedCommands: run.allowedCommands }, false); }
    catch { return null; }
    const input = this.pinned(run);
    try { this.protocol.checkDomains(current, input.request, false); return input; }
    catch { return null; }
  }

  private chain(records: Step[], inputChecksum: string): Evidence<F> {
    return this.native(()=>this.protocol.evidenceChain(records, inputChecksum, (encrypted, checksum, schema) => this.open(encrypted, checksum, schema)));
  }

  /** Only current owning-reader authorization is used here. Historical values
   * remain the original authenticated packet, even when today's values change. */
  private async scopeAvailable(context: TenantContext, input: NativePinned<F>, evidence: Evidence<F>): Promise<boolean> {
    return this.protocol.scopeAvailable(context, input, evidence, this.ports);
  }

  async get(context: TenantContext, id: string): Promise<NativeView<F>> {
    if (!Id.safeParse(id).success) throw new BadRequestException({ code: "agent_id_invalid" });
    const snapshot = await withTenant(this.database.db, context, async tx => {
      const [run] = await tx.select().from(runs).where(and(eq(runs.id, id), eq(runs.ownerId, context.userId), eq(runs.version, this.protocol.version)));
      if (!run) throw new NotFoundException();
      const session = await this.current(tx, context);
      const current = await this.current(tx, intersectPermissionContexts(session, run.originCeiling));
      const now = await this.now(tx), input = this.privateInput(run, current, now);
      const records = await tx.select().from(steps).where(eq(steps.runId, run.id)).orderBy(asc(steps.sequence)).limit(this.protocol.maxSteps + 1);
      if (records.length > this.protocol.maxSteps) throw new ConflictException({ code: "agent_step_chain_invalid" });
      let previous = run.inputChecksum;
      for (const [index, step] of records.entries()) {
        if (step.sequence !== index + 1 || step.previousChecksum !== previous
          || (index % 2 === 0 ? step.kind !== "model" : step.kind === "model"))
          throw new ConflictException({ code: "agent_step_chain_invalid" });
        if (step.phase === "completed") {
          if (!step.outputChecksum) throw new ConflictException({ code: "agent_step_chain_invalid" });
          previous = step.outputChecksum;
        } else if (index !== records.length - 1) throw new ConflictException({ code: "agent_step_chain_invalid" });
      }
      const evidence = input ? this.chain(records, run.inputChecksum) : { definitions: [], observations: [] };
      const result = input && run.encryptedResult ? this.checkedResult(run, input, records, evidence) : null;
      const [ledger] = await tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.id, run.budgetLedgerId));
      if (!ledger || ledger.requestId !== run.id || ledger.taskType !== "erp_agent_plan") throw new ConflictException({ code: "agent_budget_invalid" });
      const itemRecords = await tx.select().from(items).where(eq(items.runId, run.id)).orderBy(asc(items.position));
      const commandRecords: Array<NativeOriginalLink & { itemId: string }> = [];
      for (const item of itemRecords) commandRecords.push({ itemId: item.id, ...await this.commandPreparation.linked(tx, this.originalIdentity(run, item)) });
      if (result && (itemRecords.length !== result.proposals.length || itemRecords.some((item, index) => {
        const proposal = result.proposals[index]; return !proposal || item.id !== proposal.id || item.position !== proposal.position
          || item.proposalChecksum !== proposal.proposalChecksum ||
          (item.originalProtocol === AGENT_FULFILLMENT_COMMAND_VERSION ? proposal.draft.capability.domain !== "fulfillment" ||
            proposal.originalChecksum !== null || proposal.preparationRequestChecksum !== null ||
            item.originalOrderId !== (proposal.draft.fulfillment?.source.orderId ?? null) ||
            (item.originalChecksum === null) !== (item.completionChecksum === null) :
            item.originalChecksum !== proposal.originalChecksum || item.preparationRequestChecksum !== proposal.preparationRequestChecksum);
      }))) throw new ConflictException({ code: "agent_plan_item_original_mismatch" });
      if (result) for (const item of itemRecords) if (item.encryptedCompletion) {
        const proposal=result.proposals.find(value=>value.id===item.id);
        if(!proposal || item.originalProtocol!==AGENT_FULFILLMENT_COMMAND_VERSION)throw new ConflictException({code:"agent_plan_item_original_mismatch"});
        const completion=this.open(item.encryptedCompletion,item.completionChecksum,PrepareAgentFulfillmentCommandSchema);
        const binding=this.native(()=>this.commandPreparation.bind(proposal,completion));
        if(binding.originalChecksum!==item.originalChecksum || binding.preparationRequestChecksum!==item.preparationRequestChecksum ||
          binding.completionChecksum!==item.completionChecksum)throw new ConflictException({code:"agent_plan_item_original_mismatch"});
      }
      return { run, session, current, input, records, evidence, result, ledger, itemRecords, commandRecords };
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
    let privateAvailable = !!snapshot.input;
    if (snapshot.input) privateAvailable = await this.scopeAvailable(snapshot.current, snapshot.input, snapshot.evidence);
    const final = await withTenant(this.database.db, context, async tx => {
      const [run] = await tx.select().from(runs).where(and(eq(runs.id, id), eq(runs.ownerId, context.userId), eq(runs.version, this.protocol.version))).for("share");
      if (!run) throw new NotFoundException();
      const session = await this.current(tx, context), current = await this.current(tx, intersectPermissionContexts(session, run.originCeiling));
      if (run.revision < snapshot.run.revision || run.ownerId !== snapshot.run.ownerId || run.version !== snapshot.run.version
        || run.inputChecksum !== snapshot.run.inputChecksum)
        throw new ConflictException({ code: "agent_checkpoint_changed" });
      const now = await this.now(tx);
      const retained = run.expiresAt > now && !!run.encryptedInput;
      // Progress may advance while native-object authorization is in flight.
      // Keep the complete RR snapshot; an existing retained seal remains immutable.
      if (snapshot.run.resultChecksum !== null && retained && (run.resultChecksum !== snapshot.run.resultChecksum
        || run.encryptedResult !== snapshot.run.encryptedResult)) throw new ConflictException({ code: "agent_checkpoint_changed" });
      return { session, current, now, stopped: run.stopRequestedAt !== null, readable: privateAvailable && retained
        && authority(snapshot.current) === authority(current) && authority(snapshot.session) === authority(session) };
    });
    privateAvailable = final.readable;
    const { run, records, ledger, itemRecords, commandRecords } = snapshot;
    const input = privateAvailable ? snapshot.input : null, result = privateAvailable ? snapshot.result : null;
    const missingCost = records.some(step => step.kind === "model" && step.submissionState !== "not_submitted" && (step.submissionState !== "received" || step.costUsd === null));
    return this.protocol.schemas.view.parse({ version: this.protocol.version, id: run.id, requestId: run.requestId, requestChecksum: run.requestChecksum,
      contextAuthority: authority(final.session), revision: run.revision, status: run.status, goal: input?.request.goal ?? null,
      contextText: input?.request.contextText ?? null, modelLabel: run.modelSnapshot.label, bindings: input?.request.bindings ?? [],
      allowedCommands: privateAvailable ? run.allowedCommands : [], executionContract: run.executionContract, limits: run.limits,
      cost: { capUsd: run.capUsd, knownCostUsd: run.knownCostUsd, reservedUsd: ledger.state === "reserved" ? ledger.amountUsd : "0.000000",
        coverage: missingCost || run.unknownCost ? agentNativeMicros(run.knownCostUsd) > 0n ? "partial" : "unknown" : "known", modelTurns: run.modelTurns },
      toolCalls: run.toolCalls, observedRows: run.observedRows, stopRequestedAt: run.stopRequestedAt?.toISOString() ?? null, errorCode: run.errorCode,
      createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(), deadlineAt: run.deadlineAt.toISOString(), expiresAt: run.expiresAt.toISOString(),
      ...this.protocol.viewFields(input), privateAvailable, stepsComplete: true, steps: privateAvailable ? records.map(step => ({ id: step.id, sequence: step.sequence, kind: step.kind, phase: step.phase,
        label: step.label, tool: step.tool, inputChecksum: step.inputChecksum, outputChecksum: step.outputChecksum, submissionState: step.submissionState,
        providerRequestId: step.providerRequestId, inputTokens: step.inputTokens, outputTokens: step.outputTokens, costUsd: step.costUsd, errorCode: step.errorCode,
        createdAt: step.createdAt.toISOString(), completedAt: step.completedAt?.toISOString() ?? null })) : [],
      definitions: privateAvailable ? snapshot.evidence.definitions : [], observations: privateAvailable ? snapshot.evidence.observations : [], result,
      items: itemRecords.map(item => {
        const proposal = result?.proposals.find(value => value.id === item.id);
        const hasDraft = !!proposal?.draft.original || !!proposal?.draft.fulfillment;
        const nativeAvailable = final.current.permissions.includes(Permission.WorkflowRun) && hasDraft
          && this.commandPreparation.capabilities(final.current).some(cap => cap.domain === proposal!.draft.capability.domain && cap.kind === proposal!.draft.capability.kind && cap.available);
        const blockReason = !privateAvailable || !proposal ? "input_unavailable" : run.expiresAt <= final.now ? "expired"
          : run.stopRequestedAt || final.stopped ? "plan_stopped" : !hasDraft ? "missing_information" : !nativeAvailable ? "permission_denied"
            : !["completed", "partial"].includes(run.status) ? "planning_incomplete" : null;
        return { id: item.id, position: item.position, proposalChecksum: item.proposalChecksum, originalChecksum: item.originalChecksum,
          preparationRequestChecksum: item.preparationRequestChecksum, preparationRequestedAt: item.preparationRequestedAt?.toISOString() ?? null,
          agentCommandId: item.agentCommandId, ownerCommandId: commandRecords.find(command => command.itemId === item.id)?.ownerCommandId ?? null,
          ...(this.protocol.schemas.itemReceiptQuery ? { originalProtocol: item.originalProtocol,
            fulfillmentIntentId: item.fulfillmentIntentId, completionChecksum: item.completionChecksum,
            completionState: item.originalProtocol === AGENT_FULFILLMENT_COMMAND_VERSION ? item.completionChecksum ? "bound" : hasDraft ? "operator_required" : "unavailable" : "not_required" } : {}),
          preparationState: item.agentCommandId || item.fulfillmentIntentId ? "known" : item.preparationRequestedAt ? "requested_unknown" : item.originalChecksum || proposal?.draft.fulfillment ? "not_requested" : "blocked",
          canPrepare: blockReason === null && !item.agentCommandId && !item.fulfillmentIntentId && !(this.protocol.schemas.itemReceiptQuery && item.preparationRequestedAt), blockReason };
      }), businessExecution: "separate_original_confirmation",
      verification: result && ["completed", "partial"].includes(run.status) ? "native_scalar_values_and_current_source_basis_only" : isTerminal(run.status) ? "not_adopted" : "pending" });
  }

  private receiptView(run: Run, session: TenantContext, privateAvailable = false): NativeReceipt {
    return this.protocol.schemas.receipt.parse({ version: this.protocol.version, requestId: run.requestId, requestChecksum: run.requestChecksum,
      disposition: "known", runId: run.id, status: run.status, contextAuthority: authority(session), privateAvailable });
  }

  async receipt(context: TenantContext, raw: unknown): Promise<NativeReceipt> {
    const parsed = this.protocol.schemas.receiptQuery.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ code: "agent_receipt_invalid" });
    const metadata = await withTenant(this.database.db, context, async tx => {
      const session = await this.current(tx, context);
      const [run] = await tx.select().from(runs).where(and(eq(runs.ownerId, context.userId), eq(runs.requestId, parsed.data.requestId), eq(runs.version, this.protocol.version)));
      if (run && run.requestChecksum !== parsed.data.requestChecksum) throw new ConflictException({ code: "agent_request_conflict" });
      return { run, session };
    });
    if (!metadata.run) return this.protocol.schemas.receipt.parse({ version: this.protocol.version, ...parsed.data, disposition: "not_found", runId: null,
      status: null, contextAuthority: authority(metadata.session), privateAvailable: false });
    const view = await this.get(context, metadata.run.id);
    return this.protocol.schemas.receipt.parse({ version: this.protocol.version, requestId: view.requestId, requestChecksum: view.requestChecksum,
      disposition: "known", runId: view.id, status: view.status, contextAuthority: view.contextAuthority, privateAvailable: view.privateAvailable });
  }


  async stop(context: TenantContext, id: string, raw: unknown): Promise<NativeReceipt> {
    const parsed = this.protocol.schemas.stop.safeParse(raw);
    if (!parsed.success || !Id.safeParse(id).success) throw new BadRequestException({ code: "agent_stop_invalid" });
    return withTenant(this.database.db, context, async tx => {
      const [run] = await tx.select().from(runs).where(and(eq(runs.id, id), eq(runs.ownerId, context.userId),eq(runs.version,this.protocol.version))).for("update");
      if (!run) throw new NotFoundException();
      const session = await this.current(tx, context, Permission.WorkflowRun);
      const current = await this.current(tx, intersectPermissionContexts(session, run.originCeiling), Permission.WorkflowRun);
      if (run.requestId !== parsed.data.requestId) throw new ConflictException({ code: "agent_request_conflict" });
      if (run.stopRequestedAt || isTerminal(run.status)&&!['completed','partial'].includes(run.status)) return this.receiptView(run, session);
      const [stopped] = await tx.update(runs).set({ stopRequestedAt: sql`clock_timestamp()`, status: isTerminal(run.status)?run.status:"stopping", revision: sql`${runs.revision}+1`, updatedAt: sql`clock_timestamp()` })
        .where(eq(runs.id, id)).returning();
      await recordAuditInTransaction(tx, current, { action: "agent.plan.stop", resourceType: "agent_plan_run", resourceId: id, result: "success",
        metadata: { requestChecksum: run.requestChecksum } });
      return this.receiptView(stopped!, session);
    });
  }

  private async now(tx:TenantTransaction){
    const [row]=await tx.execute<{milliseconds:string}>(sql`select floor(extract(epoch from clock_timestamp())*1000)::text as milliseconds`);
    const value=Number(row?.milliseconds);if(!Number.isSafeInteger(value))throw new ConflictException({code:"agent_clock_unavailable"});return new Date(value);
  }

  private checkedResult(run:Run, input:NativePinned<F>, records:Step[], evidence:Evidence<F>){
    const result=this.open(run.encryptedResult,run.resultChecksum,this.protocol.schemas.result);
    const last=records.at(-1);
    if(!last||last.kind!=="model"||last.phase!=="completed")throw new ConflictException({code:"agent_plan_original_invalid"});
    const decision=this.open(last.encryptedOutput,last.outputChecksum,this.protocol.schemas.decision);
    if(decision.action!=="finish"||!decision.result)throw new ConflictException({code:"agent_plan_original_invalid"});
    const expected=this.native(()=>this.protocol.resolveResult(run.id,decision.result,input.request.allowedCommands,input.request.limits.maxProposals,evidence.definitions));
    this.native(()=>this.protocol.verifyClaims(expected,evidence.observations));
    if(agentNativeChecksum(expected)!==run.resultChecksum)throw new ConflictException({code:"agent_plan_original_invalid"});return result;
  }

  private native<T>(action:()=>T):T{
    try{return action();}catch(error){
      if(error instanceof AgentNativeError)throw new ConflictException({code:error.code});
      if(error instanceof z.ZodError||error instanceof SyntaxError)throw new ConflictException({code:"agent_native_evidence_invalid"});
      throw error;
    }
  }

  private async originalItem(context:TenantContext,runId:string,itemId:string,raw:unknown,write=false){
    const parsed=(write ? this.protocol.schemas.prepare : this.protocol.schemas.itemReceiptQuery ?? this.protocol.schemas.prepare).safeParse(raw);
    if(!parsed.success||!Id.safeParse(runId).success||!Id.safeParse(itemId).success)throw new BadRequestException({code:"agent_plan_item_invalid"});
    return withTenant(this.database.db,context,async tx=>{
      const [run]=await tx.select().from(runs).where(and(eq(runs.id,runId),eq(runs.ownerId,context.userId),eq(runs.version,this.protocol.version))).for("share");if(!run)throw new NotFoundException();
      const session=await this.current(tx,context),current=await this.current(tx,intersectPermissionContexts(session,run.originCeiling),write?Permission.WorkflowRun:Permission.WorkflowRead);
      const [item]=await tx.select().from(items).where(and(eq(items.runId,run.id),eq(items.id,itemId)));
      if(!item)throw new NotFoundException();
      if(run.requestId!==parsed.data.requestId||item.proposalChecksum!==parsed.data.proposalChecksum)throw new ConflictException({code:"agent_plan_item_original_mismatch"});
      return{run,item,current,session,now:await this.now(tx), selection:parsed.data};
    });
  }

  private async linkItem(context:TenantContext,runId:string,itemId:string,link:NativeOriginalLink){
    return withTenant(this.database.db,context,async tx=>{
      const [run]=await tx.select().from(runs).where(and(eq(runs.id,runId),eq(runs.ownerId,context.userId),eq(runs.version,this.protocol.version))).for("update");if(!run)throw new NotFoundException();
      const current=await this.current(tx,intersectPermissionContexts(context,run.originCeiling));
      const [item]=await tx.select().from(items).where(and(eq(items.runId,run.id),eq(items.id,itemId))).for("update");if(!item)throw new NotFoundException();
      await this.commandPreparation.linked(tx, { ...this.originalIdentity(run,item), agentCommandId:link.agentCommandId, fulfillmentIntentId:link.fulfillmentIntentId });
      if(item.agentCommandId || item.fulfillmentIntentId){if(item.agentCommandId!==link.agentCommandId || item.fulfillmentIntentId!==link.fulfillmentIntentId)throw new ConflictException({code:"agent_plan_item_original_mismatch"});return;}
      await tx.update(items).set({agentCommandId:link.agentCommandId,fulfillmentIntentId:link.fulfillmentIntentId}).where(eq(items.id,item.id));
      await recordAuditInTransaction(tx,current,{action:"agent.plan.item.link",resourceType:"agent_plan_item",resourceId:item.id,result:"success",metadata:{runId:run.id,proposalChecksum:item.proposalChecksum,
        ...(link.fulfillmentIntentId ? {fulfillmentIntentId:link.fulfillmentIntentId,originalProtocol:item.originalProtocol} : {agentCommandId:link.agentCommandId})}});
    });
  }

  private async savedEvidence(context:TenantContext,run:Run){
    const records=await withTenant(this.database.db,context,async tx=>{
      await this.current(tx,intersectPermissionContexts(context,run.originCeiling));
      const values=await tx.select().from(steps).where(eq(steps.runId,run.id)).orderBy(asc(steps.sequence)).limit(this.protocol.maxSteps + 1);
      if(values.length>this.protocol.maxSteps)throw new ConflictException({code:"agent_step_chain_invalid"});return values;
    },{isolationLevel:"repeatable read",accessMode:"read write"});
    return {records,evidence:this.chain(records,run.inputChecksum)};
  }

  /** Explicitly stages a frozen native proposal; it never confirms or executes. */
  async prepareItem(context:TenantContext,runId:string,itemId:string,raw:unknown){
    const initial=await this.originalItem(context,runId,itemId,raw,true);
    const receiptQuery={version:this.protocol.version,requestId:initial.run.requestId,proposalChecksum:initial.item.proposalChecksum};
    if(!this.protocol.schemas.itemReceiptQuery && initial.item.agentCommandId)
      return this.itemReceipt(context,runId,itemId,receiptQuery);
    if(initial.run.expiresAt<=initial.now||!initial.run.encryptedInput||!initial.run.encryptedResult)throw new ConflictException({code:"agent_plan_expired"});
    if(initial.run.stopRequestedAt||!["completed","partial"].includes(initial.run.status))throw new ConflictException({code:"agent_plan_not_preparable"});
    const input=this.pinned(initial.run);
    this.native(()=>this.protocol.checkDomains(initial.current,input.request));
    const saved=await this.savedEvidence(initial.current,initial.run);
    const result=this.checkedResult(initial.run,input,saved.records,saved.evidence),proposal=result.proposals.find(value=>value.id===initial.item.id);
    const fulfillment=initial.item.originalProtocol===AGENT_FULFILLMENT_COMMAND_VERSION;
    if(!proposal || !proposal.draft.original&&!proposal.draft.fulfillment || proposal.proposalChecksum!==initial.item.proposalChecksum ||
      (fulfillment ? proposal.draft.capability.domain!=="fulfillment" || proposal.originalChecksum!==null || proposal.preparationRequestChecksum!==null ||
        initial.item.originalOrderId!==proposal.draft.fulfillment?.source.orderId :
        proposal.originalChecksum!==initial.item.originalChecksum||proposal.preparationRequestChecksum!==initial.item.preparationRequestChecksum))
      throw new ConflictException({code:"agent_plan_original_invalid"});
    if(!this.commandPreparation.capabilities(initial.current).some(cap=>cap.domain===proposal.draft.capability.domain&&cap.kind===proposal.draft.capability.kind&&cap.available))throw new ForbiddenException({code:"agent_plan_permission_denied"});
    const completion="completion" in initial.selection?initial.selection.completion:undefined;
    this.native(()=>this.protocol.validateCompletion?.(proposal,completion,saved.evidence.observations));
    const binding=this.native(()=>this.commandPreparation.bind(proposal,completion)),checksum=binding.preparationRequestChecksum;
    if(fulfillment ? binding.protocol!==AGENT_FULFILLMENT_COMMAND_VERSION || binding.request.orderId!==initial.item.originalOrderId :
      binding.protocol!==AGENT_COMMAND_VERSION || checksum!==initial.item.preparationRequestChecksum)
      throw new ConflictException({code:"agent_plan_original_invalid"});
    if(initial.item.preparationRequestedAt){
      if(initial.item.originalChecksum!==binding.originalChecksum || initial.item.preparationRequestChecksum!==checksum ||
        initial.item.completionChecksum!==binding.completionChecksum)throw new ConflictException({code:"agent_plan_item_original_mismatch"});
      // V4 unknown dispatches recover by GET only, with the same frozen body and key.
      if(this.protocol.schemas.itemReceiptQuery || initial.item.agentCommandId || initial.item.fulfillmentIntentId)
        return this.itemReceipt(context,runId,itemId,receiptQuery);
    }
    let calls=0;
    try{
      await this.protocol.recheck(input,saved.evidence.definitions,saved.evidence.observations,this.ports,async()=>{
        if(++calls>this.protocol.maxHistoryCalls)throw new ConflictException({code:"agent_tool_limit"});
        const fresh=await this.originalItem(context,runId,itemId,raw,true);
        if(fresh.run.resultChecksum!==initial.run.resultChecksum||fresh.run.inputChecksum!==initial.run.inputChecksum
          ||authority(fresh.current)!==authority(initial.current))throw new ConflictException({code:"authority_changed"});
        if(fresh.run.expiresAt<=fresh.now||fresh.run.stopRequestedAt||!["completed","partial"].includes(fresh.run.status))
          throw new ConflictException({code:"agent_plan_not_preparable"});
        this.native(()=>this.protocol.checkDomains(fresh.current,input.request));return fresh.current;
      });
    }catch(error){if(error instanceof AgentNativeError)throw new ConflictException({code:error.code});throw error;}
    const staged=await withTenant(this.database.db,context,async tx=>{
      const [run]=await tx.select().from(runs).where(and(eq(runs.id,runId),eq(runs.ownerId,context.userId),eq(runs.version,this.protocol.version))).for("update");if(!run)throw new NotFoundException();
      const current=await this.current(tx,intersectPermissionContexts(context,run.originCeiling),Permission.WorkflowRun),now=await this.now(tx);
      this.native(()=>this.protocol.checkDomains(current,input.request));
      if(authority(current)!==authority(initial.current)||run.resultChecksum!==initial.run.resultChecksum||run.inputChecksum!==initial.run.inputChecksum
        ||run.revision!==initial.run.revision)throw new ConflictException({code:"authority_changed"});
      if(run.expiresAt<=now||run.stopRequestedAt||!["completed","partial"].includes(run.status))throw new ConflictException({code:"agent_plan_not_preparable"});
      const [item]=await tx.select().from(items).where(and(eq(items.runId,run.id),eq(items.id,itemId))).for("update");
      if(!item||item.proposalChecksum!==initial.item.proposalChecksum || item.originalProtocol!==initial.item.originalProtocol ||
        item.originalOrderId!==initial.item.originalOrderId || (item.preparationRequestChecksum!==null && item.preparationRequestChecksum!==checksum) ||
        (item.completionChecksum!==null && item.completionChecksum!==binding.completionChecksum))throw new ConflictException({code:"agent_plan_item_original_mismatch"});
      if(!item.preparationRequestedAt){
        if(binding.protocol===AGENT_FULFILLMENT_COMMAND_VERSION){
          if(item.originalChecksum!==null || item.preparationRequestChecksum!==null || item.encryptedCompletion!==null || item.completionChecksum!==null)
            throw new ConflictException({code:"agent_plan_item_original_mismatch"});
          if(agentNativeChecksum(binding.request)!==binding.completionChecksum)throw new ConflictException({code:"agent_plan_original_invalid"});
          await tx.update(items).set({originalChecksum:binding.originalChecksum,preparationRequestChecksum:checksum,
            encryptedCompletion:this.vault.encrypt(JSON.stringify(binding.request)),completionChecksum:binding.completionChecksum,
            completionBoundAt:sql`clock_timestamp()`,preparationRequestedAt:sql`clock_timestamp()`}).where(eq(items.id,item.id));
          await recordAuditInTransaction(tx,current,{action:"agent.plan.item.complete",resourceType:"agent_plan_item",resourceId:item.id,result:"success",
            metadata:{runId:run.id,proposalChecksum:item.proposalChecksum,completionChecksum:binding.completionChecksum,
              originalChecksum:binding.originalChecksum,preparationRequestChecksum:checksum,provenance:"operator_completed_not_model_evidence"}});
        }else await tx.update(items).set({preparationRequestedAt:sql`clock_timestamp()`}).where(eq(items.id,item.id));
        await recordAuditInTransaction(tx,current,{action:"agent.plan.item.prepare",resourceType:"agent_plan_item",resourceId:item.id,result:"success",metadata:{runId:run.id,proposalChecksum:item.proposalChecksum}});
      }
      return{current,alreadyLinked:!!item.agentCommandId||!!item.fulfillmentIntentId,
        alreadyRequested:!!item.preparationRequestedAt};
    });
    if(!staged.alreadyLinked && !(this.protocol.schemas.itemReceiptQuery && staged.alreadyRequested)){
      const actual=await this.commandPreparation.prepare(staged.current,binding);
      if(actual)await this.linkItem(staged.current,runId,itemId,actual);
    }
    return this.itemReceipt(context,runId,itemId,receiptQuery);
  }


  /** Receipt recovery never calls prepare or execute, including an unknown dispatch. */
  async itemReceipt(context:TenantContext,runId:string,itemId:string,raw:unknown){
    const initial=await this.originalItem(context,runId,itemId,raw);
    let link:NativeOriginalLink|null=null;
    let disposition:"not_requested"|"unknown"|"known"|"blocked"=initial.item.originalChecksum || initial.item.originalProtocol===AGENT_FULFILLMENT_COMMAND_VERSION&&initial.item.originalOrderId
      ?initial.item.preparationRequestedAt?"unknown":"not_requested":"blocked";
    if(initial.item.preparationRequestedAt&&initial.item.preparationRequestChecksum){
      link=await this.commandPreparation.receipt(initial.current,this.originalIdentity(initial.run,initial.item));
      if(link){
        if(initial.item.agentCommandId&&initial.item.agentCommandId!==link.agentCommandId ||
          initial.item.fulfillmentIntentId&&initial.item.fulfillmentIntentId!==link.fulfillmentIntentId)throw new ConflictException({code:"agent_plan_item_original_mismatch"});
        await this.linkItem(initial.current,runId,itemId,link);disposition="known";
      }
    }
    const fresh=await this.originalItem(context,runId,itemId,raw);
    if(authority(initial.session)!==authority(fresh.session))throw new ConflictException({code:"authority_changed"});
    if(initial.item.preparationRequestChecksum!==fresh.item.preparationRequestChecksum || initial.item.completionChecksum!==fresh.item.completionChecksum)
      throw new ConflictException({code:"agent_checkpoint_changed"});
    return this.protocol.schemas.itemReceipt.parse({version:this.protocol.version,runId,itemId,proposalChecksum:initial.item.proposalChecksum,preparationRequestChecksum:initial.item.preparationRequestChecksum,
      disposition,agentCommandId:disposition==="known"?link!.agentCommandId:null,ownerCommandId:disposition==="known"?link!.ownerCommandId:null,
      ...(this.protocol.schemas.itemReceiptQuery ? {originalProtocol:initial.item.originalProtocol,fulfillmentIntentId:disposition==="known"?link!.fulfillmentIntentId:null,completionChecksum:initial.item.completionChecksum} : {}),
      contextAuthority:authority(fresh.session)});
  }
}
