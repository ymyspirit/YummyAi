import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Module, type INestApplication, type NestInterceptor, type ExecutionContext, type CallHandler } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { mergeMap } from "rxjs";
import { generateKeyPair, SignJWT } from "jose";
import { AgentMcpV2PacketSchema } from "@yummyai/contracts/ai/agent-mcp-v2";
import { AgentReadinessFamilySchema, type AgentReadinessFamily } from "@yummyai/contracts/ai/agent-readiness";
import { ErpSessionViewSchema } from "@yummyai/contracts/auth/session";
import type { DatabaseConnection } from "@yummyai/database";
import { requireAgentMcpReadinessEnvironment } from "../../../../tools/testing/require-agent-mcp-readiness-environment.mjs";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { IdentitySessionController } from "../auth/identity-session.controller.js";
import { OidcJwtStrategy } from "../auth/oidc-jwt.strategy.js";
import { TenantContextGuard, DatabaseMembershipContextLoader } from "../auth/tenant-context.guard.js";
import { PermissionsGuard } from "../auth/permissions.guard.js";
import { ApiClientRouteGuard } from "../auth/api-client-route.guard.js";
import { ApiClientAuthorityInterceptor } from "../auth/api-client-authority.interceptor.js";
import { AgentReadinessController } from "./agent-readiness.controller.js";
import { AgentReadinessService } from "./agent-readiness.service.js";
import { AgentToolsController } from "./agent-tools.controller.js";
import { AgentToolsService } from "./agent-tools.service.js";
import { AgentNativeController } from "./agent-native.controller.js";
import { AgentNativeService } from "./agent-native.service.js";
import { AgentNativeV3Controller } from "./agent-native-v3.controller.js";
import { AgentNativeV3Service } from "./agent-native-v3.service.js";
import { AgentResourcesController } from "./agent-resources.controller.js";
import { AgentResourcesService } from "./agent-resources.service.js";
import { AgentFulfillmentController } from "./agent-fulfillment.controller.js";
import { AgentFulfillmentService } from "./agent-fulfillment.service.js";
import { agentReadinessFixture } from "./agent-readiness.test-fixture.js";
import { deferred, type AgentActor } from "./agent-read.test-fixture.js";
import type * as OfficialClient from "../../../agent-mcp/node_modules/@modelcontextprotocol/client/dist/index.mjs";
import type * as OfficialStdio from "../../../agent-mcp/node_modules/@modelcontextprotocol/client/dist/stdio.mjs";

export const mcpReadinessRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const mcpReadinessQa = resolve(mcpReadinessRoot, "tmp/agent-mcp-readiness-20261023-8b2c6d14/qa");
export const mcpReadinessHash = (value: string) => createHash("sha256").update(value).digest("hex");

/** New owned stdio helper. No old operation directory, host config, vault or
 * credential is read. The explicit signer token is fixed for this process. */
