import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { HttpException, Module, type INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { generateKeyPair, SignJWT } from "jose";
import { Permission, erpPermissionContext, intersectPermissionContexts } from "@yummyai/authz";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AGENT_COMMAND_VERSION, ConfirmAgentCommandSchema, PrepareAgentCommandSchema, type AgentCommandView } from "@yummyai/contracts/ai/agent-command";
import { AGENT_DEPENDENCY_PLAN_KIND, AGENT_DEPENDENCY_PLAN_VERSION, CreateAgentDependencyPlanSchema,
  PrepareAgentDependencyPlanSchema, canonicalAgentDependencyPlanRequest, type AgentDependencyPlanView } from "@yummyai/contracts/ai/agent-dependency-plan";
import { agentCommandRequests, agentDependencyPlans, loadCurrentMembershipContext, memberships, roles, withTenant, type DatabaseConnection } from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";
import { requireAgentDependencyPlanEnvironment } from "../../../../tools/testing/require-agent-dependency-plan-environment.mjs";
import { invoiceCommandFixture } from "../procurement/invoice-command.fixtures.js";
import { IdentitySessionController } from "../auth/identity-session.controller.js";
import { OidcJwtStrategy } from "../auth/oidc-jwt.strategy.js";
import { ApiClientRouteGuard } from "../auth/api-client-route.guard.js";
import { ApiClientAuthorityInterceptor } from "../auth/api-client-authority.interceptor.js";
import { DatabaseApiClientContextLoader, DatabaseMembershipContextLoader, TenantContextGuard } from "../auth/tenant-context.guard.js";
import { PermissionsGuard } from "../auth/permissions.guard.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { AgentCommandController } from "./agent-command.controller.js";
import { AgentCommandService } from "./agent-command.service.js";
import { agentCommandOwners } from "./agent-command.test-fixture.js";
import { AgentDependencyPlanSource } from "./agent-dependency-plan-source.js";
import { AgentDependencyPlanService } from "./agent-dependency-plan.service.js";
import { AgentDependencyPlanController } from "./agent-dependency-plan.controller.js";

export const dependencyHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const dependencyDigest = (value: unknown) => dependencyHash(canonicalJson(value));
export const dependencyAuthority = (context: TenantContext) => erpSessionAuthority(erpPermissionContext(context));
export const dependencyPermissions = [Permission.WorkflowRead, Permission.WorkflowRun, Permission.ProcurementRead, Permission.ProcurementWrite,
  Permission.ProcurementApprove, Permission.InventoryRead, Permission.InventoryWrite, Permission.ProductRead, Permission.ProductWrite,
  Permission.FinanceRead, Permission.FinanceWrite, Permission.FinanceReview];
export function dependencyErrorStatus(error: unknown): number | null {
  if (error instanceof HttpException) return error.getStatus();
  return error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : null;
}
export function dependencyErrorCode(error: unknown): string | null {
  if (error instanceof HttpException) {
    const value = error.getResponse();
    if (value && typeof value === "object" && "code" in value && typeof value.code === "string" && /^(?:agent_dependency_plan_|agent_command_|authority_changed$)[a-z0-9_]*$/.test(value.code)) return value.code;
  }
  for (let depth = 0; depth < 3 && error && typeof error === "object"; depth++) {
    if ("code" in error && typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)) return error.code;
    error = "cause" in error ? error.cause : undefined;
  }
  return null;
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(done => { release = done; });
  return { promise, release };
}

/** The only synthetic admissions are disposable identities and source inputs.
 * Every invoice, allocation, owner command, bill and audit is an original owner
 * result. No model, Worker, queue consumer or external supplier is constructed. */
