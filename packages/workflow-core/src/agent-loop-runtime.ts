import {
  assessPaidRequestRecovery,
  decodeModelResponse,
  ModelResponseCheckpointSchema,
  type ModelResponseCheckpoint,
  type SecretVault,
} from "@yummyai/ai-core";
import { authorize, intersectPermissionContexts, Permission, permissionScope } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  AGENT_LOOP_VERSION,
  AgentLoopCollectionSchema,
  AgentLoopDecisionSchema,
  AgentLoopPinnedInputSchema,
  AgentLoopReadRequestSchema,
  AgentLoopResultSchema,
  type AgentLoopCollection,
  type AgentLoopPinnedInput,
  type AgentLoopReadRequest,
  type AgentLoopResult,
} from "@yummyai/contracts/ai/agent-loop";
import {
  AGENT_READ_VERSION,
  AgentReadPageViewSchema,
  AgentReadWorkspaceSchema,
  type AgentReadCall,
  type AgentReadPageView,
} from "@yummyai/contracts/ai/agent-read";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import {
  agentLoopRuns as runs,
  agentLoopSteps as steps,
  aiBudgetLedger,
  loadCurrentMembershipContext,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  AGENT_LOOP_MODEL_TOOL,
  AgentLoopError,
  AgentLoopTurnInputSchema,
  agentLoopChecksum,
  agentLoopHarness,
  agentLoopMicros,
  agentLoopMoney,
  agentLoopResponseCost,
  agentLoopSkill,
  createAgentLoopProvider,
  readAgentLoopModel,
  type AgentLoopProviderFactory,
  type AgentLoopReadPort,
} from "./agent-loop-model.js";

type Run = typeof runs.$inferSelect;
type Step = typeof steps.$inferSelect;
type Identity = Pick<TenantContext, "tenantId" | "userId">;
type Locked = { run: Run; steps: Step[]; now: Date };
type Claim = { run: Run; token: string };
const Progress = z.object({ pages: z.array(AgentReadPageViewSchema).max(32) }).strict();
const terminal = (status: Run["status"]) => ["completed", "partial", "failed", "uncertain", "stopped", "expired"].includes(status);
const identityContext = (identity: Identity): TenantContext => ({ ...identity, permissions: [], dataScope: "tenant" });
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const requiredBits = (run: Run) => [Permission.WorkflowRead, Permission.WorkflowRun, ...run.allowedTools.map(tool =>
  tool === "orders.exceptions.page" ? Permission.OrderRead : Permission.InventoryRead)];

async function clock(tx: TenantTransaction): Promise<Date> {
  const [row] = await tx.execute<{ milliseconds: string }>(sql`select floor(extract(epoch from clock_timestamp())*1000)::text as milliseconds`);
  const value = Number(row?.milliseconds);
  if (!Number.isSafeInteger(value)) throw new AgentLoopError("agent_clock_unavailable");
  return new Date(value);
}

/** One original run is the outbox and budget owner. Each model turn has its own
 * submission boundary; neither queue replay nor GET can create a second call. */