async function openReadinessClient(input: { apiUrl: string; accessToken: string; flags: readonly string[]; nonce: string }) {
  requireAgentMcpReadinessEnvironment();
  const official = createRequire(new URL("../../../agent-mcp/package.json", import.meta.url));
  const sdk = await import(pathToFileURL(official.resolve("@modelcontextprotocol/client")).href) as typeof OfficialClient;
  const stdio = await import(pathToFileURL(official.resolve("@modelcontextprotocol/client/stdio")).href) as typeof OfficialStdio;
  const temp = resolve(mcpReadinessQa, input.nonce, "stdio-" + randomUUID()); await mkdir(temp, { recursive: true });
  const environment: Record<string, string> = { TEMP: temp, TMP: temp, TSX_DISABLE_CACHE: "1",
    YUMMYAI_MCP_ERP_API_URL: input.apiUrl, YUMMYAI_MCP_ERP_ACCESS_TOKEN: input.accessToken };
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT"]) if (process.env[name]) environment[name] = process.env[name]!;
  const transport = new stdio.StdioClientTransport({ command: process.execPath, cwd: mcpReadinessRoot, env: environment,
    args: ["--import", pathToFileURL(resolve(mcpReadinessRoot, "apps/agent-mcp/node_modules/tsx/dist/loader.mjs")).href,
      resolve(mcpReadinessRoot, "apps/agent-mcp/src/main-v2.ts"), ...input.flags], stderr: "pipe", maxBufferSize: 12 * 1024 * 1024 });
  const client = new sdk.Client({ name: "synthetic-mcp-readiness-real-owner-acceptance", version: "1" });
  const stderrHash = createHash("sha256"), codes = new Set<string>(); let tail = "", pid: number | null = null, closed = false;
  const evidence = { pid: null as number | null, closed: false, processExited: false, credentialLeaked: false, stderrBytes: 0,
    stderrSha256: "", stderrCodes: [] as string[], injectedEnvironmentKeys: Object.keys(environment).sort() };
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrHash.update(chunk); evidence.stderrBytes += chunk.byteLength;
    const text = tail + chunk.toString("utf8"); evidence.credentialLeaked ||= text.includes(input.accessToken);
    for (const line of text.split(/\r?\n/)) if (/^mcp_(?:protocol_error|close_failed|personal_or_config_invalid)$/.test(line)) codes.add(line);
    tail = text.slice(-2048);
  });
  async function close() {
    if (closed) return; closed = true; const failures: unknown[] = [];
    for (const done of [() => client.close(), () => transport.close()]) try { await done(); } catch { failures.push(new Error("mcp_readiness_stdio_close_failed")); }
    evidence.stderrSha256 = stderrHash.digest("hex"); evidence.stderrCodes = [...codes]; tail = "";
    if (pid === null) evidence.processExited = true;
    else for (let attempt = 0; attempt < 50; attempt++) {
      try { process.kill(pid, 0); } catch { evidence.processExited = true; break; }
      await new Promise(accept => setTimeout(accept, 20));
    }
    evidence.closed = true;
    if (evidence.credentialLeaked || !evidence.processExited) failures.push(new Error("mcp_readiness_stdio_unclean_exit"));
    if (failures.length) throw new AggregateError(failures, "mcp_readiness_stdio_close_failed");
  }
  try { await client.connect(transport); pid = transport.pid; evidence.pid = pid; }
  catch { pid = transport.pid; try { await close(); } catch { throw new Error("mcp_readiness_stdio_start_and_close_failed"); } throw new Error("mcp_readiness_stdio_start_failed"); }
  return { client, evidence, close, async call(name: string, arguments_: Record<string, unknown>) {
    const actual = await client.callTool({ name, arguments: arguments_ });
    // No token is part of an argument. Scan against the original fixed token.
    evidence.credentialLeaked ||= JSON.stringify(actual).includes(environment.YUMMYAI_MCP_ERP_ACCESS_TOKEN!);
    if (evidence.credentialLeaked) throw new Error("mcp_readiness_protocol_credential_leak");
    return { packet: AgentMcpV2PacketSchema.parse(actual.structuredContent), isError: actual.isError === true };
  } };
}
export type ReadinessMcpClient = Awaited<ReturnType<typeof openReadinessClient>>;

/** Real current-owner composition. The only synthetic boundary is a local JWT
 * signer accepted by the actual OIDC verifier, membership loader and RLS. */
