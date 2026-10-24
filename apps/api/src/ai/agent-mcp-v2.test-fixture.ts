import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, relative, isAbsolute } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Module, type INestApplication, type NestInterceptor, type ExecutionContext, type CallHandler } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { mergeMap } from "rxjs";
import { z } from "zod";
import { createEnvironmentSecretVault } from "@yummyai/ai-core";
import { intersectPermissionContexts } from "@yummyai/authz";
import { TenantContextSchema } from "@yummyai/contracts";
import type { TenantContext } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AGENT_MCP_TOOL_NAMES, AgentMcpPacketSchema } from "@yummyai/contracts/ai/agent-mcp";
import { AgentMcpV2PacketSchema } from "@yummyai/contracts/ai/agent-mcp-v2";
import { AGENT_NATIVE_V3_VERSION, AgentNativeV3ViewSchema, AgentNativeV3WorkspaceSchema, CreateAgentNativeV3Schema, AgentNativeV3BindingSchema,
  canonicalAgentNativeV3Request, type CreateAgentNativeV3, type AgentNativeV3Binding } from "@yummyai/contracts/ai/agent-native-v3";
import { AgentResourceCandidatesSchema, AgentResourceCandidatesQuerySchema, AGENT_RESOURCES_VERSION, AgentResourceKeySchema } from "@yummyai/contracts/ai/agent-resources";
import { AGENT_FULFILLMENT_VERSION, AGENT_FULFILLMENT_TOOL, AgentFulfillmentCandidatesSchema } from "@yummyai/contracts/ai/agent-fulfillment";
import { HarnessExecutionContractSchema } from "@yummyai/contracts/harness";
import { connectDatabase, withTenant, loadCurrentMembershipContext, memberships, type DatabaseConnection } from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";
import { requireAgentMcpV2Environment as requireMcpV2Guard } from "../../../../tools/testing/require-agent-mcp-v2-environment.mjs";
import { startAgentMcpAuthFixture } from "../../../../tools/testing/agent-mcp-auth-fixture.mjs";
import { ApiClientAuthorityInterceptor } from "../auth/api-client-authority.interceptor.js";
import { ApiClientRouteGuard } from "../auth/api-client-route.guard.js";
import { IdentitySessionController } from "../auth/identity-session.controller.js";
import { OidcJwtStrategy } from "../auth/oidc-jwt.strategy.js";
import { PermissionsGuard } from "../auth/permissions.guard.js";
import { TenantContextGuard, DatabaseMembershipContextLoader } from "../auth/tenant-context.guard.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { AgentCommandController } from "./agent-command.controller.js";
import { AgentCommandService } from "./agent-command.service.js";
import { AgentNativeController } from "./agent-native.controller.js";
import { AgentNativeService } from "./agent-native.service.js";
import { AgentNativeV3Controller } from "./agent-native-v3.controller.js";
import { AgentNativeV3Service } from "./agent-native-v3.service.js";
import { AgentToolsController } from "./agent-tools.controller.js";
import { AgentToolsService } from "./agent-tools.service.js";
import { AgentResourcesController } from "./agent-resources.controller.js";
import { AgentResourcesService } from "./agent-resources.service.js";
import { AgentFulfillmentController } from "./agent-fulfillment.controller.js";
import { AgentFulfillmentService } from "./agent-fulfillment.service.js";
import { createOrderPiiVault } from "../orders/order-pii-vault.js";
import { createIntegrationSecretVault } from "../integrations/integration-secret-vault.js";
import { AgentMcpCredentialStore } from "../../../agent-mcp/src/auth/credential-store.js";
import { WindowsAgentMcpDataProtection } from "../../../agent-mcp/src/auth/windows-dpapi.js";
import type { AgentActor } from "./agent-read.test-fixture.js";
import { agentNativeV3Fixture, nativeV3Sequence } from "./agent-native-v3.test-fixture.js";
import type * as OfficialMcpClient from "../../../agent-mcp/node_modules/@modelcontextprotocol/client/dist/index.mjs";
import type * as OfficialMcpStdio from "../../../agent-mcp/node_modules/@modelcontextprotocol/client/dist/stdio.mjs";
import { agentMcpAuthProfileDigest, loadAgentMcpAuthProfile, type AgentMcpAuthProfile } from "../../../agent-mcp/src/auth/config.js";
import { createPersonalAgentMcpSession } from "../../../agent-mcp/src/auth/session.js";