export class AgentLoopRuntime {
  constructor(private readonly options: {
    database: DatabaseConnection;
    contentVault: SecretVault;
    modelVault: SecretVault;
    reads: AgentLoopReadPort;
    providerFactory?: AgentLoopProviderFactory;
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
          if (pending.phase === "failed" || pending.phase === "uncertain") throw new AgentLoopError(pending.errorCode ?? "agent_step_failed");
          if (pending.kind === "model") await this.model(identity, claim, input, pending, controller.signal);
          else await this.read(identity, claim, input, pending);
          continue;
        }
        const last = state.steps.at(-1);
        if (last?.kind === "model") {
          const decision = this.open(last.encryptedOutput, last.outputChecksum, AgentLoopDecisionSchema);
          if (decision.action === "finish") {
            await this.finish(identity, claim, input, decision.result!, collections);
            return { id, disposition: "settled" as const };
          }
          if (state.run.modelTurns >= input.request.limits.maxModelTurns) throw new AgentLoopError("agent_turn_limit");
          const request = decision.read!;
          if (!input.request.allowedTools.includes(request.tool)) throw new AgentLoopError("agent_tool_not_allowed");
          if (state.steps.some(step => step.kind === "read" && step.inputChecksum === agentLoopChecksum(request)))
            throw new AgentLoopError("agent_duplicate_read");
          if (state.run.observedRows >= input.request.limits.maxRows) throw new AgentLoopError("agent_row_limit");
          if (state.run.toolCalls >= input.request.limits.maxToolCalls) throw new AgentLoopError("agent_tool_limit");
          await this.addStep(identity, claim, "read", request, decision.label, request.tool);
        } else {
          if (state.run.modelTurns >= input.request.limits.maxModelTurns) throw new AgentLoopError("agent_turn_limit");
          const packet = AgentLoopTurnInputSchema.parse({ version: AGENT_LOOP_VERSION, runId: id,
            turn: state.run.modelTurns + 1, goal: input.request.goal, allowedTools: input.request.allowedTools,
            limits: input.request.limits, collections });
          if (bytes(packet) + Buffer.byteLength(agentLoopHarness.instructions(input.request.executionContract, agentLoopSkill))
            > input.request.limits.maxPromptBytes) throw new AgentLoopError("agent_prompt_limit");
          agentLoopHarness.checkInput(input.request.executionContract, agentLoopSkill, AGENT_LOOP_MODEL_TOOL, packet);
          await this.addStep(identity, claim, "model", packet, `模型决策 ${packet.turn}`, null);
        }
      }
      throw new AgentLoopError("agent_step_limit");
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

  private pinned(run: Run): AgentLoopPinnedInput {
    const value = this.open(run.encryptedInput, run.inputChecksum, AgentLoopPinnedInputSchema);
    if (run.version !== AGENT_LOOP_VERSION || value.ceiling.tenantId !== run.tenantId || value.ceiling.userId !== run.ownerId
      || value.request.requestId !== run.requestId || agentLoopChecksum(value.request) !== run.requestChecksum
      || agentLoopChecksum(value.ceiling) !== agentLoopChecksum(run.originCeiling)
      || agentLoopChecksum(value.model) !== agentLoopChecksum(run.modelSnapshot)
      || agentLoopChecksum(value.request.executionContract) !== agentLoopChecksum(run.executionContract)
      || agentLoopChecksum(value.readExecutionContract) !== agentLoopChecksum(run.readExecutionContract)
      || agentLoopChecksum(value.request.allowedTools) !== agentLoopChecksum(run.allowedTools)
      || agentLoopChecksum(value.request.limits) !== agentLoopChecksum(run.limits)) throw new AgentLoopError("agent_input_invalid");
    agentLoopHarness.assertCurrent(value.request.executionContract, agentLoopSkill);
    return value;
  }

  private open<T>(encrypted: string | null, checksum: string | null, schema: z.ZodType<T>): T {
    if (!encrypted || !checksum) throw new AgentLoopError("agent_checkpoint_unavailable");
    try {
      return this.options.contentVault.withSecret(encrypted, raw => {
        if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new AgentLoopError("agent_checkpoint_invalid");
        const value = schema.parse(JSON.parse(raw));
        if (agentLoopChecksum(value) !== checksum) throw new AgentLoopError("agent_checkpoint_invalid");
        return value;
      });
    } catch { throw new AgentLoopError("agent_checkpoint_invalid"); }
  }

  private seal(value: unknown) {
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new AgentLoopError("agent_checkpoint_too_large");
    return { encrypted: this.options.contentVault.encrypt(raw), checksum: agentLoopChecksum(value) };
  }

