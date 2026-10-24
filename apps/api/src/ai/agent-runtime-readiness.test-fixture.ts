import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpException, Module, type INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { generateKeyPair, SignJWT } from "jose";
import { createEnvironmentSecretVault } from "@yummyai/ai-core";
import { erpPermissionContext, Permission, authorize } from "@yummyai/authz";
import { TenantContextSchema } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AgentReadinessFamilySchema, type AgentReadinessFamily } from "@yummyai/contracts/ai/agent-readiness";
import { AGENT_PLAN_VERSION, CreateAgentPlanSchema, defaultAgentPlanLimits } from "@yummyai/contracts/ai/agent-plan";
import { AGENT_NATIVE_VERSION, CreateAgentNativeSchema, defaultAgentNativeLimits } from "@yummyai/contracts/ai/agent-native";
import { AGENT_NATIVE_V2_VERSION, CreateAgentNativeV2Schema, defaultAgentNativeV2Limits } from "@yummyai/contracts/ai/agent-native-v2";
import { AgentNativeV3ReceiptSchema, StopAgentNativeV3Schema } from "@yummyai/contracts/ai/agent-native-v3";
import { type AgentRuntimeQueue, type AgentRuntimeObservation } from "@yummyai/contracts/ai/agent-runtime-readiness";
import { agentLoopRuns, agentPlanRuns, aiBudgetPolicies, connectDatabase, withTenant, type DatabaseConnection } from "@yummyai/database";
import { createQueue, createTraceId, enqueueJob, type QueueNameValue } from "@yummyai/jobs";
import { RedisAgentRuntimePresence } from "../../../../packages/jobs/src/agent-runtime-presence.js";
import { eq, sql } from "drizzle-orm";
import { requireAgentRuntimeReadinessEnvironment } from "../../../../tools/testing/require-agent-runtime-readiness-environment.mjs";
import { openAgentRuntimeWorker, openAgentRuntimeRedisProxy, waitForAgentRuntime } from "../../../../tools/testing/agent-runtime-readiness-runtime.mjs";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { IdentitySessionController } from "../auth/identity-session.controller.js";
import { OidcJwtStrategy } from "../auth/oidc-jwt.strategy.js";
import { TenantContextGuard, DatabaseMembershipContextLoader } from "../auth/tenant-context.guard.js";
import { PermissionsGuard } from "../auth/permissions.guard.js";
import { ApiClientRouteGuard } from "../auth/api-client-route.guard.js";
import { ApiClientAuthorityInterceptor } from "../auth/api-client-authority.interceptor.js";
import { AgentRuntimeReadinessService } from "./agent-runtime-readiness.service.js";
import { AgentRuntimeReadinessController } from "./agent-runtime-readiness.controller.js";
import { AgentNativeV3Controller } from "./agent-native-v3.controller.js";
import { AgentNativeV3Service } from "./agent-native-v3.service.js";
import { AgentLoopService } from "./agent-loop.service.js";
import { ModelConfigurationService } from "./model-configuration.service.js";
import { agentReadinessFixture, readinessAuthority, readinessHash } from "./agent-readiness.test-fixture.js";
import { deferred, type AgentActor } from "./agent-read.test-fixture.js";

/** Owns only disposable transport and real original owners. No process is
 * launched until launchWorker is explicitly called by a resource test. */