export const mcpV2Root = fileURLToPath(new URL("../../../../", import.meta.url));
export const mcpV2Qa = resolve(mcpV2Root, "tmp/agent-mcp-v2-20261022-7c4e1b92/qa");
export const mcpV2Hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function requireAgentMcpV2Environment(env: NodeJS.ProcessEnv = process.env) {
  return requireMcpV2Guard(env);
}

/** Compiled-browser owner child. It owns source credentials but launches each
 * actual MCP server with only the strict environment in openMcpV2Client. */
async function mcpV2BrowserChild() {
  const env = requireAgentMcpV2Environment(), database = connectDatabase(env.url), native = agentNativeV3Fixture(database, {
    contentVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist"),
    modelVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config"), orderVault: createOrderPiiVault(), integrationVault: createIntegrationSecretVault() });
  let context: TenantContext | undefined, actor: AgentActor | undefined, source: Awaited<ReturnType<typeof native.seed>> | undefined;
  let profile: AgentMcpAuthProfile | undefined, profilePath: string | undefined, storeDir: string | undefined;
  let personal: z.infer<typeof ErpSessionViewSchema> | undefined, session: Awaited<ReturnType<typeof createPersonalAgentMcpSession>> | undefined;
  let loginTask: Promise<unknown> | undefined, loginAbort: AbortController | undefined, active: Promise<unknown> | undefined;
  let settled = true, entered = false, release: (() => void) | undefined, failure: string | null = null, closed = false, phase = "ready", serial = Promise.resolve();
  const clients: McpV2Client[] = [], owned = new Set<string>();
  const stats = () => ({ modelCalls: native.modelCalls.length, definitions: native.definitionCalls.length, reads: native.readCalls.length, settled, entered, failure });
  async function issuerControl(path: string, body: URLSearchParams) {
    const issuer = new URL(process.env.FACTORY_IDENTITY_FIXTURE_URL ?? "https://invalid.invalid"), controlKey = process.env.FACTORY_FIXTURE_CONTROL_TOKEN;
    if (!["localhost", "127.0.0.1"].includes(issuer.hostname) || !controlKey || !["/_fixture/register-mcp-client", "/_fixture/configure"].includes(path)) throw new Error("mcp_v2_actual_idp_boundary_missing");
    const response = await fetch(new URL(path, issuer), { method: "POST", redirect: "error", headers: { "x-fixture-control": controlKey, "content-type": "application/x-www-form-urlencoded" }, body });
    if (response.status !== 200) throw new Error("mcp_v2_actual_idp_control_rejected");
  }
  async function connect(flags: readonly string[]) {
    if (!profile || !profilePath || !storeDir || !personal) throw new Error("mcp_v2_personal_login_missing");
    const sdk = await openMcpV2Client({ apiUrl: profile.apiUrl, profilePath, storeDir, flags }); clients.push(sdk);
    const tools = await sdk.client.listTools(); return { clientId: clients.length - 1, tools: tools.tools.map((tool: { name: string }) => tool.name), personal };
  }
  async function close() {
    if (closed) return; closed = true; release?.(); loginAbort?.abort(); const errors: unknown[] = [];
    try { await active; } catch (error) { errors.push(error); } if (loginTask) await loginTask.catch(() => {});
    for (const sdk of clients) try { await sdk.close(); } catch (error) { errors.push(error); }
    if (context) {
      try { const current = TenantContextSchema.parse(await native.base.current(context)), rows = await native.rows(current);
        for (const run of rows.runs.filter(row => owned.has(row.id) && ["queued", "running", "stopping"].includes(row.status))) {
          await native.service().stop(current, run.id, { version: AGENT_NATIVE_V3_VERSION, requestId: run.requestId }); if (actor) await native.process(run.id, actor);
        }
        await native.settlePrepared(current);
      } catch (error) { errors.push(error); }
    }
    for (const done of [() => session?.logout(), () => native.close(), () => database.client.end()]) try { await done(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "MCP v2 exact browser owner teardown failed");
  }
  process.on("disconnect", () => { release?.(); loginAbort?.abort(); void serial.then(close).catch(() => { process.exitCode = 1; }); });
  process.on("message", raw => { serial = serial.then(async () => {
    if (!raw || typeof raw !== "object") return; const message = raw as Record<string, unknown>;
    if (message.nonce !== env.nonce || typeof message.id !== "number") return;
    try {
      let value: unknown;
      if (message.operation === "seed") {
        phase = "actual_personal_sources"; const caller = TenantContextSchema.parse(message.context);
        context = await withTenant(database.db, caller, async tx => TenantContextSchema.parse(intersectPermissionContexts(caller, await loadCurrentMembershipContext(tx, caller, { lock: true }))));
        const [membership] = await withTenant(database.db, context, tx => tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, context!.userId), eq(memberships.status, "active"))));
        if (!membership) throw new Error("mcp_v2_actual_personal_membership_missing");
        actor = { ...context, context, subject: "unused-personal-source-actor", membershipId: membership.id, roleIds: new Map() };
        await native.prior.legacy.facts.initialize(); await native.prior.resources.facts.initialize(); source = await native.seed(actor);
        value = { seeded: true, sourceCount: source.bindings.length, originalOrderId: source.order.id };
      } else if (message.operation === "auth_begin") {
        phase = "actual_personal_pkce"; if (!context) throw new Error("mcp_v2_actual_personal_context_missing");
        const api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid"), issuer = new URL(process.env.FACTORY_IDENTITY_FIXTURE_URL ?? "https://invalid.invalid");
        if (api.port !== "8130" || !["localhost", "127.0.0.1"].includes(api.hostname)) throw new Error("mcp_v2_actual_api_boundary_missing");
        const directory = mcpV2OwnedPath("browser-auth", env.nonce, randomUUID()); await mkdir(directory, { recursive: true });
        storeDir = resolve(directory, "vault"); profilePath = resolve(directory, "profile.json"); profile = { schemaVersion: 1, apiUrl: api.origin, issuer: issuer.origin,
          clientId: "yummyai-agent-mcp", audience: "yummyai-api", redirectUri: await callbackUri() };
        await issuerControl("/_fixture/register-mcp-client", new URLSearchParams({ client_id: profile.clientId, redirect_uri: profile.redirectUri }));
        await writeFile(profilePath, JSON.stringify(profile), { encoding: "utf8", flag: "wx" });
        let opened!: (url: URL) => void; const opening = new Promise<URL>(yes => { opened = yes; }); loginAbort = new AbortController();
        const login = await createPersonalAgentMcpSession(profile, { storeDir, openAuthorization: async url => { opened(url); } });
        loginTask = login.login({ signal: loginAbort.signal }); void loginTask.catch(() => {});
        const authorizationUrl = await Promise.race([opening, loginTask.then(() => { throw new Error("mcp_v2_authorization_not_opened"); })]);
        value = { authorizationUrl: authorizationUrl.href };
      } else if (message.operation === "auth_finish") {
        if (!profile || !storeDir || !context || !loginTask) throw new Error("mcp_v2_actual_pkce_login_missing"); await loginTask;
        session = await createPersonalAgentMcpSession(profile, { storeDir }); const lease = await session.credentials.acquire(new AbortController().signal);
        const response = await fetch(profile.apiUrl + "/v1/identity/session", { headers: { authorization: "Bearer " + lease.accessToken }, redirect: "error" });
        if (response.status !== 200) throw new Error("mcp_v2_actual_erp_session_rejected"); personal = ErpSessionViewSchema.parse(await response.json());
        if (personal.userId !== context.userId || personal.tenantId !== context.tenantId) throw new Error("mcp_v2_actual_personal_identity_mismatch"); await lease.assertCurrent();
        value = await connect(z.array(z.string()).parse(message.flags));
      } else if (message.operation === "connect") value = await connect(z.array(z.string()).parse(message.flags));
      else if (message.operation === "request") {
        if (!source) throw new Error("mcp_v2_actual_sources_missing"); const sdk = clients[z.int().nonnegative().parse(message.clientId)]; if (!sdk) throw new Error("mcp_v2_actual_sdk_missing");
        const mode = z.enum(["one", "fulfillment"]).parse(message.mode), bindings = source.bindings.filter(binding => mode === "one" ? binding.tool === "inventory.balances.page" : binding.tool === AGENT_FULFILLMENT_TOOL);
        value = (await discoverMcpV2Request(sdk, bindings, { allowedCommands: mode === "one" ? [{ domain: "finance", kind: "bill_record" }] :
          [{ domain: "procurement", kind: "requisition_create" }, { domain: "finance", kind: "bill_record" }] })).input;
      } else if (message.operation === "call") {
        const sdk = clients[z.int().nonnegative().parse(message.clientId)]; if (!sdk) throw new Error("mcp_v2_actual_sdk_missing");
        const name = z.enum(Object.values(AGENT_MCP_TOOL_NAMES) as [string, ...string[]]).parse(message.name), input = z.record(z.string(), z.unknown()).parse(message.input);
        const result = await sdk.call(name, input); if (!result.isError && result.packet.kind === "run") owned.add(AgentNativeV3ViewSchema.parse(result.packet.data).id); value = result;
      } else if (message.operation === "execute") {
        if (!source || !actor || active && !settled) throw new Error("mcp_v2_actual_execution_unavailable"); const id = z.uuidv7().parse(message.runId);
        let gate: Promise<void> | undefined; entered = false; if (message.hold === true) gate = new Promise(yes => { release = yes; });
        native.controls.beforeModel = async packet => { if (gate && packet.turn === 1) { entered = true; await gate; } };
        native.controls.decision = packet => nativeV3Sequence(packet, source!.originals.filter(original => packet.allowedCommands.some(command => command.domain === original.domain && command.kind === original.command.kind)), source!.query);
        settled = false; failure = null; owned.add(id); active = native.process(id, actor).then(result => { settled = true; return result; }, error => { settled = true; failure = "mcp_v2_runtime_rejected"; throw error; });
        void active.catch(() => {}); value = { started: true };
      } else if (message.operation === "progress") value = stats();
      else if (message.operation === "wait") { await active; value = stats(); }
      else if (message.operation === "release") { release?.(); value = { released: true }; }
      else if (message.operation === "business") { if (!context) throw new Error("mcp_v2_actual_context_missing"); value = { native: await native.business(context), fulfillment: await native.fulfillmentBusiness(context), carrier: { ...native.fulfillment.carrier.calls } }; }
      else if (message.operation === "state") {
        if (!context) throw new Error("mcp_v2_actual_context_missing"); const requestId = z.uuid().parse(message.requestId), caller = context;
        value = await withTenant(database.db, caller, async tx => ({
          runs: Array.from(await tx.execute(sql`select id,version,request_id,status,revision,model_turns,known_cost_usd::text,unknown_cost,input_checksum,result_checksum from agent_plan_runs where owner_id=${caller.userId}::uuid and request_id=${requestId}::uuid order by id`)),
          steps: Array.from(await tx.execute(sql`select s.id,s.sequence,s.kind,s.phase,s.submission_state,s.input_checksum,s.output_checksum,s.response_checksum,s.cost_usd::text from agent_plan_steps s join agent_plan_runs r on r.id=s.run_id and r.tenant_id=s.tenant_id where r.owner_id=${caller.userId}::uuid and r.request_id=${requestId}::uuid order by s.sequence`)),
          budgets: Array.from(await tx.execute(sql`select b.id,b.state,b.amount_usd::text from ai_budget_ledger b join agent_plan_runs r on r.id=b.request_id and r.tenant_id=b.tenant_id where r.owner_id=${caller.userId}::uuid and r.request_id=${requestId}::uuid order by b.id`)),
        }));
      } else if (message.operation === "refresh") {
        phase = "actual_rotating_refresh"; if (!profile || !storeDir) throw new Error("mcp_v2_actual_personal_grant_missing");
        const store = new AgentMcpCredentialStore(storeDir, agentMcpAuthProfileDigest(profile), new WindowsAgentMcpDataProtection()), before = await store.read();
        if (before?.state !== "ready") throw new Error("mcp_v2_actual_ready_grant_missing");
        await issuerControl("/_fixture/configure", new URLSearchParams({ accessSeconds: "600" }));
        try { const shifted = await createPersonalAgentMcpSession(profile, { storeDir, now: () => before.tokens.accessExpiresAt - 1000 });
          const lease = await shifted.credentials.acquire(new AbortController().signal); await lease.assertCurrent();
          const after = await store.read(); if (after?.state !== "ready" || after.grantId !== before.grantId || after.tokens.refreshToken === before.tokens.refreshToken) throw new Error("mcp_v2_actual_refresh_not_rotated");
          value = { rotated: true, originalGrantPreserved: true, revisionAdvanced: after.revision > before.revision, timing: "proactive_refresh_triggered_via_public_now_DI" };
        } finally { await issuerControl("/_fixture/configure", new URLSearchParams({ accessSeconds: "300" })); }
      } else if (message.operation === "close") { phase = "closing"; await close(); value = { closed: true, clients: clients.map(client => client.evidence) }; }
      else throw new Error("mcp_v2_browser_operation_invalid");
      process.send?.({ type: "result", nonce: env.nonce, id: message.id, value });
    } catch (error) {
      let code: string | null = null, cause: unknown = error;
      for (let index = 0; index < 7 && cause && typeof cause === "object"; index++) { if ("code" in cause && typeof cause.code === "string" && /^(?:[A-Z0-9]{5}|mcp_[a-z0-9_]{1,70})$/.test(cause.code)) code ??= cause.code; cause = "cause" in cause ? cause.cause : null; }
      process.send?.({ type: "failure", nonce: env.nonce, id: message.id, phase, code });
    }
  }); });
  process.send?.({ type: "ready", nonce: env.nonce });
}
if (process.argv.includes("--agent-mcp-v2-browser-child")) void mcpV2BrowserChild().catch(() => { process.exitCode = 1; });
export function mcpV2OwnedPath(...parts: string[]) {
  const value = resolve(mcpV2Qa, ...parts), child = relative(mcpV2Qa, value);
  if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("mcp_v2_owned_path_invalid"); return value;
}
async function callbackUri() {
  const server = createServer(); await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const address = server.address(); await new Promise<void>((yes, no) => server.close(error => error ? no(new Error("mcp_callback_reservation_close_failed")) : yes()));
  if (!address || typeof address === "string") throw new Error("mcp_callback_reservation_failed"); return `http://127.0.0.1:${address.port}/callback`;
}

