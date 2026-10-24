import "reflect-metadata";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Module, type INestApplication, type NestInterceptor, type ExecutionContext, type CallHandler } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { generateKeyPair, SignJWT } from "jose";
import { mergeMap } from "rxjs";
import { z } from "zod";
import { createEnvironmentSecretVault } from "@yummyai/ai-core";
import { intersectPermissionContexts } from "@yummyai/authz";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { AGENT_MCP_TOOL_NAMES, AgentMcpPacketSchema } from "@yummyai/contracts/ai/agent-mcp";
import { AGENT_COMMAND_VERSION } from "@yummyai/contracts/ai/agent-command";
import { AgentNativeItemReceiptSchema, AgentNativeViewSchema } from "@yummyai/contracts/ai/agent-native";
import { createQueue, JobEnvelopeSchema, QueueName } from "@yummyai/jobs";
import { connectDatabase, loadCurrentMembershipContext, withTenant, type DatabaseConnection } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { ApiClientAuthorityInterceptor } from "../auth/api-client-authority.interceptor.js";
import { ApiClientRouteGuard } from "../auth/api-client-route.guard.js";
import { IdentitySessionController } from "../auth/identity-session.controller.js";
import { OidcJwtStrategy } from "../auth/oidc-jwt.strategy.js";
import { PermissionsGuard } from "../auth/permissions.guard.js";
import { TenantContextGuard, DatabaseMembershipContextLoader } from "../auth/tenant-context.guard.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { agentPlanRuntimeRouter } from "../../../worker/src/agent-plan-runtime-router.js";
import { AgentPlanProcessor } from "../../../worker/src/processors/agent-plan.processor.js";
import { AgentCommandController } from "./agent-command.controller.js";
import { AgentCommandService } from "./agent-command.service.js";
import { AgentNativeController } from "./agent-native.controller.js";
import { AgentNativeService } from "./agent-native.service.js";
import { agentNativeFixture, nativeSequence, requireAgentNativeEnvironment } from "./agent-native.test-fixture.js";
import { AgentToolsController } from "./agent-tools.controller.js";
import { AgentToolsService } from "./agent-tools.service.js";
import { RedisAgentPlanDispatcher } from "./redis-agent-plan-dispatcher.js";
import type * as OfficialMcpClient from "../../../agent-mcp/node_modules/@modelcontextprotocol/client/dist/index.mjs";
import type * as OfficialMcpStdio from "../../../agent-mcp/node_modules/@modelcontextprotocol/client/dist/stdio.mjs";

export const mcpTestSha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
export function requireAgentMcpEnvironment(env: NodeJS.ProcessEnv = process.env) {
  if (env.E2E_AGENT_MCP_ISOLATED !== "1") throw new Error("MCP requires its explicit disposable opt-in before construction or connection");
  return requireAgentNativeEnvironment(env);
}
export type McpHttpEvidence = { method: string; path: string; bodyChecksum: string | null; authenticated: boolean; status: number | null };

/** Runtime loading follows the official package exports. The type imports use
 * those same installed public targets, not a local SDK implementation. */
