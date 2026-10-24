import { assessPaidRequestRecovery, calculateCostUsd, decodeModelResponse, ModelResponseCheckpointSchema, type ModelResponseCheckpoint, type SecretVault } from "@yummyai/ai-core";
import { intersectPermissionContexts } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { agentPlanRuns as runs, agentPlanSteps as steps, agentPlanItems as items, aiBudgetLedger, loadCurrentMembershipContext, recordAuditInTransaction, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { AgentNativeError, agentNativeChecksum, agentNativeMicros, agentNativeMoney, agentNativeResponseCost, createAgentNativeProvider, readAgentNativeModel, type AgentNativeProviderFactory } from "./agent-native-model.js";
import type { NativePinned, NativeModelResult, NativePorts, NativeProtocol, NativeFamily, NativeV2Family, NativeDefinitionEvidence } from "./agent-native-protocol.js";
export type NativeRuntimeOptions = NativePorts & { database: DatabaseConnection; contentVault: SecretVault; modelVault: SecretVault; providerFactory?: AgentNativeProviderFactory };
type Run = typeof runs.$inferSelect;
type Step = typeof steps.$inferSelect;
type Identity = Pick<TenantContext, "tenantId" | "userId">;
type Locked = { run: Run; steps: Step[]; now: Date };
type Claim = { run: Run; token: string };
const terminal = (status: Run["status"]) => ["completed", "partial", "failed", "uncertain", "stopped", "expired"].includes(status);
const identityContext = (identity: Identity): TenantContext => ({ ...identity, permissions: [], dataScope: "tenant" });
async function clock(tx: TenantTransaction): Promise<Date> {
 const [row] = await tx.execute<{ milliseconds: string }>(sql`select floor(extract(epoch from clock_timestamp())*1000)::text as milliseconds`);
 const value=Number(row?.milliseconds); if(!Number.isSafeInteger(value))throw new AgentNativeError("agent_clock_unavailable"); return new Date(value);
}
/** Shared paid-request and lease state machine. Protocol adapters own exact wire schemas. */
export class NativeRuntimeEngine<F extends NativeFamily = NativeV2Family> {
  constructor(private readonly options: NativeRuntimeOptions, private readonly protocol: NativeProtocol<F>) {}

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
      for (let iteration = 0; iteration < this.protocol.maxSteps * 2 + 1; iteration++) {
        controller.signal.throwIfAborted();
        const state = await this.state(identity, claim);
        this.control(state);
        await this.authority(identity, claim);
        this.readContract(input);
        const evidence = this.evidence(state.steps, state.run.inputChecksum);
        const pending = state.steps.find(step => step.phase !== "completed");
        if (pending) {
          if (pending.phase === "failed" || pending.phase === "uncertain") throw new AgentNativeError(pending.errorCode ?? "agent_step_failed");
          if (pending.kind === "model") await this.model(identity, claim, input, pending, controller.signal);
          else if (pending.kind === "definition") await this.definition(identity, claim, input, pending);
          else await this.read(identity, claim, input, pending);
          continue;
        }
        const last = state.steps.at(-1);
        if (last?.kind === "model") {
          const decision = this.open(last.encryptedOutput, last.outputChecksum, this.protocol.schemas.decision);
          if (decision.action === "finish") {
            await this.finish(identity, claim, input, last, decision.result!, evidence.definitions, evidence.observations);
            return { id, disposition: "settled" as const };
          }
          if (state.run.modelTurns >= input.request.limits.maxModelTurns) throw new AgentNativeError("agent_turn_limit");
          if (state.run.toolCalls >= input.request.limits.maxToolCalls) throw new AgentNativeError("agent_tool_limit");
          if (decision.action === "definition") {
            const selection = decision.definition!;
            this.selection(input, selection);
            if (state.steps.some(step => step.kind === "definition" && step.inputChecksum === agentNativeChecksum(selection)))
              throw new AgentNativeError("agent_duplicate_definition");
            await this.addStep(identity, claim, "definition", selection, decision.label, selection.kind === "read" ? selection.tool : null);
          } else {
            const request = decision.read!;
            const binding = input.request.bindings[request.bindingIndex];
            const definition = evidence.definitions.find(value => { const selection = this.protocol.selectionOf(value.definition); return selection.kind === "read" && selection.tool === binding?.tool; });
            if (!binding || !definition) throw new AgentNativeError("agent_tool_definition_required");
            this.protocol.readCall(input, request, definition.definition.definitionChecksum);
            if (state.steps.some(step => step.kind === "read" && step.inputChecksum === agentNativeChecksum(request)))
              throw new AgentNativeError("agent_duplicate_read");
            if (state.run.observedRows >= input.request.limits.maxRows) throw new AgentNativeError("agent_row_limit");
            await this.addStep(identity, claim, "read", request, decision.label, binding.tool);
          }
        } else {
          if (state.run.modelTurns >= input.request.limits.maxModelTurns) throw new AgentNativeError("agent_turn_limit");
          const packet = this.protocol.schemas.turn.parse({ version: this.protocol.version, runId: id,
            turn: state.run.modelTurns + 1, goal: input.request.goal, contextText: input.request.contextText,
            bindings: input.request.bindings, allowedCommands: input.request.allowedCommands,
            slots: this.protocol.slots(id, input.request.limits.maxProposals), limits: input.request.limits, ...evidence, ...this.protocol.turnFields?.(input) });
          if (this.promptBytes(packet, this.protocol.harness.instructions(input.request.executionContract, this.protocol.skill))
            > input.request.limits.maxPromptBytes) throw new AgentNativeError("agent_prompt_limit");
          this.protocol.harness.checkInput(input.request.executionContract, this.protocol.skill, this.protocol.modelTool, packet);
          await this.addStep(identity, claim, "model", packet, `模型决策 ${packet.turn}`, null);
        }
      }
      throw new AgentNativeError("agent_step_limit");
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
            : ["agent_turn_limit", "agent_step_limit", "agent_tool_limit", "agent_row_limit", "agent_prompt_limit", "agent_deadline_reached", "agent_duplicate_read", "agent_duplicate_definition", "agent_budget_limit"].includes(code)
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

  private promptBytes(packet: unknown, instructions: string) { return Buffer.byteLength(JSON.stringify({ instructions, input: packet, outputSchema: this.protocol.decisionJsonSchema }), "utf8"); }

  private pinned(run: Run): NativePinned<F> {
    const value = this.open(run.encryptedInput, run.inputChecksum, this.protocol.schemas.pinned);
    if (run.version !== this.protocol.version || value.ceiling.tenantId !== run.tenantId || value.ceiling.userId !== run.ownerId
      || value.request.requestId !== run.requestId || value.request.modelId !== value.model.id
      || agentNativeMicros(value.request.maxCostUsd.toFixed(6)) !== agentNativeMicros(run.capUsd)
      || agentNativeChecksum(value.request) !== run.requestChecksum
      || agentNativeChecksum(value.ceiling) !== agentNativeChecksum(run.originCeiling)
      || agentNativeChecksum(value.model) !== agentNativeChecksum(run.modelSnapshot)
      || agentNativeChecksum(value.request.executionContract) !== agentNativeChecksum(run.executionContract)
      || agentNativeChecksum(value.readExecutionContract) !== agentNativeChecksum(run.readExecutionContract)
      || agentNativeChecksum(this.protocol.readKeys(value.request)) !== agentNativeChecksum(run.allowedReads)
      || agentNativeChecksum(value.request.allowedCommands) !== agentNativeChecksum(run.allowedCommands)
      || agentNativeChecksum(value.request.limits) !== agentNativeChecksum(run.limits)) throw new AgentNativeError("agent_input_invalid");
    this.protocol.harness.assertCurrent(value.request.executionContract, this.protocol.skill);
    return value;
  }

  private open<T>(encrypted: string | null, checksum: string | null, schema: z.ZodType<T>): T {
    if (!encrypted || !checksum) throw new AgentNativeError("agent_checkpoint_unavailable");
    try {
      return this.options.contentVault.withSecret(encrypted, raw => {
        if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new AgentNativeError("agent_checkpoint_invalid");
        const value = schema.parse(JSON.parse(raw));
        if (agentNativeChecksum(value) !== checksum) throw new AgentNativeError("agent_checkpoint_invalid");
        return value;
      });
    } catch { throw new AgentNativeError("agent_checkpoint_invalid"); }
  }

  private seal(value: unknown) {
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new AgentNativeError("agent_checkpoint_too_large");
    return { encrypted: this.options.contentVault.encrypt(raw), checksum: agentNativeChecksum(value) };
  }

  private async lock(tx: TenantTransaction, identity: Identity, id: string): Promise<Locked | null> {
    const [run] = await tx.select().from(runs).where(and(eq(runs.id, id), eq(runs.ownerId, identity.userId), eq(runs.version, this.protocol.version))).for("update");
    if (!run) return null;
    const rows = await tx.select().from(steps).where(eq(steps.runId, id)).orderBy(asc(steps.sequence));
    return { run, steps: rows, now: await clock(tx) };
  }

  private async held(tx: TenantTransaction, identity: Identity, claim: Claim) {
    const locked = await this.lock(tx, identity, claim.run.id);
    if (!locked || locked.run.leaseToken !== claim.token || !locked.run.leaseExpiresAt || locked.run.leaseExpiresAt <= locked.now
      || terminal(locked.run.status)) throw new AgentNativeError("agent_lease_lost");
    return locked;
  }

  private state(identity: Identity, claim: Claim) {
    return withTenant(this.options.database.db, identityContext(identity), tx => this.held(tx, identity, claim));
  }

  private control(state: Locked) {
    if (state.run.stopRequestedAt || state.run.status === "stopping") throw new AgentNativeError("agent_stop_requested");
    if (state.run.expiresAt <= state.now) throw new AgentNativeError("agent_expired");
    if (state.run.deadlineAt <= state.now) throw new AgentNativeError("agent_deadline_reached");
  }

  private async current(tx: TenantTransaction, run: Run) {
    const fresh = await loadCurrentMembershipContext(tx, run.originCeiling, { lock: true });
    const current = intersectPermissionContexts(run.originCeiling, fresh);
    try {
      this.protocol.checkDomains(current, this.pinned(run).request);
    } catch { throw new AgentNativeError("agent_access_changed"); }
    return current;
  }

  private authority(identity: Identity, claim: Claim) {
    return withTenant(this.options.database.db, identityContext(identity), async tx => {
      const state = await this.held(tx, identity, claim);
      this.control(state);
      return this.current(tx, state.run);
    });
  }

  private readContract(input: NativePinned<F>) {
    try { this.protocol.assertReadContract(input); }
    catch { throw new AgentNativeError("agent_read_contract_changed"); }
  }

  private evidence(rows: Step[], inputChecksum: string) {
    return this.protocol.evidenceChain(rows, inputChecksum, (encrypted, checksum, schema) => this.open(encrypted, checksum, schema));
  }

  private selection(input: NativePinned<F>, selection: F["selection"]) {
    const allowed = selection.kind === "read" ? input.request.bindings.some(binding => binding.tool === selection.tool)
      : input.request.allowedCommands.some(command => agentNativeChecksum(command) === agentNativeChecksum(selection.command));
    if (!allowed) throw new AgentNativeError("agent_tool_not_allowed");
  }

  private async addStep(identity: Identity, claim: Claim, kind: Step["kind"], input: unknown, label: string, tool: Step["tool"]) {
    const sealed = this.seal(input);
    await withTenant(this.options.database.db, identityContext(identity), async tx => {
      const state = await this.held(tx, identity, claim);
      this.control(state);
      await this.current(tx, state.run);
      if (state.steps.some(step => step.phase !== "completed") || state.steps.length >= this.protocol.maxSteps) throw new AgentNativeError("agent_step_limit");
      if (kind === "model" && state.run.modelTurns >= state.run.limits.maxModelTurns) throw new AgentNativeError("agent_turn_limit");
      await tx.insert(steps).values({ id: createEntityId(), tenantId: identity.tenantId, runId: state.run.id,
        sequence: state.steps.length + 1, kind, label, tool, inputChecksum: sealed.checksum,
        previousChecksum: state.steps.at(-1)?.outputChecksum ?? state.run.inputChecksum, encryptedInput: sealed.encrypted });
      await tx.update(runs).set({ ...(kind === "model" ? { modelTurns: state.run.modelTurns + 1 } : {}),
        revision: sql`${runs.revision}+1`, updatedAt: state.now }).where(eq(runs.id, state.run.id));
    });
  }

  private async model(identity: Identity, claim: Claim, input: NativePinned<F>, step: Step, signal: AbortSignal) {
    const packet = this.open(step.encryptedInput, step.inputChecksum, this.protocol.schemas.turn);
    const original = await this.state(identity, claim);
    const predecessors = original.steps.filter(value => value.sequence < step.sequence);
    const expected = this.protocol.schemas.turn.parse({ version: this.protocol.version, runId: claim.run.id,
      turn: predecessors.filter(value => value.kind === "model").length + 1, goal: input.request.goal, contextText: input.request.contextText,
      bindings: input.request.bindings, allowedCommands: input.request.allowedCommands,
      slots: this.protocol.slots(claim.run.id, input.request.limits.maxProposals), limits: input.request.limits,
      ...this.evidence(predecessors, original.run.inputChecksum), ...this.protocol.turnFields?.(input) });
    if (agentNativeChecksum(packet) !== agentNativeChecksum(expected)) throw new AgentNativeError("agent_input_invalid");
    const recovery = assessPaidRequestRecovery({ submissionState: step.submissionState, hasResponseReceipt: step.receivedAt !== null,
      hasResponseCheckpoint: step.encryptedResponse !== null });
    if (recovery.action === "reconcile") throw new AgentNativeError("agent_submission_unknown");
    const admission = await this.authority(identity, claim);
    const expectedAuthority = erpSessionAuthority(admission);
    let response: ModelResponseCheckpoint;
    if (recovery.action === "reuse_response") {
      response = this.open(step.encryptedResponse, step.responseChecksum, ModelResponseCheckpointSchema);
      if (response.modelKey !== input.model.model || response.providerRequestId !== step.providerRequestId
        || response.inputTokens !== step.inputTokens || response.outputTokens !== step.outputTokens
        || agentNativeResponseCost(response) !== step.costUsd) throw new AgentNativeError("agent_response_invalid");
    } else {
      const selected = await withTenant(this.options.database.db, admission, tx => readAgentNativeModel(tx, input.model));
      const provider = createAgentNativeProvider(selected.provider, input.model, this.options.modelVault, this.options.providerFactory);
      const state = await this.state(identity, claim);
      const remaining = agentNativeMicros(state.run.capUsd) - agentNativeMicros(state.run.knownCostUsd);
      if (remaining <= 0n || state.run.unknownCost) throw new AgentNativeError("agent_budget_limit");
      const request = { modelKey: input.model.model, providerModel: input.model.model, taskType: "erp_agent_plan",
        systemInstructions: this.protocol.harness.instructions(input.request.executionContract, this.protocol.skill), untrustedSourceData: packet,
        outputSchema: this.protocol.decisionWireSchema, outputSchemaName: this.protocol.outputSchemaName,
        maxCostUsd: Math.min(Number(agentNativeMoney(remaining)), input.model.maxTaskCostUsd ?? 0), maxOutputTokens: input.request.limits.maxOutputTokens };
      const estimate = await provider.estimate(request);
      if (estimate.costUsd === null || !Number.isFinite(estimate.costUsd) || estimate.costUsd < 0 || estimate.costUsd > request.maxCostUsd)
        throw new AgentNativeError("agent_budget_limit");
      const envelopeBytes = this.promptBytes(packet, request.systemInstructions);
      if (envelopeBytes > input.request.limits.maxPromptBytes) throw new AgentNativeError("agent_prompt_limit");
      // UTF-8 bytes bound ordinary byte-tokenization conservatively, including
      // the actual wire schema omitted by the legacy provider's own estimate.
      const conservativeInputTokens = Math.max(estimate.estimatedInputTokens, envelopeBytes + 1024);
      if (input.model.inputUsdPerMillion === null || input.model.outputUsdPerMillion === null ||
        calculateCostUsd(conservativeInputTokens, request.maxOutputTokens, input.model.inputUsdPerMillion,
          input.model.outputUsdPerMillion) > request.maxCostUsd) throw new AgentNativeError("agent_budget_limit");
      // A stable membership stamp does not prove that an already observed
      // object is still assigned to this user's team. Check before marking any
      // new submission; a received paid response continues through reuse above.
      await this.protocol.beforeModelSubmit(admission, input, {definitions: packet.definitions, observations: packet.observations}, this.options,
        async () => (await this.takeCall(identity, claim)).current);
      await withTenant(this.options.database.db, identityContext(identity), async tx => {
        const state = await this.held(tx, identity, claim);
        this.control(state);
        const current = await this.current(tx, state.run);
        if (erpSessionAuthority(current) !== expectedAuthority) throw new AgentNativeError("agent_access_changed");
        await readAgentNativeModel(tx, input.model);
        const original = state.steps.find(row => row.id === step.id);
        if (!original || original.submissionState !== "not_submitted" || original.phase !== "preparing") throw new AgentNativeError("agent_step_changed");
        await tx.update(steps).set({ phase: "submitted", submissionState: "submitted", submittedAt: state.now }).where(eq(steps.id, step.id));
      });
      let received: ModelResponseCheckpoint | undefined;
      await provider.generate({ ...request, onResponseCheckpoint: async raw => {
        const value = ModelResponseCheckpointSchema.parse(raw);
        if (value.modelKey !== input.model.model || value.providerId !== provider.providerId) throw new AgentNativeError("agent_response_invalid");
        const sealed = this.seal(value), cost = agentNativeResponseCost(value);
        await withTenant(this.options.database.db, identityContext(identity), async tx => {
          // Store a submitted original response even after stop/revocation. This
          // captures incurred usage; permission checks govern adoption later.
          const state = await this.held(tx, identity, claim);
          const original = state.steps.find(row => row.id === step.id);
          if (!original || original.submissionState === "not_submitted") throw new AgentNativeError("agent_response_invalid");
          if (original.responseChecksum && original.responseChecksum !== sealed.checksum) throw new AgentNativeError("agent_response_invalid");
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
      if (!received) throw new AgentNativeError("agent_response_missing");
      response = received;
    }
    if (agentNativeResponseCost(response) === null) throw new AgentNativeError("agent_cost_unknown");
    const decision = this.protocol.schemas.decision.parse(decodeModelResponse(response, this.protocol.schemas.decision).value);
    this.protocol.harness.checkOutput(input.request.executionContract, this.protocol.skill, this.protocol.modelTool, decision);
    const fresh = await this.authority(identity, claim);
    if (erpSessionAuthority(fresh) !== expectedAuthority) throw new AgentNativeError("agent_access_changed");
    await withTenant(this.options.database.db, fresh, async tx => {
      const state = await this.held(tx, identity, claim);
      this.control(state);
      await this.current(tx, state.run);
      await readAgentNativeModel(tx, input.model);
      if (agentNativeMicros(state.run.knownCostUsd) > agentNativeMicros(state.run.capUsd)) throw new AgentNativeError("agent_cost_exceeded");
      const sealed = this.seal(decision);
      await tx.update(steps).set({ phase: "completed", encryptedOutput: sealed.encrypted, outputChecksum: sealed.checksum, completedAt: state.now })
        .where(eq(steps.id, step.id));
    });
  }

  private async definition(identity: Identity, claim: Claim, input: NativePinned<F>, step: Step) {
    const selection = this.open(step.encryptedInput, step.inputChecksum, this.protocol.schemas.selection);
    this.selection(input, selection);
    const { current } = await this.takeCall(identity, claim);
    const definition = this.protocol.validateDefinition(input,
      await this.protocol.definition(current, selection, this.options), selection);
    const sealed = this.seal({ stepId: step.id, definition });
    await withTenant(this.options.database.db, identityContext(identity), async tx => {
      const state = await this.held(tx, identity, claim);
      this.control(state);
      const fresh = await this.current(tx, state.run);
      if (erpSessionAuthority(fresh) !== erpSessionAuthority(current)) throw new AgentNativeError("agent_access_changed");
      const original = state.steps.find(value => value.id === step.id);
      if (!original || original.phase !== "preparing" || original.inputChecksum !== step.inputChecksum)
        throw new AgentNativeError("agent_step_changed");
      await tx.update(steps).set({ phase: "completed", encryptedOutput: sealed.encrypted, outputChecksum: sealed.checksum, completedAt: state.now })
        .where(eq(steps.id, step.id));
    });
  }

  private async takeCall(identity: Identity, claim: Claim) {
    return withTenant(this.options.database.db, identityContext(identity), async tx => {
      const state = await this.held(tx, identity, claim);
      this.control(state);
      const current = await this.current(tx, state.run);
      if (state.run.toolCalls >= state.run.limits.maxToolCalls) throw new AgentNativeError("agent_tool_limit");
      await tx.update(runs).set({ toolCalls: state.run.toolCalls + 1, revision: sql`${runs.revision}+1`, updatedAt: state.now }).where(eq(runs.id, state.run.id));
      return { current, state };
    });
  }

  private async read(identity: Identity, claim: Claim, input: NativePinned<F>, step: Step) {
    const request = this.open(step.encryptedInput, step.inputChecksum, this.protocol.schemas.readRequest);
    const binding = input.request.bindings[request.bindingIndex];
    if (!binding || step.tool !== binding.tool) throw new AgentNativeError("agent_tool_not_allowed");
    const original = await this.state(identity, claim);
    const evidence = this.evidence(original.steps.filter(value => value.sequence < step.sequence), original.run.inputChecksum);
    const definition = evidence.definitions.find(value => { const selection = this.protocol.selectionOf(value.definition); return selection.kind === "read" && selection.tool === binding.tool; });
    if (!definition) throw new AgentNativeError("agent_tool_definition_required");
    const results = step.encryptedOutput ? this.open(step.encryptedOutput, step.outputChecksum, this.protocol.schemas.progress).results : [];
    const page = (result?: (typeof results)[number]) => this.protocol.readPageState?.(binding, result) ?? {
      paged: binding.tool === "orders.exceptions.page" || binding.tool === "inventory.balances.page",
      hasMore: !!result && "coverage" in result && result.coverage.kind === "paged_collection" && !result.coverage.complete,
      cursor: result && "coverage" in result && result.coverage.kind === "paged_collection" ? result.coverage.nextCursor : null,
      maxPageSize: 100,
    };
    const paged = page().paged;
    const isIncomplete = () => {
      const last = results.at(-1);
      return !!last && page(last).hasMore;
    };
    if (results.length) this.protocol.buildObservation({ stepId: step.id, input, request, results,
      truncatedBy: isIncomplete() ? "tool_limit" : null });
    let reason: "row_limit" | "tool_limit" | null = null;
    while (!results.length || paged && isIncomplete()) {
      const state = await this.state(identity, claim);
      this.control(state);
      const available = input.request.limits.maxRows - state.run.observedRows;
      if (available <= 0) { reason = "row_limit"; break; }
      if (state.run.toolCalls >= input.request.limits.maxToolCalls) { reason = "tool_limit"; break; }
      const { current } = await this.takeCall(identity, claim);
      const last = results.at(-1);
      const call = this.protocol.readCall(input, request, definition.definition.definitionChecksum, {
        pageSize: Math.min(page(last).maxPageSize, available), cursor: page(last).cursor,
      });
      const result = await this.protocol.call(current, call, this.options);
      this.protocol.verifyReadResult(result, call);
      const next = [...results, result];
      this.protocol.buildObservation({ stepId: step.id, input, request, results: next,
        truncatedBy: page(result).hasMore ? "tool_limit" : null });
      const count = this.protocol.observationRows(result), sealed = this.seal({ results: next });
      await withTenant(this.options.database.db, identityContext(identity), async tx => {
        // Preserve a received native page under the original lease. Only the
        // subsequent fresh authorization may adopt it as completed evidence.
        const state = await this.held(tx, identity, claim);
        const original = state.steps.find(value => value.id === step.id);
        if (!original || original.phase !== "preparing" || original.inputChecksum !== step.inputChecksum
          || original.outputChecksum !== (results.length ? agentNativeChecksum({ results }) : null))
          throw new AgentNativeError("agent_step_changed");
        if (state.run.observedRows + count > input.request.limits.maxRows) throw new AgentNativeError("agent_row_limit");
        await tx.update(steps).set({ encryptedOutput: sealed.encrypted, outputChecksum: sealed.checksum }).where(eq(steps.id, step.id));
        await tx.update(runs).set({ observedRows: state.run.observedRows + count, revision: sql`${runs.revision}+1`, updatedAt: state.now })
          .where(eq(runs.id, state.run.id));
      });
      results.push(result);
      const fresh = await this.authority(identity, claim);
      if (erpSessionAuthority(fresh) !== erpSessionAuthority(current)) throw new AgentNativeError("agent_access_changed");
    }
    if (!results.length) throw new AgentNativeError(reason === "row_limit" ? "agent_row_limit" : "agent_tool_limit");
    const observation = this.protocol.buildObservation({ stepId: step.id, input, request, results, truncatedBy: reason });
    const sealed = this.seal(observation);
    await withTenant(this.options.database.db, identityContext(identity), async tx => {
      const state = await this.held(tx, identity, claim);
      this.control(state);
      await this.current(tx, state.run);
      const original = state.steps.find(value => value.id === step.id);
      if (!original || original.phase !== "preparing" || original.outputChecksum !== agentNativeChecksum({ results }))
        throw new AgentNativeError("agent_step_changed");
      await tx.update(steps).set({ phase: "completed", encryptedOutput: sealed.encrypted, outputChecksum: sealed.checksum, completedAt: state.now })
        .where(eq(steps.id, step.id));
    });
  }

  private async finish(identity: Identity, claim: Claim, input: NativePinned<F>, modelStep: Step,
    raw: NativeModelResult<F>, definitions: NativeDefinitionEvidence<F>[], observations: F["observation"][]) {
    const result = this.protocol.resolveResult(claim.run.id, raw, input.request.allowedCommands, input.request.limits.maxProposals, definitions);
    this.protocol.verifyClaims(result, observations);
    await this.protocol.recheck(input, definitions, observations, this.options,
      async () => (await this.takeCall(identity, claim)).current);
    const sealed = this.seal(result);
    await withTenant(this.options.database.db, identityContext(identity), async tx => {
      const state = await this.held(tx, identity, claim);
      this.control(state);
      const current = await this.current(tx, state.run);
      await readAgentNativeModel(tx, input.model);
      const original = state.steps.at(-1);
      if (!original || original.id !== modelStep.id || original.kind !== "model" || original.phase !== "completed" ||
        original.outputChecksum !== modelStep.outputChecksum || original.submissionState !== "received")
        throw new AgentNativeError("agent_checkpoint_invalid");
      const decision = this.open(original.encryptedOutput, original.outputChecksum, this.protocol.schemas.decision);
      if (decision.action !== "finish" || agentNativeChecksum(decision.result) !== agentNativeChecksum(raw))
        throw new AgentNativeError("agent_checkpoint_invalid");
      const saved = this.evidence(state.steps, state.run.inputChecksum);
      if (agentNativeChecksum(saved) !== agentNativeChecksum({ definitions, observations })) throw new AgentNativeError("agent_checkpoint_invalid");
      if (result.proposals.length) await tx.insert(items).values(result.proposals.map(proposal => ({
        id: proposal.id, tenantId: state.run.tenantId, runId: state.run.id, modelStepId: original.id,
        position: proposal.position, proposalChecksum: proposal.proposalChecksum, originalChecksum: proposal.originalChecksum,
        ...this.protocol.itemBirthFields?.(proposal),
        preparationRequestChecksum: proposal.preparationRequestChecksum,
      })));
      for (const proposal of result.proposals) await recordAuditInTransaction(tx, current, {
        action: "agent.plan.item.create", resourceType: "agent_plan_item", resourceId: proposal.id,
        result: "success", metadata: { runId: state.run.id, proposalChecksum: proposal.proposalChecksum },
      });
      await tx.update(runs).set({ encryptedResult: sealed.encrypted, resultChecksum: sealed.checksum }).where(eq(runs.id, state.run.id));
      await this.settle(tx, state.run, observations.some(value => this.protocol.isPartialObservation?.(value) ?? (value.collectionComplete === false)) ? "partial" : "completed", null);
    });
  }


  private async costs(tx: TenantTransaction, id: string) {
    const [value] = await tx.execute<{ known: string; submitted: string; unknown: boolean }>(sql`
      select coalesce(sum(cost_usd) filter(where submission_state='received'),0)::text as known,
        count(*) filter(where submission_state<>'not_submitted')::text as submitted,
        coalesce(bool_or(submission_state<>'not_submitted' and (submission_state<>'received' or cost_usd is null)),false) as unknown
      from ${steps} where tenant_id=current_setting('app.tenant_id')::uuid and run_id=${id}::uuid and kind='model'
    `);
    if (!value) throw new AgentNativeError("agent_cost_invalid");
    return { known: agentNativeMoney(agentNativeMicros(value.known)), submitted: Number(value.submitted), unknown: value.unknown };
  }

  private async settle(tx: TenantTransaction, run: Run, status: Run["status"], errorCode: string | null) {
    const totals = await this.costs(tx, run.id), now = await clock(tx);
    await tx.update(runs).set({ status: totals.unknown && status !== "expired" ? "uncertain" : status,
      errorCode: totals.unknown ? (errorCode ?? "agent_cost_unknown") : errorCode,
      knownCostUsd: totals.known, unknownCost: totals.unknown ? 1 : 0, leaseToken: null, leaseExpiresAt: null,
      revision: sql`${runs.revision}+1`, completedAt: now, updatedAt: now }).where(eq(runs.id, run.id));
    const [ledger] = await tx.select().from(aiBudgetLedger).where(and(eq(aiBudgetLedger.id, run.budgetLedgerId),
      eq(aiBudgetLedger.requestId, run.id), eq(aiBudgetLedger.taskType, "erp_agent_plan"))).for("update");
    if (!ledger || agentNativeMicros(ledger.amountUsd) !== agentNativeMicros(run.capUsd) || ledger.state !== "reserved")
      throw new AgentNativeError("agent_budget_invalid");
    if (!totals.unknown) await tx.update(aiBudgetLedger).set(totals.submitted === 0 ? { state: "released" } : { state: "committed", amountUsd: totals.known })
      .where(eq(aiBudgetLedger.id, ledger.id));
  }

  private async expire(tx: TenantTransaction, state: Locked) {
    if (!terminal(state.run.status)) await this.settle(tx, state.run, "expired", "agent_expired");
    await tx.update(steps).set({ encryptedInput: null, encryptedOutput: null, encryptedResponse: null })
      .where(eq(steps.runId, state.run.id));
    await tx.update(runs).set({ encryptedInput: null, encryptedResult: null, resultChecksum: null, updatedAt: state.now })
      .where(eq(runs.id, state.run.id));
    if(this.protocol.itemBirthFields){
      const cleared=await tx.update(items).set({encryptedCompletion:null,completionRedactedAt:sql`clock_timestamp()`})
        .where(and(eq(items.runId,state.run.id),sql`${items.encryptedCompletion} is not null`))
        .returning({id:items.id,proposalChecksum:items.proposalChecksum,completionChecksum:items.completionChecksum});
      for(const item of cleared)await recordAuditInTransaction(tx,identityContext({tenantId:state.run.tenantId,userId:state.run.ownerId}),{
        action:"agent.plan.item.redact",resourceType:"agent_plan_item",resourceId:item.id,result:"success",
        metadata:{runId:state.run.id,proposalChecksum:item.proposalChecksum,completionChecksum:item.completionChecksum}});
    }
  }

  private safeCode(error: unknown) {
    if (error instanceof AgentNativeError) return error.code;
    if (error instanceof z.ZodError || error instanceof SyntaxError) return "agent_model_output_invalid";
    const mapped = (code: unknown) => {
      if (code === "FORBIDDEN" || code === "authority_changed" || code === "agent_read_scope_not_verified" || code === "agent_tools_access_denied") return "agent_access_changed";
      if (code === "agent_collection_changed" || code === "agent_read_timeout" || code === "agent_tool_read_timeout"
        || code === "agent_tool_definition_changed" || code === "agent_tool_contract_changed") return code;
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