  private async lock(tx: TenantTransaction, identity: Identity, id: string): Promise<Locked | null> {
    const [run] = await tx.select().from(runs).where(and(eq(runs.id, id), eq(runs.ownerId, identity.userId))).for("update");
    if (!run) return null;
    const rows = await tx.select().from(steps).where(eq(steps.runId, id)).orderBy(asc(steps.sequence));
    return { run, steps: rows, now: await clock(tx) };
  }

  private async held(tx: TenantTransaction, identity: Identity, claim: Claim) {
    const locked = await this.lock(tx, identity, claim.run.id);
    if (!locked || locked.run.leaseToken !== claim.token || !locked.run.leaseExpiresAt || locked.run.leaseExpiresAt <= locked.now
      || terminal(locked.run.status)) throw new AgentLoopError("agent_lease_lost");
    return locked;
  }

  private state(identity: Identity, claim: Claim) {
    return withTenant(this.options.database.db, identityContext(identity), tx => this.held(tx, identity, claim));
  }

  private control(state: Locked) {
    if (state.run.stopRequestedAt || state.run.status === "stopping") throw new AgentLoopError("agent_stop_requested");
    if (state.run.expiresAt <= state.now) throw new AgentLoopError("agent_expired");
    if (state.run.deadlineAt <= state.now) throw new AgentLoopError("agent_deadline_reached");
  }

  private async current(tx: TenantTransaction, run: Run) {
    const fresh = await loadCurrentMembershipContext(tx, run.originCeiling, { lock: true });
    const current = intersectPermissionContexts(run.originCeiling, fresh);
    try {
      for (const permission of requiredBits(run)) {
        authorize(current, permission, { ownerId: run.ownerId });
        if ((permission === Permission.OrderRead || permission === Permission.InventoryRead)
          && permissionScope(current, permission) !== "tenant") throw new AgentLoopError("agent_access_changed");
      }
    } catch { throw new AgentLoopError("agent_access_changed"); }
    return current;
  }

  private authority(identity: Identity, claim: Claim) {
    return withTenant(this.options.database.db, identityContext(identity), async tx => {
      const state = await this.held(tx, identity, claim);
      this.control(state);
      return this.current(tx, state.run);
    });
  }

  private async readContract(context: TenantContext, input: AgentLoopPinnedInput) {
    const view = AgentReadWorkspaceSchema.parse(await this.options.reads.workspace(context));
    if (agentLoopChecksum(view.executionContract) !== agentLoopChecksum(input.readExecutionContract)
      || input.request.allowedTools.some(tool => !view.tools.some(entry => entry.key === tool && entry.available)))
      throw new AgentLoopError("agent_read_contract_changed");
  }

  private collections(rows: Step[], inputChecksum: string): AgentLoopCollection[] {
    let previous: string = inputChecksum;
    let unfinished = false;
    const result: AgentLoopCollection[] = [];
    rows.forEach((step, index) => {
      if (step.sequence !== index + 1 || step.previousChecksum !== previous || unfinished
        || step.kind !== (index % 2 === 0 ? "model" : "read"))
        throw new AgentLoopError("agent_step_chain_invalid");
      if (step.phase !== "completed") { unfinished = true; return; }
      if (!step.outputChecksum) throw new AgentLoopError("agent_step_chain_invalid");
      previous = step.outputChecksum;
      if (step.kind !== "read") return;
      const collection = this.open(step.encryptedOutput, step.outputChecksum, AgentLoopCollectionSchema);
      const request = this.open(step.encryptedInput, step.inputChecksum, AgentLoopReadRequestSchema);
      const decision = this.open(rows[index - 1]!.encryptedOutput, rows[index - 1]!.outputChecksum, AgentLoopDecisionSchema);
      if (collection.stepId !== step.id || collection.tool !== request.tool || agentLoopChecksum(collection.query) !== agentLoopChecksum(request.query)
        || decision.action !== "read" || agentLoopChecksum(decision.read) !== step.inputChecksum
        || collection.queryChecksum !== agentLoopChecksum(request) || collection.rows.some(row => row.sourceChecksum !== agentLoopChecksum(row.data)))
        throw new AgentLoopError("agent_checkpoint_invalid");
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
      if (state.steps.some(step => step.phase !== "completed") || state.steps.length >= 15) throw new AgentLoopError("agent_step_limit");
      if (kind === "model" && state.run.modelTurns >= state.run.limits.maxModelTurns) throw new AgentLoopError("agent_turn_limit");
      await tx.insert(steps).values({ id: createEntityId(), tenantId: identity.tenantId, runId: state.run.id,
        sequence: state.steps.length + 1, kind, label, tool, inputChecksum: sealed.checksum,
        previousChecksum: state.steps.at(-1)?.outputChecksum ?? state.run.inputChecksum, encryptedInput: sealed.encrypted });
      await tx.update(runs).set({ ...(kind === "model" ? { modelTurns: state.run.modelTurns + 1 } : {}),
        revision: sql`${runs.revision}+1`, updatedAt: state.now }).where(eq(runs.id, state.run.id));
    });
  }

