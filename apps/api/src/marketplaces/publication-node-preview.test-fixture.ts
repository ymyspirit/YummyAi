import "reflect-metadata";
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createServer as createHttpsServer, request as httpsRequest, Agent, type Server as HttpsServer } from "node:https";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { Permission } from "@yummyai/authz";
import { createEntityId, CreateMarketplaceAccountInputSchema, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { StoreNodeEnrollmentCreatedSchema, StoreNodeHeartbeatInputSchema, StoreNodeHeartbeatViewSchema, StoreNodeWorkspaceSchema,
  STORE_NODE_PROTOCOL, storeNodeEnrollmentProofText, type StoreNodeEnrollmentBundle, type StoreNodeHeartbeatInput } from "@yummyai/contracts/marketplace/store-node";
import { memberships, membershipRoles, roles, marketplaceStoreNodes, marketplaceStoreNodeBindings, loadCurrentMembershipContext,
  withTenant, type DatabaseConnection } from "@yummyai/database";
import { createMarketplaceSecretVault, HttpMarketplaceAuthorizationGateway, HttpMarketplaceCapabilityGateway } from "@yummyai/marketplace-connectors";
import { requirePublicationNodePreviewEnvironment } from "../../../../tools/testing/publication-node-preview-environment.mjs";
import { requirePublicationAuthorityEnvironment } from "../../../../tools/testing/publication-authority-environment.mjs";
import { requireAmazonPublicNodeEnvironment } from "../../../../tools/testing/amazon-public-node-environment.mjs";
import { requirePublicationNodeSubmitEnvironment } from "../../../../tools/testing/publication-node-submit-environment.mjs";
import { ErpSessionViewSchema } from "@yummyai/contracts/auth/session";
import { executionBounded, startPublicationNodePreviewProvider } from "./publication-node-preview-provider.test-fixture.js";
import { startFactoryIdentityFixture } from "../../../../tools/testing/factory-identity-fixture.mjs";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { MarketplaceAccountService } from "./marketplace-account.service.js";
import { MarketplaceAuthorizationService } from "./marketplace-authorization.service.js";
import { MarketplaceCapabilityService } from "./marketplace-capability.service.js";
import { StoreNodeService } from "./store-node.service.js";
import { StoreNodePki } from "./store-node-pki.js";
import { StoreNodeExecutionService } from "./store-node-execution.service.js";
import { MarketplacePublicationService } from "./marketplace-publication.service.js";
import { ListingService, DrizzleListingRepository } from "../listings/listing.service.js";
import { productPlans, spus, assetFiles, marketplacePublicationIntents, marketplacePublicationRequests,
  marketplacePublicationEvents, marketplaceStoreNodeExecutions, marketplaceStoreNodeExecutionSteps } from "@yummyai/database";
import { CreatePublicationPreviewInputSchema, PublicationPreviewRequestViewSchema, PublicationPreviewWorkspaceSchema,
  publicationPreviewRequestText, type PublicationPreviewWorkspaceInput } from "@yummyai/contracts/marketplace/publication-preview";
import { CreateStoreNodeExecutionInputSchema, StoreNodeExecutionViewSchema, storeNodeExecutionRequestText, STORE_NODE_EXECUTION_OPERATION,
  type CreateStoreNodeExecutionInput } from "@yummyai/contracts/marketplace/store-node-execution";
import { marketplaceAccounts, marketplaceCredentials, marketplaceCapabilitySnapshots } from "@yummyai/database";
import { openStoreNodeState } from "../../../store-api-node/src/identity.js";
import type { StoreNodeCertificateIssuer } from "./store-node.types.js";
export { assertPublicationNodePreviewOriginal181Graph, migratePublicationNodePreviewLegacyDatabase } from "./publication-node-preview-graph.test-fixture.js";

export const root = fileURLToPath(new URL("../../../../", import.meta.url));
export const lane = process.env.E2E_PUBLICATION_NODE_SUBMIT_ISOLATED === "1" ? requirePublicationNodeSubmitEnvironment().lane
  : process.env.E2E_AMAZON_PUBLIC_NODE_ISOLATED === "1" ? requireAmazonPublicNodeEnvironment().lane
  : process.env.E2E_PUBLICATION_AUTHORITY_ISOLATED === "1" ? requirePublicationAuthorityEnvironment().lane : resolve(root, "tmp/publication-node-preview-20261022-a6f4c2d9/qa");
export const nodeExecutionPermissions = [Permission.StoreRead, Permission.StoreManage, Permission.StoreAuthorize, Permission.ListingRead, Permission.ListingWrite, Permission.ListingReview, Permission.ListingPublish, Permission.ProductRead, Permission.WorkflowRead, Permission.WorkflowRun];
export const nodeExecutionSha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function safeCode(raw: unknown): string | null {
  const result = z.object({ code: z.string().regex(/^(?:store_node_|marketplace_|publication_)[a-z_]{1,100}$/) }).safeParse(raw);
  return result.success ? result.data.code : null;
}
const StorageDiagnosticSchema = z.object({ code: z.literal("store_node_storage_diagnostic"),
  phase: z.enum(["initialize", "acl_read", "acl_apply", "acl_verify", "acquire", "receive", "validate", "decode", "create", "write", "flush", "replace", "move", "ack"]),
  target: z.enum(["none", "state", "journal"]),
  errorType: z.enum(["IOException", "UnauthorizedAccessException", "PrivilegeNotHeldException", "ArgumentException", "ArgumentNullException", "PathTooLongException",
    "NotSupportedException", "SecurityException", "InvalidOperationException", "FormatException", "OutOfMemoryException", "MethodInvocationException", "RuntimeException", "Other"]),
  hresult: z.int().min(-2147483648).max(2147483647) }).strict();
/** Keeps only database-owned diagnostics and fixed stages, never error text, SQL or secret values. */
export function executionCleanupDiagnostic(error: unknown, phase: string) {
  const result: Array<{ phase: string; errorName: string; code: string | null; constraint: string | null }> = [], seen = new Set<object>();
  const visit = (value: unknown, depth = 0) => { if (!value || typeof value !== "object" || seen.has(value) || depth > 6 || result.length >= 24) return; seen.add(value);
    const names = ["Error", "AggregateError", "PostgresError", "DrizzleQueryError", "ConflictException", "UnauthorizedException", "ForbiddenException", "StoreNodeError"];
    const errorName = value instanceof Error && names.includes(value.name) ? value.name : "Error";
    const code = "code" in value && typeof value.code === "string" && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|store_node_[a-z_]{1,100})$/.test(value.code) ? value.code : null;
    const constraint = "constraint_name" in value && typeof value.constraint_name === "string" && /^(?:store_node_|marketplace_)[a-z0-9_]{1,110}$/.test(value.constraint_name) ? value.constraint_name : null;
    result.push({ phase: /^[a-z_]{1,40}$/.test(phase) ? phase : "unknown", errorName, code, constraint });
    if ("cause" in value) visit(value.cause, depth + 1);
    if (value instanceof AggregateError) for (const nested of value.errors.slice(0, 24)) visit(nested, depth + 1);
  }; visit(error); return result;
}
export type ExecutionActor = { userId: string; tenantId: string; membershipId: string; roleId: string; subject: string; ceiling: TenantContext };
export type ExecutionNodeKeys = { id: string; directory: string; publicKeyPem: string; passphrase: string };
export type SocketIdentity = { cert?: string; key?: Buffer; passphrase?: string; ca?: string; agent?: Agent };
export type PreviewSource = { listingId: string; versionId: string; variantSkuId: string; assetId: string; supplementalAssetId: string; spuId: string; planId: string;
  accountId: string; title: string; sku: string; sellerId: string; attributes: Record<string, unknown> };