export function agentDependencyPlanFixture(database: DatabaseConnection) {
  const isolated = requireAgentDependencyPlanEnvironment(), invoices = invoiceCommandFixture(database), owners = agentCommandOwners(database);
  const a = TenantContextSchema.parse({ ...invoices.context, permissions: dependencyPermissions });
  const peer = TenantContextSchema.parse({ ...invoices.coworker, permissions: dependencyPermissions });
  const foreign = TenantContextSchema.parse({ ...invoices.outsider, permissions: dependencyPermissions });
  const commands = owners.service(), controls: { afterSource?: () => Promise<void> } = {}, releases = new Set<() => void>();
  const issued = new Map<string, string>(), ownedParents = new Set<string>();
  let app: INestApplication | undefined, origin: string | undefined, signing: Awaited<ReturnType<typeof generateKeyPair>> | undefined, closed = false;
  class ObservedSource extends AgentDependencyPlanSource {
    override async read(context: TenantContext, parentAgentCommandId: string) {
      const actual = await super.read(context, parentAgentCommandId); await controls.afterSource?.(); return actual;
    }
  }
  const source = new ObservedSource(database, commands, owners.procurementOwner);
  const service = () => new AgentDependencyPlanService(database, commands, source, owners.audit);
  async function current(actor = a) {
    return withTenant(database.db, actor, async tx => TenantContextSchema.parse(intersectPermissionContexts(actor, await loadCurrentMembershipContext(tx, actor))));
  }
  async function initialize() {
    requireAgentDependencyPlanEnvironment(); await invoices.initialize();
    for (const actor of [a, peer, foreign]) await setPermissions(actor, dependencyPermissions);
  }
  async function setPermissions(actor: TenantContext, values: readonly string[], scope: TenantContext["dataScope"] = "tenant") {
    const roleId = invoices.roleIds.get(actor.userId); if (!roleId) throw new Error("dependency_fixture_original_role_missing");
    const changed = await withTenant(database.db, actor, tx => tx.update(roles).set({ permissions: [...values], dataScope: scope })
      .where(eq(roles.id, roleId)).returning({ id: roles.id }));
    if (changed.length !== 1) throw new Error("dependency_fixture_original_role_changed");
  }
  async function permissions(actor: TenantContext, values: readonly string[], scope: TenantContext["dataScope"] = "tenant") {
    const before = await current(actor); await setPermissions(actor, values, scope);
    return { before, after: await current(actor), restore: () => setPermissions(actor, dependencyPermissions) };
  }
  async function membership(actor: TenantContext, status: "active" | "disabled") {
    await withTenant(database.db, actor, tx => tx.update(memberships).set({ status }).where(eq(memberships.userId, actor.userId)));
  }
  async function basis() {
    const actual = await invoices.basis(), original = invoices.original(actual.order.id);
    const input = PrepareAgentCommandSchema.parse({ version: AGENT_COMMAND_VERSION, requestId: randomUUID(), original: { domain: "procurement", command: original } });
    const parent = await commands.prepare(await current(), input); ownedParents.add(parent.id);
    if (parent.domain !== "procurement" || parent.kind !== "invoice_record" || !parent.ownerCommandId) throw new Error("dependency_fixture_parent_not_original_invoice");
    return { ...actual, original, input, parent };
  }
  function request(parent: Pick<AgentCommandView, "id">, dueAt: string | null = null, requestId = randomUUID()) {
    return CreateAgentDependencyPlanSchema.parse({ version: AGENT_DEPENDENCY_PLAN_VERSION, kind: AGENT_DEPENDENCY_PLAN_KIND, requestId, parentAgentCommandId: parent.id, dueAt });
  }
  const receipt = (raw: unknown) => { const input = CreateAgentDependencyPlanSchema.parse(raw); return { requestId: input.requestId, requestChecksum: dependencyHash(canonicalAgentDependencyPlanRequest(input)) }; };
  function prepareInput(view: AgentDependencyPlanView) {
    if (!view.source) throw new Error("dependency_fixture_actual_source_missing");
    return PrepareAgentDependencyPlanSchema.parse({ version: AGENT_DEPENDENCY_PLAN_VERSION, requestId: view.requestId, sourceChecksum: view.source.sourceChecksum });
  }
  const confirmation = (view: AgentCommandView) => ConfirmAgentCommandSchema.parse({ version: AGENT_COMMAND_VERSION, requestId: view.requestId,
    ownerCommandId: view.ownerCommandId, originalChecksum: view.originalChecksum, confirmationToken: view.confirmationToken, decision: "execute_original" });
  async function completeParent(parent: Pick<AgentCommandView, "id">) {
    const actual = await commands.get(await current(), parent.id);
    return commands.confirm(await current(), actual.id, confirmation(actual));
  }
  function holdSource() {
    const entered = deferred(), held = deferred(); let used = false;
    const release = () => { held.release(); releases.delete(release); }; releases.add(release);
    controls.afterSource = async () => { if (used) return; used = true; entered.release(); await held.promise; };
    return { entered: entered.promise, release, clear() { release(); controls.afterSource = undefined; } };
  }
  async function rows(actor = a) {
    return withTenant(database.db, actor, async tx => ({
      plans: await tx.select().from(agentDependencyPlans).where(eq(agentDependencyPlans.ownerId, actor.userId)),
      commands: await tx.select({ id: agentCommandRequests.id, requestId: agentCommandRequests.requestId, requestChecksum: agentCommandRequests.requestChecksum,
        originalChecksum: agentCommandRequests.originalChecksum, ownerCommandId: agentCommandRequests.ownerCommandId, binding: agentCommandRequests.binding,
        originCeiling: agentCommandRequests.originCeiling, createdAt: agentCommandRequests.createdAt }).from(agentCommandRequests).where(eq(agentCommandRequests.ownerId, actor.userId)),
      audits: await tx.execute<{ id: string; action: string; entity_id: string; metadata: unknown }>(sql`select id,action,entity_id,metadata from audit_events
        where action like 'agent.dependency_plan.%' order by id`),
    }));
  }
  async function business(actor = a) {
    return withTenant(database.db, actor, async tx => {
      const tables: Record<string, { count: number; sha256: string }> = {};
      for (const table of ["inventory_supplier_invoices", "inventory_supplier_invoice_lines", "inventory_supplier_invoice_requests", "inventory_supplier_invoice_allocations",
        "inventory_purchase_orders", "inventory_purchase_order_versions", "inventory_movements", "inventory_balances", "inventory_reservations",
        "finance_payable_bills", "finance_payable_payments", "finance_original_write_proofs", "orders", "production_orders", "ai_budget_ledger", "agent_plan_runs", "agent_plan_steps", "agent_loop_runs"]) {
        const [value] = await tx.execute<{ count: number; canonical: string }>(sql`select count(*)::int as count,coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]') as canonical from ${sql.identifier(table)} t`);
        if (!value) throw new Error("dependency_fixture_business_snapshot_missing"); tables[table] = { count: value.count, sha256: dependencyHash(value.canonical) };
      }
      return { tables, modelCalls: 0 as const, providerCalls: 0 as const, queueDispatches: 0 as const };
    });
  }
  async function result(view: AgentDependencyPlanView) {
    return withTenant(database.db, a, async tx => {
      const [invoice] = await tx.execute<{ id: string; purchase_order_id: string; currency: string; total_minor: string; invoice_number: string }>(sql`select id,purchase_order_id,currency,total_minor::text as total_minor,invoice_number from inventory_supplier_invoices where id=${view.source?.invoiceId ?? null}::uuid`);
      const [proof] = await tx.execute<{ id: string; invoice_id: string; created_by: string }>(sql`select id,invoice_id,created_by from inventory_supplier_invoice_requests where id=${view.source?.procurementProofId ?? null}::uuid`);
      const [bill] = await tx.execute<{ id: string; procurement_invoice_id: string; procurement_proof_id: string; supplier_id: string; currency: string; amount_minor: string; request_key: string; recorded_by: string }>(sql`select id,procurement_invoice_id,procurement_proof_id,supplier_id,currency,amount_minor::text as amount_minor,idempotency_key as request_key,recorded_by from finance_payable_bills where procurement_invoice_id=${view.source?.invoiceId ?? null}::uuid`);
      return { invoice, proof, bill };
    });
  }
  async function token(actor: TenantContext) {
    let value = issued.get(actor.userId); if (value) return value; signing ??= await generateKeyPair("RS256");
    value = await new SignJWT({ tenant_id: actor.tenantId }).setProtectedHeader({ alg: "RS256" }).setSubject("procurement-command-" + actor.userId)
      .setIssuer("https://synthetic-dependency-plan-oidc.invalid").setAudience("synthetic-dependency-plan-api").setIssuedAt().setExpirationTime("20m").sign(signing.privateKey);
    issued.set(actor.userId, value); return value;
  }
  async function startHttp() {
    if (origin) return origin; signing ??= await generateKeyPair("RS256");
    @Module({ controllers: [AgentDependencyPlanController, AgentCommandController, IdentitySessionController], providers: [
      { provide: DATABASE_CONNECTION, useValue: database }, { provide: AgentDependencyPlanService, useValue: service() }, { provide: AgentCommandService, useValue: commands },
    ] }) class DependencyPlanPersonalModule {}
    app = await NestFactory.create(DependencyPlanPersonalModule, { logger: false, abortOnError: false });
    const reflector = new Reflector(), clients = new DatabaseApiClientContextLoader(database);
    app.useGlobalGuards(new TenantContextGuard(new OidcJwtStrategy({ issuer: "https://synthetic-dependency-plan-oidc.invalid", audience: "synthetic-dependency-plan-api", verificationKey: signing.publicKey }),
      new DatabaseMembershipContextLoader(database), clients, reflector), new PermissionsGuard(reflector), new ApiClientRouteGuard(reflector));
    app.useGlobalInterceptors(new ApiClientAuthorityInterceptor(clients)); await app.listen(0, "127.0.0.1"); origin = await app.getUrl(); return origin;
  }
  async function http(actor: TenantContext, path: string, body?: unknown) {
    if (!/^\/v1\/(?:identity\/session|agent-dependency-plans(?:\/[a-z0-9/-]*)?|agent-commands(?:\/[a-z0-9/-]*)?)(?:\?|$)/.test(path)) throw new Error("dependency_fixture_http_path_invalid");
    return fetch(new URL(path, await startHttp()), { method: body === undefined ? "GET" : "POST", redirect: "error", headers: {
      authorization: "Bearer " + await token(actor), "x-yummyai-context-authority": dependencyAuthority(await current(actor)),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function settle() {
    controls.afterSource = undefined; for (const release of releases) release();
    for (const actor of [a, peer, foreign]) { await membership(actor, "active"); await setPermissions(actor, dependencyPermissions); }
    const live = await current();
    const own = await withTenant(database.db, live, tx => tx.select({ id: agentCommandRequests.id }).from(agentCommandRequests).where(and(eq(agentCommandRequests.ownerId, a.userId))));
    for (const row of own) {
      let view = await commands.get(live, row.id);
      if (view.canCancel && view.ownerCommandId) view = await commands.cancel(live, view.id, { version: AGENT_COMMAND_VERSION, requestId: view.requestId, ownerCommandId: view.ownerCommandId });
      if (view.snapshot && view.ownerCommandId && !view.snapshot.native.view.acknowledged && view.snapshot.native.view.status !== "prepared")
        await commands.acknowledge(live, view.id, { version: AGENT_COMMAND_VERSION, requestId: view.requestId, ownerCommandId: view.ownerCommandId });
    }
    ownedParents.clear();
  }
  async function close() {
    if (closed) return; closed = true; const errors: unknown[] = [];
    try { await settle(); } catch (error) { errors.push(error); }
    try { await app?.close(); } catch (error) { errors.push(error); }
    issued.clear(); if (errors.length) throw new AggregateError(errors, "dependency_fixture_close_failed");
  }
  return { isolated, invoices, owners, commands, source, service, a, peer, foreign, current, initialize, permissions, membership, basis,
    request, receipt, prepareInput, confirmation, completeParent, holdSource, rows, business, result, token, http, startHttp, settle, close };
}