export async function openMcpClient(apiUrl: string, accessToken: string, flags: readonly string[] = []) {
  requireAgentMcpEnvironment();
  const root = fileURLToPath(new URL("../../../../", import.meta.url)), official = createRequire(new URL("../../../../apps/agent-mcp/package.json", import.meta.url));
  const sdk = await import(pathToFileURL(official.resolve("@modelcontextprotocol/client")).href) as typeof OfficialMcpClient;
  const stdio = await import(pathToFileURL(official.resolve("@modelcontextprotocol/client/stdio")).href) as typeof OfficialMcpStdio;
  const inherited: Record<string, string> = {};
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP"]) if (process.env[name]) inherited[name] = process.env[name]!;
  const env = { ...inherited, TSX_DISABLE_CACHE: "1", YUMMYAI_MCP_ERP_API_URL: apiUrl, YUMMYAI_MCP_ERP_ACCESS_TOKEN: accessToken };
  const transport = new stdio.StdioClientTransport({ command: process.execPath,
    args: ["--import", pathToFileURL(resolve(root, "apps/agent-mcp/node_modules/tsx/dist/loader.mjs")).href, resolve(root, "apps/agent-mcp/src/main.ts"), ...flags],
    cwd: root, env, stderr: "pipe", maxBufferSize: 12 * 1024 * 1024 });
  const client = new sdk.Client({ name: "yummyai-real-erp-acceptance", version: "1.0.0" });
  let stderrTail = "", pid: number | null = null, closed = false;
  const stderrDigest = createHash("sha256");
  const evidence = { pid: null as number | null, closed: false, processExited: false, stderrBytes: 0, stderrChecksum: "", credentialLeaked: false,
    injectedEnvironmentKeys: Object.keys(env).sort() };
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrDigest.update(chunk); evidence.stderrBytes += chunk.byteLength;
    const text = stderrTail + chunk.toString("utf8"); evidence.credentialLeaked ||= text.includes(accessToken);
    stderrTail = text.slice(-Math.max(accessToken.length, 128));
  });
  const close = async () => {
    if (closed) return; closed = true; const errors: unknown[] = [];
    try { await client.close(); } catch (error) { errors.push(error); }
    try { await transport.close(); } catch (error) { errors.push(error); }
    evidence.stderrChecksum = stderrDigest.digest("hex"); stderrTail = "";
    if (pid !== null) { try { process.kill(pid, 0); } catch { evidence.processExited = true; } } else evidence.processExited = true;
    evidence.closed = true;
    if (evidence.credentialLeaked || !evidence.processExited) errors.push(new Error("MCP stdio did not exit cleanly or exposed a credential"));
    if (errors.length) throw new AggregateError(errors, "MCP official client cleanup failed");
  };
  try { await client.connect(transport); pid = transport.pid; evidence.pid = pid; }
  catch (error) { pid = transport.pid; try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "MCP handshake and cleanup failed"); } throw error; }
  return { client, evidence, close, async call(name: string, input: Record<string, unknown>) {
    const value = await client.callTool({ name, arguments: input });
    return { packet: AgentMcpPacketSchema.parse(value.structuredContent), isError: value.isError === true };
  } };
}

/** Owns real sources, OIDC verification, non-owner tenant RLS and native HTTP.
 * Only the model provider's HTTP transport is synthetic. No business approval
 * is manufactured. The MCP subprocess receives no database or storage secret. */