export function agentRuntimeReadinessFixture(database: DatabaseConnection) {
  const environment = requireAgentRuntimeReadinessEnvironment(), readiness = agentReadinessFixture(database), base = readiness.base;
  const presence = new RedisAgentRuntimePresence(process.env.REDIS_URL), workers: Array<Awaited<ReturnType<typeof openAgentRuntimeWorker>>> = [];
  const proxies: Array<Awaited<ReturnType<typeof openAgentRuntimeRedisProxy>>> = [];
  const extraPresence: RedisAgentRuntimePresence[] = [], queues = new Map<AgentRuntimeQueue, ReturnType<typeof createQueue>>();
  const releases = new Set<() => void>(), issued = new Map<string, string>();
  const inspections: Array<{ queue: AgentRuntimeQueue; status: AgentRuntimeObservation["status"] }> = [];
  const controls: { afterInspect?: (queue: AgentRuntimeQueue, result: AgentRuntimeObservation) => Promise<void> } = {};
  const reader = { async inspect(queue: AgentRuntimeQueue) {
    const result = await presence.inspect(queue); inspections.push({ queue, status: result.status });
    await controls.afterInspect?.(queue, result); return result;
  } };
  const service = new AgentRuntimeReadinessService(database, reader);
  let signing: Awaited<ReturnType<typeof generateKeyPair>> | undefined, app: INestApplication | undefined, origin: string | undefined, closed = false;

  function queue(name: AgentRuntimeQueue) {
    let value = queues.get(name); if (!value) { value = createQueue(name as QueueNameValue, process.env.REDIS_URL); queues.set(name, value); } return value;
  }
  async function launchWorker(input: Parameters<typeof openAgentRuntimeWorker>[0] = {}) {
    const worker = await openAgentRuntimeWorker(input); workers.push(worker); return worker;
  }
  async function proxy() { const value = await openAgentRuntimeRedisProxy(); proxies.push(value); return value; }
  function serviceThrough(value: Awaited<ReturnType<typeof openAgentRuntimeRedisProxy>>) {
    const connection = new RedisAgentRuntimePresence(value.url); extraPresence.push(connection);
    return new AgentRuntimeReadinessService(database, connection);
  }
  function holdInspect(queueName: AgentRuntimeQueue = "agent-plan") {
    const entered = deferred(), released = deferred(); let used = false, observation: AgentRuntimeObservation | undefined;
    const release = () => { released.resolve(); releases.delete(release); }; releases.add(release);
    controls.afterInspect = async (selected, actual) => { if (!used && selected === queueName) { used = true; observation = actual; entered.resolve(); await released.promise; } };
    return { entered: entered.promise, captured: () => observation, release, clear() { release(); controls.afterInspect = undefined; } };
  }
  async function token(actor: AgentActor) {
    const saved = issued.get(actor.userId); if (saved) return saved;
    signing ??= await generateKeyPair("RS256");
    const value = await new SignJWT({ tenant_id: actor.tenantId }).setProtectedHeader({ alg: "RS256" }).setSubject(actor.subject)
      .setIssuer("https://synthetic-runtime-readiness-oidc.invalid").setAudience("synthetic-runtime-readiness-api").setIssuedAt().setExpirationTime("20m").sign(signing.privateKey);
    issued.set(actor.userId, value); return value;
  }
  async function startHttp() {
    if (origin) return origin; signing ??= await generateKeyPair("RS256");
    @Module({ controllers: [IdentitySessionController, AgentRuntimeReadinessController, AgentNativeV3Controller], providers: [
      { provide: DATABASE_CONNECTION, useValue: database }, { provide: AgentRuntimeReadinessService, useValue: service },
      { provide: AgentNativeV3Service, useValue: readiness.owners.native_v3 },
    ] })
    class RuntimeReadinessPersonalModule {}
    app = await NestFactory.create(RuntimeReadinessPersonalModule, { logger: false, abortOnError: false });
    const reflector = new Reflector();
    app.useGlobalGuards(new TenantContextGuard(new OidcJwtStrategy({ issuer: "https://synthetic-runtime-readiness-oidc.invalid", audience: "synthetic-runtime-readiness-api", verificationKey: signing.publicKey }),
      new DatabaseMembershipContextLoader(database), base.loader, reflector), new PermissionsGuard(reflector), new ApiClientRouteGuard(reflector));
    app.useGlobalInterceptors(new ApiClientAuthorityInterceptor(base.loader));
    await app.listen(0, "127.0.0.1"); origin = await app.getUrl(); return origin;
  }
  async function http(actor: AgentActor, path: string, method: "GET" | "POST" = "GET", authority?: string) {
    if (!/^\/v1\/(?:identity\/session|ai\/agent-runtime-readiness\/[^/]+|agent-native-v3\/(?:receipt|runs\/[0-9a-f-]{36}))$/.test(path.split("?")[0]!))
      throw new Error("runtime_readiness_fixture_path_invalid");
    return fetch(new URL(path, await startHttp()), { method, redirect: "error", headers: { authorization: "Bearer " + await token(actor),
      "x-yummyai-context-authority": authority ?? readinessAuthority(await base.current(actor)), ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}) });
  }

  async function original(family: AgentReadinessFamily, shortRetention = true) {
    if(family==="native_v4")throw new Error("Native-v4 requires its independent original-owner fixture");
    const { actor, modelId } = await readiness.actor(); if (!modelId) throw new Error("runtime_original_model_missing");
    await readiness.policy(actor);
    const originalOwners = readiness.original, planner = originalOwners.prior.legacy.prior;
    const owner = !shortRetention ? readiness.owners[family] : family === "loop"
      ? new AgentLoopService(database, base.vault, planner.gateway, { enqueue: async () => {} }, 35)
      : family === "plan" ? planner.service(35) : family === "native_v1" ? originalOwners.prior.legacy.service(35)
      : family === "native_v2" ? originalOwners.prior.service(35) : originalOwners.service(35);
    const context = await base.current(actor), workspace = await owner.workspace(context);
    const common = { requestId: randomUUID(), modelId, goal: "Synthetic original expiry consumption without a model or business action", maxCostUsd: 0.000001,
      contextText: "Explicit synthetic admission; only the original expiry path is consumed", allowedCommands: [], executionContract: workspace.executionContract };
    const deadline = shortRetention ? { deadlineSeconds: 30 } : {};
    const loopInput = family === "loop" ? await readiness.loopRequest(actor, modelId) : null;
    const nativeInput = family === "native_v3" ? await readiness.nativeRequest(actor, modelId, 0.000001) : null;
    const input = loopInput ? { ...loopInput, limits: { ...loopInput.limits, ...deadline } }
      : nativeInput ? { ...nativeInput, limits: { ...nativeInput.limits, ...deadline } }
      : family === "plan" ? CreateAgentPlanSchema.parse({ ...common, version: AGENT_PLAN_VERSION, allowedReads: ["inventory.balances.page"],
        allowedCommands: [{ domain: "finance", kind: "bill_record" }], limits: { ...defaultAgentPlanLimits(), ...deadline } })
      : family === "native_v1" ? CreateAgentNativeSchema.parse({ ...common, version: AGENT_NATIVE_VERSION, bindings: [{ tool: "inventory.balances.page", scope: {} }], limits: { ...defaultAgentNativeLimits(), ...deadline } })
      : CreateAgentNativeV2Schema.parse({ ...common, version: AGENT_NATIVE_V2_VERSION, bindings: [{ tool: "inventory.balances.page", scope: {} }], limits: { ...defaultAgentNativeV2Limits(), ...deadline } });
    const view = await owner.start(context, input), name = family === "loop" ? "agent-loop" as const : "agent-plan" as const;
    return { actor, family, input, view, queue: name, owner };
  }
  async function isExpired(value: Awaited<ReturnType<typeof original>>) {
    return withTenant(database.db, value.actor.context, async tx => {
      const table = value.family === "loop" ? agentLoopRuns : agentPlanRuns;
      const [row] = await tx.select({ expired: sql<boolean>`${table.expiresAt}<=clock_timestamp()` }).from(table).where(eq(table.id, value.view.id));
      return row?.expired === true;
    });
  }
  async function enqueueOriginal(value: Awaited<ReturnType<typeof original>>) {
    await enqueueJob(queue(value.queue), value.queue + ".expire", { jobId: value.view.id, idempotencyKey: value.view.id, correlationId: value.view.id,
      traceId: createTraceId(), tenantId: value.actor.tenantId, requestedBy: value.actor.userId, requestedAt: new Date().toISOString(), attempt: 0, maxAttempts: 1,
      payload: { runId: value.view.id, operation: "expire" } });
  }
  async function originalMetadata(value: Awaited<ReturnType<typeof original>>) {
    return withTenant(database.db, value.actor.context, async tx => {
      const table = value.family === "loop" ? "agent_loop_runs" : "agent_plan_runs", steps = value.family === "loop" ? "agent_loop_steps" : "agent_plan_steps";
      const [row] = await tx.execute<{ id: string; version: string; request_id: string; request_checksum: string; input_checksum: string;
        status: string; dispatch_count: number; private_present: boolean; step_count: number }>(sql`select id,version,request_id,request_checksum,input_checksum,status,dispatch_count,
        encrypted_input is not null as private_present,(select count(*)::int from ${sql.identifier(steps)} s where s.tenant_id=r.tenant_id and s.run_id=r.id) as step_count
        from ${sql.identifier(table)} r where id=${value.view.id}::uuid`);
      if (!row) throw new Error("runtime_original_metadata_missing"); return row;
    });
  }
  async function holdOriginal(value: Awaited<ReturnType<typeof original>>) {
    const entered = deferred(), released = deferred(); const release = () => { released.resolve(); releases.delete(release); }; releases.add(release);
    const pending = withTenant(database.db, value.actor.context, async tx => {
      const table = value.family === "loop" ? agentLoopRuns : agentPlanRuns;
      await tx.select({ id: table.id }).from(table).where(eq(table.id, value.view.id)).for("update"); entered.resolve(); await released.promise;
    });
    await entered.promise; return { release, settled: pending };
  }
  async function close() {
    if (closed) return; closed = true; controls.afterInspect = undefined; for (const release of releases) release();
    const errors: unknown[] = [];
    for (const worker of workers) try { await worker.stop(worker.evidence.processExited ? "graceful" : "kill"); } catch (error) { errors.push(error); }
    for (const done of [() => app?.close(), ...[...queues.values()].map(value => () => value.close()), () => presence.close(), ...extraPresence.map(value => () => value.close()),
      ...proxies.map(value => () => value.close()), () => readiness.close()]) try { await done(); } catch (error) { errors.push(error); }
    issued.clear();
    if (workers.some(worker => !worker.evidence.processExited || worker.evidence.privateEnvironmentLeaked)) errors.push(new Error("runtime_worker_cleanup_unproven"));
    if (errors.length) throw new AggregateError(errors, "runtime_readiness_fixture_cleanup_failed");
  }
  return { environment, readiness, base, presence, inspections, workers, service, serviceThrough, queue, launchWorker, proxy, holdInspect,
    original, isExpired, enqueueOriginal, originalMetadata, holdOriginal, token, http, startHttp, state: readiness.state, hash: readinessHash, close, initialize: readiness.initialize,
    families: AgentReadinessFamilySchema.options };
}

