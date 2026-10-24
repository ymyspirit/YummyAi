import {
  assessPaidRequestRecovery,
  calculateCostUsd,
  decodeModelResponse,
  ModelResponseCheckpointSchema,
  type ModelResponseCheckpoint,
  type SecretVault,
} from "@yummyai/ai-core";
import { intersectPermissionContexts } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  AGENT_PLAN_VERSION,
  AgentPlanDecisionSchema,
  AgentPlanCommandKeySchema,
  type AgentPlanModelResultSchema,
  AgentPlanPinnedInputSchema,
  type AgentPlanPinnedInput,
  type AgentPlanResult,
} from "@yummyai/contracts/ai/agent-plan";
import { AgentLoopCollectionSchema, AgentLoopReadRequestSchema,
  type AgentLoopCollection, type AgentLoopReadRequest } from "@yummyai/contracts/ai/agent-loop";
import {
  AGENT_READ_VERSION,
  AgentReadPageViewSchema,
  AgentReadWorkspaceSchema,
  type AgentReadCall,
  type AgentReadPageView,
} from "@yummyai/contracts/ai/agent-read";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import {
  agentPlanRuns as runs,
  agentPlanSteps as steps,
  agentPlanItems as items,
  aiBudgetLedger,
  loadCurrentMembershipContext,
  recordAuditInTransaction,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  AGENT_PLAN_MODEL_TOOL,
  AgentPlanError,
  AgentPlanTurnInputSchema,
  agentPlanChecksum,
  agentPlanCheckDomains,
  agentPlanDecisionJsonSchema,
  agentPlanDecisionWireSchema,
  agentPlanHarness,
  agentPlanMicros,
  agentPlanMoney,
  agentPlanResponseCost,
  agentPlanSkill,
  agentPlanSlots,
  resolveAgentPlanResult,
  createAgentPlanProvider,
  readAgentPlanModel,
  type AgentPlanProviderFactory,
  type AgentPlanReadPort,
} from "./agent-plan-model.js";

type Run = typeof runs.$inferSelect;
type Step = typeof steps.$inferSelect;
type Identity = Pick<TenantContext, "tenantId" | "userId">;
type Locked = { run: Run; steps: Step[]; now: Date };
type Claim = { run: Run; token: string };
const Progress = z.object({ pages: z.array(AgentReadPageViewSchema).max(32) }).strict();
const terminal = (status: Run["status"]) => ["completed", "partial", "failed", "uncertain", "stopped", "expired"].includes(status);
const identityContext = (identity: Identity): TenantContext => ({ ...identity, permissions: [], dataScope: "tenant" });
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
type ModelResult = z.infer<typeof AgentPlanModelResultSchema>;
const promptBytes = (packet: unknown, instructions: string) => bytes({ instructions, input: packet, outputSchema: agentPlanDecisionJsonSchema });

async function clock(tx: TenantTransaction): Promise<Date> {
  const [row] = await tx.execute<{ milliseconds: string }>(sql`select floor(extract(epoch from clock_timestamp())*1000)::text as milliseconds`);
  const value = Number(row?.milliseconds);
  if (!Number.isSafeInteger(value)) throw new AgentPlanError("agent_clock_unavailable");
  return new Date(value);
}

/** One original run is the outbox and budget owner. Each model turn has its own
 * submission boundary; neither queue replay nor GET can create a second call. */
export class AgentPlanRuntime {
  constructor(private readonly options: {
    database: DatabaseConnection;
    contentVault: SecretVault;
    modelVault: SecretVault;
    reads: AgentPlanReadPort;
    providerFactory?: AgentPlanProviderFactory;
  }) {}

