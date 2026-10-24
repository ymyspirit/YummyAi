import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { generateKeyPair, SignJWT } from "jose";
import { Permission, intersectPermissionContexts } from "@yummyai/authz";
import { CreateMarketplaceAccountInputSchema, TenantContextSchema, createEntityId, type TenantContext } from "@yummyai/contracts";
import { CaptureDraftSchema } from "@yummyai/contracts/capture";
import { ResearchStudyContentSchema } from "@yummyai/contracts/research/creative";
import { CreateProductSpuSchema, RegisterArtworkSchema, SaveProductSpecificationSchema, CreateProductCombinationSchema } from "@yummyai/contracts/catalog/development";
import { CANVAS_BRIDGE, CreateCanvasBriefInputSchema, SubmitCanvasResultInputSchema } from "@yummyai/contracts/pod/canvas-bridge";
import { ReviewVersionInputSchema, CreateCanvasPrintSpecVersionInputSchema, CreateProductionEditorProjectInputSchema,
  SaveProductionEditorVersionInputSchema, PrintProfileInputSchema } from "@yummyai/contracts";
import { AdGoalFieldsSchema, AdImportInputSchema } from "@yummyai/contracts/advertising";
import { AGENT_RESOURCES_VERSION, AgentResourceCallSchema, type AgentResourceKey, type AgentResourceInput } from "@yummyai/contracts/ai/agent-resources";
import { AgentMcpPacketSchema, AGENT_MCP_TOOL_NAMES } from "@yummyai/contracts/ai/agent-mcp";
import { agentTransportChecksum } from "@yummyai/contracts/ai/agent-transport";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { organizationTeamMembers, memberships, membershipRoles, roles, connectDatabase, loadCurrentMembershipContext, withTenant, type DatabaseConnection } from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import sharp from "sharp";
import { ClamAvScanner } from "@yummyai/storage";
import { createDefaultProductionDocument } from "../../../../packages/production-editor/src/products.js";
import { roleBenchmarkOwners } from "../../../../tools/testing/role-benchmark-fixture.mjs";
import { syntheticSpecificationFacts } from "../../../../tools/testing/specification-fixtures.js";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import type { AgentActor } from "./agent-read.test-fixture.js";
import { agentNativeFixture } from "./agent-native.test-fixture.js";
import { AgentToolsService } from "./agent-tools.service.js";
import { AgentToolsController } from "./agent-tools.controller.js";
import { AgentNativeService } from "./agent-native.service.js";
import { AgentNativeController } from "./agent-native.controller.js";
import { AgentCommandService } from "./agent-command.service.js";
import { AgentCommandController } from "./agent-command.controller.js";
import { MarketplaceAccountService } from "../marketplaces/marketplace-account.service.js";
import { ResearchStudyService } from "../research/research-study.service.js";
import { ListingService, DrizzleListingRepository } from "../listings/listing.service.js";
import { FinanceService } from "../finance/finance.service.js";
import { monetaryFact, monetaryStatement } from "../finance/finance-monetary.fixtures.js";
import { AdvertisingService } from "../customer-intelligence/advertising.service.js";
import { AdSourceGateway } from "../customer-intelligence/ad-source.gateway.js";
import { ResearchRepository } from "../research/research.repository.js";
import { AgentResourceOwners, type AgentResourceOwnerResult } from "./agent-resource-owners.js";
import { AgentResourcesService } from "./agent-resources.service.js";
import { AgentResourcesController } from "./agent-resources.controller.js";
import { IdentitySessionController } from "../auth/identity-session.controller.js";
import { OidcJwtStrategy } from "../auth/oidc-jwt.strategy.js";
import { TenantContextGuard, DatabaseMembershipContextLoader } from "../auth/tenant-context.guard.js";
import { PermissionsGuard } from "../auth/permissions.guard.js";
import { ApiClientRouteGuard } from "../auth/api-client-route.guard.js";
import { ApiClientAuthorityInterceptor } from "../auth/api-client-authority.interceptor.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import type * as OfficialMcpClient from "../../../agent-mcp/node_modules/@modelcontextprotocol/client/dist/index.mjs";
import type * as OfficialMcpStdio from "../../../agent-mcp/node_modules/@modelcontextprotocol/client/dist/stdio.mjs";

export const resourceSha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
export const resourceScopes = () => Object.fromEntries(Object.values(Permission).map(bit => [bit, "tenant" as const]));

/** Reject before constructing a connection or SDK client. There is no .env
 * fallback and this fixture never changes an isolation flag. */