/** Explicit browser setup in this nonce only. It first checks the runner-issued
 * real API token and browser session, then uses the original configuration and
 * model owners. The queued historical task is allowed to expire before work. */
type BrowserCleanupPhase = "original_metadata" | "original_stop" | "original_stop_receipt" | "model_retirement" | "budget_restore" | "actor_authority" | "owner_retirement" | "fixture_close" | "database_close";
type BrowserCleanupDiagnostic = { phase: BrowserCleanupPhase; code: string | null; status: number | null };
type BrowserBudgetCleanup = { budgetRestored: true; budgetCleanup: { mode: "restored_original_policy" | "not_written"; requiresIndependentDatabaseAbsence: false } }
  | { budgetRestored: false; budgetCleanup: { mode: "disposable_database_teardown"; requiresIndependentDatabaseAbsence: true; databaseName: string } };
type BrowserOwnerRetirement = BrowserBudgetCleanup & { modelConfigurationRetired: true; actorAuthorityUnchanged: true; providerCalls: 0; modelSteps: 0;
  originalHistory: "retained_immutable" | "not_created" };
const browserCleanupCodes = ["runtime_browser_unexpected_model_step", "runtime_browser_original_stop_receipt_changed", "runtime_browser_owned_configuration_missing",
  "runtime_browser_owned_budget_changed", "runtime_browser_actor_changed_during_fixture", "runtime_browser_model_step_not_zero",
  "runtime_browser_owner_retirement_failed", "runtime_browser_fixture_close_failed", "runtime_readiness_fixture_cleanup_failed", "runtime_worker_cleanup_unproven"] as const;