  async process(context: TenantContext, id: string, operation: "execute" | "expire" = "execute") {
    const identity = identityContext(context);
    const claim = await withTenant(this.options.database.db, identity, async tx => {
      const locked = await this.lock(tx, identity, id);
      if (!locked) return null;
      if (locked.run.leaseExpiresAt && locked.run.leaseExpiresAt > locked.now) return null;
      if (locked.run.expiresAt <= locked.now) {
        await this.expire(tx, locked);
        return null;
      }
      if (operation === "expire" || terminal(locked.run.status)) return null;
      const token = createEntityId();
      const [run] = await tx.update(runs).set({
        status: locked.run.stopRequestedAt ? "stopping" : "running", leaseToken: token,
        leaseExpiresAt: new Date(locked.now.getTime() + 300_000), updatedAt: locked.now,
        revision: sql`${runs.revision}+1`,
      }).where(eq(runs.id, id)).returning();
      return run ? { run, token } : null;
    });
    if (!claim) return { id, disposition: "skipped" as const };
    const controller = new AbortController();
    let heartbeat: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (heartbeat) return;
      heartbeat = withTenant(this.options.database.db, identity, async tx => {
        const locked = await this.held(tx, identity, claim);
        await tx.update(runs).set({ leaseExpiresAt: new Date(locked.now.getTime() + 300_000), updatedAt: locked.now })
          .where(eq(runs.id, id));
      }).catch(() => { controller.abort(); }).finally(() => { heartbeat = undefined; });
    }, 30_000);
    timer.unref();
    try {
      const input = this.pinned(claim.run);
      for (let iteration = 0; iteration < 33; iteration++) {
        controller.signal.throwIfAborted();
        const state = await this.state(identity, claim);
        this.control(state);
        const current = await this.authority(identity, claim);
        await this.readContract(current, input);
        const collections = this.collections(state.steps, state.run.inputChecksum);
        const pending = state.steps.find(step => step.phase !== "completed");
        if (pending) {
          if (pending.phase === "failed" || pending.phase === "uncertain") throw new AgentPlanError(pending.errorCode ?? "agent_step_failed");
          if (pending.kind === "model") await this.model(identity, claim, input, pending, controller.signal);
          else await this.read(identity, claim, input, pending);
          continue;
        }
        const last = state.steps.at(-1);
        if (last?.kind === "model") {
          const decision = this.open(last.encryptedOutput, last.outputChecksum, AgentPlanDecisionSchema);
          if (decision.action === "finish") {
            await this.finish(identity, claim, input, last, decision.result!, collections);
            return { id, disposition: "settled" as const };
          }
          if (state.run.modelTurns >= input.request.limits.maxModelTurns) throw new AgentPlanError("agent_turn_limit");
          const request = decision.read!;
          if (!input.request.allowedReads.includes(request.tool)) throw new AgentPlanError("agent_tool_not_allowed");
          if (state.steps.some(step => step.kind === "read" && step.inputChecksum === agentPlanChecksum(request)))
            throw new AgentPlanError("agent_duplicate_read");
          if (state.run.observedRows >= input.request.limits.maxRows) throw new AgentPlanError("agent_row_limit");
          if (state.run.toolCalls >= input.request.limits.maxToolCalls) throw new AgentPlanError("agent_tool_limit");
          await this.addStep(identity, claim, "read", request, decision.label, request.tool);
        } else {
          if (state.run.modelTurns >= input.request.limits.maxModelTurns) throw new AgentPlanError("agent_turn_limit");
          const packet = AgentPlanTurnInputSchema.parse({ version: AGENT_PLAN_VERSION, runId: id,
            turn: state.run.modelTurns + 1, goal: input.request.goal, contextText: input.request.contextText,
            allowedReads: input.request.allowedReads, allowedCommands: input.request.allowedCommands,
            slots: agentPlanSlots(id, input.request.limits.maxProposals), limits: input.request.limits, collections });
          if (promptBytes(packet, agentPlanHarness.instructions(input.request.executionContract, agentPlanSkill))
            > input.request.limits.maxPromptBytes) throw new AgentPlanError("agent_prompt_limit");
          agentPlanHarness.checkInput(input.request.executionContract, agentPlanSkill, AGENT_PLAN_MODEL_TOOL, packet);
          await this.addStep(identity, claim, "model", packet, `模型决策 ${packet.turn}`, null);
        }
      }
      throw new AgentPlanError("agent_step_limit");
    } catch (error) {
      const code = this.safeCode(error);
      try {
        await withTenant(this.options.database.db, identity, async tx => {
          const locked = await this.held(tx, identity, claim);
          const unfinished = locked.steps.find(step => step.phase !== "completed");
          const unknown = unfinished?.kind === "model" && unfinished.submissionState !== "not_submitted" && !unfinished.encryptedResponse;
          if (unfinished) await tx.update(steps).set({ phase: unknown ? "uncertain" : "failed", errorCode: unknown ? "agent_submission_unknown" : code,
            completedAt: locked.now }).where(eq(steps.id, unfinished.id));
          const status: Run["status"] = unknown ? "uncertain" : code === "agent_stop_requested" ? "stopped"
            : ["agent_turn_limit", "agent_step_limit", "agent_tool_limit", "agent_row_limit", "agent_prompt_limit", "agent_deadline_reached", "agent_duplicate_read", "agent_budget_limit"].includes(code)
              ? "partial" : code === "agent_expired" ? "expired" : "failed";
          await this.settle(tx, locked.run, status, unknown ? "agent_submission_unknown" : code);
        });
      } catch {
        // A lost lease or uncertain commit is reconciled from the original rows;
        // never use this error path to repeat an external request.
        return { id, disposition: "lease_lost" as const };
      }
      return { id, disposition: "settled" as const };
    } finally {
      clearInterval(timer);
      controller.abort();
      await heartbeat;
    }
  }

  private pinned(run: Run): AgentPlanPinnedInput {
    const value = this.open(run.encryptedInput, run.inputChecksum, AgentPlanPinnedInputSchema);
    if (run.version !== AGENT_PLAN_VERSION || value.ceiling.tenantId !== run.tenantId || value.ceiling.userId !== run.ownerId
      || value.request.requestId !== run.requestId || agentPlanChecksum(value.request) !== run.requestChecksum
      || agentPlanChecksum(value.ceiling) !== agentPlanChecksum(run.originCeiling)
      || agentPlanChecksum(value.model) !== agentPlanChecksum(run.modelSnapshot)
      || agentPlanChecksum(value.request.executionContract) !== agentPlanChecksum(run.executionContract)
      || agentPlanChecksum(value.readExecutionContract) !== agentPlanChecksum(run.readExecutionContract)
      || agentPlanChecksum(value.request.allowedReads) !== agentPlanChecksum(run.allowedReads)
      || agentPlanChecksum(value.request.allowedCommands) !== agentPlanChecksum(run.allowedCommands)
      || agentPlanChecksum(value.request.limits) !== agentPlanChecksum(run.limits)) throw new AgentPlanError("agent_input_invalid");
    agentPlanHarness.assertCurrent(value.request.executionContract, agentPlanSkill);
    return value;
  }

  private open<T>(encrypted: string | null, checksum: string | null, schema: z.ZodType<T>): T {
    if (!encrypted || !checksum) throw new AgentPlanError("agent_checkpoint_unavailable");
    try {
      return this.options.contentVault.withSecret(encrypted, raw => {
        if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new AgentPlanError("agent_checkpoint_invalid");
        const value = schema.parse(JSON.parse(raw));
        if (agentPlanChecksum(value) !== checksum) throw new AgentPlanError("agent_checkpoint_invalid");
        return value;
      });
    } catch { throw new AgentPlanError("agent_checkpoint_invalid"); }
  }

  private seal(value: unknown) {
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new AgentPlanError("agent_checkpoint_too_large");
    return { encrypted: this.options.contentVault.encrypt(raw), checksum: agentPlanChecksum(value) };
  }

  private async lock(tx: TenantTransaction, identity: Identity, id: string): Promise<Locked | null> {
    const [run] = await tx.select().from(runs).where(and(eq(runs.version, AGENT_PLAN_VERSION), eq(runs.id, id), eq(runs.ownerId, identity.userId))).for("update");
    if (!run) return null;
    const rows = await tx.select().from(steps).where(eq(steps.runId, id)).orderBy(asc(steps.sequence));
    return { run, steps: rows, now: await clock(tx) };
  }

  private async held(tx: TenantTransaction, identity: Identity, claim: Claim) {
    const locked = await this.lock(tx, identity, claim.run.id);
    if (!locked || locked.run.leaseToken !== claim.token || !locked.run.leaseExpiresAt || locked.run.leaseExpiresAt <= locked.now
      || terminal(locked.run.status)) throw new AgentPlanError("agent_lease_lost");
    return locked;
  }

  private state(identity: Identity, claim: Claim) {
    return withTenant(this.options.database.db, identityContext(identity), tx => this.held(tx, identity, claim));
  }

  private control(state: Locked) {
    if (state.run.stopRequestedAt || state.run.status === "stopping") throw new AgentPlanError("agent_stop_requested");
    if (state.run.expiresAt <= state.now) throw new AgentPlanError("agent_expired");
    if (state.run.deadlineAt <= state.now) throw new AgentPlanError("agent_deadline_reached");
  }

  private async current(tx: TenantTransaction, run: Run) {
    const fresh = await loadCurrentMembershipContext(tx, run.originCeiling, { lock: true });
    const current = intersectPermissionContexts(run.originCeiling, fresh);
    try {
      agentPlanCheckDomains(current, { ...run, allowedCommands:run.allowedCommands.map(value=>AgentPlanCommandKeySchema.parse(value)) });
    } catch { throw new AgentPlanError("agent_access_changed"); }
    return current;
  }

  private authority(identity: Identity, claim: Claim) {
    return withTenant(this.options.database.db, identityContext(identity), async tx => {
      const state = await this.held(tx, identity, claim);
      this.control(state);
      return this.current(tx, state.run);
    });
  }

  private async readContract(context: TenantContext, input: AgentPlanPinnedInput) {
    const view = AgentReadWorkspaceSchema.parse(await this.options.reads.workspace(context));
    if (agentPlanChecksum(view.executionContract) !== agentPlanChecksum(input.readExecutionContract)
      || input.request.allowedReads.some(tool => !view.tools.some(entry => entry.key === tool && entry.available)))
      throw new AgentPlanError("agent_read_contract_changed");
  }

  private collections(rows: Step[], inputChecksum: string): AgentLoopCollection[] {
    let previous: string = inputChecksum;
    let unfinished = false;
    const result: AgentLoopCollection[] = [];
    rows.forEach((step, index) => {
      if (step.sequence !== index + 1 || step.previousChecksum !== previous || unfinished
        || step.kind !== (index % 2 === 0 ? "model" : "read"))
        throw new AgentPlanError("agent_step_chain_invalid");
      if (step.phase !== "completed") { unfinished = true; return; }
      if (!step.outputChecksum) throw new AgentPlanError("agent_step_chain_invalid");
      previous = step.outputChecksum;
      if (step.kind !== "read") return;
      const collection = this.open(step.encryptedOutput, step.outputChecksum, AgentLoopCollectionSchema);
      const request = this.open(step.encryptedInput, step.inputChecksum, AgentLoopReadRequestSchema);
      const decision = this.open(rows[index - 1]!.encryptedOutput, rows[index - 1]!.outputChecksum, AgentPlanDecisionSchema);
      if (collection.stepId !== step.id || collection.tool !== request.tool || agentPlanChecksum(collection.query) !== agentPlanChecksum(request.query)
        || decision.action !== "read" || agentPlanChecksum(decision.read) !== step.inputChecksum
        || collection.queryChecksum !== agentPlanChecksum(request) || collection.rows.some(row => row.sourceChecksum !== agentPlanChecksum(row.data)))
        throw new AgentPlanError("agent_checkpoint_invalid");
      result.push(collection);
    });
    return result;
  }

  private async addStep(identity: Identity, claim: Claim, kind: Step["kind"], input: unknown, label: string, tool: Step["tool"]) {
    const sealed = this.seal(input);
    await withTenant(this.options.database.db, identityContext(identity), async tx => {
      const state = await this.held(tx, identity, claim);
      this.control(state);
      await this.current(tx, state.run);
      if (state.steps.some(step => step.phase !== "completed") || state.steps.length >= 15) throw new AgentPlanError("agent_step_limit");
      if (kind === "model" && state.run.modelTurns >= state.run.limits.maxModelTurns) throw new AgentPlanError("agent_turn_limit");
      await tx.insert(steps).values({ id: createEntityId(), tenantId: identity.tenantId, runId: state.run.id,
        sequence: state.steps.length + 1, kind, label, tool, inputChecksum: sealed.checksum,
        previousChecksum: state.steps.at(-1)?.outputChecksum ?? state.run.inputChecksum, encryptedInput: sealed.encrypted });
      await tx.update(runs).set({ ...(kind === "model" ? { modelTurns: state.run.modelTurns + 1 } : {}),
        revision: sql`${runs.revision}+1`, updatedAt: state.now }).where(eq(runs.id, state.run.id));
    });
  }

  private async model(identity: Identity, claim: Claim, input: AgentPlanPinnedInput, step: Step, signal: AbortSignal) {
    const packet = this.open(step.encryptedInput, step.inputChecksum, AgentPlanTurnInputSchema);
    const original = await this.state(identity, claim);
    const predecessors = original.steps.filter(value => value.sequence < step.sequence);
    const expected = AgentPlanTurnInputSchema.parse({ version: AGENT_PLAN_VERSION, runId: claim.run.id,
      turn: predecessors.filter(value => value.kind === "model").length + 1, goal: input.request.goal, contextText: input.request.contextText,
      allowedReads: input.request.allowedReads, allowedCommands: input.request.allowedCommands,
      slots: agentPlanSlots(claim.run.id, input.request.limits.maxProposals), limits: input.request.limits,
      collections: this.collections(predecessors, original.run.inputChecksum) });
    if (packet.runId !== claim.run.id || packet.goal !== input.request.goal || agentPlanChecksum(packet.allowedReads) !== agentPlanChecksum(input.request.allowedReads)
      || agentPlanChecksum(packet.limits) !== agentPlanChecksum(input.request.limits) || agentPlanChecksum(packet) !== agentPlanChecksum(expected))
      throw new AgentPlanError("agent_input_invalid");
    const recovery = assessPaidRequestRecovery({ submissionState: step.submissionState, hasResponseReceipt: step.receivedAt !== null,
      hasResponseCheckpoint: step.encryptedResponse !== null });
    if (recovery.action === "reconcile") throw new AgentPlanError("agent_submission_unknown");
    const admission = await this.authority(identity, claim);
    const expectedAuthority = erpSessionAuthority(admission);
    let response: ModelResponseCheckpoint;
    if (recovery.action === "reuse_response") {
      response = this.open(step.encryptedResponse, step.responseChecksum, ModelResponseCheckpointSchema);
      if (response.modelKey !== input.model.model || response.providerRequestId !== step.providerRequestId
        || response.inputTokens !== step.inputTokens || response.outputTokens !== step.outputTokens
        || agentPlanResponseCost(response) !== step.costUsd) throw new AgentPlanError("agent_response_invalid");
    } else {
      const selected = await withTenant(this.options.database.db, admission, tx => readAgentPlanModel(tx, input.model));
      const provider = createAgentPlanProvider(selected.provider, input.model, this.options.modelVault, this.options.providerFactory);
      const state = await this.state(identity, claim);
      const remaining = agentPlanMicros(state.run.capUsd) - agentPlanMicros(state.run.knownCostUsd);
      if (remaining <= 0n || state.run.unknownCost) throw new AgentPlanError("agent_budget_limit");
      const request = { modelKey: input.model.model, providerModel: input.model.model, taskType: "erp_agent_plan",
        systemInstructions: agentPlanHarness.instructions(input.request.executionContract, agentPlanSkill), untrustedSourceData: packet,
        outputSchema: agentPlanDecisionWireSchema, outputSchemaName: "erp_agent_plan_decision_v1",
        maxCostUsd: Math.min(Number(agentPlanMoney(remaining)), input.model.maxTaskCostUsd ?? 0), maxOutputTokens: input.request.limits.maxOutputTokens };
      const estimate = await provider.estimate(request);
      if (estimate.costUsd === null || !Number.isFinite(estimate.costUsd) || estimate.costUsd < 0 || estimate.costUsd > request.maxCostUsd)
        throw new AgentPlanError("agent_budget_limit");
      const envelopeBytes = promptBytes(packet, request.systemInstructions);
      if (envelopeBytes > input.request.limits.maxPromptBytes) throw new AgentPlanError("agent_prompt_limit");
      // UTF-8 bytes bound ordinary byte-tokenization conservatively, including
      // the actual wire schema omitted by the legacy provider's own estimate.
      const conservativeInputTokens = Math.max(estimate.estimatedInputTokens, envelopeBytes + 1024);
      if (input.model.inputUsdPerMillion === null || input.model.outputUsdPerMillion === null ||
        calculateCostUsd(conservativeInputTokens, request.maxOutputTokens, input.model.inputUsdPerMillion,
          input.model.outputUsdPerMillion) > request.maxCostUsd) throw new AgentPlanError("agent_budget_limit");
      await withTenant(this.options.database.db, identityContext(identity), async tx => {
        const state = await this.held(tx, identity, claim);
        this.control(state);
        const current = await this.current(tx, state.run);
        if (erpSessionAuthority(current) !== expectedAuthority) throw new AgentPlanError("agent_access_changed");
        await readAgentPlanModel(tx, input.model);
        const original = state.steps.find(row => row.id === step.id);
        if (!original || original.submissionState !== "not_submitted" || original.phase !== "preparing") throw new AgentPlanError("agent_step_changed");
        await tx.update(steps).set({ phase: "submitted", submissionState: "submitted", submittedAt: state.now }).where(eq(steps.id, step.id));
      });
      let received: ModelResponseCheckpoint | undefined;
      await provider.generate({ ...request, onResponseCheckpoint: async raw => {
        const value = ModelResponseCheckpointSchema.parse(raw);
        if (value.modelKey !== input.model.model || value.providerId !== provider.providerId) throw new AgentPlanError("agent_response_invalid");
        const sealed = this.seal(value), cost = agentPlanResponseCost(value);
        await withTenant(this.options.database.db, identityContext(identity), async tx => {
          // Store a submitted original response even after stop/revocation. This
          // captures incurred usage; permission checks govern adoption later.
          const state = await this.held(tx, identity, claim);
          const original = state.steps.find(row => row.id === step.id);
          if (!original || original.submissionState === "not_submitted") throw new AgentPlanError("agent_response_invalid");
          if (original.responseChecksum && original.responseChecksum !== sealed.checksum) throw new AgentPlanError("agent_response_invalid");
          if (!original.responseChecksum) await tx.update(steps).set({ phase: "response_ready", submissionState: "received",
            receivedAt: new Date(value.receivedAt), encryptedResponse: sealed.encrypted, responseChecksum: sealed.checksum,
            providerRequestId: value.providerRequestId, inputTokens: value.inputTokens, outputTokens: value.outputTokens, costUsd: cost,
          }).where(eq(steps.id, step.id));
          const totals = await this.costs(tx, state.run.id);
          await tx.update(runs).set({ knownCostUsd: totals.known, unknownCost: totals.unknown ? 1 : 0,
            revision: sql`${runs.revision}+1`, updatedAt: state.now }).where(eq(runs.id, state.run.id));
        });
        received = value;
      } }, AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(selected.timeoutMs, state.run.deadlineAt.getTime() - state.now.getTime())))]));
      if (!received) throw new AgentPlanError("agent_response_missing");
      response = received;
    }
    if (agentPlanResponseCost(response) === null) throw new AgentPlanError("agent_cost_unknown");
    const decision = AgentPlanDecisionSchema.parse(decodeModelResponse(response, AgentPlanDecisionSchema).value);
    agentPlanHarness.checkOutput(input.request.executionContract, agentPlanSkill, AGENT_PLAN_MODEL_TOOL, decision);
    const fresh = await this.authority(identity, claim);
    if (erpSessionAuthority(fresh) !== expectedAuthority) throw new AgentPlanError("agent_access_changed");
    await withTenant(this.options.database.db, fresh, async tx => {
      const state = await this.held(tx, identity, claim);
      this.control(state);
      await this.current(tx, state.run);
      await readAgentPlanModel(tx, input.model);
      if (agentPlanMicros(state.run.knownCostUsd) > agentPlanMicros(state.run.capUsd)) throw new AgentPlanError("agent_cost_exceeded");
      const sealed = this.seal(decision);
      await tx.update(steps).set({ phase: "completed", encryptedOutput: sealed.encrypted, outputChecksum: sealed.checksum, completedAt: state.now })
        .where(eq(steps.id, step.id));
    });
  }

  private call(input: AgentPlanPinnedInput, request: AgentLoopReadRequest, pageSize: number, cursor: string | null): AgentReadCall {
    const base = { version: AGENT_READ_VERSION, executionContract: input.readExecutionContract } as const;
    if (request.tool === "orders.exceptions.page") return { ...base, tool: request.tool,
      input: { pageSize, cursor, status: request.query.status, ...(request.query.orderId ? { orderId: request.query.orderId } : {}) } };
    return { ...base, tool: request.tool, input: { pageSize, cursor,
      ...(request.query.stockItemId ? { stockItemId: request.query.stockItemId } : {}),
      ...(request.query.locationId ? { locationId: request.query.locationId } : {}) } };
  }

  private async takeCall(identity: Identity, claim: Claim) {
    return withTenant(this.options.database.db, identityContext(identity), async tx => {
      const state = await this.held(tx, identity, claim);
      this.control(state);
      const current = await this.current(tx, state.run);
      if (state.run.toolCalls >= state.run.limits.maxToolCalls) throw new AgentPlanError("agent_tool_limit");
      await tx.update(runs).set({ toolCalls: state.run.toolCalls + 1, revision: sql`${runs.revision}+1`, updatedAt: state.now }).where(eq(runs.id, state.run.id));
      return { current, state };
    });
  }

  private validatePages(request: AgentLoopReadRequest, pages: AgentReadPageView[]) {
    let count = 0;
    const ids = new Set<string>();
    pages.forEach((page, index) => {
      const first = pages[0]!;
      if (page.tool !== request.tool || page.collectionFingerprint !== first.collectionFingerprint || page.total !== first.total
        || page.contextAuthority !== first.contextAuthority || index > 0 && (pages[index - 1]!.nextCursor !== page.query.cursor || pages[index - 1]!.complete))
        throw new AgentPlanError("agent_read_checkpoint_invalid");
      for (const row of page.items) {
        if (ids.has(row.id)) throw new AgentPlanError("agent_read_checkpoint_invalid");
        ids.add(row.id);
      }
      count += page.items.length;
      if (page.readCount !== count || count > page.total || page.items.length > page.query.pageSize
        || !page.complete && page.items.length === 0 || page.complete !== (count === page.total) || page.complete !== (page.nextCursor === null))
        throw new AgentPlanError("agent_read_checkpoint_invalid");
      const { pageSize, cursor } = page.query;
      const expected = request.tool === "orders.exceptions.page"
        ? { pageSize, cursor, status: request.query.status, ...(request.query.orderId ? { orderId: request.query.orderId } : {}) }
        : { pageSize, cursor, ...(request.query.stockItemId ? { stockItemId: request.query.stockItemId } : {}),
          ...(request.query.locationId ? { locationId: request.query.locationId } : {}) };
      if (agentPlanChecksum(expected) !== agentPlanChecksum(page.query) || index === 0 && cursor !== null)
        throw new AgentPlanError("agent_read_checkpoint_invalid");
    });
    return count;
  }

  private async read(identity: Identity, claim: Claim, input: AgentPlanPinnedInput, step: Step) {
    const request = this.open(step.encryptedInput, step.inputChecksum, AgentLoopReadRequestSchema);
    if (step.tool !== request.tool || !input.request.allowedReads.includes(request.tool)) throw new AgentPlanError("agent_tool_not_allowed");
    const pages = step.encryptedOutput ? this.open(step.encryptedOutput, step.outputChecksum, Progress).pages : [];
    this.validatePages(request, pages);
    let reason: "row_limit" | "tool_limit" | null = null;
    while (!pages.at(-1)?.complete) {
      const state = await this.state(identity, claim);
      this.control(state);
      const available = input.request.limits.maxRows - state.run.observedRows;
      if (available <= 0) { reason = "row_limit"; break; }
      if (state.run.toolCalls >= input.request.limits.maxToolCalls) { reason = "tool_limit"; break; }
      const { current } = await this.takeCall(identity, claim);
      const call = this.call(input, request, Math.min(100, available), pages.at(-1)?.nextCursor ?? null);
      const page = AgentReadPageViewSchema.parse(await this.options.reads.call(current, call));
      if (page.tool !== request.tool || agentPlanChecksum(page.query) !== agentPlanChecksum(call.input)) throw new AgentPlanError("agent_read_checkpoint_invalid");
      const fresh = await this.authority(identity, claim);
      if (erpSessionAuthority(fresh) !== erpSessionAuthority(current)) throw new AgentPlanError("agent_access_changed");
      const next = [...pages, page];
      this.validatePages(request, next);
      const sealed = this.seal({ pages: next });
      await withTenant(this.options.database.db, fresh, async tx => {
        const state = await this.held(tx, identity, claim);
        this.control(state);
        await this.current(tx, state.run);
        if (state.run.observedRows + page.items.length > input.request.limits.maxRows) throw new AgentPlanError("agent_row_limit");
        await tx.update(steps).set({ encryptedOutput: sealed.encrypted, outputChecksum: sealed.checksum }).where(eq(steps.id, step.id));
        await tx.update(runs).set({ observedRows: state.run.observedRows + page.items.length, revision: sql`${runs.revision}+1`, updatedAt: state.now })
          .where(eq(runs.id, state.run.id));
      });
      pages.push(page);
    }
    const first = pages[0], last = pages.at(-1);
    if (!first || !last) throw new AgentPlanError(reason === "row_limit" ? "agent_row_limit" : "agent_tool_limit");
    const collection = AgentLoopCollectionSchema.parse({ stepId: step.id, tool: request.tool, query: request.query,
      queryChecksum: agentPlanChecksum(request), collectionFingerprint: first.collectionFingerprint, checkedAt: last.checkedAt,
      total: first.total, readCount: last.readCount, complete: last.complete, limitReason: last.complete ? null : reason,
      rows: pages.flatMap(page => page.items.map(data => ({ sourceId: data.id, sourceChecksum: agentPlanChecksum(data), data }))) });
    const sealed = this.seal(collection);
    await withTenant(this.options.database.db, identityContext(identity), async tx => {
      const state = await this.held(tx, identity, claim);
      this.control(state);
      await this.current(tx, state.run);
      await tx.update(steps).set({ phase: "completed", encryptedOutput: sealed.encrypted, outputChecksum: sealed.checksum, completedAt: state.now })
        .where(eq(steps.id, step.id));
    });
  }

  private verifyClaims(result: Pick<AgentPlanResult, "claims">, collections: AgentLoopCollection[]) {
    for (const claim of result.claims) {
      const collection = collections.find(value => value.stepId === claim.stepId);
      if (!collection) throw new AgentPlanError("agent_claim_invalid");
      if (claim.sourceId === "$collection") {
        if (!collection.complete || claim.field !== "total" || claim.sourceChecksum !== collection.collectionFingerprint || claim.value !== collection.total)
          throw new AgentPlanError("agent_claim_invalid");
      } else {
        const row = collection.rows.find(value => value.sourceId === claim.sourceId);
        if (!row || claim.field === "total" || row.sourceChecksum !== claim.sourceChecksum || !Object.hasOwn(row.data, claim.field)
          || (row.data as unknown as Record<string, unknown>)[claim.field] !== claim.value) throw new AgentPlanError("agent_claim_invalid");
      }
    }
  }

  private async finish(identity: Identity, claim: Claim, input: AgentPlanPinnedInput, modelStep: Step,
    raw: ModelResult, collections: AgentLoopCollection[]) {
    const result = resolveAgentPlanResult(claim.run.id, raw, input.request.allowedCommands, input.request.limits.maxProposals);
    this.verifyClaims(result, collections);
    for (const proposal of result.proposals) this.verifyClaims(proposal.draft, collections);
    for (const collection of collections) {
      const { current } = await this.takeCall(identity, claim);
      const request = AgentLoopReadRequestSchema.parse({ tool: collection.tool, query: collection.query });
      const call = this.call(input, request, 1, null);
      const page = AgentReadPageViewSchema.parse(await this.options.reads.call(current, call));
      if (page.tool !== call.tool || agentPlanChecksum(page.query) !== agentPlanChecksum(call.input)
        || page.collectionFingerprint !== collection.collectionFingerprint || page.total !== collection.total)
        throw new AgentPlanError("agent_collection_changed");
      const fresh = await this.authority(identity, claim);
      if (erpSessionAuthority(fresh) !== erpSessionAuthority(current)) throw new AgentPlanError("agent_access_changed");
    }
    const sealed = this.seal(result);
    await withTenant(this.options.database.db, identityContext(identity), async tx => {
      const state = await this.held(tx, identity, claim);
      this.control(state);
      const current = await this.current(tx, state.run);
      await readAgentPlanModel(tx, input.model);
      const original = state.steps.at(-1);
      if (!original || original.id !== modelStep.id || original.kind !== "model" || original.phase !== "completed" ||
        original.outputChecksum !== modelStep.outputChecksum || original.submissionState !== "received")
        throw new AgentPlanError("agent_checkpoint_invalid");
      const decision = this.open(original.encryptedOutput, original.outputChecksum, AgentPlanDecisionSchema);
      if (decision.action !== "finish" || agentPlanChecksum(decision.result) !== agentPlanChecksum(raw))
        throw new AgentPlanError("agent_checkpoint_invalid");
      if (result.proposals.length) await tx.insert(items).values(result.proposals.map(proposal => ({
        id: proposal.id, tenantId: state.run.tenantId, runId: state.run.id, modelStepId: original.id,
        position: proposal.position, proposalChecksum: proposal.proposalChecksum, originalChecksum: proposal.originalChecksum,
        preparationRequestChecksum: proposal.preparationRequestChecksum,
      })));
      for (const proposal of result.proposals) await recordAuditInTransaction(tx, current, {
        action: "agent.plan.item.create", resourceType: "agent_plan_item", resourceId: proposal.id,
        result: "success", metadata: { runId: state.run.id, proposalChecksum: proposal.proposalChecksum },
      });
      await tx.update(runs).set({ encryptedResult: sealed.encrypted, resultChecksum: sealed.checksum }).where(eq(runs.id, state.run.id));
      await this.settle(tx, state.run, collections.some(value => !value.complete) ? "partial" : "completed", null);
    });
  }

  private async costs(tx: TenantTransaction, id: string) {
    const [value] = await tx.execute<{ known: string; submitted: string; unknown: boolean }>(sql`
      select coalesce(sum(cost_usd) filter(where submission_state='received'),0)::text as known,
        count(*) filter(where submission_state<>'not_submitted')::text as submitted,
        coalesce(bool_or(submission_state<>'not_submitted' and (submission_state<>'received' or cost_usd is null)),false) as unknown
      from ${steps} where tenant_id=current_setting('app.tenant_id')::uuid and run_id=${id}::uuid and kind='model'
    `);
    if (!value) throw new AgentPlanError("agent_cost_invalid");
    return { known: agentPlanMoney(agentPlanMicros(value.known)), submitted: Number(value.submitted), unknown: value.unknown };
  }

  private async settle(tx: TenantTransaction, run: Run, status: Run["status"], errorCode: string | null) {
    const totals = await this.costs(tx, run.id), now = await clock(tx);
    await tx.update(runs).set({ status: totals.unknown && status !== "expired" ? "uncertain" : status,
      errorCode: totals.unknown ? (errorCode ?? "agent_cost_unknown") : errorCode,
      knownCostUsd: totals.known, unknownCost: totals.unknown ? 1 : 0, leaseToken: null, leaseExpiresAt: null,
      revision: sql`${runs.revision}+1`, completedAt: now, updatedAt: now }).where(eq(runs.id, run.id));
    const [ledger] = await tx.select().from(aiBudgetLedger).where(and(eq(aiBudgetLedger.id, run.budgetLedgerId),
      eq(aiBudgetLedger.requestId, run.id), eq(aiBudgetLedger.taskType, "erp_agent_plan"))).for("update");
    if (!ledger || agentPlanMicros(ledger.amountUsd) !== agentPlanMicros(run.capUsd) || ledger.state !== "reserved")
      throw new AgentPlanError("agent_budget_invalid");
    if (!totals.unknown) await tx.update(aiBudgetLedger).set(totals.submitted === 0 ? { state: "released" } : { state: "committed", amountUsd: totals.known })
      .where(eq(aiBudgetLedger.id, ledger.id));
  }

  private async expire(tx: TenantTransaction, state: Locked) {
    if (!terminal(state.run.status)) await this.settle(tx, state.run, "expired", "agent_expired");
    await tx.update(steps).set({ encryptedInput: null, encryptedOutput: null, encryptedResponse: null })
      .where(eq(steps.runId, state.run.id));
    await tx.update(runs).set({ encryptedInput: null, encryptedResult: null, resultChecksum: null, updatedAt: state.now })
      .where(eq(runs.id, state.run.id));
  }

  private safeCode(error: unknown) {
    if (error instanceof AgentPlanError) return error.code;
    if (error instanceof z.ZodError) return "agent_model_output_invalid";
    const mapped = (code: unknown) => {
      if (code === "FORBIDDEN" || code === "authority_changed" || code === "agent_read_scope_not_verified") return "agent_access_changed";
      if (code === "agent_collection_changed" || code === "agent_read_timeout") return code;
      if (code === "agent_cursor_invalid") return "agent_read_checkpoint_invalid";
      if (typeof code === "string" && ["harness_contract_missing", "harness_contract_invalid", "harness_contract_changed", "harness_tool_unavailable"].includes(code))
        return "agent_read_contract_changed";
      return null;
    };
    if (error && typeof error === "object" && "code" in error) {
      const code = mapped(error.code);
      if (code) return code;
    }
    if (error && typeof error === "object" && "getResponse" in error && typeof error.getResponse === "function") {
      const response: unknown = error.getResponse();
      if (response && typeof response === "object" && "code" in response) {
        const code = mapped(response.code);
        if (code) return code;
      }
    }
    return "agent_execution_failed";
  }
}