export function requireAgentResourcesEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const url = new URL(requireDisposableIntegrationEnvironment(env));
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const local = ["localhost", "127.0.0.1", "[::1]"];
  const redis = env.E2E_DISPOSABLE_REDIS_URL;
  const flags = ["E2E_AGENT_RESOURCES_ISOLATED", "E2E_AGENT_READ_ISOLATED", "E2E_ROLE_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_EVALUATION_ISOLATED"];
  if (!nonce || flags.some(key => env[key] !== "1") || env.E2E_LEGACY_SCHEMA_TARGET !== "current" || !local.includes(url.hostname) ||
    env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || env.REDIS_URL !== redis ||
    env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` || !["redis:", "rediss:"].includes(new URL(redis).protocol) || !local.includes(new URL(redis).hostname))
    throw new Error("Resource acceptance requires every opt-in and its exact disposable current database bucket and Redis before connection");
  return { url: url.href, nonce };
}

/** Only this fixture child imports decorated owners. Playwright receives
 * serializable original IDs and hashes, not a replacement domain service. */
async function resourcesBrowserChild() {
  const env = requireAgentResourcesEnvironment(), database = connectDatabase(env.url), f = agentResourcesFixture(database);
  const clients: Array<Awaited<ReturnType<typeof openResourceMcpClient>>> = [];
  let context: TenantContext | undefined, seed: Awaited<ReturnType<typeof f.seed>> | undefined, closed = false, phase = "ready";
  let originals: Array<{ id: string; permissions: string[]; dataScope: "self" | "team" | "tenant" }> = [], membershipId: string | undefined, auxiliaryRoleId: string | undefined;
  let serial = Promise.resolve();
  async function restore() {
    if (!context || !membershipId) return;
    await withTenant(database.db, context, async tx => {
      for (const role of originals) await tx.update(roles).set({ permissions: role.permissions, dataScope: role.dataScope }).where(eq(roles.id, role.id));
      if (auxiliaryRoleId) {
        await tx.delete(membershipRoles).where(and(eq(membershipRoles.membershipId, membershipId!), eq(membershipRoles.roleId, auxiliaryRoleId)));
        await tx.delete(roles).where(eq(roles.id, auxiliaryRoleId)); auxiliaryRoleId = undefined;
      }
    });
    const actual = await withTenant(database.db, context, tx => tx.select({ id: roles.id, permissions: roles.permissions, dataScope: roles.dataScope })
      .from(roles).innerJoin(membershipRoles, eq(membershipRoles.roleId, roles.id)).where(eq(membershipRoles.membershipId, membershipId!)));
    if (canonicalJson(actual.sort((a, b) => a.id.localeCompare(b.id))) !== canonicalJson([...originals].sort((a, b) => a.id.localeCompare(b.id))))
      throw new Error("resource_personal_role_restore_mismatch");
  }
  async function close() {
    if (closed) return { closed: true, clients: clients.map(client => client.evidence), restored: true }; closed = true;
    const errors: unknown[] = [];
    for (const client of clients) try { await client.close(); } catch (error) { errors.push(error); }
    try { await restore(); } catch (error) { errors.push(error); }
    let cleanup: Awaited<ReturnType<typeof f.close>>;
    try { cleanup = await f.close(); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "resource_child_cleanup_failed");
    return { closed: true, clients: clients.map(client => client.evidence), restored: true, ownedCount: cleanup?.owned.length ?? 0 };
  }
  process.on("disconnect", () => { void serial.finally(close).then(() => process.exit(0), () => process.exit(1)); });
  process.on("message", raw => {
    if (!raw || typeof raw !== "object") return; const value = raw as Record<string, unknown>;
    if (value.nonce !== env.nonce || typeof value.id !== "number") return;
    const requestId = value.id;
    serial = serial.then(async () => {
      try {
        let result: unknown;
        if (value.operation === "close") { phase = "close"; result = await close(); }
        else if (value.operation === "seed") {
          phase = "initialize"; if (context) throw new Error("resource_child_already_seeded");
          const caller = TenantContextSchema.parse(value.context);
          context = TenantContextSchema.parse(await withTenant(database.db, caller, async tx => {
            const current = await loadCurrentMembershipContext(tx, { tenantId: caller.tenantId, userId: caller.userId });
            const [member] = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.tenantId, caller.tenantId), eq(memberships.userId, caller.userId), eq(memberships.status, "active")));
            if (!member) throw new Error("resource_personal_member_missing"); membershipId = member.id;
            originals = (await tx.select({ id: roles.id, permissions: roles.permissions, dataScope: roles.dataScope }).from(roles)
              .innerJoin(membershipRoles, eq(membershipRoles.roleId, roles.id)).where(eq(membershipRoles.membershipId, member.id)))
              .map(row => ({ ...row, permissions: [...row.permissions], dataScope: z.enum(["self", "team", "tenant"]).parse(row.dataScope) }));
            return intersectPermissionContexts(caller, current);
          }));
          if (!originals.length) throw new Error("resource_personal_roles_missing");
          // The actual browser operator already has a real membership and
          // model configuration. Only initialize original storage sources;
          // don't seed unrelated actors or synthetic model routes here.
          await f.facts.initialize(); phase = "six_original_sources"; seed = await f.seed(context);
          const peer = await f.base.actor(context.tenantId); phase = "foreign_original_source";
          const peerSource = await f.researchSource(TenantContextSchema.parse(peer.context), createEntityId());
          result = { id: seed.id, inputs: seed.inputs, labels: { research: seed.source.draft.title, sku: `SKU-${seed.id}`, listing: seed.listing.version.content.title,
            order: seed.order.value.id, profit: seed.profit.run.id, advertising: seed.ad.run.id, account: seed.ad.shop.displayName },
            foreign: { researchItemId: peerSource.capture.researchItemId, snapshotId: peerSource.capture.snapshotId, studyRevisionId: null, label: peerSource.draft.title },
            contextAuthority: (await f.service.workspace(context)).contextAuthority };
        } else {
          if (!context || !seed) throw new Error("resource_child_not_seeded");
          if (value.operation === "state") { phase = "state"; result = await f.state(context); }
          else if (value.operation === "restore") { phase = "restore"; await restore(); result = { restored: true }; }
          else if (value.operation === "research_self") {
            phase = "research_scope";
            await withTenant(database.db, context, async tx => {
              for (const role of originals) await tx.update(roles).set({ permissions: role.permissions.filter(bit => bit !== Permission.ResearchRead) }).where(eq(roles.id, role.id));
              if (!auxiliaryRoleId) {
                auxiliaryRoleId = createEntityId(); await tx.insert(roles).values({ id: auxiliaryRoleId, tenantId: context!.tenantId, name: `Synthetic resource scope ${auxiliaryRoleId}`,
                  permissions: [Permission.ResearchRead], dataScope: "self" });
                await tx.insert(membershipRoles).values({ tenantId: context!.tenantId, membershipId: membershipId!, roleId: auxiliaryRoleId });
              }
            }); result = { narrowed: true };
          } else if (value.operation === "connect") {
            phase = "official_sdk"; const apiUrl = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
            if (!["localhost", "127.0.0.1", "[::1]"].includes(apiUrl.hostname) || apiUrl.port !== "8130") throw new Error("resource_actual_api_missing");
            const token = z.string().min(1).max(32768).parse(value.token), flags = z.array(z.string().max(200)).max(8).parse(value.flags);
            const client = await openResourceMcpClient(apiUrl.origin, token, flags); clients.push(client);
            const tools = await client.client.listTools(); result = { clientId: clients.length - 1, tools: tools.tools.map((tool: { name: string }) => tool.name) };
          } else if (value.operation === "call") {
            phase = "sdk_call"; const id = z.int().nonnegative().parse(value.clientId), name = z.enum(Object.values(AGENT_MCP_TOOL_NAMES)).parse(value.name);
            const client = clients[id]; if (!client) throw new Error("resource_sdk_client_missing");
            result = await client.call(name, z.record(z.string(), z.unknown()).parse(value.input));
          } else throw new Error("resource_child_operation_invalid");
        }
        process.send?.({ type: "result", nonce: env.nonce, id: requestId, value: result });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : null;
        process.send?.({ type: "failure", nonce: env.nonce, id: requestId, phase, code });
      }
    });
  });
  process.send?.({ type: "ready", nonce: env.nonce });
}

if (process.argv.includes("--agent-resources-browser-child")) await resourcesBrowserChild();

/** The real public SDK and the actual stdio entrypoint. The subprocess gets
 * only the ERP URL and short-lived personal token, never fixture credentials. */
export async function openResourceMcpClient(apiUrl: string, accessToken: string, flags: readonly string[] = []) {
  requireAgentResourcesEnvironment();
  const root = fileURLToPath(new URL("../../../../", import.meta.url)), official = createRequire(new URL("../../../../apps/agent-mcp/package.json", import.meta.url));
  const sdk = await import(pathToFileURL(official.resolve("@modelcontextprotocol/client")).href) as typeof OfficialMcpClient;
  const stdio = await import(pathToFileURL(official.resolve("@modelcontextprotocol/client/stdio")).href) as typeof OfficialMcpStdio;
  const inherited: Record<string, string> = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP"]) if (process.env[key]) inherited[key] = process.env[key]!;
  const env = { ...inherited, TSX_DISABLE_CACHE: "1", YUMMYAI_MCP_ERP_API_URL: apiUrl, YUMMYAI_MCP_ERP_ACCESS_TOKEN: accessToken };
  const transport = new stdio.StdioClientTransport({ command: process.execPath,
    args: ["--import", pathToFileURL(resolve(root, "apps/agent-mcp/node_modules/tsx/dist/loader.mjs")).href, resolve(root, "apps/agent-mcp/src/main.ts"), ...flags],
    cwd: root, env, stderr: "pipe", maxBufferSize: 12 * 1024 * 1024 });
  const client = new sdk.Client({ name: "yummyai-real-resource-acceptance", version: "1.0.0" });
  const digest = createHash("sha256"), evidence = { pid: null as number | null, closed: false, processExited: false,
    stderrBytes: 0, stderrChecksum: "", credentialLeaked: false, environmentKeys: Object.keys(env).sort() };
  let tail = "", closed = false;
  transport.stderr?.on("data", (chunk: Buffer) => {
    digest.update(chunk); evidence.stderrBytes += chunk.byteLength;
    const value = tail + chunk.toString("utf8"); evidence.credentialLeaked ||= value.includes(accessToken); tail = value.slice(-Math.max(accessToken.length, 128));
  });
  const close = async () => {
    if (closed) return; closed = true; const errors: unknown[] = [];
    try { await client.close(); } catch (error) { errors.push(error); }
    try { await transport.close(); } catch (error) { errors.push(error); }
    evidence.stderrChecksum = digest.digest("hex"); tail = ""; evidence.closed = true;
    if (evidence.pid === null) evidence.processExited = true;
    else try { process.kill(evidence.pid, 0); } catch { evidence.processExited = true; }
    if (!evidence.processExited || evidence.credentialLeaked) errors.push(new Error("Resource MCP child remained active or exposed a credential"));
    if (errors.length) throw new AggregateError(errors, "Official resource MCP SDK cleanup failed");
  };
  try { await client.connect(transport); evidence.pid = transport.pid; }
  catch (error) { evidence.pid = transport.pid; try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Resource MCP handshake and cleanup failed"); } throw error; }
  return { client, evidence, close, async call(name: string, input: Record<string, unknown>) {
    const raw = await client.callTool({ name, arguments: input });
    return { packet: AgentMcpPacketSchema.parse(raw.structuredContent), isError: raw.isError === true };
  } };
}

/** Only synthetic membership admission uses fixture rows. All six business
 * resources below are created by their original services. The geometric image
 * is an original test asset, not a buyer production file or competitor asset.
 * A pending recipe and an unapproved Listing deliberately remain unfinished. */
export function agentResourcesFixture(database: DatabaseConnection) {
  const isolated = requireAgentResourcesEnvironment();
  // Reuse the real old metadata services for MCP's unchanged 49-entry catalog.
  // Its sourceContext/model execution helpers are never called by this suite.
  const prior = agentNativeFixture(database), original = prior.base;
  const current = async (actor: Pick<AgentActor, "tenantId" | "userId">) => TenantContextSchema.parse(await original.current({ tenantId: actor.tenantId, userId: actor.userId }));
  // Object spread would eagerly invoke the old fixture's lazy actor getters
  // before initialize(). Forward its real ports without enumerating them.
  const base = Object.create(original) as typeof original;
  Object.defineProperties(base, { current: { value: current },
    scopes: { value: async (...args: Parameters<typeof original.scopes>) => TenantContextSchema.parse(await original.scopes(...args)) },
    a: { get: () => ({ ...original.a, context: TenantContextSchema.parse(original.a.context) }) },
    second: { get: () => ({ ...original.second, context: TenantContextSchema.parse(original.second.context) }) },
    foreign: { get: () => ({ ...original.foreign, context: TenantContextSchema.parse(original.foreign.context) }) },
  });
  const facts = roleBenchmarkOwners(database, original.originalVault, { assistVault: original.vault });
  const accounts = new MarketplaceAccountService(database, original.audit);
  const research = new ResearchStudyService(database, original.audit);
  const listings = new ListingService(new DrizzleListingRepository(database));
  const finance = new FinanceService(database, original.audit);
  const advertising = new AdvertisingService(database, original.audit, new AdSourceGateway(facts.storage, new ClamAvScanner()));
  const repository = new ResearchRepository(database);
  const resourceOwners = new AgentResourceOwners(repository, research, facts.development, listings, base.orders, finance, advertising);
  const readCalls: Array<{ tool: AgentResourceKey; userId: string; inputChecksum: string }> = [];
  const controls: { afterRead?: (context: TenantContext, call: Parameters<typeof resourceOwners.read>[1], output: AgentResourceOwnerResult) => Promise<void> } = {};
  const read = resourceOwners.read.bind(resourceOwners);
  resourceOwners.read = async (context, call) => {
    const output = await read(context, call);
    readCalls.push({ tool: call.tool, userId: context.userId, inputChecksum: await agentTransportChecksum(call.input) });
    await controls.afterRead?.(context, call, output); return output;
  };
  const service = new AgentResourcesService(database, resourceOwners);
  let app: INestApplication | undefined, origin: string | undefined, signing: Awaited<ReturnType<typeof generateKeyPair>> | undefined;
  const issuer = "https://synthetic-resource-oidc.invalid", audience = "synthetic-resource-api";
  const owned: Array<{ kind: string; id: string; tenantId: string; ownerId: string }> = [];
  let closed = false;
  const track = (context: TenantContext, kind: string, id: string) => { owned.push({ kind, id, tenantId: context.tenantId, ownerId: context.userId }); return id; };

  async function token(actor = base.a, seconds = 300) {
    signing ??= await generateKeyPair("RS256");
    return new SignJWT({ tenant_id: actor.tenantId }).setProtectedHeader({ alg: "RS256" }).setSubject(actor.subject)
      .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + seconds).sign(signing.privateKey);
  }
  async function startHttp() {
    if (origin) return origin;
    signing ??= await generateKeyPair("RS256");
    @Module({ controllers: [IdentitySessionController, AgentResourcesController, AgentToolsController, AgentNativeController, AgentCommandController], providers: [
      { provide: DATABASE_CONNECTION, useValue: database }, { provide: AgentResourcesService, useValue: service },
      { provide: AgentToolsService, useValue: prior.gateway }, { provide: AgentNativeService, useValue: prior.service() },
      { provide: AgentCommandService, useValue: prior.owners.service() },
    ] })
    class ActualResourceHttpModule {}
    const reflector = new Reflector(), verifier = new OidcJwtStrategy({ issuer, audience, verificationKey: signing.publicKey });
    app = await NestFactory.create(ActualResourceHttpModule, { logger: false });
    app.useGlobalGuards(new TenantContextGuard(verifier, new DatabaseMembershipContextLoader(database), base.loader, reflector),
      new PermissionsGuard(reflector), new ApiClientRouteGuard(reflector));
    app.useGlobalInterceptors(new ApiClientAuthorityInterceptor(base.loader));
    await app.listen(0, "127.0.0.1"); origin = await app.getUrl(); return origin;
  }

  async function account(context: TenantContext, platform: "amazon" | "etsy", seed: string) {
    const value = await accounts.create(context, CreateMarketplaceAccountInputSchema.parse({ platform,
      displayName: `Synthetic resource ${platform} ${seed}`, externalAccountId: null, region: platform === "amazon" ? "NA" : "GLOBAL",
      marketplaceIds: ["US"], authorizationMode: platform === "amazon" ? "amazon_private" : "etsy_oauth", requestedScopes: [] }));
    track(context, "marketplace_account", value.id); return value;
  }

  async function researchSource(context: TenantContext, seed: string) {
    const externalId = BigInt("0x" + seed.replaceAll("-", "").slice(-14)).toString();
    const draft = CaptureDraftSchema.parse({ platform: "etsy", parserVersion: "etsy@1.0.0", extensionVersion: "0.0.0",
      marketplace: "www.etsy.com", sourceUrl: `https://www.etsy.com/listing/${externalId}/synthetic-resource`, externalId,
      title: `Synthetic research evidence ${seed}`, domain: "research", price: { raw: "$20.00", amount: 20, currency: "USD" },
      rating: null, reviewCount: null, taxonomy: [], listingPublishedAt: null, favoriteCount: null, shipping: null, shop: null,
      reviewSummary: null, reviews: [], reviewCollection: { collectedCount: 0, reportedTotal: null, pageCount: 0, status: "visible", updatedAt: new Date().toISOString() },
      bullets: ["Synthetic original visible-page evidence"], media: [], variants: [], productInformation: [], contentBlocks: [],
      missingFields: [], diagnostics: [], captureStatus: "complete", capturedAt: new Date().toISOString() });
    const capture = await facts.captures.createSnapshot(context, draft);
    track(context, "research_item", capture.researchItemId); track(context, "capture_snapshot", capture.snapshotId);
    const revision = await research.save(context, capture.researchItemId, { requestId: randomUUID(), snapshotId: capture.snapshotId, expectedVersion: 0,
      content: ResearchStudyContentSchema.parse({ status: "analyzed", theme: "Synthetic geometric print",
        differentiation: "Original test geometry with a known single-panel specification", audience: "Synthetic internal QA", annotations: [] }) });
    track(context, "research_study_revision", revision.id);
    return { draft, capture, revision };
  }

  async function skuSource(context: TenantContext, seed: string, teamId?: string) {
    // A distinct original raster prevents content deduplication from borrowing
    // a previous actor's asset owner or an earlier child's source admission.
    const pixels = Buffer.alloc(1024 * 1024 * 4, 255), digest = createHash("sha256").update(seed).digest();
    digest.copy(pixels, 0);
    const bytes = await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 4 } }).png().withMetadata({ density: 150 }).toBuffer();
    const scanned = await facts.clam.scan({ body: bytes, fileName: `resource-original-${seed}.png`, mediaType: "image/png" });
    if (scanned.result !== "clean" || !scanned.signatureVersion || ["unknown", "unavailable"].includes(scanned.signatureVersion))
      throw new Error("Actual source scan did not admit the synthetic original asset");
    const brief = await facts.canvas.create(context, CreateCanvasBriefInputSchema.parse({ requestId: randomUUID(), name: `Synthetic resource original ${seed}`,
      prompt: "Known original synthetic geometric pixels No production order", referenceAssetIds: [] }));
    const submitted = await facts.canvas.submit(context, brief.id, SubmitCanvasResultInputSchema.parse({ submissionId: randomUUID(),
      protocolVersion: CANVAS_BRIDGE.protocolVersion, pluginVersion: CANVAS_BRIDGE.pluginVersion, upstreamVersion: CANVAS_BRIDGE.upstreamVersion,
      sourceNodeId: createEntityId(), title: `Synthetic original asset ${seed}`, contentBase64: bytes.toString("base64"),
      rightsAttested: true, sourceKind: "owned", sourceReference: "Fixture generated original geometry No marketplace or buyer source" }));
    await facts.workflows.reviewCreativeVersion(context, submitted.versionId, ReviewVersionInputSchema.parse({ decision: "approve" }));
    const artwork = (await facts.development.registerArtwork(context, RegisterArtworkSchema.parse({ code: `AR-${seed}`, name: "Synthetic rectangular graphic",
      mode: "fixed", creativeVersionId: submitted.versionId, expectedVersion: 0, idempotencyKey: randomUUID(), ...(teamId ? { teamId } : {}) }))).artwork;
    const spu = (await facts.development.createSpu(context, CreateProductSpuSchema.parse({ code: `SPU-${seed}`, name: `Synthetic resource panel ${seed}`,
      idempotencyKey: randomUUID(), ...(teamId ? { teamId } : {}) }))).spu;
    const document = createDefaultProductionDocument("rectangular_print");
    if (document.productType !== "rectangular_print") throw new Error("Synthetic source requires its original rectangular type");
    document.name = `Synthetic source process ${seed}`; document.spec = { ...document.spec, widthMm: 60, heightMm: 40, dpi: 150, safeInsetMm: 2 };
    let template = await facts.editor.create(context, CreateProductionEditorProjectInputSchema.parse({ name: document.name, document }));
    const uploaded = await facts.editor.upload(context, template.project.id, `process-${seed}.png`, bytes);
    if (!("width" in uploaded)) throw new Error("Actual original process asset must decode as a raster");
    document.layers = [{ id: "original-image", kind: "image", name: "Original synthetic raster", assetId: uploaded.id, assetVersion: 1,
      xMm: 10, yMm: 8, widthMm: 30, heightMm: 24, rotationDeg: 0, opacity: 1, visible: true, locked: false, flipX: false, flipY: false }];
    document.confirmations = { physicalSize: true, visualReview: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true };
    template = await facts.editor.save(context, template.project.id, SaveProductionEditorVersionInputSchema.parse({ expectedVersionId: template.version.id, document }));
    await facts.editor.review(context, template.project.id, template.version.id);
    const profileCode = `RESOURCE-${seed}`;
    const profile = (await facts.work.saveProfile(context, PrintProfileInputSchema.parse({ code: profileCode, name: document.name,
      projectId: template.project.id, versionId: template.version.id, instructions: "Original synthetic rectangular facts No order or release",
      expectedVersion: 0, idempotencyKey: randomUUID() }))).find(row => row.code === profileCode);
    if (!profile) throw new Error("Original process owner did not retain its actual reviewed profile");
    const printSpec = await facts.workflows.createPrintSpec(context, CreateCanvasPrintSpecVersionInputSchema.parse({ name: `Resource panel ${seed}`,
      aspectWidth: 3, aspectHeight: 2, targetDpi: 150, bleedMm: 0, safeZoneMm: 1, wrapMode: "none",
      physicalSizes: [{ key: "synthetic", label: "Known synthetic panel", widthMm: 60, heightMm: 40 }] }));
    await facts.workflows.reviewPrintSpec(context, printSpec.id, ReviewVersionInputSchema.parse({ decision: "approve" }));
    const specification = (await facts.development.saveSpecification(context, SaveProductSpecificationSchema.parse({ spuId: spu.id, code: "PANEL-60-40",
      name: "Synthetic 60 by 40 mm panel", attributes: { size: "60x40mm", material: "synthetic QA fabric" },
      facts: syntheticSpecificationFacts({ material: "Synthetic QA fabric", physicalDimensions: { basis: "flat_piece", unit: "mm", length: 60, width: 40, height: null },
        packageContents: "One synthetic panel", packageQuantity: 1, factsConfirmed: true }),
      processProfileVersionId: profile.versionId, canvasPrintSpecVersionId: printSpec.id, stockItemId: null, expectedVersion: 0, idempotencyKey: randomUUID() }))).specification;
    const combined = await facts.development.combine(context, CreateProductCombinationSchema.parse({ artworkVersionId: artwork.versionId,
      items: [{ specificationVersionId: specification.versionId, skuCode: `SKU-${seed}` }], idempotencyKey: randomUUID() }));
    const recipe = combined.recipes[0]; if (!recipe) throw new Error("Actual ProductDevelopment owner did not create its original recipe");
    track(context, "canvas_brief", brief.id); track(context, "creative_version", submitted.versionId); track(context, "artwork", artwork.id);
    track(context, "spu", spu.id); track(context, "specification_version", specification.versionId); track(context, "sku", recipe.skuId); track(context, "recipe", recipe.id);
    return { spu, artwork, specification, recipe };
  }

  async function listingSource(context: TenantContext, sku: Awaited<ReturnType<typeof skuSource>>, seed: string) {
    const value = await listings.create(context, { spuId: sku.spu.id, platform: "etsy", marketplaceId: "US", locale: "en-US",
      content: { platform: "etsy", locale: "en-US", title: `Synthetic unreviewed listing ${seed}`, description: "Original unapproved draft facts",
        bullets: [], tags: [], mediaAssetIds: [], variants: [{ skuId: sku.recipe.skuId, skuCode: `SKU-${seed}`, optionValues: { size: "60x40mm" } }],
        attributes: { material: "Synthetic QA fabric" }, compliance: {} } });
    track(context, "listing", value.listing.id); track(context, "listing_version", value.version.id); return value;
  }

  async function orderSource(context: TenantContext, seed: string) {
    const shop = await account(context, "etsy", seed);
    const value = await base.orders.ingestNormalized(context, { accountId: shop.id, platform: "etsy", externalEventId: `${seed}:1`, externalOrderId: seed,
      providerStatus: "paid", placedAt: new Date().toISOString(), orderTotal: { amountMinor: 12345, currency: "USD" },
      lines: [{ externalLineId: `${seed}-line`, externalListingId: null, skuCode: null, title: "Synthetic ordinary resource item", quantity: 3,
        unitPrice: { amountMinor: 4115, currency: "USD" }, customizationCount: 0 }],
      redactedSource: { fixture: seed }, protectedDetails: null });
    track(context, "order", value.id); return { shop, value };
  }

  async function financeSource(context: TenantContext, seed: string, complete = true) {
    const statement = await finance.recordStatement(context, monetaryStatement("USD", [
      monetaryFact("USD", 10000, { factType: "sale_revenue", direction: "credit" }),
      ...(complete ? [monetaryFact("USD", 4700)] : []),
    ], { externalStatementId: `resource-${seed}`, idempotencyKey: `statement-${seed}` }));
    const metric = await finance.upsertProfitMetric(context, { metricId: null, name: `Synthetic resource metric ${seed}`, reportingCurrency: "USD",
      revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost"], requiredFactTypes: ["sale_revenue", "production_cost"],
      reasonCode: "SYNTHETIC", idempotencyKey: `metric-${seed}` });
    const run = await finance.calculateProfit(context, { metricId: metric.id, expectedMetricVersion: 1, statementIds: [statement.id], fxRateIds: [],
      coverageDimension: "aggregate", idempotencyKey: `profit-${seed}` });
    track(context, "finance_statement", statement.id); track(context, "finance_metric", metric.id); track(context, "finance_profit_run", run.id);
    return { statement, metric, run };
  }

  async function adSource(context: TenantContext, seed: string) {
    const shop = await account(context, "amazon", seed);
    const header = "日期范围,广告主账户 ID,广告产品,广告活动编号,广告组编号,预算货币,展示量,点击量,购买量,总成本,销售额";
    const row = "2026年09月01日 - 2026年09月15日,advertiser,SP,campaign,group,USD,1000,40,4,10,40";
    const body = AdImportInputSchema.parse({ accountId: shop.id, marketplaceByCurrency: { USD: "US" }, timezone: "America/Los_Angeles",
      attributionWindowDays: 7, attributionBasis: "click", observedAt: "2026-09-16T18:00:00.000Z", dateOrder: null,
      allowPartial: false, idempotencyKey: `ad-import-${seed}`, files: [
        { fileName: `${seed}-campaign.csv`, content: `${header}\n${row}` },
        { fileName: `${seed}-product.csv`, content: `${header},推广的商品编号\n${row},B012345678` },
        { fileName: `${seed}-target.csv`, content: `${header},投放方案编号,投放方案,目标竞价,投放状态\n${row},target,synthetic geometric panel,1,ENABLED` },
      ] });
    const preview = await advertising.preview(context, body);
    if (!preview.canCommit) throw new Error("Actual advertising owner rejected the synthetic original CSV sources");
    const imported = await advertising.commit(context, { ...body, previewChecksum: preview.previewChecksum });
    const goal = await advertising.saveGoal(context, { scope: { accountId: shop.id, marketplace: "US", currency: "USD", asin: "B012345678" }, expectedRevision: 0,
      fields: AdGoalFieldsSchema.parse({ mode: "profit_defense", effectiveFrom: "2026-09-01", targetAcosBps: 2100, unitPriceMinor: 10000, unitCostMinor: 7000,
        coreKeywords: [], protectedTerms: [], trialEndDate: null, trialSpendLimitMinor: null, notes: "Synthetic independently specified USD economics" }), idempotencyKey: `ad-goal-${seed}` });
    const run = await advertising.analyze(context, { accountId: shop.id, periodStart: "2026-09-01", periodEnd: "2026-09-15", marketplace: null, currency: null,
      evidenceCutoffAt: new Date().toISOString(), idempotencyKey: `ad-analysis-${seed}` });
    for (const item of imported.imports) track(context, "ad_import", item.id);
    track(context, "ad_goal", goal.id); track(context, "ad_analysis", run.id); return { shop, imported, goal, run };
  }

  async function seed(rawContext: TenantContext, teamId?: string) {
    const context = TenantContextSchema.parse(rawContext), id = createEntityId();
    // New id per invocation is essential: the compiled browser reuses a real
    // personal actor while restarting this child for each independent leaf.
    const source = await researchSource(context, id), sku = await skuSource(context, id, teamId), listing = await listingSource(context, sku, id),
      order = await orderSource(context, id), profit = await financeSource(context, id), ad = await adSource(context, id);
    const inputs: { [K in AgentResourceKey]: AgentResourceInput<K> } = {
      "research.evidence": { researchItemId: source.capture.researchItemId, snapshotId: source.capture.snapshotId, studyRevisionId: source.revision.id },
      "catalog.sku": { skuId: sku.recipe.skuId, recipeId: sku.recipe.id }, "listing.version": { listingId: listing.listing.id, versionId: listing.version.id },
      "orders.order": { orderId: order.value.id, expectedSequence: order.value.latestEventSequence },
      "finance.profit_run": { runId: profit.run.id }, "advertising.analysis": { accountId: ad.shop.id, analysisId: ad.run.id },
    };
    return { id, source, sku, listing, order, profit, ad, inputs };
  }

  async function state(context: TenantContext) {
    const tables = ["capture_snapshots", "research_study_revisions", "artwork_master_versions", "product_specification_versions", "sales_recipe_versions", "listing_versions",
      "orders", "order_events", "order_lines", "order_protected_access_events", "finance_statements", "finance_facts", "finance_profit_runs", "finance_profit_contributions", "ad_imports", "ad_facts", "ad_analysis_runs",
      "inventory_procurement_commands", "inventory_incoming_commands", "production_command_intents", "finance_commands", "advertising_commands", "agent_command_requests",
      "ad_actions", "ad_action_events", "production_orders", "audit_events",
      "ai_assist_runs", "ai_assist_executions", "ai_budget_ledger", "agent_plan_runs", "agent_plan_steps", "agent_plan_items"];
    return withTenant(database.db, context, async tx => {
      const result: Record<string, { count: number; hash: string }> = {};
      for (const table of tables) result[table] = (await tx.execute<{ count: number; hash: string }>(sql`select count(*)::int as count,
        md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from ${sql.identifier(table)} t`))[0]!;
      return { tables: result, paidDispatches: base.dispatches.length, providerRequests: base.providerRequests.length };
    });
  }
  async function joinTeam(actor: AgentActor, teamId: string) {
    const id = createEntityId();
    await withTenant(database.db, await current(actor), tx => tx.insert(organizationTeamMembers).values({ id, tenantId: actor.tenantId,
      teamId, membershipId: actor.membershipId, createdBy: actor.userId }));
    return id;
  }

  async function close() {
    if (closed) return; closed = true;
    const errors: unknown[] = [];
    try { await app?.close(); } catch (error) { errors.push(error); }
    try { facts.close(); } catch (error) { errors.push(error); }
    try { prior.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Resource fixture SDK cleanup failed");
    // The disposable runner destroys this exact nonce database and private
    // bucket even when a seed or assertion fails. Immutable source history is
    // never edited merely to clean up a test.
    return { nonce: isolated.nonce, owned: [...owned], immutableHistory: "until_exact_nonce_runner_disposal" as const };
  }
  async function initialize() {
    try { await prior.initialize(); await facts.initialize(); }
    catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Resource fixture initialization and cleanup failed"); } throw error; }
  }
  return { base, facts, accounts, research, repository, listings, finance, advertising, database, isolated, owned, resourceOwners, service, controls, readCalls,
    initialize, close, seed, state, current, token, startHttp, joinTeam, researchSource, skuSource, listingSource, orderSource, financeSource, adSource,
    sha: resourceSha, canonical: canonicalJson, checksum: agentTransportChecksum, parseCall: AgentResourceCallSchema.parse, version: AGENT_RESOURCES_VERSION };
}