function browserCleanupDiagnostic(phase: BrowserCleanupPhase, error: unknown): BrowserCleanupDiagnostic {
  let code: string | null = null, status: number | null = null, current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
    const message = current instanceof Error ? current.message : null;
    if (message !== null && browserCleanupCodes.some(value => value === message)) code ??= message;
    if (current instanceof HttpException) {
      const response = current.getResponse(), value = current.getStatus();
      if (Number.isInteger(value) && value >= 400 && value <= 599) status ??= value;
      if (response && typeof response === "object" && "code" in response
        && (response.code === "agent_stop_invalid" || response.code === "agent_request_conflict")) code ??= response.code;
    }
    if ("statusCode" in current && typeof current.statusCode === "number" && Number.isInteger(current.statusCode) && current.statusCode >= 400 && current.statusCode <= 599) status ??= current.statusCode;
    if ("code" in current && typeof current.code === "string" && /^[0-9A-Z]{5}$/.test(current.code)) code ??= current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return { phase, code, status };
}
async function browserRuntimeOwner(database: DatabaseConnection, f: ReturnType<typeof agentRuntimeReadinessFixture>, rawSession: unknown, cleanupDiagnostics: BrowserCleanupDiagnostic[]) {
  const environment = requireAgentRuntimeReadinessEnvironment(process.env, true);
  const supplied = ErpSessionViewSchema.parse(rawSession), actors: unknown = JSON.parse(process.env.ERP_FIXTURE_ACTORS!);
  if (!actors || typeof actors !== "object" || !("operator" in actors) || !actors.operator || typeof actors.operator !== "object"
    || !("userId" in actors.operator) || !("tenantId" in actors.operator) || !("membershipId" in actors.operator)
    || supplied.userId !== actors.operator.userId || supplied.tenantId !== actors.operator.tenantId || typeof actors.operator.membershipId !== "string")
    throw new Error("runtime_browser_original_actor_invalid");
  const response = await fetch(new URL("/v1/identity/session", process.env.API_BASE_URL), { redirect: "error", headers: { authorization: "Bearer " + process.env.API_ACCESS_TOKEN! } });
  if (response.status !== 200) throw new Error("runtime_browser_original_session_rejected");
  const session = ErpSessionViewSchema.parse(await response.json());
  if (session.userId !== supplied.userId || session.tenantId !== supplied.tenantId || erpSessionAuthority(session) !== erpSessionAuthority(supplied))
    throw new Error("runtime_browser_original_session_changed");
  const context = TenantContextSchema.parse(erpPermissionContext(session));
  const current = await f.base.current(context);
  if (readinessAuthority(current) !== erpSessionAuthority(session)) throw new Error("runtime_browser_original_membership_changed");
  authorize(current, Permission.WorkflowRead); authorize(current, Permission.WorkflowRun, { ownerId: current.userId }); authorize(current, Permission.ModelConfigure);
  const actor: AgentActor = { tenantId: current.tenantId, userId: current.userId, subject: "unused-no-browser-token-is-minted",
    membershipId: actors.operator.membershipId, roleIds: new Map(), context: current };
  const owner = new ModelConfigurationService(database, createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config"));
  const label = "Synthetic runtime gate " + randomUUID(), stamp = readinessAuthority(current);
  const priorBudget = await withTenant(database.db, current, async tx => (await tx.select().from(aiBudgetPolicies))[0] ?? null);
  let providerId: string | undefined, original: Awaited<ReturnType<typeof f.original>> | undefined, retired = false, budgetWritten = false;
  let retirement: Promise<BrowserOwnerRetirement> | undefined;
  async function retire() {
    if (retirement) return retirement;
    retirement = (async () => {
      const errors: unknown[] = [];
      let modelSteps = 0;
      let budgetCleanup: BrowserBudgetCleanup = { budgetRestored: true, budgetCleanup: { mode: "not_written", requiresIndependentDatabaseAbsence: false } };
      if (original) {
        let phase: BrowserCleanupPhase = "original_metadata";
        try {
          const row = await f.originalMetadata(original); modelSteps = row.step_count;
          if (row.step_count !== 0) throw new Error("runtime_browser_unexpected_model_step");
          const stop = StopAgentNativeV3Schema.parse({ version: original.view.version, requestId: original.view.requestId });
          phase = "original_stop";
          const stopped = await original.owner.stop(current, original.view.id, stop);
          phase = "original_stop_receipt";
          const receipt = AgentNativeV3ReceiptSchema.parse(stopped);
          if (receipt.disposition !== "known" || receipt.runId !== original.view.id || receipt.requestId !== original.view.requestId
            || receipt.requestChecksum !== original.view.requestChecksum) throw new Error("runtime_browser_original_stop_receipt_changed");
        } catch (error) { cleanupDiagnostics.push(browserCleanupDiagnostic(phase, error)); errors.push(error); }
      }
      if (providerId) try {
        const snapshot = await owner.invoke(current, { operation: "configuration.get" });
        const channel = "channels" in snapshot ? snapshot.channels.find(value => value.id === providerId) : undefined;
        if (!channel || channel.name !== label) throw new Error("runtime_browser_owned_configuration_missing");
        await owner.invoke(current, { operation: "channel.remove", id: channel.id, revision: channel.revision });
      } catch (error) { cleanupDiagnostics.push(browserCleanupDiagnostic("model_retirement", error)); errors.push(error); }
      if (budgetWritten) try {
        budgetCleanup = await withTenant(database.db, current, async tx => {
          const [actual] = await tx.select().from(aiBudgetPolicies);
          if (!actual || actual.monthlyCapUsd !== "100.000000" || actual.defaultTaskCapUsd !== "1.000000" || JSON.stringify(actual.taskCapsUsd) !== "{}")
            throw new Error("runtime_browser_owned_budget_changed");
          if (priorBudget) {
            const [restored] = await tx.update(aiBudgetPolicies).set({ monthlyCapUsd: priorBudget.monthlyCapUsd, defaultTaskCapUsd: priorBudget.defaultTaskCapUsd, taskCapsUsd: priorBudget.taskCapsUsd })
              .where(eq(aiBudgetPolicies.tenantId, current.tenantId)).returning();
            if (!restored || restored.monthlyCapUsd !== priorBudget.monthlyCapUsd || restored.defaultTaskCapUsd !== priorBudget.defaultTaskCapUsd
              || JSON.stringify(restored.taskCapsUsd) !== JSON.stringify(priorBudget.taskCapsUsd)) throw new Error("runtime_browser_owned_budget_changed");
            return { budgetRestored: true, budgetCleanup: { mode: "restored_original_policy", requiresIndependentDatabaseAbsence: false } } as const;
          }
          // The application role deliberately has no DELETE grant. Retain only
          // this exact nonce-owned policy until independently verified DB teardown.
          return { budgetRestored: false, budgetCleanup: { mode: "disposable_database_teardown", requiresIndependentDatabaseAbsence: true, databaseName: environment.name } } as const;
        });
      } catch (error) { cleanupDiagnostics.push(browserCleanupDiagnostic("budget_restore", error)); errors.push(error); }
      try {
        if (readinessAuthority(await f.base.current(current)) !== stamp) throw new Error("runtime_browser_actor_changed_during_fixture");
      } catch (error) { cleanupDiagnostics.push(browserCleanupDiagnostic("actor_authority", error)); errors.push(error); }
      retired = errors.length === 0;
      if (errors.length) throw new AggregateError(errors, "runtime_browser_owner_retirement_failed");
      if (modelSteps !== 0) throw new Error("runtime_browser_model_step_not_zero");
      return { modelConfigurationRetired: true, actorAuthorityUnchanged: true, providerCalls: 0, modelSteps: 0,
        originalHistory: original ? "retained_immutable" : "not_created", ...budgetCleanup } as const;
    })();
    return retirement;
  }
  try {
    const configured = await owner.invoke(current, { operation: "channel.save", name: label, baseUrl: "https://synthetic-runtime-gate.invalid/v1",
      apiKey: "synthetic-runtime-gate-never-sent", textProtocol: "chat_completions", models: [] });
    const channel = "channels" in configured ? configured.channels.find(value => value.name === label) : undefined;
    if (!channel) throw new Error("runtime_browser_created_configuration_missing"); providerId = channel.id;
    const model = await f.base.assists.addModel(current, { providerConfigId: providerId, model: "synthetic-runtime-gate", label: "Synthetic runtime gate model",
      inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2, maxTaskCostUsd: 1 });
    await f.readiness.policy(actor); budgetWritten = true;
    const planner = f.readiness.original.prior.legacy.prior;
    const native = new AgentNativeV3Service(database, createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist"), f.readiness.original.prior.legacy.gateway,
      f.readiness.original.prior.resources.service, planner.owners.service(), planner.owners.adapter, { enqueue: async () => {} }, f.readiness.original.fulfillmentService, 35);
    const source = await f.readiness.nativeRequest(actor, model.id, 0.000001), input = { ...source, limits: { ...source.limits, deadlineSeconds: 30 } };
    const view = await native.start(current, input);
    original = { actor, family: "native_v3", input, view, owner: native, queue: "agent-plan" };
    return { seed: { modelId: model.id, providerId, runId: view.id, requestId: view.requestId, requestChecksum: view.requestChecksum, expiresAt: view.expiresAt,
      authoritySha256: readinessHash(stamp), source: "original_model_configuration_and_analysis_model_owners", paidCalls: 0, originalAdmissionReservations: 1 } as const,
      async expired() {
        await waitForAgentRuntime(() => f.isExpired(original!), "runtime_browser_original_not_expired", 42_000);
        if ((await f.originalMetadata(original!)).step_count !== 0) throw new Error("runtime_browser_model_started_before_worker");
        return { expired: true, modelSteps: 0 } as const;
      }, retire, isRetired: () => retired };
  } catch (error) {
    try { await retire(); } catch (closeError) { throw new AggregateError([error, closeError], "runtime_browser_setup_and_retirement_failed"); }
    throw error;
  }
}

async function runRuntimeReadinessBrowserFixture() {
  const environment = requireAgentRuntimeReadinessEnvironment(process.env, true), database = connectDatabase(environment.url), f = agentRuntimeReadinessFixture(database);
  const cleanupDiagnostics: BrowserCleanupDiagnostic[] = [];
  let setup: Awaited<ReturnType<typeof browserRuntimeOwner>> | undefined, initialized = false, closing: Promise<unknown> | undefined, serial = Promise.resolve();
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      const failures: unknown[] = []; let retired: Awaited<ReturnType<NonNullable<typeof setup>["retire"]>> | undefined;
      try { retired = await setup?.retire(); } catch (error) { cleanupDiagnostics.push(browserCleanupDiagnostic("owner_retirement", error)); failures.push(error); }
      try { await f.close(); } catch (error) { cleanupDiagnostics.push(browserCleanupDiagnostic("fixture_close", error)); failures.push(error); }
      try { await database.client.end(); } catch (error) { cleanupDiagnostics.push(browserCleanupDiagnostic("database_close", error)); failures.push(error); }
      if (failures.length || !retired) throw new AggregateError(failures, "runtime_browser_fixture_close_failed");
      return { nonce: environment.nonce, pid: process.pid, closed: true, fixtureClosed: true, databaseClosed: true, ...retired } as const;
    })(); return closing;
  }
  const send = (message: unknown) => new Promise<void>((done, reject) => {
    if (!process.send || !process.connected) { reject(new Error("runtime_browser_ipc_unavailable")); return; }
    process.send(message, error => error ? reject(new Error("runtime_browser_ipc_failed")) : done());
  });
  process.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || !("type" in message) || message.type !== "runtime.readiness.fixture"
      || !("id" in message) || typeof message.id !== "string" || !/^[0-9a-f-]{36}$/.test(message.id) || !("operation" in message)
      || !["setup", "expired", "close"].includes(String(message.operation))) return;
    serial = serial.then(async () => {
      const id = message.id, operation = message.operation;
      try {
        let value: unknown;
        if (operation === "setup") {
          if (initialized || closing || !("value" in message)) throw new Error("runtime_browser_setup_repeated");
          initialized = true; await f.initialize(); setup = await browserRuntimeOwner(database, f, message.value, cleanupDiagnostics); value = setup.seed;
        } else if (operation === "expired") {
          if (!setup || closing) throw new Error("runtime_browser_setup_missing"); value = await setup.expired();
        } else value = await close();
        await send({ type: "runtime.readiness.fixture", id, ok: true, value });
        if (operation === "close") { process.exitCode = 0; process.disconnect?.(); }
      } catch {
        await send({ type: "runtime.readiness.fixture", id, ok: false, code: "runtime_browser_fixture_operation_failed", phase: String(operation), cleanupDiagnostics });
        try { await close(); } catch { /* Explicit failure response remains failure. */ }
        process.exitCode = 1; process.disconnect?.();
      }
    }).catch(() => { process.exitCode = 1; });
  });
  process.on("disconnect", () => { void serial.then(close).catch(() => { process.exitCode = 1; }); });
  await send({ type: "runtime.readiness.fixture.boot", nonce: environment.nonce, pid: process.pid });
}

if (process.argv.includes("--runtime-readiness-browser-fixture") && resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  void runRuntimeReadinessBrowserFixture().catch(() => { process.exitCode = 1; process.stderr.write("runtime_browser_fixture_start_failed\n"); process.disconnect?.(); });
}