export function agentMcpFixture(database: DatabaseConnection, remote = false) {
  const isolated = requireAgentMcpEnvironment();
  const native = agentNativeFixture(database, remote ? {
    contentVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist"),
    modelVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config"),
  } : {});
  const queue = createQueue(QueueName.AgentPlan, process.env.E2E_DISPOSABLE_REDIS_URL);
  const requests: McpHttpEvidence[] = [], active = new Set<Promise<unknown>>();
  const controls: { dropNext: string | null; afterHttp?: (request: McpHttpEvidence) => Promise<void> } = { dropNext: null };
  let app: INestApplication | undefined, dispatcher: RedisAgentPlanDispatcher | undefined, origin: string | undefined, closed = false;
  let signingKeys: Awaited<ReturnType<typeof generateKeyPair>> | undefined;
  const issuer = "https://synthetic-mcp-oidc.invalid", audience = "synthetic-mcp-api";
  async function token(actor = native.base.a, seconds = 300) {
    signingKeys ??= await generateKeyPair("RS256");
    return new SignJWT({ tenant_id: actor.tenantId }).setProtectedHeader({ alg: "RS256" }).setSubject(actor.subject)
      .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + seconds).sign(signingKeys.privateKey);
  }
  async function startHttp() {
    if (origin) return origin;
    if (remote) throw new Error("Compiled personal MCP fixture uses the original API server");
    signingKeys ??= await generateKeyPair("RS256");
    dispatcher = new RedisAgentPlanDispatcher();
    const service = new AgentNativeService(database, native.base.vault, native.gateway, native.owners.service(), native.owners.adapter, dispatcher);
    @Module({ controllers: [IdentitySessionController, AgentToolsController, AgentNativeController, AgentCommandController], providers: [
      { provide: DATABASE_CONNECTION, useValue: database }, { provide: AgentToolsService, useValue: native.gateway },
      { provide: AgentNativeService, useValue: service }, { provide: AgentCommandService, useValue: native.owners.service() },
    ] })
    class ActualMcpHttpModule {}
    const reflector = new Reflector(), verifier = new OidcJwtStrategy({ issuer, audience, verificationKey: signingKeys.publicKey });
    const interceptor: NestInterceptor = { intercept(context: ExecutionContext, next: CallHandler) {
      const request = context.switchToHttp().getRequest<IncomingMessage & { body?: unknown }>();
      const record: McpHttpEvidence = { method: request.method ?? "", path: new URL(request.url ?? "/", "http://fixture.invalid").pathname,
        bodyChecksum: request.body === undefined ? null : mcpTestSha(JSON.stringify(request.body)), authenticated: !!request.headers.authorization, status: null };
      context.switchToHttp().getResponse<ServerResponse>().once("finish", function (this: ServerResponse) { record.status = this.statusCode; });
      requests.push(record);
      return next.handle().pipe(mergeMap(async (value: unknown) => {
        await controls.afterHttp?.(record);
        if (controls.dropNext === record.path && record.method === "POST") {
          controls.dropNext = null; context.switchToHttp().getResponse<ServerResponse>().destroy();
        }
        return value;
      }));
    } };
    app = await NestFactory.create(ActualMcpHttpModule, { logger: false });
    app.useGlobalGuards(new TenantContextGuard(verifier, new DatabaseMembershipContextLoader(database), native.base.loader, reflector),
      new PermissionsGuard(reflector), new ApiClientRouteGuard(reflector));
    app.useGlobalInterceptors(new ApiClientAuthorityInterceptor(native.base.loader), interceptor);
    await app.listen(0, "127.0.0.1"); origin = await app.getUrl(); return origin;
  }
  async function processRun(context: TenantContext, id: string, originals: Parameters<typeof nativeSequence>[1] = [], keyword?: string) {
    native.controls.decision = packet => nativeSequence(packet, originals, keyword);
    const job = await queue.getJob(id);
    if (!job?.id) throw new Error("MCP original Redis execution job missing");
    const envelope = JobEnvelopeSchema.parse(job.data);
    if (envelope.tenantId !== context.tenantId || envelope.requestedBy !== context.userId) throw new Error("MCP original Redis owner mismatch");
    const task = new AgentPlanProcessor(agentPlanRuntimeRouter(database, native.prior.runtime(), native.runtime())).process(envelope);
    active.add(task); try { return await task; } finally { active.delete(task); }
  }
  async function close() {
    if (closed) return; closed = true; const errors: unknown[] = [];
    for (const task of active) try { await task; } catch (error) { errors.push(error); }
    try { await app?.close(); } catch (error) { errors.push(error); }
    try { await dispatcher?.onModuleDestroy(); } catch (error) { errors.push(error); }
    try { await queue.close(); } catch (error) { errors.push(error); }
    try { native.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "MCP actual fixture cleanup failed");
  }
  return { native, database, isolated, requests, controls, startHttp, token, process: processRun, close,
    async queued(id: string) { const job = await queue.getJob(id); if (!job?.id) throw new Error("Original MCP Redis job missing"); const envelope = JobEnvelopeSchema.parse(job.data);
      return { id: job.id, tenantId: envelope.tenantId, requestedBy: envelope.requestedBy, operation: (envelope.payload as { operation?: string }).operation }; },
    initialize: () => native.initialize(), seed: (context: TenantContext) => native.sourceContext(context),
    get origin() { if (!origin) throw new Error("MCP original HTTP server not started"); return origin; } };
}

/** Browser-only RPC lives in this new fixture so no decorated Nest module is
 * loaded by Playwright. Existing integration exports above retain their path.
 * Only this owner child has nonce resource credentials; SDK stdio receives the
 * separately whitelisted environment in openMcpClient. */