function owned(name: string) {
  const path = resolve(lane, name), rel = relative(lane, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("store_node_fixture_path_invalid"); return path;
}
export function executionSystemEnvironment() {
  return Object.fromEntries(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
}
export function nodeExecutionLatch() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
async function openssl(args: string[]) {
  return new Promise<string>((done, reject) => execFile("D:/Git/usr/bin/openssl.exe", args, { windowsHide: true, timeout: 30_000, maxBuffer: 131072, env: executionSystemEnvironment() },
    (error, stdout) => error ? reject(new Error("store_node_fixture_openssl_failed")) : done(stdout)));
}
/** Called only inside the root-owned functional runner, never during module import. */
export async function createExecutionPki(nonce: string) {
  if (!/^OpenSSL 3\.5\.4\b/.test(await openssl(["version"]))) throw new Error("store_node_fixture_openssl_version_changed");
  const directory = owned(`pki-${nonce}-${createEntityId()}`); await mkdir(directory, { recursive: false });
  const path = (name: string) => resolve(directory, name);
  await openssl(["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-keyout", path("ca-key.pem"), "-out", path("ca.pem"),
    "-days", "2", "-sha256", "-subj", "/CN=Synthetic-disposable-store-node-CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  await openssl(["req", "-new", "-newkey", "rsa:3072", "-nodes", "-keyout", path("server-key.pem"), "-out", path("server.csr"), "-subj", "/CN=localhost"]);
  await writeFile(path("server.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n", { flag: "wx" });
  await openssl(["x509", "-req", "-in", path("server.csr"), "-CA", path("ca.pem"), "-CAkey", path("ca-key.pem"), "-set_serial", "0x" + randomBytes(16).toString("hex"),
    "-days", "1", "-sha256", "-extfile", path("server.ext"), "-out", path("server.pem")]);
  await openssl(["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-keyout", path("foreign-key.pem"), "-out", path("foreign-ca.pem"),
    "-days", "1", "-sha256", "-subj", "/CN=Synthetic-untrusted-node-CA"]);
  const temp = path("temporary"); await mkdir(temp);
  return { directory, ca: await readFile(path("ca.pem"), "utf8"), foreignCa: await readFile(path("foreign-ca.pem"), "utf8"),
    serverKey: await readFile(path("server-key.pem")), serverCert: await readFile(path("server.pem"), "utf8"),
    env: { STORE_NODE_RUNTIME_ENABLED: "1", STORE_NODE_OPENSSL_PATH: "D:/Git/usr/bin/openssl.exe", STORE_NODE_CA_CERT_PATH: path("ca.pem"),
      STORE_NODE_CA_KEY_PATH: path("ca-key.pem"), STORE_NODE_SERVER_CERT_PATH: path("server.pem"), STORE_NODE_SERVER_KEY_PATH: path("server-key.pem"),
      STORE_NODE_ENROLLMENT_ORIGIN: "https://127.0.0.1:8141", STORE_NODE_RUNTIME_ORIGIN: "https://127.0.0.1:8142",
      STORE_NODE_RUNTIME_HOST: "127.0.0.1", STORE_NODE_RUNTIME_PORT: "8142", TEMP: temp, TMP: temp } };
}

export function publicationNodePreviewFixture(database: DatabaseConnection, options: { actor?: Omit<ExecutionActor, "ceiling">; apiPort?: number; readyPath?: string; ready?: () => boolean; amazonPublic?: boolean } = {}) {
  const submissionFamily = process.env.E2E_PUBLICATION_NODE_SUBMIT_ISOLATED === "1";
  const isolated = submissionFamily ? requirePublicationNodeSubmitEnvironment(process.env, "current")
    : process.env.E2E_AMAZON_PUBLIC_NODE_ISOLATED === "1" ? requireAmazonPublicNodeEnvironment() : requirePublicationNodePreviewEnvironment(process.env, "current");
  if (options.amazonPublic && process.env.E2E_AMAZON_PUBLIC_NODE_ISOLATED !== "1" && !submissionFamily) throw new Error("public_node_fixture_requires_its_owned_family");
  const audit = new AuditService(database), accounts = new MarketplaceAccountService(database, audit), vault = createMarketplaceSecretVault();
  const authorization = new MarketplaceAuthorizationService(database, vault, new HttpMarketplaceAuthorizationGateway(), audit);
  let a: ExecutionActor, peer: ExecutionActor, foreign: ExecutionActor, pkiFiles: Awaited<ReturnType<typeof createExecutionPki>>, pki: StoreNodePki, service: StoreNodeService;
  let provider: Awaited<ReturnType<typeof startPublicationNodePreviewProvider>>, identity: Awaited<ReturnType<typeof startFactoryIdentityFixture>>;
  let capabilities: MarketplaceCapabilityService;
  let executions: StoreNodeExecutionService;
  let publications: MarketplacePublicationService;
  const localListings = new ListingService(new DrizzleListingRepository(database));
  let app: INestApplication | undefined, appDatabase: DatabaseConnection | undefined, bootstrap: HttpsServer | undefined, origin = "", closed = false;
  let restoreProvider: (() => void) | undefined, restoreEnvironment: (() => void) | undefined;
  const stores = new Map<string, ExecutionActor>(), children = new Set<ReturnType<typeof launchNode>>(), agents = new Set<Agent>();
  const evidence = { openssl: "3.5.4", pkiDirectory: "", bootstrapClosed: false, apiClosed: false, identityClosed: false,
    providerClosed: false, childExits: [] as object[], cleanupFailures: [] as ReturnType<typeof executionCleanupDiagnostic>, bootstrapPosts: 0, runtimePlatformCalls: 0, execution: "marketplace.capabilities.sync.v1" };

  async function actor(tenantId = createEntityId()) {
    const userId = createEntityId(), membershipId = createEntityId(), roleId = createEntityId(), subject = "store-node-execution-" + userId;
    const ceiling: TenantContext = { tenantId, userId, permissions: [...nodeExecutionPermissions], dataScope: "tenant" };
    await database.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic node tenant',$2)on conflict(id)do nothing", [tenantId, "node-" + tenantId]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic store node operator')", [userId, subject, userId + "@example.invalid"]);
    await withTenant(database.db, ceiling, async tx => { await tx.insert(memberships).values({ id: membershipId, tenantId, userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId, name: "Synthetic node role " + roleId, permissions: [...nodeExecutionPermissions], dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId, membershipId, roleId }); });
    return { tenantId, userId, membershipId, roleId, subject, ceiling };
  }
  const current = async (who = a) => withTenant(database.db, who.ceiling, async tx => TenantContextSchema.parse(await loadCurrentMembershipContext(tx, { tenantId: who.tenantId, userId: who.userId })));
  const rights = async (who: ExecutionActor, permissions: readonly string[] = nodeExecutionPermissions, dataScope: "self" | "tenant" = "tenant") =>
    withTenant(database.db, who.ceiling, tx => tx.update(roles).set({ permissions: [...permissions], dataScope }).where(eq(roles.id, who.roleId)));
  async function registerStore(accountId: string, who = a) {
    const context = await current(who), account = await accounts.get(context, accountId);
    const [row] = await withTenant(database.db, context, tx => tx.select({ createdBy: marketplaceAccounts.createdBy }).from(marketplaceAccounts).where(eq(marketplaceAccounts.id, accountId)).limit(1));
    if (!row || row.createdBy !== who.userId || stores.has(accountId) && stores.get(accountId) !== who) throw new Error("public_node_fixture_store_not_owned");
    stores.set(accountId, who); return account;
  }
  async function createStore(who = a, platform: "etsy" | "amazon" = "etsy", amazonMode: "amazon_private" | "amazon_public" = options.amazonPublic ? "amazon_public" : "amazon_private") {
    if (amazonMode === "amazon_public" && process.env.E2E_AMAZON_PUBLIC_NODE_ISOLATED !== "1" && !submissionFamily) throw new Error("public_node_fixture_requires_its_owned_family");
    const context = await current(who), account = await accounts.create(context, CreateMarketplaceAccountInputSchema.parse({ platform,
      authorizationMode: platform === "etsy" ? "etsy_oauth" : amazonMode, region: platform === "etsy" ? "GLOBAL" : "NA",
      marketplaceIds: platform === "etsy" ? ["etsy"] : ["ATVPDKIKX0DER"], requestedScopes: platform === "etsy" ? ["listings_r", "shops_r"] : ["product-listing"],
      displayName: "Synthetic-node-execution-" + createEntityId() }));
    await registerStore(account.id, who);
    if (platform === "etsy") { const started = await authorization.startOAuth(await current(who), account.id);
      await authorization.completeOAuth(await current(who), account.id, provider.code(started.authorizationUrl));
    } else if (amazonMode === "amazon_public") {
      const started = await authorization.startOAuth(await current(who), account.id);
      await authorization.completeOAuth(await current(who), account.id, provider.amazonCode(started.authorizationUrl, provider.sellerId + "-" + account.id));
    } else await authorization.authorizeAmazonPrivate(await current(who), account.id, { ...provider.privateInput, sellingPartnerId: provider.sellerId + "-" + account.id });
    const known = await accounts.get(await current(who), account.id);
    if (known.status !== "pending_authorization" || !known.hasCredential || known.credentialStatus !== "valid") throw new Error("store_node_fixture_requires_original_known_bootstrap");
    return known;
  }

  async function token(who = a) {
    if (options.actor) {
      if (who !== a) throw new Error("publication_preview_browser_token_actor_not_owned");
      const originalToken = process.env.API_ACCESS_TOKEN;
      if (!originalToken) throw new Error("publication_preview_browser_original_personal_token_missing");
      const response = await fetch(origin + "/v1/identity/session", { method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { authorization: "Bearer " + originalToken } });
      if (response.status !== 200) throw new Error("publication_preview_browser_original_personal_session_unavailable");
      const session = ErpSessionViewSchema.parse(await response.json());
      if (session.userId !== a.userId || session.tenantId !== a.tenantId) throw new Error("publication_preview_browser_original_personal_actor_mismatch");
      return originalToken;
    }
    const name = who === a ? "operator" : who === peer ? "peer" : "foreign";
    const response = await fetch(identity.baseUrl + "/_fixture/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-fixture-control": identity.controlKey },
      body: new URLSearchParams({ account: name }), redirect: "error" });
    if (response.status !== 200) throw new Error("store_node_fixture_token_failed");
    return z.object({ access_token: z.string().min(1) }).strict().parse(await response.json()).access_token;
  }
  async function http(path: string, input?: unknown, who = a) {
    const url = new URL(path, "http://synthetic-fixture.invalid"), keys = [...url.searchParams.keys()];
    const preview = /^\/v1\/marketplace-publications\/preview(?:\/[0-9a-f-]{36}(?:\/cancel)?|\/workspace|\/receipt)?$/.test(url.pathname);
    const events = /^\/v1\/marketplace-publications\/[0-9a-f-]{36}\/events$/.test(url.pathname);
    const query = url.pathname.endsWith("/workspace") ? keys.every(key => ["listingId", "listingVersionId", "variantSkuId"].includes(key))
      : url.pathname.endsWith("/receipt") ? keys.every(key => ["requestKey", "requestChecksum"].includes(key)) : keys.length === 0;
    if (url.origin !== "http://synthetic-fixture.invalid" || url.hash || keys.length !== new Set(keys).size || !query ||
      !(preview || events || /^\/v1\/(?:marketplace-accounts\/|identity\/session)/.test(path) && !url.search)) throw new Error("publication_preview_fixture_http_path_invalid");
    const response = await fetch(origin + path, { method: input === undefined ? "GET" : "POST", redirect: "error", headers: { authorization: "Bearer " + await token(who),
      ...(input === undefined ? {} : { "content-type": "application/json" }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: await response.json() as unknown };
  }
  async function tls(path: string, body: unknown, socket: SocketIdentity = {}, headers: Record<string, string> = {}) {
    if (!/^\/v1\/store-nodes\/(?:enroll|runtime\/(?:heartbeat|executions\/(?:claim|permit|step|checkpoint|complete|receipt)))$/.test(path)) throw new Error("store_node_tls_path_invalid");
    const url = new URL(path, path.endsWith("enroll") ? pkiFiles.env.STORE_NODE_ENROLLMENT_ORIGIN : pkiFiles.env.STORE_NODE_RUNTIME_ORIGIN);
    return new Promise<{ status: number; body: unknown }>((done, reject) => {
      const request = httpsRequest(url, { method: "POST", ca: socket.ca ?? pkiFiles.ca, cert: socket.cert, key: socket.key, passphrase: socket.passphrase,
        agent: socket.agent ?? false, rejectUnauthorized: true, timeout: 15_000, headers: { "content-type": "application/json", ...headers } }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 24 * 1024 * 1024) response.destroy(new Error("store_node_fixture_response_oversized")); else chunks.push(chunk); });
        response.once("error", () => reject(new Error("store_node_fixture_tls_response_failed")));
        response.once("end", () => { try { done({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }); }
          catch { reject(new Error("store_node_fixture_tls_json_invalid")); } });
      });
      request.once("timeout", () => request.destroy(new Error("store_node_fixture_tls_deadline")));
      request.once("error", error => { const code = "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : "TLS_REJECTED";
        reject(new Error(code)); }); request.end(JSON.stringify(body));
    });
  }
  async function initialize() {
    try {
      const [count] = await database.client.unsafe("select count(*)::int as value from drizzle.__drizzle_migrations");
      if (count?.value !== (submissionFamily ? 183 : 182)) throw new Error(submissionFamily ? "publication_submit_fixture_requires_current183" : "publication_preview_fixture_requires_current182");
      await mkdir(lane, { recursive: true }); pkiFiles = await createExecutionPki(isolated.nonce); evidence.pkiDirectory = pkiFiles.directory;
      a = options.actor ? { ...options.actor, ceiling: { tenantId: options.actor.tenantId, userId: options.actor.userId, permissions: [...nodeExecutionPermissions], dataScope: "tenant" } } : await actor();
      peer = await actor(a.tenantId); foreign = await actor();
      if (!options.actor) identity = await startFactoryIdentityFixture(a.tenantId, a.subject, "http://localhost:3130", { application: "erp", clientId: "yummyai-web", accounts: {
        operator: { subject: a.subject, name: "Synthetic node operator" }, peer: { subject: peer.subject, name: "Synthetic node peer" },
        foreign: { subject: foreign.subject, name: "Synthetic unrelated node operator", tenantId: foreign.tenantId } } });
      provider = await startPublicationNodePreviewProvider({ key: pkiFiles.serverKey, cert: pkiFiles.serverCert, ca: pkiFiles.ca }, pkiFiles.directory,
        { amazonPublic: options.amazonPublic, publicationSubmit: submissionFamily });
      const values = { ...pkiFiles.env, ...provider.environment, STORE_NODE_EXECUTION_ENABLED: "1", ...(!options.actor ? { OIDC_ISSUER: identity.baseUrl, OIDC_AUDIENCE: "yummyai-api", OIDC_JWKS_URI: identity.baseUrl + "/protocol/openid-connect/certs" } : {}) };
      const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
      restoreEnvironment = () => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; };
      restoreProvider = provider.installAuthorizationTransport();
      capabilities = new MarketplaceCapabilityService(database, vault, new HttpMarketplaceCapabilityGateway(provider.request), authorization, audit);
      pki = await StoreNodePki.fromEnvironment(process.env); service = new StoreNodeService(database, audit, pki);
      executions = new StoreNodeExecutionService(database, vault, audit, service, capabilities);
      const { AppModule } = await import("../app.module.js"); app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
      appDatabase = app.get<DatabaseConnection>(DATABASE_CONNECTION);
      publications = app.get(MarketplacePublicationService);
      executions = new StoreNodeExecutionService(database, vault, audit, service, capabilities, publications);
      if (options.readyPath) app.getHttpAdapter().get(options.readyPath, (_request: unknown, response: { status(value: number): { json(value: object): void } }) => {
        const ready = options.ready?.() ?? true; return response.status(ready ? 200 : 503).json({ ready }); });
      await app.listen(options.apiPort ?? 0, "127.0.0.1"); origin = await app.getUrl();
      bootstrap = createHttpsServer({ key: pkiFiles.serverKey, cert: pkiFiles.serverCert, minVersion: "TLSv1.3" }, async (request, response) => {
        if (request.method !== "POST" || request.url !== "/v1/store-nodes/enroll") { response.writeHead(404); response.end(); return; }
        evidence.bootstrapPosts++; const chunks: Buffer[] = []; let size = 0;
        try { for await (const chunk of request) { size += chunk.length; if (size > 32768) throw new Error("oversized"); chunks.push(Buffer.from(chunk)); }
          const actual = await fetch(origin + "/v1/store-nodes/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks), redirect: "error" });
          response.writeHead(actual.status, { "content-type": "application/json" }); response.end(Buffer.from(await actual.arrayBuffer()));
        } catch { response.writeHead(502, { "content-type": "application/json" }); response.end('{"code":"synthetic_bootstrap_transport_failed"}'); }
      });
      await new Promise<void>((done, reject) => { bootstrap!.once("error", reject); bootstrap!.listen(8141, "127.0.0.1", done); });
    } catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Store node fixture initialization failed"); } throw error; }
  }
  async function initNode() {
    const id = createEntityId(), directory = owned(`node-${isolated.nonce}-${id}`), passphrase = randomBytes(32).toString("base64url");
    const process = launchNode("init", { directory, passphrase }); children.add(process); await executionBounded(process.done, "store_node_cli_init_deadline", 30_000);
    if (process.evidence.exitCode !== 0 || process.evidence.leaked) throw new Error("store_node_real_cli_init_failed:" + JSON.stringify({ exitCode: process.evidence.exitCode, code: process.evidence.stderrCode, storageDiagnostic: process.evidence.storageDiagnostic }));
    const publicKeyPem = (await readFile(resolve(directory, "public-key.pem"), "utf8")).replaceAll("\r\n", "\n");
    return { id, directory, publicKeyPem, passphrase };
  }
  async function waitSavedHeartbeat(keys: ExecutionNodeKeys, pulse: Awaited<ReturnType<typeof runNode>>,
    expected: { accountId: string; nodeId: string; bindingRevision?: number }, who = a) {
    if (stores.get(expected.accountId)?.userId !== who.userId) throw new Error("store_node_fixture_heartbeat_not_owned");
    const savedState = z.object({ pending: z.null(), last: StoreNodeHeartbeatViewSchema }).passthrough(), spki = nodeExecutionSha(createPublicKey(keys.publicKeyPem).export({ type: "spki", format: "der" }));
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (pulse.evidence.exited) throw new Error("store_node_fixture_heartbeat_cli_exited:" + JSON.stringify({ exitCode: pulse.evidence.exitCode, code: pulse.evidence.stderrCode, states: pulse.evidence.states.slice(-6), storageDiagnostic: pulse.evidence.storageDiagnostic }));
        const online = pulse.evidence.states.filter(value => value.state === "online" && value.sequence !== undefined).at(-1);
        if (online) { const bytes = await readFile(resolve(keys.directory, "state.pe"));
          try { const state = savedState.safeParse(await openStoreNodeState(bytes, keys.passphrase, spki));
            if (state.success && state.data.last.nodeId === expected.nodeId && state.data.last.sequence === online.sequence &&
              (expected.bindingRevision === undefined || state.data.last.bindingRevision === expected.bindingRevision && state.data.last.bindingState === "active")) {
              const latest = await rows(expected.nodeId, who), after = await readFile(resolve(keys.directory, "state.pe"));
              try { if (latest.node?.accountId === expected.accountId && latest.node.publicKeySpkiSha256 === spki && latest.node.sessionId === state.data.last.sessionId &&
                latest.node.lastSequence === state.data.last.sequence && (expected.bindingRevision === undefined || latest.binding?.nodeId === expected.nodeId &&
                  latest.binding.state === "active" && latest.binding.revision === expected.bindingRevision) && bytes.equals(after)) return state.data.last; }
              finally { after.fill(0); }
            }
          } finally { bytes.fill(0); }
        }
        let timer: NodeJS.Timeout | undefined;
        try { await Promise.race([pulse.done, new Promise<void>(done => { timer = setTimeout(done, 50); })]); } finally { if (timer) clearTimeout(timer); }
      }
      throw new Error("store_node_fixture_saved_heartbeat_deadline:" + JSON.stringify({ code: pulse.evidence.stderrCode, states: pulse.evidence.states.slice(-6), storageDiagnostic: pulse.evidence.storageDiagnostic }));
  }
  async function bindNode(accountId: string, keys: ExecutionNodeKeys, who = a) {
    const enrolled = await enrollNode(accountId, keys, who);
    const pulse = await runNode(keys), original = { accountId, nodeId: enrolled.created.enrollment.nodeId };
    try {
      await waitSavedHeartbeat(keys, pulse, original, who);
      const view = StoreNodeWorkspaceSchema.parse(await service.workspace(await current(who), accountId));
      const bound = StoreNodeWorkspaceSchema.parse(await service.bind(await current(who), accountId, { nodeId: enrolled.created.enrollment.nodeId,
        expectedAuthorizationGeneration: view.authorizationGeneration, expectedBindingRevision: view.binding.revision,
        expectedCertificateGeneration: enrolled.created.enrollment.certificateGeneration }));
      if (bound.binding.state !== "active" || !bound.binding.nodeId) throw new Error("store_node_fixture_real_binding_required");
      // Keep the original CLI alive across binding. A later stop may leave an
      // unknown heartbeat, but its receipt now belongs to this current revision.
      await waitSavedHeartbeat(keys, pulse, { ...original, bindingRevision: bound.binding.revision }, who);
      return { ...enrolled, keys, accountId, nodeId: enrolled.created.enrollment.nodeId };
    } finally { await pulse.close(); }
  }
  async function intent(accountId: string, input: unknown = {}, who = a): Promise<CreateStoreNodeExecutionInput> {
    const workspace = await executions.workspace(await current(who), accountId);
    if (!workspace.binding.nodeId || !workspace.binding.certificateGeneration) throw new Error("store_node_fixture_intent_requires_real_binding");
    const raw = CreateStoreNodeExecutionInputSchema.parse({ nodeId: workspace.binding.nodeId, certificateGeneration: workspace.binding.certificateGeneration,
      authorizationGeneration: workspace.authorizationGeneration, bindingRevision: workspace.binding.revision,
      requestId: createEntityId(), requestChecksum: "0".repeat(64), operation: STORE_NODE_EXECUTION_OPERATION, input });
    return { ...raw, requestChecksum: nodeExecutionSha(storeNodeExecutionRequestText(accountId, raw)) };
  }
  async function submit(accountId: string, input: unknown = {}, who = a) {
    const request = await intent(accountId, input, who), response = await http(`/v1/marketplace-accounts/${accountId}/node-executions`, request, who);
    if (response.status !== 201) throw new Error("store_node_fixture_submit_failed:" + JSON.stringify({ status: response.status, code: safeCode(response.body) }));
    return { request, view: StoreNodeExecutionViewSchema.parse(response.body) };
  }
  async function platformPreload(keys: ExecutionNodeKeys, loss?: "checkpoint" | "complete" | "step") {
    if (loss === "step" && !submissionFamily) throw new Error("publication_submit_step_loss_requires_its_owned_family");
    const filename = owned(`platform-preload-${isolated.nonce}-${keys.id}-${createEntityId()}.mjs`);
    const lossMarker = owned(`rpc-loss-${isolated.nonce}-${keys.id}-${createEntityId()}.json`);
    const source = `import https from 'node:https';import {readFileSync,writeFileSync,existsSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const ca=readFileSync(${JSON.stringify(provider.caPath)}),origin=${JSON.stringify(provider.origin)},realRequest=https.request;
globalThis.fetch=async function(input,init={}){const u=new URL(input instanceof Request?input.url:String(input));if(!['https://api.amazon.com','https://api.etsy.com','https://openapi.etsy.com','https://sellingpartnerapi-na.amazon.com','https://schema.amazonaws.com'].includes(u.origin))throw new Error('synthetic_platform_origin_refused');const headers=new Headers(init.headers);headers.set('x-synthetic-node-transport','1');let data=init.body==null?undefined:String(init.body);return new Promise((done,fail)=>{const r=realRequest(origin+u.pathname+u.search,{method:init.method??'GET',headers:Object.fromEntries(headers),ca,rejectUnauthorized:true,signal:init.signal},response=>{let n=0;const parts=[];response.on('data',part=>{n+=part.length;if(n>25*1024*1024)response.destroy(new Error('synthetic_boundary_limit'));else parts.push(part)});response.once('error',()=>fail(new Error('synthetic_boundary_response_failed')));response.once('end',()=>done(new Response(Buffer.concat(parts),{status:response.statusCode,headers:Object.fromEntries(Object.entries(response.headers).filter(([,v])=>typeof v==='string'))})))});r.once('error',()=>fail(new Error('synthetic_boundary_transport_failed')));r.end(data)})};
${loss ? `let lossSeen=0;https.request=function(...args){let chosen=false;try{const u=new URL(args[0]);chosen=u.origin==='https://127.0.0.1:8142'&&u.pathname==='/v1/store-nodes/runtime/executions/${loss}'&&!u.search&&args[1]?.method==='POST'&&!existsSync(${JSON.stringify(lossMarker)})${loss === "step" ? "&&++lossSeen===2" : ""}}catch{}const callback=args.at(-1);if(chosen&&typeof callback==='function')args[args.length-1]=function(response){const result=Reflect.apply(callback,this,[response]);if(response.statusCode===200&&!existsSync(${JSON.stringify(lossMarker)})){writeFileSync(${JSON.stringify(lossMarker)},JSON.stringify({rpc:'${loss}',status:200,explicitSyntheticLoss:true}),{flag:'wx'});response.destroy(new Error('synthetic_original_rpc_response_loss'))}return result};return Reflect.apply(realRequest,this,args)};syncBuiltinESMExports();` : ""}
`;
    await writeFile(filename, source, { flag: "wx", mode: 0o600 }); return { filename, lossMarker };
  }
  async function workNode(keys: ExecutionNodeKeys, options: { loss?: "checkpoint" | "complete" | "step"; etsy?: "valid" | "missing" | "wrong"; amazon?: "valid" | "missing" | "wrong" } = {}) {
    const preload = await platformPreload(keys, options.loss);
    const nodeEnvironment: Record<string, string> = { ...provider.nodeEnvironment };
    if (options.etsy === "missing") { delete nodeEnvironment.STORE_NODE_ETSY_APP_KEYSTRING; delete nodeEnvironment.STORE_NODE_ETSY_APP_SHARED_SECRET; }
    if (options.etsy === "wrong") nodeEnvironment.STORE_NODE_ETSY_APP_KEYSTRING = "synthetic-unrelated-public-client";
    if (options.amazon === "missing") { delete nodeEnvironment.STORE_NODE_AMAZON_APP_CLIENT_ID; delete nodeEnvironment.STORE_NODE_AMAZON_APP_CLIENT_SECRET; }
    if (options.amazon === "wrong") nodeEnvironment.STORE_NODE_AMAZON_APP_CLIENT_ID = "synthetic-unrelated-amazon-public-client";
    const child = launchNode("work", keys, undefined, provider.secretValues, preload.filename, nodeEnvironment, () => provider.secretValues); children.add(child);
    return { ...child, lossMarker: preload.lossMarker };
  }
  async function waitExecution(accountId: string, id: string, child: Awaited<ReturnType<typeof workNode>>, who = a) {
    const deadline = Date.now() + 60_000;
    let result: z.infer<typeof StoreNodeExecutionViewSchema> | undefined;
    while (Date.now() < deadline) {
      result = StoreNodeExecutionViewSchema.parse(await executions.get(await current(who), accountId, id));
      if (["succeeded", "failed", "unknown_outcome", "authority_changed", "cancelled", "expired"].includes(result.state)) return result;
      if (child.evidence.exited) break;
      await executionBounded(Promise.race([child.done, new Promise<void>(done => setTimeout(done, 100))]), "publication_preview_cap_wait_failed", 2000);
    }
    throw new Error("publication_preview_original_cap_bootstrap_failed:" + JSON.stringify({ state: result?.state ?? null, errorCode: result?.errorCode ?? null,
      childCode: child.evidence.stderrCode, childStates: child.evidence.states.slice(-5), exitCode: child.evidence.exitCode }));
  }
  /** Original authorization, actual CLI capability operation and original capability adoption. */
  async function bootstrapStore(who = a) {
    const store = await createStore(who, "amazon"), node = await bindNode(store.id, await initNode(), who);
    const submitted = await submit(store.id, { amazonProductTypes: ["HOME"] }, who), child = await workNode(node.keys);
    try {
      const completed = await waitExecution(store.id, submitted.view.id, child, who);
      const original = await accountRows(store.id, who);
      if (completed.state !== "succeeded" || original.account?.status !== "active" || original.snapshots.length !== 1 ||
        completed.snapshot?.id !== original.snapshots[0]?.id) throw new Error("publication_preview_requires_real_capability_adoption");
      if (!original.account.capabilities.includes("listing_write") || !original.snapshots[0]!.capabilities.includes("listing_write"))
        throw new Error("publication_preview_original_listing_write_capability_missing");
      return { store, node, capabilityId: completed.snapshot!.id, capabilityExecutionId: submitted.view.id };
    } finally { await child.close(); }
  }
  /** Only the product plan/SPU/authorized asset metadata are synthetic prerequisites.
   * The Listing owner actually creates, validates and approves the immutable version.
   * No artwork, unattended production, marketplace publication or node completion is fabricated. */
  async function seedListing(accountId: string, who = a): Promise<PreviewSource> {
    const id = createEntityId(), planId = createEntityId(), spuId = createEntityId(), assetId = createEntityId(), supplementalAssetId = createEntityId(), variantSkuId = createEntityId();
    const title = "Synthetic node preview original " + id, sku = "SYNTHETIC-PREVIEW-" + id;
    const context = await current(who), original = await accountRows(accountId, who);
    if (!original.account?.externalAccountId) throw new Error("publication_preview_original_store_required");
    await withTenant(database.db, context, async tx => {
      await tx.insert(productPlans).values({ id: planId, tenantId: who.tenantId, name: title, status: "approved", customization: { version: 1, fields: [] }, createdBy: who.userId });
      await tx.insert(spus).values({ id: spuId, tenantId: who.tenantId, productPlanId: planId, code: "PREVIEW-" + id, name: title, status: "listing", customization: { version: 1, fields: [] } });
      await tx.insert(assetFiles).values({ id: assetId, tenantId: who.tenantId, ownerUserId: who.userId,
        objectKey: `tenants/${who.tenantId}/authorized/synthetic-historical-preview-${assetId}.jpg`, assetDomain: "authorized", fileName: "synthetic-historical-preview.jpg",
        mediaType: "image/jpeg", byteSize: 100, checksumSha256: nodeExecutionSha(id), rightsStatus: "approved" });
      await tx.insert(assetFiles).values({ id: supplementalAssetId, tenantId: who.tenantId, ownerUserId: who.userId,
        objectKey: `tenants/${who.tenantId}/authorized/synthetic-historical-aplus-${supplementalAssetId}.jpg`, assetDomain: "authorized", fileName: "synthetic-historical-aplus.jpg",
        mediaType: "image/jpeg", byteSize: 100, checksumSha256: nodeExecutionSha("supplemental:" + id), rightsStatus: "approved" });
    });
    const attributes = { item_name: [{ value: title, marketplace_id: "ATVPDKIKX0DER" }],
      purchasable_offer: [{ currency: "USD", our_price: [{ schedule: [{ value_with_tax: 12.34 }] }] }],
      fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 7 }] };
    const created = await localListings.create(context, { spuId, platform: "amazon", marketplaceId: "ATVPDKIKX0DER", locale: "en-US", content: {
      platform: "amazon", locale: "en-US", title, description: "Synthetic original fixture preview does not publish a Listing", bullets: ["Original authorized source"],
      tags: [], mainImageId: assetId, mediaAssetIds: [assetId], variants: [{ skuId: variantSkuId, skuCode: sku, optionValues: {} }],
      aPlusModules: [{ type: "standard", assetIds: [supplementalAssetId], headline: "Synthetic historical supplemental A+ metadata" }],
      attributes: { brand: "Synthetic Preview" }, compliance: { countryOfOrigin: "CN" }, publication: { platform: "amazon", productType: "HOME", attributes } } });
    await localListings.approveVersion(await current(who), created.listing.id, created.version.id);
    provider.expectPreview({ sellerId: original.account.externalAccountId, sku, marketplaceId: "ATVPDKIKX0DER", locale: "en-US", productType: "HOME", attributes });
    return { listingId: created.listing.id, versionId: created.version.id, variantSkuId, assetId, supplementalAssetId, spuId, planId, accountId, title, sku,
      sellerId: original.account.externalAccountId, attributes };
  }
  function workspacePath(source: PublicationPreviewWorkspaceInput) {
    return "/v1/marketplace-publications/preview/workspace?" + new URLSearchParams({ listingId: source.listingId, listingVersionId: source.listingVersionId,
      ...(source.variantSkuId ? { variantSkuId: source.variantSkuId } : {}) });
  }
  async function previewInput(source: PreviewSource, who = a) {
    const response = await http(workspacePath({ listingId: source.listingId, listingVersionId: source.versionId, variantSkuId: source.variantSkuId }), undefined, who);
    if (response.status !== 200) throw new Error("publication_preview_workspace_failed:" + JSON.stringify({ status: response.status, code: safeCode(response.body) }));
    const workspace = PublicationPreviewWorkspaceSchema.parse(response.body), selected = workspace.sources.find(value => value.accountId === source.accountId);
    if (!selected?.canPrepare || !selected.target) {
      const messages = ["Marketplace account must be active and healthy before publication", "Marketplace account does not grant listing_write",
        "Target marketplace is not authorized for this account", "Marketplace account authorization is incomplete", "Marketplace account is not authorized",
        "Latest capability snapshot does not grant listing_write", "Only the current approved Listing version can be published", "Listing has blocking validation issues",
        "Approved Listing version is missing platform publication settings", "Latest capability snapshot does not cover the publication target",
        "Marketplace capabilities are stale; synchronize them before publication", "Amazon Product Type Definition is missing or stale for this publication",
        "Amazon publication requires variantSkuId", "Amazon publication variant is not part of the approved Listing version", "Publication media must be authorized and approved",
        "Pinned publication media is unavailable", "Listing platform does not match the marketplace account", "Marketplace capabilities must be synchronized before publication"];
      let prepared: object;
      try { const original = await publications.prepareForBatch(await current(who), { accountId: source.accountId, listingId: source.listingId,
        listingVersionId: source.versionId, marketplaceId: "ATVPDKIKX0DER", variantSkuId: source.variantSkuId });
        prepared = { success: true, capabilitySnapshotId: original.capabilitySnapshotId, payloadChecksum: nodeExecutionSha(JSON.stringify(original.payload)),
          assetCount: original.assets.length, assetsChecksum: nodeExecutionSha(JSON.stringify(original.assets)) };
      } catch (error) { prepared = { success: false, errorName: error instanceof Error && ["Error", "ConflictException", "NotFoundException", "UnauthorizedException", "UnprocessableEntityException", "ForbiddenError", "ZodError"].includes(error.constructor.name) ? error.constructor.name : "Other",
        message: error instanceof Error && messages.includes(error.message) ? error.message : "unclassified_original_prepare_failure" }; }
      const node = await service.workspace(await current(who), source.accountId), account = await accountRows(source.accountId, who);
      throw new Error("publication_preview_original_target_unavailable:" + JSON.stringify({ sourceReason: selected?.reason ?? "not_listed", prepared,
        accountStatus: account.account?.status ?? null, accountCapabilities: account.account?.capabilities ?? [], bindingState: node.binding.state, bindingRevision: node.binding.revision,
        nodeId: node.binding.nodeId, configuration: node.configuration.enabled, nodes: node.nodes.map(value => ({ id: value.id, status: value.status, certificateGeneration: value.certificateGeneration })) }));
    }
    return CreatePublicationPreviewInputSchema.parse({ ...selected.target, requestKey: createEntityId(), requestChecksum: nodeExecutionSha(publicationPreviewRequestText(selected.target)) });
  }
  async function previewRows(who = a) {
    return withTenant(database.db, who.ceiling, async tx => ({ requests: await tx.select().from(marketplacePublicationRequests),
      events: await tx.select().from(marketplacePublicationEvents), intents: await tx.select().from(marketplacePublicationIntents),
      executions: await tx.select().from(marketplaceStoreNodeExecutions), steps: await tx.select().from(marketplaceStoreNodeExecutionSteps) }));
  }
  async function waitPreview(id: string, child: Awaited<ReturnType<typeof workNode>>, who = a) {
    const deadline = Date.now() + 60_000; let latest: z.infer<typeof PublicationPreviewRequestViewSchema> | undefined;
    while (Date.now() < deadline) {
      latest = PublicationPreviewRequestViewSchema.parse(await publications.getPreview(await current(who), id));
      if (latest.execution && ["succeeded", "failed", "unknown_outcome", "authority_changed", "cancelled", "expired"].includes(latest.execution.state)) return latest;
      if (child.evidence.exited) break;
      await executionBounded(Promise.race([child.done, new Promise<void>(done => setTimeout(done, 100))]), "publication_preview_wait_failed", 2000);
    }
    throw new Error("publication_preview_cli_not_finished:" + JSON.stringify({ requestId: id, executionState: latest?.execution?.state ?? null,
      errorCode: latest?.execution?.errorCode ?? null, exitCode: child.evidence.exitCode, childCode: child.evidence.stderrCode, childStates: child.evidence.states.slice(-5) }));
  }
  async function enrollBundle(keys: ExecutionNodeKeys, bundle: StoreNodeEnrollmentBundle) {
    if (!stores.has(bundle.accountId) || bundle.publicKeySpkiSha256 !== nodeExecutionSha(createPublicKey(keys.publicKeyPem).export({ type: "spki", format: "der" }))) throw new Error("store_node_fixture_bundle_not_owned");
    const path = resolve(keys.directory, "bundle-" + bundle.certificateGeneration + ".json"); await writeFile(path, JSON.stringify(bundle), { flag: "wx", mode: 0o600 });
    const child = launchNode("enroll", keys, path, [bundle.ticketToken]); children.add(child); await executionBounded(child.done, "store_node_fixture_browser_enroll_deadline", 45_000);
    if (child.evidence.exitCode !== 0 || child.evidence.leaked) throw new Error("store_node_fixture_browser_enroll_failed:" + JSON.stringify({ code: child.evidence.stderrCode, exitCode: child.evidence.exitCode, storageDiagnostic: child.evidence.storageDiagnostic }));
    return { nodeId: bundle.nodeId, enrolled: true as const };
  }
  async function retireStore(accountId: string, who = a) {
    if (stores.get(accountId)?.userId !== who.userId) throw new Error("store_node_fixture_retire_not_owned");
    const workspace = await service.workspace(await current(who), accountId);
    for (const node of workspace.nodes) if (node.status !== "revoked") {
      const latest = await service.workspace(await current(who), accountId);
      await service.revoke(await current(who), accountId, node.id, { expectedAuthorizationGeneration: latest.authorizationGeneration,
        expectedBindingRevision: latest.binding.revision, expectedCertificateGeneration: node.certificateGeneration });
    }
    await authorization.revoke(await current(who), accountId); stores.delete(accountId);
  }
  async function stopChildren() { for (const child of children) await child.close(); }
  async function accountRows(accountId: string, who = a) {
    return withTenant(database.db, who.ceiling, async tx => ({ account: (await tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, accountId)))[0],
      credential: (await tx.select().from(marketplaceCredentials).where(eq(marketplaceCredentials.accountId, accountId)))[0],
      snapshots: await tx.select().from(marketplaceCapabilitySnapshots).where(eq(marketplaceCapabilitySnapshots.accountId, accountId)),
      executions: await tx.execute(sql`select * from marketplace_store_node_executions where account_id=${accountId}::uuid`),
      steps: await tx.execute(sql`select s.* from marketplace_store_node_execution_steps s join marketplace_store_node_executions e on e.id=s.execution_id and e.tenant_id=s.tenant_id where e.account_id=${accountId}::uuid`) }));
  }
  async function enrollNode(accountId: string, keys: ExecutionNodeKeys, who = a) {
    const before = service.workspace(await current(who), accountId), view = await before;
    const raw = { expectedAuthorizationGeneration: view.authorizationGeneration, expectedBindingRevision: view.binding.revision,
      label: "Synthetic node " + keys.id, publicKeyPem: keys.publicKeyPem, idempotencyKey: nodeExecutionSha("node-request:" + keys.id) };
    const response = await http(`/v1/marketplace-accounts/${accountId}/nodes/enrollments`, raw, who);
    if (response.status !== 201) {
      const code = z.object({ code: z.string().regex(/^store_node_[a-z_]{1,100}$/) }).safeParse(response.body);
      throw new Error(`store_node_real_enrollment_create_failed status=${response.status} code=${code.success ? code.data.code : "unavailable"}`);
    }
    const created = StoreNodeEnrollmentCreatedSchema.parse(response.body), bundlePath = resolve(keys.directory, "enrollment.json");
    await writeFile(bundlePath, JSON.stringify(created.enrollment), { flag: "wx", mode: 0o600 });
    const child = launchNode("enroll", keys, bundlePath, [created.enrollment.ticketToken]); children.add(child); await executionBounded(child.done, "store_node_cli_enroll_deadline", 45_000);
    if (child.evidence.exitCode !== 0 || child.evidence.leaked) {
      const node = (await rows(created.enrollment.nodeId, who)).node;
      const [clock] = await database.client.unsafe("select clock_timestamp()::text as database_now");
      throw new Error("store_node_real_cli_enroll_failed:" + JSON.stringify({ code: child.evidence.stderrCode, exitCode: child.evidence.exitCode, storageDiagnostic: child.evidence.storageDiagnostic,
        ticketState: node?.ticketState ?? null, claimed: node?.enrollmentClaimId !== null, nodeStatus: node?.status ?? null,
        certificateIssuedAt: node?.certificateIssuedAt?.toISOString() ?? null, certificateExpiresAt: node?.certificateExpiresAt?.toISOString() ?? null,
        databaseNow: clock?.database_now ?? null, nodeClock: new Date().toISOString() }));
    }
    const row = await rows(created.enrollment.nodeId, who); if (!row.node?.certificatePem) throw new Error("store_node_real_certificate_missing");
    return { created, request: raw, socket: { cert: row.node.certificatePem, key: await readFile(resolve(keys.directory, "private-key.pem")), passphrase: keys.passphrase } };
  }
  async function rows(nodeId: string, who = a) {
    return withTenant(database.db, who.ceiling, async tx => {
      const [node] = await tx.select().from(marketplaceStoreNodes).where(eq(marketplaceStoreNodes.id, nodeId));
      const [binding] = node ? await tx.select().from(marketplaceStoreNodeBindings).where(eq(marketplaceStoreNodeBindings.accountId, node.accountId)) : [];
      return { node, binding };
    });
  }
  async function expire(nodeId: string, kind: "ticket" | "session" | "binding", who = a) {
    await withTenant(database.db, who.ceiling, async tx => {
      const [node] = await tx.select().from(marketplaceStoreNodes).where(and(eq(marketplaceStoreNodes.id, nodeId), eq(marketplaceStoreNodes.createdBy, who.userId)));
      if (!node || !stores.has(node.accountId)) throw new Error("store_node_fixture_expiry_not_owned");
      if (kind === "ticket") await tx.update(marketplaceStoreNodes).set({ ticketExpiresAt: sql`clock_timestamp()-interval '1 second'` }).where(eq(marketplaceStoreNodes.id, nodeId));
      else if (kind === "session") await tx.update(marketplaceStoreNodes).set({ sessionExpiresAt: sql`clock_timestamp()-interval '1 second'` }).where(eq(marketplaceStoreNodes.id, nodeId));
      else await tx.update(marketplaceStoreNodeBindings).set({ leaseExpiresAt: sql`clock_timestamp()-interval '1 second'` }).where(and(eq(marketplaceStoreNodeBindings.accountId, node.accountId), eq(marketplaceStoreNodeBindings.nodeId, nodeId)));
    });
  }
  async function runNode(keys: ExecutionNodeKeys, loseFirstHeartbeat = false) {
    let preload: string | undefined;
    if (loseFirstHeartbeat) {
      preload = owned(`loss-preload-${isolated.nonce}-${keys.id}.mjs`);
      await writeFile(preload, `import https from 'node:https';import {syncBuiltinESMExports} from 'node:module';\nconst original=https.request;let used=false;https.request=function(...args){let selected=false;try{const u=new URL(args[0]);selected=!used&&u.origin==='https://127.0.0.1:8142'&&u.pathname==='/v1/store-nodes/runtime/heartbeat'&&!u.search&&args[1]?.method==='POST'}catch{}const callback=args.at(-1);if(selected&&typeof callback==='function')args[args.length-1]=function(response){const value=Reflect.apply(callback,this,[response]);if(!used&&response.statusCode===200){used=true;response.destroy(new Error('synthetic_store_node_response_loss'))}return value};return Reflect.apply(original,this,args)};syncBuiltinESMExports();\n`, { flag: "wx", mode: 0o600 });
    }
    const child = launchNode("run", keys, undefined, [], preload); children.add(child); return child;
  }
  async function heldHeartbeat(body: StoreNodeHeartbeatInput, socket: SocketIdentity) {
    const bytes = Buffer.from(JSON.stringify(StoreNodeHeartbeatInputSchema.parse(body))), entered = nodeExecutionLatch();
    let release!: () => void;
    const result = new Promise<{ status: number; body: unknown }>((done, reject) => {
      const request = httpsRequest(new URL("/v1/store-nodes/runtime/heartbeat", pkiFiles.env.STORE_NODE_RUNTIME_ORIGIN), {
        method: "POST", ca: pkiFiles.ca, ...socket, rejectUnauthorized: true, agent: false, headers: { "content-type": "application/json", "content-length": bytes.length },
      }, response => { const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => { try { done({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }); }
          catch { reject(new Error("store_node_held_response_invalid")); } }); response.once("error", () => reject(new Error("store_node_held_response_failed"))); });
      request.once("socket", stream => stream.once("secureConnect", () => entered.release()));
      request.once("error", () => reject(new Error("store_node_held_request_failed")));
      request.setTimeout(15_000, () => request.destroy()); request.flushHeaders(); request.write(bytes.subarray(0, 1));
      release = () => request.end(bytes.subarray(1));
    });
    void result.catch(() => {}); await executionBounded(Promise.race([entered.promise, result.then(() => { throw new Error("store_node_hold_settled_early"); })]), "store_node_tls_handshake_deadline");
    return { release, result };
  }
  async function close() {
    if (closed) return; closed = true; const errors: unknown[] = [];
    const failure = (phase: string, error: unknown) => { const safe = executionCleanupDiagnostic(error, phase); evidence.cleanupFailures.push(...safe);
      errors.push(new Error("store_node_fixture_cleanup_stage:" + JSON.stringify(safe))); };
    for (const child of children) try { await child.close(); evidence.childExits.push({ ...child.evidence }); } catch (error) { failure("child", error); }
    for (const agent of agents) agent.destroy();
    for (const who of [a, peer, foreign].filter(Boolean)) try { await rights(who); } catch (error) { failure("restore_rights", error); }
    for (const [id, who] of stores) try { await authorization.revoke(await current(who), id); } catch (error) { failure("revoke_authorization", error); }
    try { if (bootstrap) { bootstrap.closeAllConnections(); await new Promise<void>((done, reject) => bootstrap!.close(error => error ? reject(error) : done())); } evidence.bootstrapClosed = true; } catch (error) { failure("bootstrap", error); }
    try { await app?.close(); evidence.apiClosed = true; } catch (error) { failure("api", error); }
    try { if (appDatabase && appDatabase !== database) await appDatabase.client.end(); } catch (error) { failure("api_database", error); }
    evidence.runtimePlatformCalls = provider?.records.filter(value => value.node).length ?? 0;
    try { await provider?.close(); evidence.providerClosed = true; } catch (error) { failure("provider", error); }
    try { await identity?.close(); evidence.identityClosed = true; } catch (error) { failure("identity", error); }
    restoreProvider?.(); restoreEnvironment?.();
    if (errors.length) throw new AggregateError(errors, "Store node fixture cleanup failed");
  }
  return { initialize, close, current, rights, createStore, registerStore, token, http, tls, heldHeartbeat, initNode, enrollNode, runNode, rows, expire, accounts, authorization, evidence,
    bindNode, waitSavedHeartbeat, intent, submit, workNode, stopChildren, accountRows, enrollBundle, retireStore,
    bootstrapStore, seedListing, workspacePath, previewInput, previewRows, waitPreview, waitExecution, listings: localListings,
    get publications() { return publications; },
    get executions() { return executions; }, get capabilities() { return capabilities; }, get vault() { return vault; },
    get a() { return a; }, get peer() { return peer; }, get foreign() { return foreign; }, get service() { return service; }, get pki() { return pki; },
    get provider() { return provider; }, get ca() { return pkiFiles.ca; }, get foreignCa() { return pkiFiles.foreignCa; }, get origin() { return origin; },
    issuerGate() {
      const entered = nodeExecutionLatch(), released = nodeExecutionLatch();
      const issuer: StoreNodeCertificateIssuer = { configuration: () => pki.configuration(), caCertificatePem: () => pki.caCertificatePem(), issue: async input => {
        const certificate = await pki.issue(input); entered.release(); await released.promise; return certificate; } };
      return { entered: entered.promise, release: released.release, service: new StoreNodeService(database, audit, issuer) };
    },
    keepAlive(socket: SocketIdentity) { const agent = new Agent({ keepAlive: true, ca: pkiFiles.ca, ...socket, rejectUnauthorized: true }); agents.add(agent); return { ...socket, agent }; },
  };
}

