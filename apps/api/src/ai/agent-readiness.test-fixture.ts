import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { generateKeyPair, SignJWT } from "jose";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { erpPermissionContext } from "@yummyai/authz";
import { AGENT_LOOP_VERSION, CreateAgentLoopSchema, defaultAgentLoopLimits } from "@yummyai/contracts/ai/agent-loop";
import { AGENT_NATIVE_V3_VERSION, CreateAgentNativeV3Schema, defaultAgentNativeV3Limits } from "@yummyai/contracts/ai/agent-native-v3";
import { type AgentReadinessFamily } from "@yummyai/contracts/ai/agent-readiness";
import { aiAssistRuns, aiBudgetLedger, aiBudgetPolicies, modelProviderConfigs, modelRoutes, withTenant, type DatabaseConnection } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { requireAgentReadinessEnvironment } from "../../../../tools/testing/require-agent-readiness-environment.mjs";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { IdentitySessionController } from "../auth/identity-session.controller.js";
import { OidcJwtStrategy } from "../auth/oidc-jwt.strategy.js";
import { TenantContextGuard, DatabaseMembershipContextLoader } from "../auth/tenant-context.guard.js";
import { PermissionsGuard } from "../auth/permissions.guard.js";
import { ApiClientRouteGuard } from "../auth/api-client-route.guard.js";
import { ApiClientAuthorityInterceptor } from "../auth/api-client-authority.interceptor.js";
import { AgentLoopService } from "./agent-loop.service.js";
import { AgentNativeV3Service } from "./agent-native-v3.service.js";
import { AgentNativeV3Controller } from "./agent-native-v3.controller.js";
import { AgentReadinessService } from "./agent-readiness.service.js";
import { AgentReadinessController } from "./agent-readiness.controller.js";
import { agentNativeV3Fixture } from "./agent-native-v3.test-fixture.js";
import type { AgentActor } from "./agent-read.test-fixture.js";
import type { AgentPlanDispatcher } from "./agent-plan.service.js";

export const readinessAuthority = (context: TenantContext) => erpSessionAuthority(erpPermissionContext(context));
export const readinessHash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Compose the existing owners, not their fourteen-source/model execution scenario.
 * Every dispatcher below only records original admission; no processor is exposed. */
