import "reflect-metadata";
import { createHash, randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { HttpException, Module, type CallHandler, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { generateKeyPair, SignJWT } from "jose";
import { tap } from "rxjs";
import { SecretVault } from "@yummyai/ai-core";
import type { TenantContext } from "@yummyai/contracts";
import {
  AGENT_FULFILLMENT_COMMAND_VERSION, PrepareAgentFulfillmentCommandSchema, ConfirmAgentFulfillmentCommandSchema,
  CancelAgentFulfillmentCommandSchema, AcknowledgeAgentFulfillmentCommandSchema,
  type AgentFulfillmentCommandView,
} from "@yummyai/contracts/ai/agent-fulfillment-command";
import type { FulfillmentCommandKind } from "@yummyai/contracts/order/fulfillment-command";
import { withTenant, type DatabaseConnection } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { requireAgentFulfillmentCommandEnvironment } from "../../../../tools/testing/require-agent-fulfillment-command-environment.mjs";
import { orderFulfillmentCommandFixture, fulfillmentCommandBounded } from "../orders/order-fulfillment-command.test-fixture.js";
import { IdentitySessionController } from "../auth/identity-session.controller.js";
import { OidcJwtStrategy } from "../auth/oidc-jwt.strategy.js";
import { TenantContextGuard, DatabaseMembershipContextLoader, DatabaseApiClientContextLoader } from "../auth/tenant-context.guard.js";
import { PermissionsGuard } from "../auth/permissions.guard.js";
import { ApiClientRouteGuard } from "../auth/api-client-route.guard.js";
import { ApiClientAuthorityInterceptor } from "../auth/api-client-authority.interceptor.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { AgentFulfillmentCommandOwner } from "./agent-fulfillment-command-owner.js";
import { AgentFulfillmentCommandService } from "./agent-fulfillment-command.service.js";
import { AgentFulfillmentCommandController } from "./agent-fulfillment-command.controller.js";

export const agentFulfillmentHash = (value: string) => createHash("sha256").update(value).digest("hex");
export { fulfillmentCommandBounded as agentFulfillmentBounded };
const version = AGENT_FULFILLMENT_COMMAND_VERSION;
const prefix = "/v1/agent-fulfillment-commands";

/** Only source admission, test identities and operator physical attestations are
 * synthetic. The original fixture owns every original preparation, manufacturing
 * prerequisite, mutation and receipt. This wrapper adds no business SQL writer. */
export function agentFulfillmentCommandFixture(database: DatabaseConnection) {
  const isolated = requireAgentFulfillmentCommandEnvironment(), original = orderFulfillmentCommandFixture(database);
  const vault = new SecretVault(randomBytes(32));
  const hooks: { afterRead?: () => Promise<void>; afterPrepare?: () => Promise<void> } = {};
  const preparedIntents = new Map<string, string>();
  class ObservedAgentOwner extends AgentFulfillmentCommandOwner {
    override async read(...args: Parameters<AgentFulfillmentCommandOwner["read"]>) {
      const actual = await super.read(...args); await hooks.afterRead?.(); return actual;
    }
    override async prepare(...args: Parameters<AgentFulfillmentCommandOwner["prepare"]>) {
      const actual = await super.prepare(...args); preparedIntents.set(actual.id, args[1].orderId); await hooks.afterPrepare?.(); return actual;
    }
  }
  const owner = new ObservedAgentOwner(original.service());
  const service = (ttl?: number) => new AgentFulfillmentCommandService(database, vault, owner, original.owners.audit, ttl);
  const tokens = new Map<string, string>(), running = new Set<Promise<unknown>>(), releases = new Set<() => void>();
  const httpCalls: Array<{ method: "GET" | "POST"; path: string; queryKeys: string[]; bodyHash: string | null }> = [];
  const lostResponses = { prepare: 0, confirm: 0 };
  const cleanupDiagnostics: Array<{ id: string; orderId: string; phase: "read" | "lease_wait" | "lease_expired" | "cancel" | "acknowledge" | "verified" | "failed";
    status: AgentFulfillmentCommandView["native"]["status"] | null; canCancel: boolean; leasePresent: boolean; errorCode: string | null }> = [];
  let app: INestApplication | undefined, origin: string | undefined, keys: Awaited<ReturnType<typeof generateKeyPair>> | undefined;
  let drop: { operation: "prepare" | "confirm"; id: string | null } | null = null, closed = false;
  const current = original.current;
  async function command(kind: FulfillmentCommandKind, actor = original.a) {
    const value = await original.command(kind, actor);
    return { ...value, input: PrepareAgentFulfillmentCommandSchema.parse({ version, orderId: value.scene.order.id, original: value.command }) };
  }
  const query = (orderId: string) => ({ version, orderId });
  const lookup = (view: AgentFulfillmentCommandView) => ({ ...query(view.native.orderId), requestId: view.native.requestId, requestChecksum: view.native.requestChecksum });
  function confirmation(view: AgentFulfillmentCommandView) {
    return ConfirmAgentFulfillmentCommandSchema.parse({ ...lookup(view), originalChecksum: view.originalChecksum,
      confirmationToken: view.confirmationToken, decision: view.confirmationDecision });
  }
  const cancellation = (view: AgentFulfillmentCommandView) => CancelAgentFulfillmentCommandSchema.parse({ ...lookup(view), decision: "cancel_original" });
  const acknowledgement = (view: AgentFulfillmentCommandView) => AcknowledgeAgentFulfillmentCommandSchema.parse({ ...lookup(view), decision: "acknowledge_original" });
  function confirm(context: TenantContext, view: AgentFulfillmentCommandView, input = confirmation(view), ttl?: number) {
    const promise = service(ttl).confirm(context, view.native.id, input); running.add(promise);
    void promise.then(() => running.delete(promise), () => running.delete(promise)); return promise;
  }
  function hold(phase: Parameters<typeof original.hold>[0]) {
    const gate = original.hold(phase); releases.add(gate.release);
    return { entered: gate.entered, release() { gate.release(); releases.delete(gate.release); } };
  }
  function holdAgent(phase: keyof typeof hooks) {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(done => { enter = done; }), released = new Promise<void>(done => { release = done; });
    hooks[phase] = async () => { hooks[phase] = undefined; enter(); await released; }; releases.add(release);
    return { entered, release() { release(); releases.delete(release); } };
  }
  async function token(actor = original.a) {
    const prior = tokens.get(actor.userId); if (prior) return prior;
    keys ??= await generateKeyPair("RS256");
    const value = await new SignJWT({ tenant_id: actor.tenantId }).setProtectedHeader({ alg: "RS256" }).setSubject(`capacity-${actor.userId}`)
      .setIssuer("https://synthetic-agent-fulfillment.invalid").setAudience("synthetic-agent-fulfillment-api")
      .setIssuedAt().setExpirationTime("30m").sign(keys.privateKey);
    tokens.set(actor.userId, value); return value;
  }
  async function startHttp() {
    if (origin) return origin; keys ??= await generateKeyPair("RS256");
    @Module({ controllers: [AgentFulfillmentCommandController, IdentitySessionController], providers: [
      { provide: DATABASE_CONNECTION, useValue: database }, { provide: AgentFulfillmentCommandService, useValue: service() },
    ] }) class AgentFulfillmentPersonalModule {}
    app = await NestFactory.create(AgentFulfillmentPersonalModule, { logger: false, abortOnError: false });
    const reflector = new Reflector(), clients = new DatabaseApiClientContextLoader(database);
    app.useGlobalGuards(new TenantContextGuard(new OidcJwtStrategy({ issuer: "https://synthetic-agent-fulfillment.invalid", audience: "synthetic-agent-fulfillment-api", verificationKey: keys.publicKey }),
      new DatabaseMembershipContextLoader(database), clients, reflector), new PermissionsGuard(reflector), new ApiClientRouteGuard(reflector));
    app.useGlobalInterceptors(new ApiClientAuthorityInterceptor(clients), { intercept(context: ExecutionContext, next: CallHandler) {
      const request = context.switchToHttp().getRequest<{ method: string; url: string }>();
      return next.handle().pipe(tap(() => {
        const selected = drop;
        if (selected && request.method === "POST" && request.url === (selected.operation === "prepare" ? `${prefix}/prepare` : `${prefix}/requests/${selected.id}/confirm`)) {
          drop = null; lostResponses[selected.operation]++; context.switchToHttp().getResponse<ServerResponse>().destroy();
        }
      }));
    } });
    await app.listen(0, "127.0.0.1"); origin = await app.getUrl(); return origin;
  }
  async function http(actor: TenantContext, path: string, body?: unknown) {
    const url = new URL(path, "http://fixture.invalid");
    if (url.origin !== "http://fixture.invalid" || !/^\/(?:workspace|prepare|receipts|requests(?:\/[a-f0-9-]{36}(?:\/(?:confirm|cancel|acknowledge))?)?)$/.test(url.pathname)
      || [...url.searchParams.keys()].some(key => !["version", "orderId", "lineId", "requestId", "requestChecksum"].includes(key)))
      throw new Error("agent_fulfillment_fixture_http_path_invalid");
    const method = body === undefined ? "GET" : "POST";
    httpCalls.push({ method, path: url.pathname, queryKeys: [...url.searchParams.keys()].sort(), bodyHash: body === undefined ? null : agentFulfillmentHash(JSON.stringify(body)) });
    return fetch(`${await startHttp()}${prefix}${url.pathname}${url.search}`, { method, redirect: "error",
      headers: { authorization: `Bearer ${await token(actor)}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function settle() {
    // Release and join Agent-started writers before the original fixture
    // inspects/cancels its intents. Cleanup cannot race a held confirmation.
    hooks.afterRead = undefined; hooks.afterPrepare = undefined;
    original.hooks.beforeExecute = undefined; original.hooks.afterExecute = undefined; original.hooks.afterDescribe = undefined; original.hooks.afterLocate = undefined;
    for (const release of releases) release(); releases.clear();
    await Promise.allSettled([...running]); drop = null;
    for (const actor of [original.a, original.peer, original.foreign]) {
      await original.membership(actor, "active"); await original.permissions(actor, original.allPermissions);
    }
    const failures: unknown[] = [];
    for (const [id, orderId] of preparedIntents) {
      let view: AgentFulfillmentCommandView | null = null;
      const record = (phase: typeof cleanupDiagnostics[number]["phase"], errorCode: string | null = null) => cleanupDiagnostics.push({ id, orderId, phase,
        status: view?.native.status ?? null, canCancel: view?.canCancel ?? false, leasePresent: view?.native.leaseExpiresAt !== null && view?.native.leaseExpiresAt !== undefined, errorCode });
      try {
        view = await service().get(await current(), id, query(orderId)); record("read");
        // A denied late writer may leave its real claim until the original
        // 120s lease expires. Observe the database clock; never rewrite a lease,
        // issue an execute, inject a clock or pretend this is already cancelled.
        if (view.native.status === "executing" && view.native.leaseExpiresAt) {
          const deadline = view.native.leaseExpiresAt; record("lease_wait");
          await fulfillmentCommandBounded((async () => {
            for (;;) {
              const [clock] = await withTenant(database.db, original.a, tx => tx.execute<{ expired: boolean }>(sql`select clock_timestamp()>=${deadline}::timestamptz as expired`));
              if (clock?.expired) return; await new Promise<void>(done => setTimeout(done, 100));
            }
          })(), "agent_fulfillment_fixture_actual_lease_expiry_not_observed", 130_000);
          record("lease_expired");
          view = await service().get(await current(), id, query(orderId)); record("read");
        }
        if (view.canCancel) { view = await service().cancel(await current(), id, cancellation(view)); record("cancel"); }
        if (["succeeded", "rejected", "cancelled", "expired"].includes(view.native.status)) {
          view = await service().acknowledge(await current(), id, acknowledgement(view)); record("acknowledge");
        }
        if (!view.native.acknowledged) throw new Error("agent_fulfillment_fixture_unresolved_original_at_close");
        record("verified"); preparedIntents.delete(id);
      } catch (error) {
        const response = error instanceof HttpException ? error.getResponse() : null;
        const code = response && typeof response === "object" && "code" in response && typeof response.code === "string"
          && /^(?:agent_fulfillment_command_[a-z_]+|authority_changed)$/.test(response.code) ? response.code : null;
        record("failed", code); failures.push(error);
      }
    }
    try { await original.settle(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "agent_fulfillment_fixture_settle_failed");
  }
  async function close() {
    if (closed) return; closed = true; const failures: unknown[] = [];
    try { await settle(); } catch (error) { failures.push(error); }
    try { await app?.close(); } catch (error) { failures.push(error); }
    try { await original.close(); } catch (error) { failures.push(error); }
    tokens.clear(); if (failures.length) throw new AggregateError(failures, "agent_fulfillment_fixture_close_failed");
  }
  return { isolated, original, vault, owner, hooks, service, current, initialize: original.initialize, command, query, lookup,
    confirmation, cancellation, acknowledgement, confirm, hold, holdAgent, token, startHttp, http, httpCalls, lostResponses, cleanupDiagnostics,
    loseResponse(operation: "prepare" | "confirm", id: string | null = null) { drop = { operation, id }; }, settle, close };
}