async function mcpBrowserChild() {
  const isolated = requireAgentMcpEnvironment(), database = connectDatabase(isolated.url), f = agentMcpFixture(database, true);
  const clients: Array<Awaited<ReturnType<typeof openMcpClient>>> = [];
  const createdRuns = new Map<string, string>(), preparedItems = new Map<string, { runId: string; itemId: string; agentCommandId: string | null; ownerCommandId: string | null }>();
  const commandCleanup: Array<{ runId: string; itemId: string; agentCommandId: string; ownerCommandId: string; initialState: string; finalState: string;
    actions: Array<{ action: "cancel" | "acknowledge"; state: string; acknowledged: boolean }>; businessPreserved: boolean }> = [];
  let context: TenantContext | undefined, source: Awaited<ReturnType<typeof f.seed>> | undefined, active: Promise<unknown> | undefined;
  let phase = "ready", serial = Promise.resolve(), closed = false, settled = false, failure: string | null = null, originalQueueJobId: string | null = null, releaseGate: (() => void) | undefined;
  const stats = () => ({ modelCalls: f.native.modelCalls.length, readCalls: f.native.readCalls.length, definitionCalls: f.native.definitionCalls.length, settled, failure, originalQueueJobId });
  const close = async () => {
    if (closed) return; closed = true; releaseGate?.(); const errors: unknown[] = [];
    try { await active; } catch (error) { errors.push(error); }
    // Each target came from an actual MCP prepare for a run this child started.
    // Never scan or settle another actor's or another child's command history.
    for (const target of preparedItems.values()) try {
      if (!context || !createdRuns.has(target.runId)) throw new Error("MCP exact cleanup parent missing");
      const run = await f.native.service().get(context, target.runId), item = run.items.find(item => item.id === target.itemId);
      if (run.requestId !== createdRuns.get(target.runId) || !item) throw new Error("MCP exact cleanup item changed");
      if (!item.agentCommandId || !item.ownerCommandId) {
        if (target.agentCommandId || target.ownerCommandId) throw new Error("MCP exact cleanup reference disappeared");
        continue;
      }
      if (target.agentCommandId && target.agentCommandId !== item.agentCommandId || target.ownerCommandId && target.ownerCommandId !== item.ownerCommandId)
        throw new Error("MCP exact cleanup reference changed");
      const owner = f.native.owners.service(), before = await f.native.business(context);
      let command = await owner.get(context, item.agentCommandId);
      if (command.ownerCommandId !== item.ownerCommandId || command.requestId !== item.id) throw new Error("MCP exact native cleanup identity mismatch");
      const reference = command.snapshot?.reference;
      if (!reference || reference.commandId !== item.ownerCommandId) throw new Error("MCP exact original cleanup reference unavailable");
      let original = await f.native.owners.adapter.read(context, reference);
      const result: (typeof commandCleanup)[number] = { runId: run.id, itemId: item.id, agentCommandId: command.id, ownerCommandId: item.ownerCommandId,
        initialState: original.native.view.status, finalState: original.native.view.status, actions: [], businessPreserved: false };
      commandCleanup.push(result);
      const actionInput = { version: AGENT_COMMAND_VERSION, requestId: command.requestId, ownerCommandId: item.ownerCommandId };
      if (original.native.view.status === "prepared") {
        if (!command.canCancel || !original.native.view.canCancel) throw new Error("MCP exact prepared cleanup cannot cancel through its owner");
        command = await owner.cancel(context, command.id, actionInput);
        original = await f.native.owners.adapter.read(context, reference);
        result.actions.push({ action: "cancel", state: original.native.view.status, acknowledged: original.native.view.acknowledged });
      }
      if (!["succeeded", "cancelled", "rejected", "expired"].includes(original.native.view.status)) throw new Error("MCP exact original cleanup is not terminal");
      if (!original.native.view.acknowledged) {
        command = await owner.acknowledge(context, command.id, actionInput);
        // Acknowledgement intentionally removes original input. Its real owner
        // receipt remains authoritative even if an outer private view is empty.
        original = await f.native.owners.adapter.read(context, reference);
        result.actions.push({ action: "acknowledge", state: original.native.view.status, acknowledged: original.native.view.acknowledged });
      }
      result.finalState = original.native.view.status; result.businessPreserved = JSON.stringify(before) === JSON.stringify(await f.native.business(context));
      if (original.reference.commandId !== item.ownerCommandId || !original.native.view.acknowledged || !result.businessPreserved)
        throw new Error("MCP original cleanup did not preserve facts or acknowledge its result");
    } catch (error) { errors.push(error); }
    for (const sdk of clients) try { await sdk.close(); } catch (error) { errors.push(error); }
    try { await f.close(); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "MCP owner child cleanup failed");
  };
  process.on("disconnect", () => { releaseGate?.(); void serial.then(close).catch(() => { process.exitCode = 1; }); });
  process.on("message", raw => {
    serial = serial.then(async () => {
      if (!raw || typeof raw !== "object") return; const message = raw as Record<string, unknown>;
      if (message.nonce !== isolated.nonce || typeof message.id !== "number") return;
      try {
        let value: unknown;
        if (message.operation === "close") { phase = "closing"; await close(); value = { closed: true, clients: clients.map(sdk => sdk.evidence), commandCleanup }; }
        else if (message.operation === "seed") {
          phase = "real_identity"; const caller = TenantContextSchema.parse(message.context);
          context = await withTenant(database.db, caller, async tx => TenantContextSchema.parse(intersectPermissionContexts(caller, await loadCurrentMembershipContext(tx, caller, { lock: true }))));
          phase = "real_native_sources"; await f.native.facts.initialize(); source = await f.seed(context);
          value = { stockItemId: source.stockItemId, supplierId: source.supplierId, inspectionId: source.compiled.id, factoryId: source.site.factory.id,
            from: source.pool.localDate, query: source.query, originals: source.originals, contextText: source.contextText };
        } else if (message.operation === "connect") {
          phase = "official_stdio_handshake"; const api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
          if (process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal" || api.port !== "8130" || !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname)) throw new Error("Actual MCP browser API boundary invalid");
          const args = z.array(z.string().max(200)).max(20).parse(message.flags), token = z.string().max(32_768).parse(message.token);
          const sdk = await openMcpClient(api.origin, token, args), clientId = clients.push(sdk) - 1;
          value = { clientId, tools: (await sdk.client.listTools()).tools.map((tool: { name: string }) => tool.name) };
        } else if (message.operation === "call") {
          phase = "official_stdio_call"; const id = z.int().min(0).max(clients.length - 1).parse(message.clientId), name = z.string().max(100).parse(message.name);
          const input = z.record(z.string(), z.unknown()).parse(message.input);
          let target: (typeof preparedItems extends Map<string, infer Item> ? Item : never) | undefined;
          if (name === AGENT_MCP_TOOL_NAMES.execute && input.operation === "prepare" && typeof input.id === "string" && createdRuns.has(input.id)) {
            const runId = z.uuidv7().parse(input.id), itemId = z.uuidv7().parse(input.itemId), key = runId + ":" + itemId;
            target = preparedItems.get(key) ?? { runId, itemId, agentCommandId: null, ownerCommandId: null }; preparedItems.set(key, target);
          }
          const response = await clients[id]!.call(name, input); value = response;
          if (!response.isError && name === AGENT_MCP_TOOL_NAMES.execute && input.operation === "start") {
            const run = AgentNativeViewSchema.parse(response.packet.data); createdRuns.set(run.id, run.requestId);
          }
          if (target && !response.isError && response.packet.kind === "item_receipt") {
            const receipt = AgentNativeItemReceiptSchema.parse(response.packet.data);
            if (receipt.runId !== target.runId || receipt.itemId !== target.itemId) throw new Error("MCP created preparation identity mismatch");
            target.agentCommandId = receipt.agentCommandId; target.ownerCommandId = receipt.ownerCommandId;
          }
        } else if (message.operation === "execute") {
          phase = "original_redis_worker"; if (!context || !source || active && !settled) throw new Error("Actual MCP sources unavailable");
          const id = z.uuidv7().parse(message.runId), job = await f.queued(id);
          if (job.tenantId !== context.tenantId || job.requestedBy !== context.userId || job.operation !== "execute") throw new Error("Actual MCP original queue identity mismatch");
          originalQueueJobId = job.id; settled = false; failure = null;
          let gate: Promise<void> | undefined; if (message.holdFirstModel === true) gate = new Promise(accept => { releaseGate = accept; });
          f.native.controls.beforeModel = async packet => { if (packet.turn === 1 && gate) await gate; };
          const run = await f.native.service().get(context, id);
          const originals = source.originals.filter(original => run.allowedCommands.some(command => command.domain === original.domain && command.kind === original.command.kind));
          active = f.process(context, id, originals, source.query).then(result => { settled = true; return result; }, error => { settled = true; failure = "actual_runtime_rejected"; throw error; });
          void active.catch(() => {}); value = { started: true, originalQueueJobId };
        } else if (message.operation === "release") { releaseGate?.(); value = { released: true }; }
        else if (message.operation === "progress") value = stats();
        else if (message.operation === "wait") { await active; value = stats(); }
        else if (message.operation === "business") { if (!context) throw new Error("Actual MCP caller missing"); value = await f.native.business(context); }
        else if (message.operation === "state") {
          phase = "metadata_only_state"; if (!context) throw new Error("Actual MCP caller missing"); const requestId = z.uuid().parse(message.requestId), caller = context;
          value = await withTenant(database.db, caller, async tx => ({
            runs: Array.from(await tx.execute(sql`select id,request_id,status,revision,model_turns,known_cost_usd::text,unknown_cost,input_checksum,result_checksum from agent_plan_runs where owner_id=${caller.userId}::uuid and request_id=${requestId}::uuid order by id`)),
            steps: Array.from(await tx.execute(sql`select s.id,s.sequence,s.kind,s.phase,s.submission_state,s.input_checksum,s.output_checksum,s.response_checksum,s.cost_usd::text from agent_plan_steps s join agent_plan_runs r on r.id=s.run_id and r.tenant_id=s.tenant_id where r.owner_id=${caller.userId}::uuid and r.request_id=${requestId}::uuid order by s.sequence`)),
            items: Array.from(await tx.execute(sql`select i.id,i.proposal_checksum,i.agent_command_id,c.owner_command_id from agent_plan_items i join agent_plan_runs r on r.id=i.run_id and r.tenant_id=i.tenant_id left join agent_command_requests c on c.id=i.agent_command_id and c.tenant_id=i.tenant_id where r.owner_id=${caller.userId}::uuid and r.request_id=${requestId}::uuid order by i.position`)),
            budgets: Array.from(await tx.execute(sql`select b.id,b.state,b.amount_usd::text from ai_budget_ledger b join agent_plan_runs r on r.id=b.request_id and r.tenant_id=b.tenant_id where r.owner_id=${caller.userId}::uuid and r.request_id=${requestId}::uuid order by b.id`)),
          }));
        } else throw new Error("MCP owner operation invalid");
        process.send?.({ type: "result", nonce: isolated.nonce, id: message.id, value });
      } catch (error) {
        let code: string | null = null, candidate: unknown = error;
        for (let depth = 0; depth < 8 && candidate && typeof candidate === "object"; depth++) {
          if ("code" in candidate && typeof candidate.code === "string" && /^[A-Z0-9]{5}$/.test(candidate.code)) { code = candidate.code; break; }
          candidate = "cause" in candidate ? candidate.cause : null;
        }
        process.send?.({ type: "failure", nonce: isolated.nonce, id: message.id, phase, code });
      }
    });
  });
  process.send?.({ type: "ready", nonce: isolated.nonce });
}
if (process.argv.includes("--agent-mcp-browser-child")) void mcpBrowserChild().catch(() => { process.exitCode = 1; });