function launchNode(command: "init" | "enroll" | "run" | "work", keys: { directory: string; passphrase: string }, bundle?: string, secrets: string[] = [], preload?: string, extraEnvironment: Record<string, string> = {}, dynamicSecrets?: () => readonly string[]) {
  const rel = relative(lane, keys.directory); if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("store_node_child_directory_invalid");
  const env = { ...executionSystemEnvironment(), TSX_DISABLE_CACHE: "1", STORE_NODE_KEY_PASSPHRASE: keys.passphrase, ...extraEnvironment };
  const args = ["--import", pathToFileURL(resolve(root, "apps/store-api-node/node_modules/tsx/dist/loader.mjs")).href, ...(preload ? ["--import", pathToFileURL(preload).href] : []),
    resolve(root, "apps/store-api-node/src/main.ts"), command, "--dir=" + keys.directory,
    ...(bundle ? ["--bundle=" + bundle] : []), ...((command === "run" || command === "work") ? ["--interval-ms=1000"] : [])];
  const child = spawn(process.execPath, args, { cwd: resolve(root, "apps/store-api-node"), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
  const evidence = { command, pid: child.pid ?? null, exitCode: null as number | null, signal: null as NodeJS.Signals | null, exited: false, forced: false,
    stdoutBytes: 0, stderrBytes: 0, stderrCode: null as string | null, leaked: false, environmentKeys: Object.keys(env).sort(), explicitResponseLossPreload: Boolean(preload),
    storageDiagnostic: null as z.infer<typeof StorageDiagnosticSchema> | null, storageDiagnosticCount: 0,
    states: [] as Array<{ state: string; execution?: string; sequence?: number; code?: string }> };
  let tail = "", lineBuffer = "", stderrLine = "", discardStderrLine = false; const needles = [keys.passphrase, ...secrets];
  const observe = (chunk: Buffer, stream: "stdoutBytes" | "stderrBytes") => { evidence[stream] += chunk.length; const text = tail + chunk.toString("utf8");
    evidence.leaked ||= [...needles, ...(dynamicSecrets?.() ?? [])].some(value => value && text.includes(value)) || text.includes("-----BEGIN PRIVATE KEY-----") || text.includes("-----BEGIN ENCRYPTED PRIVATE KEY-----");
    tail = text.slice(-Math.max(512, ...needles.map(value => value.length)));
    if (stream === "stderrBytes") { stderrLine += chunk.toString("utf8"); let end: number;
      while ((end = stderrLine.indexOf("\n")) !== -1) { const line = stderrLine.slice(0, end).replace(/\r$/, ""); stderrLine = stderrLine.slice(end + 1);
        if (discardStderrLine) { discardStderrLine = false; continue; }
        if (line.length > 2048) continue;
        if (/^store_node_[a-z_]{1,100}$/.test(line)) evidence.stderrCode = line;
        else if (line.startsWith("{")) try { const diagnostic = StorageDiagnosticSchema.safeParse(JSON.parse(line));
          if (diagnostic.success) { evidence.storageDiagnosticCount++; evidence.storageDiagnostic ??= diagnostic.data; }
        } catch { /* Invalid diagnostic lines are never retained. */ }
      } if (stderrLine.length > 2048) { stderrLine = ""; discardStderrLine = true; }
    }
    if (stream === "stdoutBytes") { lineBuffer += chunk.toString("utf8"); let end: number;
      while ((end = lineBuffer.indexOf("\n")) !== -1) { const line = lineBuffer.slice(0, end); lineBuffer = lineBuffer.slice(end + 1);
        try { const parsed = z.object({ state: z.enum(["initialized", "enrolled", "online", "offline", "stopped", "working", "waiting", "execution_finished", "execution_blocked"]), execution: z.string().regex(/^[a-z_.]{1,80}$/).optional(),
          sequence: z.int().positive().optional(), publicKeySpkiSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), code: z.string().regex(/^store_node_[a-z_]+$/).optional() }).strict().safeParse(JSON.parse(line));
          if (parsed.success) { evidence.states.push({ state: parsed.data.state, ...(parsed.data.execution === undefined ? {} : { execution: parsed.data.execution }), ...(parsed.data.sequence === undefined ? {} : { sequence: parsed.data.sequence }),
            ...(parsed.data.code === undefined ? {} : { code: parsed.data.code }) });
            if (evidence.states.length > 30) evidence.states.shift(); } } catch { /* Raw stdout is never retained. */ }
      } if (lineBuffer.length > 32768) lineBuffer = "";
    }
  };
  child.stdout.on("data", (chunk: Buffer) => observe(chunk, "stdoutBytes")); child.stderr.on("data", (chunk: Buffer) => observe(chunk, "stderrBytes"));
  const done = new Promise<void>((accept, reject) => { child.once("error", () => reject(new Error("store_node_real_cli_spawn_failed")));
    child.once("exit", (code, signal) => { Object.assign(evidence, { exitCode: code, signal, exited: true }); tail = ""; accept(); }); });
  void done.catch(() => {});
  return { child, done, evidence, async close() {
    if (!evidence.exited) child.kill("SIGTERM");
    try { await executionBounded(done, "store_node_real_cli_exit_timeout", 10_000); }
    catch { evidence.forced = true; child.kill("SIGKILL"); await executionBounded(done, "store_node_real_cli_kill_timeout", 5_000); }
    if (evidence.leaked || !evidence.exited) throw new Error("store_node_real_cli_cleanup_failed:" + JSON.stringify({ code: evidence.stderrCode, exitCode: evidence.exitCode, storageDiagnostic: evidence.storageDiagnostic }));
  } };
}

export function storeNodeExecutionSignedEnrollment(bundle: StoreNodeEnrollmentBundle, privateKey: Buffer, passphrase: string) {
  const publicKey = createPublicKey(createPrivateKey({ key: privateKey, passphrase })), publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const text = storeNodeEnrollmentProofText(bundle.nodeId, nodeExecutionSha(bundle.ticketToken), nodeExecutionSha(publicKey.export({ type: "spki", format: "der" })));
  return { protocol: STORE_NODE_PROTOCOL, nodeId: bundle.nodeId, ticketToken: bundle.ticketToken, publicKeyPem,
    signature: sign("RSA-SHA256", Buffer.from(text), createPrivateKey({ key: privateKey, passphrase })).toString("base64url") };
}