  private async model(identity: Identity, claim: Claim, input: AgentLoopPinnedInput, step: Step, signal: AbortSignal) {
    const packet = this.open(step.encryptedInput, step.inputChecksum, AgentLoopTurnInputSchema);
    const original = await this.state(identity, claim);
    const predecessors = original.steps.filter(value => value.sequence < step.sequence);
    const expected = AgentLoopTurnInputSchema.parse({ version: AGENT_LOOP_VERSION, runId: claim.run.id,
      turn: predecessors.filter(value => value.kind === "model").length + 1, goal: input.request.goal,
      allowedTools: input.request.allowedTools, limits: input.request.limits,
      collections: this.collections(predecessors, original.run.inputChecksum) });
    if (packet.runId !== claim.run.id || packet.goal !== input.request.goal || agentLoopChecksum(packet.allowedTools) !== agentLoopChecksum(input.request.allowedTools)
      || agentLoopChecksum(packet.limits) !== agentLoopChecksum(input.request.limits) || agentLoopChecksum(packet) !== agentLoopChecksum(expected))
      throw new AgentLoopError("agent_input_invalid");
    const recovery = assessPaidRequestRecovery({ submissionState: step.submissionState, hasResponseReceipt: step.receivedAt !== null,
      hasResponseCheckpoint: step.encryptedResponse !== null });
    if (recovery.action === "reconcile") throw new AgentLoopError("agent_submission_unknown");
    const admission = await this.authority(identity, claim);
    const expectedAuthority = erpSessionAuthority(admission);
    let response: ModelResponseCheckpoint;
    if (recovery.action === "reuse_response") {
      response = this.open(step.encryptedResponse, step.responseChecksum, ModelResponseCheckpointSchema);
      if (response.modelKey !== input.model.model || response.providerRequestId !== step.providerRequestId
        || response.inputTokens !== step.inputTokens || response.outputTokens !== step.outputTokens
        || agentLoopResponseCost(response) !== step.costUsd) throw new AgentLoopError("agent_response_invalid");
    } else {
      const selected = await withTenant(this.options.database.db, admission, tx => readAgentLoopModel(tx, input.model));
      const provider = createAgentLoopProvider(selected.provider, input.model, this.options.modelVault, this.options.providerFactory);
      const state = await this.state(identity, claim);
      const remaining = agentLoopMicros(state.run.capUsd) - agentLoopMicros(state.run.knownCostUsd);
      if (remaining <= 0n || state.run.unknownCost) throw new AgentLoopError("agent_budget_limit");
      const request = { modelKey: input.model.model, providerModel: input.model.model, taskType: "erp_agent",
        systemInstructions: agentLoopHarness.instructions(input.request.executionContract, agentLoopSkill), untrustedSourceData: packet,
        outputSchema: AgentLoopDecisionSchema, outputSchemaName: "erp_agent_loop_decision_v1",
        maxCostUsd: Math.min(Number(agentLoopMoney(remaining)), input.model.maxTaskCostUsd ?? 0), maxOutputTokens: input.request.limits.maxOutputTokens };
      const estimate = await provider.estimate(request);
      if (estimate.costUsd === null || !Number.isFinite(estimate.costUsd) || estimate.costUsd < 0 || estimate.costUsd > request.maxCostUsd)
        throw new AgentLoopError("agent_budget_limit");
      await withTenant(this.options.database.db, identityContext(identity), async tx => {
        const state = await this.held(tx, identity, claim);
        this.control(state);
        const current = await this.current(tx, state.run);
        if (erpSessionAuthority(current) !== expectedAuthority) throw new AgentLoopError("agent_access_changed");
        await readAgentLoopModel(tx, input.model);
        const original = state.steps.find(row => row.id === step.id);
        if (!original || original.submissionState !== "not_submitted" || original.phase !== "preparing") throw new AgentLoopError("agent_step_changed");
        await tx.update(steps).set({ phase: "submitted", submissionState: "submitted", submittedAt: state.now }).where(eq(steps.id, step.id));
      });
      let received: ModelResponseCheckpoint | undefined;
      await provider.generate({ ...request, onResponseCheckpoint: async raw => {
        const value = ModelResponseCheckpointSchema.parse(raw);
        if (value.modelKey !== input.model.model || value.providerId !== provider.providerId) throw new AgentLoopError("agent_response_invalid");
        const sealed = this.seal(value), cost = agentLoopResponseCost(value);
        await withTenant(this.options.database.db, identityContext(identity), async tx => {
          // Store a submitted original response even after stop/revocation. This
          // captures incurred usage; permission checks govern adoption later.
          const state = await this.held(tx, identity, claim);
          const original = state.steps.find(row => row.id === step.id);
          if (!original || original.submissionState === "not_submitted") throw new AgentLoopError("agent_response_invalid");
          if (original.responseChecksum && original.responseChecksum !== sealed.checksum) throw new AgentLoopError("agent_response_invalid");
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
      if (!received) throw new AgentLoopError("agent_response_missing");
      response = received;
    }
    if (agentLoopResponseCost(response) === null) throw new AgentLoopError("agent_cost_unknown");
    const decision = AgentLoopDecisionSchema.parse(decodeModelResponse(response, AgentLoopDecisionSchema).value);
    agentLoopHarness.checkOutput(input.request.executionContract, agentLoopSkill, AGENT_LOOP_MODEL_TOOL, decision);
    const fresh = await this.authority(identity, claim);
    if (erpSessionAuthority(fresh) !== expectedAuthority) throw new AgentLoopError("agent_access_changed");
    await withTenant(this.options.database.db, fresh, async tx => {
      const state = await this.held(tx, identity, claim);
      this.control(state);
      await this.current(tx, state.run);
      await readAgentLoopModel(tx, input.model);
      if (agentLoopMicros(state.run.knownCostUsd) > agentLoopMicros(state.run.capUsd)) throw new AgentLoopError("agent_cost_exceeded");
      const sealed = this.seal(decision);
      await tx.update(steps).set({ phase: "completed", encryptedOutput: sealed.encrypted, outputChecksum: sealed.checksum, completedAt: state.now })
        .where(eq(steps.id, step.id));
    });
  }

  private call(input: AgentLoopPinnedInput, request: AgentLoopReadRequest, pageSize: number, cursor: string | null): AgentReadCall {
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
      if (state.run.toolCalls >= state.run.limits.maxToolCalls) throw new AgentLoopError("agent_tool_limit");
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
        throw new AgentLoopError("agent_read_checkpoint_invalid");
      for (const row of page.items) {
        if (ids.has(row.id)) throw new AgentLoopError("agent_read_checkpoint_invalid");
        ids.add(row.id);
      }
      count += page.items.length;
      if (page.readCount !== count || count > page.total || page.items.length > page.query.pageSize
        || !page.complete && page.items.length === 0 || page.complete !== (count === page.total) || page.complete !== (page.nextCursor === null))
        throw new AgentLoopError("agent_read_checkpoint_invalid");
      const { pageSize, cursor } = page.query;
      const expected = request.tool === "orders.exceptions.page"
        ? { pageSize, cursor, status: request.query.status, ...(request.query.orderId ? { orderId: request.query.orderId } : {}) }
        : { pageSize, cursor, ...(request.query.stockItemId ? { stockItemId: request.query.stockItemId } : {}),
          ...(request.query.locationId ? { locationId: request.query.locationId } : {}) };
      if (agentLoopChecksum(expected) !== agentLoopChecksum(page.query) || index === 0 && cursor !== null)
        throw new AgentLoopError("agent_read_checkpoint_invalid");
    });
    return count;
  }

  private async read(identity: Identity, claim: Claim, input: AgentLoopPinnedInput, step: Step) {
    const request = this.open(step.encryptedInput, step.inputChecksum, AgentLoopReadRequestSchema);
    if (step.tool !== request.tool || !input.request.allowedTools.includes(request.tool)) throw new AgentLoopError("agent_tool_not_allowed");
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
      if (page.tool !== request.tool || agentLoopChecksum(page.query) !== agentLoopChecksum(call.input)) throw new AgentLoopError("agent_read_checkpoint_invalid");
      const fresh = await this.authority(identity, claim);
      if (erpSessionAuthority(fresh) !== erpSessionAuthority(current)) throw new AgentLoopError("agent_access_changed");
      const next = [...pages, page];
      this.validatePages(request, next);
      const sealed = this.seal({ pages: next });
      await withTenant(this.options.database.db, fresh, async tx => {
        const state = await this.held(tx, identity, claim);
        this.control(state);
        await this.current(tx, state.run);
        if (state.run.observedRows + page.items.length > input.request.limits.maxRows) throw new AgentLoopError("agent_row_limit");
        await tx.update(steps).set({ encryptedOutput: sealed.encrypted, outputChecksum: sealed.checksum }).where(eq(steps.id, step.id));
        await tx.update(runs).set({ observedRows: state.run.observedRows + page.items.length, revision: sql`${runs.revision}+1`, updatedAt: state.now })
          .where(eq(runs.id, state.run.id));
      });
      pages.push(page);
    }
    const first = pages[0], last = pages.at(-1);
    if (!first || !last) throw new AgentLoopError(reason === "row_limit" ? "agent_row_limit" : "agent_tool_limit");
    const collection = AgentLoopCollectionSchema.parse({ stepId: step.id, tool: request.tool, query: request.query,
      queryChecksum: agentLoopChecksum(request), collectionFingerprint: first.collectionFingerprint, checkedAt: last.checkedAt,
      total: first.total, readCount: last.readCount, complete: last.complete, limitReason: last.complete ? null : reason,
      rows: pages.flatMap(page => page.items.map(data => ({ sourceId: data.id, sourceChecksum: agentLoopChecksum(data), data }))) });
    const sealed = this.seal(collection);
    await withTenant(this.options.database.db, identityContext(identity), async tx => {
      const state = await this.held(tx, identity, claim);
      this.control(state);
      await this.current(tx, state.run);
      await tx.update(steps).set({ phase: "completed", encryptedOutput: sealed.encrypted, outputChecksum: sealed.checksum, completedAt: state.now })
        .where(eq(steps.id, step.id));
    });
  }

  private verifyClaims(result: AgentLoopResult, collections: AgentLoopCollection[]) {
    for (const claim of result.claims) {
      const collection = collections.find(value => value.stepId === claim.stepId);
      if (!collection) throw new AgentLoopError("agent_claim_invalid");
      if (claim.sourceId === "$collection") {
        if (!collection.complete || claim.field !== "total" || claim.sourceChecksum !== collection.collectionFingerprint || claim.value !== collection.total)
          throw new AgentLoopError("agent_claim_invalid");
      } else {
        const row = collection.rows.find(value => value.sourceId === claim.sourceId);
        if (!row || claim.field === "total" || row.sourceChecksum !== claim.sourceChecksum || !Object.hasOwn(row.data, claim.field)
          || (row.data as unknown as Record<string, unknown>)[claim.field] !== claim.value) throw new AgentLoopError("agent_claim_invalid");
      }
    }
  }

  private async finish(identity: Identity, claim: Claim, input: AgentLoopPinnedInput, raw: AgentLoopResult, collections: AgentLoopCollection[]) {
    const result = AgentLoopResultSchema.parse(raw);
    this.verifyClaims(result, collections);
    for (const collection of collections) {
      const { current } = await this.takeCall(identity, claim);
      const request = AgentLoopReadRequestSchema.parse({ tool: collection.tool, query: collection.query });
      const call = this.call(input, request, 1, null);
      const page = AgentReadPageViewSchema.parse(await this.options.reads.call(current, call));
      if (page.tool !== call.tool || agentLoopChecksum(page.query) !== agentLoopChecksum(call.input)
        || page.collectionFingerprint !== collection.collectionFingerprint || page.total !== collection.total)
        throw new AgentLoopError("agent_collection_changed");
      const fresh = await this.authority(identity, claim);
      if (erpSessionAuthority(fresh) !== erpSessionAuthority(current)) throw new AgentLoopError("agent_access_changed");
    }
    const sealed = this.seal(result);
    await withTenant(this.options.database.db, identityContext(identity), async tx => {
      const state = await this.held(tx, identity, claim);
      this.control(state);
      await this.current(tx, state.run);
      await readAgentLoopModel(tx, input.model);
      await tx.update(runs).set({ encryptedResult: sealed.encrypted, resultChecksum: sealed.checksum }).where(eq(runs.id, state.run.id));
      await this.settle(tx, state.run, collections.some(value => !value.complete) ? "partial" : "completed", null);
    });
  }

  private async costs(tx: TenantTransaction, id: string) {
    const [value] = await tx.execute<{ known: string; submitted: string; unknown: boolean }>(sql`
      select coalesce(sum(cost_usd) filter(where submission_state='received'),0)::text as known,
        count(*) filter(where submission_state<>'not_submitted')::text as submitted,
        coalesce(bool_or(submission_state<>'not_submitted' and (submission_state<>'received' or cost_usd is null)),false) as unknown
      from agent_loop_steps where tenant_id=current_setting('app.tenant_id')::uuid and run_id=${id}::uuid and kind='model'
    `);
    if (!value) throw new AgentLoopError("agent_cost_invalid");
    return { known: agentLoopMoney(agentLoopMicros(value.known)), submitted: Number(value.submitted), unknown: value.unknown };
  }

  private async settle(tx: TenantTransaction, run: Run, status: Run["status"], errorCode: string | null) {
    const totals = await this.costs(tx, run.id), now = await clock(tx);
    await tx.update(runs).set({ status: totals.unknown && status !== "expired" ? "uncertain" : status,
      errorCode: totals.unknown ? (errorCode ?? "agent_cost_unknown") : errorCode,
      knownCostUsd: totals.known, unknownCost: totals.unknown ? 1 : 0, leaseToken: null, leaseExpiresAt: null,
      revision: sql`${runs.revision}+1`, completedAt: now, updatedAt: now }).where(eq(runs.id, run.id));
    const [ledger] = await tx.select().from(aiBudgetLedger).where(and(eq(aiBudgetLedger.id, run.budgetLedgerId),
      eq(aiBudgetLedger.requestId, run.id), eq(aiBudgetLedger.taskType, "erp_agent"))).for("update");
    if (!ledger || agentLoopMicros(ledger.amountUsd) !== agentLoopMicros(run.capUsd) || ledger.state !== "reserved")
      throw new AgentLoopError("agent_budget_invalid");
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
    if (error instanceof AgentLoopError) return error.code;
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