/** The only stdio child environment is a fixed system allowlist plus protocol
 * configuration. LOCALAPPDATA points into this operation's owned QA tree. */
export async function openMcpV2Client(input: { apiUrl: string; profilePath?: string; storeDir?: string; accessToken?: string; flags?: readonly string[]; legacy?: boolean }) {
  requireAgentMcpV2Environment();
  const official = createRequire(new URL("../../../agent-mcp/package.json", import.meta.url));
  const sdk = await import(pathToFileURL(official.resolve("@modelcontextprotocol/client")).href) as typeof OfficialMcpClient;
  const stdio = await import(pathToFileURL(official.resolve("@modelcontextprotocol/client/stdio")).href) as typeof OfficialMcpStdio;
  const system: Record<string, string> = {};
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP"]) if (process.env[name]) system[name] = process.env[name]!;
  const env: Record<string, string> = { ...system, TSX_DISABLE_CACHE: "1", YUMMYAI_MCP_ERP_API_URL: input.apiUrl };
  if (input.profilePath) {
    if (!input.storeDir || relative(mcpV2Qa, input.storeDir).startsWith("..") || isAbsolute(relative(mcpV2Qa, input.storeDir))) throw new Error("mcp_personal_vault_not_owned");
    env.YUMMYAI_MCP_AUTH_PROFILE = input.profilePath; env.YUMMYAI_MCP_AUTH_STORE_DIR = input.storeDir;
  } else if (input.accessToken) env.YUMMYAI_MCP_ERP_ACCESS_TOKEN = input.accessToken;
  else throw new Error("mcp_v2_credentials_missing");
  const sensitive: string[] = input.accessToken ? [input.accessToken] : [];
  if (input.profilePath && input.storeDir) {
    const profile = await loadAgentMcpAuthProfile({ YUMMYAI_MCP_AUTH_PROFILE: input.profilePath });
    const stored = await new AgentMcpCredentialStore(input.storeDir, agentMcpAuthProfileDigest(profile), new WindowsAgentMcpDataProtection()).read();
    if (stored?.state === "ready") { sensitive.push(stored.tokens.accessToken); if (stored.tokens.refreshToken) sensitive.push(stored.tokens.refreshToken); }
  }
  const args = ["--import", pathToFileURL(resolve(mcpV2Root, "apps/agent-mcp/node_modules/tsx/dist/loader.mjs")).href,
    resolve(mcpV2Root, input.legacy ? "apps/agent-mcp/src/main.ts" : "apps/agent-mcp/src/main-v2.ts"), ...(input.profilePath ? ["--personal-auth"] : []), ...(input.flags ?? [])];
  const transport = new stdio.StdioClientTransport({ command: process.execPath, args, cwd: mcpV2Root, env, stderr: "pipe", maxBufferSize: 12 * 1024 * 1024 });
  const client = new sdk.Client({ name: "yummyai-mcp-v2-real-erp-acceptance", version: "1" });
  const stderrHash = createHash("sha256"); let tail = "", pid: number | null = null, closed = false;
  const evidence = { pid: null as number | null, closed: false, processExited: false, stderrBytes: 0, stderrChecksum: "", credentialLeaked: false, injectedEnvironmentKeys: Object.keys(env).sort() };
  transport.stderr?.on("data", (chunk: Buffer) => { stderrHash.update(chunk); evidence.stderrBytes += chunk.byteLength;
    const text = tail + chunk.toString("utf8"); evidence.credentialLeaked ||= sensitive.some(secret => text.includes(secret)); tail = text.slice(-32768); });
  async function close() {
    if (closed) return; closed = true; const errors: unknown[] = [];
    for (const done of [() => client.close(), () => transport.close()]) try { await done(); } catch (error) { errors.push(error); }
    evidence.stderrChecksum = stderrHash.digest("hex"); tail = "";
    if (pid === null) evidence.processExited = true; else try { process.kill(pid, 0); } catch { evidence.processExited = true; }
    evidence.closed = true; if (evidence.credentialLeaked || !evidence.processExited) errors.push(new Error("mcp_v2_stdio_unclean_exit"));
    sensitive.length = 0; if (errors.length) throw new AggregateError(errors, "MCP v2 official client teardown failed");
  }
  try { await client.connect(transport); pid = transport.pid; evidence.pid = pid; }
  catch (error) { pid = transport.pid; try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "MCP v2 handshake and cleanup failed"); } throw error; }
  const legacy = input.legacy === true;
  return { client, evidence, close, async call(name: string, arguments_: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: arguments_ });
    const diagnostic = JSON.stringify(result); evidence.credentialLeaked ||= sensitive.some(secret => diagnostic.includes(secret));
    if (evidence.credentialLeaked) throw new Error("mcp_v2_protocol_credential_leak");
    const packet = (legacy ? AgentMcpPacketSchema : AgentMcpV2PacketSchema).parse(result.structuredContent);
    return { packet, isError: result.isError === true };
  } };
}
export type McpV2Client = Awaited<ReturnType<typeof openMcpV2Client>>;