export function agentMcpReadinessFixture(database: DatabaseConnection) {
  const environment = requireAgentMcpReadinessEnvironment(), readiness = agentReadinessFixture(database), native = readiness.original;
  const clients: ReadinessMcpClient[] = [], requests: Array<{ method: string; path: string; status: number | null; credentialId: string | null }> = [];
  const issued = new Map<string, { value: string; id: string }>(), releases = new Set<() => void>();
  const controls: { afterHttp?: (path: string) => Promise<void> } = {};
  let signing: Awaited<ReturnType<typeof generateKeyPair>> | undefined, app: INestApplication | undefined, origin: string | undefined, closed = false;
  async function token(actor: AgentActor) {
    const saved = issued.get(actor.userId); if (saved) return saved;
    signing ??= await generateKeyPair("RS256");
    const value = await new SignJWT({ tenant_id: actor.tenantId }).setProtectedHeader({ alg: "RS256" }).setSubject(actor.subject)
      .setIssuer("https://synthetic-mcp-readiness-oidc.invalid").setAudience("synthetic-mcp-readiness-api").setIssuedAt().setExpirationTime("15m").sign(signing.privateKey);
    const result = { value, id: randomUUID() }; issued.set(actor.userId, result); return result;
  }
  async function startHttp() {
    if (origin) return origin; signing ??= await generateKeyPair("RS256");
    @Module({ controllers: [IdentitySessionController, AgentReadinessController, AgentToolsController, AgentNativeController,
      AgentNativeV3Controller, AgentResourcesController, AgentFulfillmentController], providers: [
      { provide: DATABASE_CONNECTION, useValue: database }, { provide: AgentReadinessService, useValue: readiness.service() },
      { provide: AgentToolsService, useValue: native.prior.legacy.gateway }, { provide: AgentNativeService, useValue: readiness.owners.native_v1 },
      { provide: AgentNativeV3Service, useValue: readiness.owners.native_v3 }, { provide: AgentResourcesService, useValue: native.prior.resources.service },
      { provide: AgentFulfillmentService, useValue: native.fulfillmentService },
    ] })
    class ReadinessMcpPersonalModule {}
    const reflector = new Reflector();
    const observer: NestInterceptor = { intercept(context: ExecutionContext, next: CallHandler) {
      const request = context.switchToHttp().getRequest<IncomingMessage>(), pathname = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
      const path = /^\/v1\/(?:identity\/session|ai\/agent-readiness\/(?:loop|plan|native_v1|native_v2|native_v3)|agent-(?:tools|native|native-v3|resources|fulfillment)\/workspace|agent-native-v3\/receipt|agent-native-v3\/runs\/[0-9a-f-]{36})$/.test(pathname) ? pathname : "unregistered";
      const credential = [...issued.values()].find(value => request.headers.authorization === "Bearer " + value.value);
      const row = { method: request.method ?? "", path, status: null as number | null, credentialId: credential?.id ?? null }; requests.push(row);
      context.switchToHttp().getResponse<ServerResponse>().once("finish", function (this: ServerResponse) { row.status = this.statusCode; });
      return next.handle().pipe(mergeMap(async (value: unknown) => { await controls.afterHttp?.(path); return value; }));
    } };
    app = await NestFactory.create(ReadinessMcpPersonalModule, { logger: false, abortOnError: false });
    app.useGlobalGuards(new TenantContextGuard(new OidcJwtStrategy({ issuer: "https://synthetic-mcp-readiness-oidc.invalid", audience: "synthetic-mcp-readiness-api", verificationKey: signing.publicKey }),
      new DatabaseMembershipContextLoader(database), readiness.base.loader, reflector), new PermissionsGuard(reflector), new ApiClientRouteGuard(reflector));
    app.useGlobalInterceptors(new ApiClientAuthorityInterceptor(readiness.base.loader), observer);
    await app.listen(0, "127.0.0.1"); origin = await app.getUrl(); return origin;
  }
  async function connect(actor: AgentActor, flags: readonly string[] = AgentReadinessFamilySchema.options.map(family => "--allow-readiness=" + family)) {
    const access = await token(actor), apiUrl = await startHttp();
    const value = await openReadinessClient({ apiUrl, accessToken: access.value, flags, nonce: environment.nonce }); clients.push(value); return value;
  }
  async function session(actor: AgentActor) {
    const response = await fetch(new URL("/v1/identity/session", await startHttp()), { redirect: "error", headers: { authorization: "Bearer " + (await token(actor)).value } });
    if (response.status !== 200) throw new Error("mcp_readiness_personal_session_rejected");
    const value = ErpSessionViewSchema.parse(await response.json());
    if (value.userId !== actor.userId || value.tenantId !== actor.tenantId) throw new Error("mcp_readiness_personal_identity_mismatch"); return value;
  }
  function hold(stage: "workspace" | "http", family: AgentReadinessFamily = "native_v3") {
    const entered = deferred(), released = deferred(); let used = false;
    const release = () => { released.resolve(); releases.delete(release); }; releases.add(release);
    if (stage === "workspace") readiness.controls.afterWorkspace = async selected => { if (!used && selected === family) { used = true; entered.resolve(); await released.promise; } };
    else controls.afterHttp = async path => { if (!used && path === "/v1/ai/agent-readiness/" + family) { used = true; entered.resolve(); await released.promise; } };
    return { entered: entered.promise, release, clear: () => { release(); readiness.controls.afterWorkspace = undefined; controls.afterHttp = undefined; } };
  }
  async function close() {
    if (closed) return; closed = true; for (const release of releases) release(); controls.afterHttp = undefined; readiness.controls.afterWorkspace = undefined;
    const errors: unknown[] = [];
    for (const done of [...clients.map(client => () => client.close()), () => app?.close(), () => readiness.close()]) try { await done(); } catch (error) { errors.push(error); }
    issued.clear(); if (errors.length) throw new AggregateError(errors, "mcp_readiness_fixture_cleanup_failed");
  }
  return { environment, readiness, clients, requests, token, session, connect, startHttp, hold, close, initialize: readiness.initialize };
}