export function agentReadinessFixture(database: DatabaseConnection) {
  const environment = requireAgentReadinessEnvironment(), original = agentNativeV3Fixture(database), base = original.base;
  const planner = original.prior.legacy.prior;
  const dispatches: Array<Parameters<AgentPlanDispatcher["enqueue"]>[0]> = [];
  const dispatcher: AgentPlanDispatcher = { enqueue: async input => { dispatches.push(input); } };
  const loop = new AgentLoopService(database, base.vault, planner.gateway, dispatcher);
  const plan = planner.service(), nativeV1 = original.prior.legacy.service(), nativeV2 = original.prior.service();
  const nativeV3 = new AgentNativeV3Service(database, base.vault, original.prior.legacy.gateway, original.prior.resources.service,
    planner.owners.service(), planner.owners.adapter, dispatcher, original.fulfillmentService);
  const controls: { afterWorkspace?: (family: AgentReadinessFamily, context: TenantContext) => Promise<void> } = {};
  async function observed<T>(family: AgentReadinessFamily, context: TenantContext, read: () => Promise<T>) {
    const result = await read(); await controls.afterWorkspace?.(family, context); return result;
  }
  const service = () => new AgentReadinessService(database,
    { workspace: context => observed("loop", context, () => loop.workspace(context)) },
    { workspace: context => observed("plan", context, () => plan.workspace(context)) },
    { workspace: context => observed("native_v1", context, () => nativeV1.workspace(context)) },
    { workspace: context => observed("native_v2", context, () => nativeV2.workspace(context)) },
    { workspace: context => observed("native_v3", context, () => nativeV3.workspace(context)) });
  const owners = { loop, plan, native_v1: nativeV1, native_v2: nativeV2, native_v3: nativeV3 };
  const syntheticLegacy: string[] = [];
  let app: INestApplication | undefined, signing: Awaited<ReturnType<typeof generateKeyPair>> | undefined, origin: string | undefined, closed = false;

  async function actor(configureModel = true) {
    const actor = await base.actor();
    let modelId: string | null = null;
    if (configureModel) {
      const providerId = createEntityId();
      // Explicit synthetic model admission, identical to the composed fixture.
      // This sentinel is never decrypted or sent to any provider in this family.
      await withTenant(database.db, actor.context, tx => tx.insert(modelProviderConfigs).values({ id: providerId, tenantId: actor.tenantId,
        provider: "openai-compatible", label: "Synthetic readiness provider", endpoint: "https://synthetic-readiness.invalid/v1",
        encryptedApiKey: base.modelVault.encrypt("synthetic-readiness-no-provider-call"), createdBy: actor.userId }));
      modelId = (await base.assists.addModel(actor.context, { providerConfigId: providerId, model: "synthetic-readiness", label: "Synthetic readiness priced model",
        inputUsdPerMillion: 0, outputUsdPerMillion: 0, maxTaskCostUsd: 1 })).id;
    }
    return { actor, modelId };
  }
  async function policy(actor: AgentActor, values: { monthly?: string; task?: string; caps?: Record<string, number> } = {}) {
    const next = { monthlyCapUsd: values.monthly ?? "100", defaultTaskCapUsd: values.task ?? "1", taskCapsUsd: values.caps ?? {} };
    await withTenant(database.db, actor.context, tx => tx.insert(aiBudgetPolicies).values({ tenantId: actor.tenantId, ...next })
      .onConflictDoUpdate({ target: aiBudgetPolicies.tenantId, set: next }));
  }
  async function modelMode(actor: AgentActor, mode: "disabled" | "unpriced" | "uncapped" | "unsupported") {
    const saved = await withTenant(database.db, actor.context, async tx => ({ routes: await tx.select().from(modelRoutes),
      providers: await tx.select({ id: modelProviderConfigs.id, provider: modelProviderConfigs.provider }).from(modelProviderConfigs) }));
    await withTenant(database.db, actor.context, async tx => {
      if (mode === "unsupported") for (const provider of saved.providers) await tx.update(modelProviderConfigs).set({ provider: "anthropic" }).where(eq(modelProviderConfigs.id, provider.id));
      else for (const route of saved.routes) {
        if (mode === "disabled") await tx.update(modelRoutes).set({ status: "disabled" }).where(eq(modelRoutes.id, route.id));
        else await tx.update(modelRoutes).set({ targets: route.targets.map(target => {
          if (mode === "unpriced") { const rest = { ...target }; delete rest.analysisPricing; return rest; }
          return { ...target, analysisPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0, maxTaskCostUsd: 0.0000001 } };
        }) }).where(eq(modelRoutes.id, route.id));
      }
    });
    return async () => withTenant(database.db, actor.context, async tx => {
      for (const route of saved.routes) await tx.update(modelRoutes).set({ status: route.status, targets: route.targets }).where(eq(modelRoutes.id, route.id));
      for (const provider of saved.providers) await tx.update(modelProviderConfigs).set({ provider: provider.provider }).where(eq(modelProviderConfigs.id, provider.id));
    });
  }
  async function ledger(actor: AgentActor, amountUsd: string, state: "reserved" | "committed" | "released", previousMonth = false) {
    const id = createEntityId();
    await withTenant(database.db, actor.context, tx => tx.insert(aiBudgetLedger).values({ id, tenantId: actor.tenantId, requestId: createEntityId(),
      taskType: "synthetic_readiness_budget_boundary", modelKey: "synthetic-readiness", provider: "openai-compatible", amountUsd, state,
      ...(previousMonth ? { createdAt: sql`date_trunc('month',clock_timestamp() at time zone 'UTC') at time zone 'UTC' - interval '1 microsecond'` } : {}) }));
    return id;
  }
  async function legacyUnknown(actor: AgentActor, variant: "unknown" | "not_started" | "not_submitted" | "known_zero" | "bounded" | "previous_month") {
    const id = createEntityId(); syntheticLegacy.push(id);
    // A synthetic legacy predicate boundary, not a genuine historical upgrade,
    // provider submission, charged call, or fabricated original-owner receipt.
    await withTenant(database.db, actor.context, async tx => {
      await tx.insert(aiAssistRuns).values({ id, tenantId: actor.tenantId, ownerId: actor.userId, requestId: randomUUID(), kind: "knowledge_answer",
        scope: "synthetic-readiness-legacy-only", status: "failed", inputFingerprint: readinessHash(id + ":input"), requestFingerprint: readinessHash(id + ":request"),
        modelSnapshot: { id: createEntityId(), label: "Synthetic legacy unknown-cost boundary", model: "synthetic-legacy", providerLabel: "Synthetic only",
          providerConfigId: createEntityId(), inputUsdPerMillion: null, outputUsdPerMillion: null, maxTaskCostUsd: variant === "bounded" ? 1 : null },
        promptVersion: "synthetic-readiness-legacy-predicate", reservedCostUsd: "0", costUsd: variant === "known_zero" ? "0" : null,
        startedAt: variant === "not_started" ? null : sql`clock_timestamp()`, completedAt: sql`clock_timestamp()`, expiresAt: sql`clock_timestamp()+interval '1 day'`,
        ...(variant === "previous_month" ? { createdAt: sql`date_trunc('month',clock_timestamp() at time zone 'UTC') at time zone 'UTC' - interval '1 microsecond'` } : {}) });
      if (variant === "not_submitted") await tx.execute(sql`insert into ai_assist_executions(run_id,tenant_id,input_fingerprint,policy_checksum,phase,submission_state)
        values(${id}::uuid,${actor.tenantId}::uuid,${readinessHash(id + ":input")},${readinessHash(id + ":policy")},'failed','not_submitted')`);
    });
    return id;
  }
  async function nativeRequest(actor: AgentActor, modelId: string, maxCostUsd = 1) {
    const workspace = await nativeV3.workspace(await base.current(actor));
    return CreateAgentNativeV3Schema.parse({ version: AGENT_NATIVE_V3_VERSION, requestId: randomUUID(), modelId, maxCostUsd,
      goal: "Synthetic queued readiness admission only", contextText: "No processor or model is invoked", bindings: [{ tool: "inventory.balances.page", scope: {} }],
      allowedCommands: [], limits: defaultAgentNativeV3Limits(), executionContract: workspace.executionContract });
  }
  async function loopRequest(actor: AgentActor, modelId: string) {
    const workspace = await loop.workspace(await base.current(actor));
    return CreateAgentLoopSchema.parse({ version: AGENT_LOOP_VERSION, requestId: randomUUID(), modelId, maxCostUsd: 1,
      goal: "Synthetic queued readiness admission only", allowedTools: ["inventory.balances.page"], limits: defaultAgentLoopLimits(), executionContract: workspace.executionContract });
  }
  async function state(actor: AgentActor) {
    const tables: Record<string, { count: number; sha256: string }> = {};
    await withTenant(database.db, actor.context, async tx => {
      for (const table of ["ai_assist_runs", "ai_assist_executions", "agent_plan_runs", "agent_plan_steps", "agent_plan_items", "agent_loop_runs", "agent_loop_steps",
        "agent_command_requests", "ai_budget_ledger", "ai_budget_policies", "model_billing_reconciliations", "model_provider_configs", "model_routes", "audit_events",
        "inventory_balances", "inventory_movements", "orders", "order_events", "knowledge_entries", "knowledge_versions"]) {
        const [row] = await tx.execute<{ count: number; text: string }>(sql`select count(*)::int as count,coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]') as text from ${sql.identifier(table)} t`);
        if (!row) throw new Error("readiness_fixture_snapshot_missing");
        tables[table] = { count: row.count, sha256: readinessHash(row.text) };
      }
    });
    return { tables, dispatches: dispatches.length + base.dispatches.length + planner.dispatcherCalls.length + original.prior.legacy.dispatcherCalls.length + original.prior.dispatches.length,
      modelCalls: base.providerRequests.length + planner.modelCalls.length + original.prior.legacy.modelCalls.length + original.prior.modelCalls.length + original.modelCalls.length,
      sourceCalls: original.readCalls.length + original.prior.readCalls.length + original.prior.legacy.readCalls.length + planner.readCalls.length };
  }
  async function token(actor: AgentActor) {
    signing ??= await generateKeyPair("RS256");
    return new SignJWT({ tenant_id: actor.tenantId }).setProtectedHeader({ alg: "RS256" }).setSubject(actor.subject)
      .setIssuer("https://synthetic-readiness-oidc.invalid").setAudience("synthetic-readiness-api").setIssuedAt().setExpirationTime("5m").sign(signing.privateKey);
  }
  async function startHttp() {
    if (origin) return origin;
    signing ??= await generateKeyPair("RS256");
    @Module({ controllers: [IdentitySessionController, AgentReadinessController, AgentNativeV3Controller], providers: [
      { provide: DATABASE_CONNECTION, useValue: database }, { provide: AgentReadinessService, useValue: service() }, { provide: AgentNativeV3Service, useValue: nativeV3 },
    ] })
    class ReadinessPersonalModule {}
    app = await NestFactory.create(ReadinessPersonalModule, { logger: false, abortOnError: false });
    const reflector = new Reflector();
    app.useGlobalGuards(new TenantContextGuard(new OidcJwtStrategy({ issuer: "https://synthetic-readiness-oidc.invalid", audience: "synthetic-readiness-api", verificationKey: signing.publicKey }),
      new DatabaseMembershipContextLoader(database), base.loader, reflector), new PermissionsGuard(reflector), new ApiClientRouteGuard(reflector));
    app.useGlobalInterceptors(new ApiClientAuthorityInterceptor(base.loader));
    await app.listen(0, "127.0.0.1"); origin = await app.getUrl(); return origin;
  }
  async function http(actor: AgentActor, path: string, method: "GET" | "POST" = "GET") {
    if (!path.startsWith("/v1/ai/agent-readiness/") && !path.startsWith("/v1/agent-native-v3/") && path !== "/v1/identity/session") throw new Error("readiness_fixture_path_invalid");
    return fetch(new URL(path, await startHttp()), { method, redirect: "error", headers: { authorization: `Bearer ${await token(actor)}`,
      "x-yummyai-context-authority": readinessAuthority(await base.current(actor)), ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}) });
  }
  async function close() {
    if (closed) return; closed = true; controls.afterWorkspace = undefined;
    const errors: unknown[] = [];
    for (const done of [() => app?.close(), () => original.close()]) try { await done(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "readiness_fixture_cleanup_failed");
  }
  return { environment, original, base, owners, service, controls, actor, policy, modelMode, ledger, legacyUnknown, syntheticLegacy,
    nativeRequest, loopRequest, state, http, close, initialize: original.initialize };
}