/** Only protocol-discovered execution pins/models/schemas enter a new request.
 * IDs identify an operator's selected originals; six-resource and fulfillment
 * selections must also occur in the real bounded MCP candidate response. The
 * historical creative/factory API has no MCP object-enumeration operation. */
export async function discoverMcpV2Request(sdk: McpV2Client, selected: readonly AgentNativeV3Binding[], changes: Partial<CreateAgentNativeV3> = {}) {
  const schema = await sdk.call(AGENT_MCP_TOOL_NAMES.schema, { key: "native-v3/start" });
  if (schema.isError) throw new Error("mcp_v2_native_start_definition_rejected");
  const metadata = z.object({ key: z.literal("native-v3/start"), originalVersion: z.literal(AGENT_NATIVE_V3_VERSION),
    executionContract: HarnessExecutionContractSchema, models: AgentNativeV3WorkspaceSchema.shape.models,
    limits: AgentNativeV3WorkspaceSchema.shape.limits, readContracts: AgentNativeV3ViewSchema.shape.readContracts.unwrap(),
    canStart: z.boolean(), bindingSchema: z.record(z.string(), z.unknown()), inputSchema: z.record(z.string(), z.unknown()), startupEnabled: z.boolean() }).passthrough().parse(schema.packet.data);
  if (!metadata.canStart || !metadata.startupEnabled || !metadata.models[0]) throw new Error("mcp_v2_native_start_not_available");
  const bindings = selected.map(value => AgentNativeV3BindingSchema.parse(value));
  for (const binding of bindings) {
    if (binding.tool === AGENT_FULFILLMENT_TOOL) {
      const packet = await sdk.call(AGENT_MCP_TOOL_NAMES.execute, { operation: "read", requestJson: JSON.stringify({ version: AGENT_FULFILLMENT_VERSION,
        kind: "candidates", query: { version: AGENT_FULFILLMENT_VERSION, filters: { limit: 100 } } }) });
      if (packet.isError) throw new Error("mcp_v2_fulfillment_candidates_rejected");
      const candidates = AgentFulfillmentCandidatesSchema.parse(packet.packet.data);
      if (!candidates.items.some(row => row.id === binding.scope.orderId && row.expectedSequence === binding.scope.expectedSequence)) throw new Error("mcp_v2_original_fulfillment_candidate_missing");
    } else if (AgentResourceKeySchema.safeParse(binding.tool).success) {
      let raw: unknown = { version: AGENT_RESOURCES_VERSION, tool: binding.tool };
      if (binding.tool === "orders.order") raw = { ...raw as object, filters: { limit: 100 } };
      if (binding.tool === "advertising.analysis") {
        const account = await sdk.call(AGENT_MCP_TOOL_NAMES.execute, { operation: "read", requestJson: JSON.stringify({ version: AGENT_RESOURCES_VERSION, kind: "candidates",
          query: { version: AGENT_RESOURCES_VERSION, tool: binding.tool, accountId: null, cursor: null, pageSize: 100 } }) });
        if (account.isError || !AgentResourceCandidatesSchema.parse(account.packet.data).items.some(row => row.id === binding.scope.accountId)) throw new Error("mcp_v2_original_ad_account_missing");
        raw = { version: AGENT_RESOURCES_VERSION, tool: binding.tool, accountId: binding.scope.accountId, cursor: null, pageSize: 100 };
      }
      const query = AgentResourceCandidatesQuerySchema.parse(raw), result = await sdk.call(AGENT_MCP_TOOL_NAMES.execute, { operation: "read",
        requestJson: JSON.stringify({ version: AGENT_RESOURCES_VERSION, kind: "candidates", query }) });
      if (result.isError) throw new Error("mcp_v2_resource_candidates_rejected");
      const candidates = AgentResourceCandidatesSchema.parse(result.packet.data), scope = binding.scope as Record<string, unknown>;
      const id = scope.researchItemId ?? scope.skuId ?? scope.listingId ?? scope.orderId ?? scope.runId ?? scope.analysisId;
      if (!candidates.items.some(row => row.id === id)) throw new Error("mcp_v2_original_resource_candidate_missing");
    }
  }
  const input = CreateAgentNativeV3Schema.parse({ version: AGENT_NATIVE_V3_VERSION, requestId: randomUUID(), goal: "Read the operator-selected original ERP sources and keep all business confirmation in ERP",
    contextText: "Synthetic operator parameters are unverified business suggestions", modelId: metadata.models[0].id, bindings, allowedCommands: [],
    limits: metadata.limits, maxCostUsd: 1, executionContract: metadata.executionContract, ...changes });
  return { input, metadata };
}

export function agentMcpV2Fixture(database: DatabaseConnection) {
  const env = requireAgentMcpV2Environment(), native = agentNativeV3Fixture(database), clients: McpV2Client[] = [];
  const requests: Array<{ method: string; path: string; bodyChecksum: string | null; status: number | null }> = [];
  const controls: { dropNext: string | null; afterHttp?: (path: string) => Promise<void> } = { dropNext: null };
  const ownedRuns = new Set<string>(); let app: INestApplication | undefined, origin: string | undefined, closed = false;
  let idp: Awaited<ReturnType<typeof startAgentMcpAuthFixture>> | undefined;
  const logins: Array<{ profilePath: string; storeDir: string; profile: AgentMcpAuthProfile }> = [];
  async function startHttp() {
    if (origin) return origin;
    idp = await startAgentMcpAuthFixture({ accounts: Object.fromEntries([["operator", native.base.a], ["peer", native.base.second], ["foreign", native.base.foreign]]
      .map(([name, actor]) => [name, { subject: (actor as typeof native.base.a).subject, tenantId: (actor as typeof native.base.a).tenantId, name: String(name) }])) });
    @Module({ controllers: [IdentitySessionController, AgentToolsController, AgentResourcesController, AgentFulfillmentController, AgentNativeController, AgentNativeV3Controller, AgentCommandController],
      providers: [{ provide: DATABASE_CONNECTION, useValue: database }, { provide: AgentToolsService, useValue: native.prior.legacy.gateway },
        { provide: AgentResourcesService, useValue: native.prior.resources.service }, { provide: AgentFulfillmentService, useValue: native.fulfillmentService },
        { provide: AgentNativeService, useValue: native.prior.legacy.service() }, { provide: AgentNativeV3Service, useValue: native.service() },
        { provide: AgentCommandService, useValue: native.prior.legacy.owners.service() }] })
    class PersonalMcpV2Module {}
    const reflector = new Reflector();
    const interceptor: NestInterceptor = { intercept(context: ExecutionContext, next: CallHandler) {
      const request = context.switchToHttp().getRequest<IncomingMessage & { body?: unknown }>(), path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
      const record = { method: request.method ?? "", path, bodyChecksum: request.body === undefined ? null : mcpV2Hash(JSON.stringify(request.body)), status: null as number | null };
      requests.push(record); context.switchToHttp().getResponse<ServerResponse>().once("finish", function (this: ServerResponse) { record.status = this.statusCode; });
      return next.handle().pipe(mergeMap(async (value: unknown) => {
        if (record.method === "POST" && path === "/v1/agent-native-v3/runs") ownedRuns.add(AgentNativeV3ViewSchema.parse(value).id);
        await controls.afterHttp?.(path);
        if (controls.dropNext === path && record.method === "POST") { controls.dropNext = null; context.switchToHttp().getResponse<ServerResponse>().destroy(); }
        return value;
      }));
    } };
    app = await NestFactory.create(PersonalMcpV2Module, { logger: false });
    app.useGlobalGuards(new TenantContextGuard(new OidcJwtStrategy({ issuer: idp.issuer, audience: idp.audience, verificationKey: idp.publicKey }),
      new DatabaseMembershipContextLoader(database), native.base.loader, reflector), new PermissionsGuard(reflector), new ApiClientRouteGuard(reflector));
    app.useGlobalInterceptors(new ApiClientAuthorityInterceptor(native.base.loader), interceptor);
    await app.listen(0, "127.0.0.1"); origin = await app.getUrl(); return origin;
  }
  async function login(account: "operator" | "peer" | "foreign" = "operator") {
    if (!idp || !origin) throw new Error("mcp_v2_http_not_started");
    const directory = mcpV2OwnedPath("auth", env.nonce, randomUUID()), profilePath = resolve(directory, "profile.json");
    const profile: AgentMcpAuthProfile = { schemaVersion: 1, apiUrl: origin, issuer: idp.issuer, clientId: idp.clientId, audience: idp.audience, redirectUri: await callbackUri() };
    const storeDir = resolve(directory, "vault", agentMcpAuthProfileDigest(profile)); idp.registerCallback(profile.redirectUri);
    await mkdir(directory, { recursive: true }); await writeFile(profilePath, JSON.stringify(profile), { encoding: "utf8", flag: "wx" });
    const value = { profilePath, storeDir, profile }; logins.push(value);
    const session = await createPersonalAgentMcpSession(profile, { storeDir, openAuthorization: url => idp!.authorize(url, account) });
    await session.login(); const restored = await createPersonalAgentMcpSession(profile, { storeDir });
    const lease = await restored.credentials.acquire(new AbortController().signal);
    const response = await fetch(origin + "/v1/identity/session", { headers: { authorization: "Bearer " + lease.accessToken }, redirect: "error" });
    if (response.status !== 200) throw new Error("mcp_v2_real_personal_session_rejected");
    const personal = ErpSessionViewSchema.parse(await response.json()), actor = account === "operator" ? native.base.a : account === "peer" ? native.base.second : native.base.foreign;
    if (personal.userId !== actor.userId || personal.tenantId !== actor.tenantId) throw new Error("mcp_v2_personal_actor_mismatch");
    await lease.assertCurrent();
    return { ...value, personal, authority: erpSessionAuthority(personal), session: restored };
  }
  async function connect(flags: readonly string[] = [], auth?: Awaited<ReturnType<typeof login>>, legacy = false) {
    const authenticated = auth ?? await login(), credentials = legacy ? { accessToken: (await authenticated.session.credentials.acquire(new AbortController().signal)).accessToken } :
      { profilePath: authenticated.profilePath, storeDir: authenticated.storeDir };
    const value = await openMcpV2Client({ apiUrl: origin!, ...credentials, flags, legacy });
    clients.push(value); return value;
  }
  async function close() {
    if (closed) return; closed = true; const errors: unknown[] = [];
    for (const client of clients) try { await client.close(); } catch (error) { errors.push(error); }
    for (const auth of logins) try { const session = await createPersonalAgentMcpSession(auth.profile, { storeDir: auth.storeDir }); await session.logout(); } catch (error) { errors.push(error); }
    for (const done of [() => app?.close(), () => idp?.close(), () => native.close()]) try { await done(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "MCP v2 real owner fixture teardown failed");
  }
  return { database, native, env, requests, controls, clients, ownedRuns, startHttp, login, connect, close, initialize: native.initialize, seed: native.seed,
    get origin() { if (!origin) throw new Error("mcp_v2_http_not_started"); return origin; }, get idp() { if (!idp) throw new Error("mcp_v2_idp_not_started"); return idp; },
    lastAuth: () => logins.at(-1),
    proof: (input: CreateAgentNativeV3) => ({ requestId: input.requestId, requestChecksum: mcpV2Hash(canonicalAgentNativeV3Request(input)) }),
    names: AGENT_MCP_TOOL_NAMES, context: async () => TenantContextSchema.parse(await native.base.current(native.base.a)),
    setDecision: (originals: Parameters<typeof nativeV3Sequence>[1] = [], keyword?: string) => { native.controls.decision = packet => nativeV3Sequence(packet, originals, keyword); } };
}
