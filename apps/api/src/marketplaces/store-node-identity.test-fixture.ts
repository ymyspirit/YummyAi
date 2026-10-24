import "reflect-metadata";
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createServer as createHttpsServer, request as httpsRequest, Agent, type Server as HttpsServer } from "node:https";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { Permission } from "@yummyai/authz";
import { createEntityId, CreateMarketplaceAccountInputSchema, SyncMarketplaceCapabilitiesInputSchema, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { StoreNodeEnrollmentCreatedSchema, StoreNodeHeartbeatInputSchema,
  STORE_NODE_PROTOCOL, storeNodeEnrollmentProofText, type StoreNodeEnrollmentBundle, type StoreNodeHeartbeatInput } from "@yummyai/contracts/marketplace/store-node";
import { memberships, membershipRoles, roles, marketplaceStoreNodes, marketplaceStoreNodeBindings, loadCurrentMembershipContext,
  withTenant, type DatabaseConnection } from "@yummyai/database";
import { createMarketplaceSecretVault, HttpMarketplaceAuthorizationGateway, HttpMarketplaceCapabilityGateway } from "@yummyai/marketplace-connectors";
import { requireStoreNodeIdentityEnvironment } from "../../../../tools/testing/require-store-node-identity-environment.mjs";
import { authorityBounded, startMarketplaceAuthorityProvider, installMarketplaceAuthoritySyntheticEnvironment } from "../../../../tools/testing/marketplace-authority-legacy-upgrade.mjs";
import { startFactoryIdentityFixture } from "../../../../tools/testing/factory-identity-fixture.mjs";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { MarketplaceAccountService } from "./marketplace-account.service.js";
import { MarketplaceAuthorizationService } from "./marketplace-authorization.service.js";
import { MarketplaceCapabilityService } from "./marketplace-capability.service.js";
import { StoreNodeService } from "./store-node.service.js";
import { StoreNodePki } from "./store-node-pki.js";
import type { StoreNodeCertificateIssuer } from "./store-node.types.js";
import { assertStoreNodeOriginal178Graph } from "./store-node-identity-graph.test-fixture.js";
export { assertStoreNodeOriginal178Graph } from "./store-node-identity-graph.test-fixture.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const lane = resolve(root, "tmp/store-node-identity-20261022-c7e3a6d2/qa");
const legacyRoot = resolve(root, "tmp/store-node-identity-20261022-c7e3a6d2/old178-source");
export const nodeIdentityPermissions = [Permission.StoreRead, Permission.StoreManage, Permission.StoreAuthorize];
export const nodeIdentitySha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export type NodeActor = { userId: string; tenantId: string; membershipId: string; roleId: string; subject: string; ceiling: TenantContext };
export type NodeKeys = { id: string; directory: string; publicKeyPem: string; passphrase: string };
type SocketIdentity = { cert?: string; key?: Buffer; passphrase?: string; ca?: string; agent?: Agent };

function owned(name: string) {
  const path = resolve(lane, name), rel = relative(lane, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("store_node_fixture_path_invalid"); return path;
}
function systemEnvironment() {
  return Object.fromEntries(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
}
export function nodeIdentityLatch() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
async function openssl(args: string[]) {
  return new Promise<string>((done, reject) => execFile("D:/Git/usr/bin/openssl.exe", args, { windowsHide: true, timeout: 30_000, maxBuffer: 131072, env: systemEnvironment() },
    (error, stdout) => error ? reject(new Error("store_node_fixture_openssl_failed")) : done(stdout)));
}
/** Called only inside the root-owned functional runner, never during module import. */
async function createPki(nonce: string) {
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

export function storeNodeIdentityFixture(database: DatabaseConnection) {
  const isolated = requireStoreNodeIdentityEnvironment();
  const audit = new AuditService(database), accounts = new MarketplaceAccountService(database, audit), vault = createMarketplaceSecretVault();
  const authorization = new MarketplaceAuthorizationService(database, vault, new HttpMarketplaceAuthorizationGateway(), audit);
  let a: NodeActor, peer: NodeActor, foreign: NodeActor, pkiFiles: Awaited<ReturnType<typeof createPki>>, pki: StoreNodePki, service: StoreNodeService;
  let provider: Awaited<ReturnType<typeof startMarketplaceAuthorityProvider>>, identity: Awaited<ReturnType<typeof startFactoryIdentityFixture>>;
  let capabilities: MarketplaceCapabilityService;
  let app: INestApplication | undefined, appDatabase: DatabaseConnection | undefined, bootstrap: HttpsServer | undefined, origin = "", closed = false;
  let restoreProvider: (() => void) | undefined, restoreSynthetic: (() => void) | undefined, restoreEnvironment: (() => void) | undefined;
  const stores = new Map<string, NodeActor>(), children = new Set<ReturnType<typeof launchNode>>(), agents = new Set<Agent>();
  const evidence = { openssl: "3.5.4", pkiDirectory: "", bootstrapClosed: false, apiClosed: false, identityClosed: false,
    providerClosed: false, childExits: [] as object[], bootstrapPosts: 0, runtimePlatformCalls: 0, execution: "not_integrated" };

  async function actor(tenantId = createEntityId()) {
    const userId = createEntityId(), membershipId = createEntityId(), roleId = createEntityId(), subject = "store-node-identity-" + userId;
    const ceiling: TenantContext = { tenantId, userId, permissions: [...nodeIdentityPermissions], dataScope: "tenant" };
    await database.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic node tenant',$2)on conflict(id)do nothing", [tenantId, "node-" + tenantId]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic store node operator')", [userId, subject, userId + "@example.invalid"]);
    await withTenant(database.db, ceiling, async tx => { await tx.insert(memberships).values({ id: membershipId, tenantId, userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId, name: "Synthetic node role " + roleId, permissions: [...nodeIdentityPermissions], dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId, membershipId, roleId }); });
    return { tenantId, userId, membershipId, roleId, subject, ceiling };
  }
  const current = async (who = a) => withTenant(database.db, who.ceiling, async tx => TenantContextSchema.parse(await loadCurrentMembershipContext(tx, { tenantId: who.tenantId, userId: who.userId })));
  const rights = async (who: NodeActor, permissions: readonly string[] = nodeIdentityPermissions, dataScope: "self" | "tenant" = "tenant") =>
    withTenant(database.db, who.ceiling, tx => tx.update(roles).set({ permissions: [...permissions], dataScope }).where(eq(roles.id, who.roleId)));
  async function createStore(who = a) {
    const context = await current(who), account = await accounts.create(context, CreateMarketplaceAccountInputSchema.parse({ platform: "etsy", authorizationMode: "etsy_oauth",
      region: "GLOBAL", marketplaceIds: ["etsy"], requestedScopes: ["listings_r", "shops_r"], displayName: "Synthetic-node-store-" + createEntityId() }));
    stores.set(account.id, who); const started = await authorization.startOAuth(await current(who), account.id);
    await authorization.completeOAuth(await current(who), account.id, provider.code(started.authorizationUrl));
    await capabilities.sync(await current(who), account.id, SyncMarketplaceCapabilitiesInputSchema.parse({}));
    const active = await accounts.get(await current(who), account.id);
    if (active.status !== "active") throw new Error("store_node_fixture_store_not_active_after_real_capability_sync");
    return active;
  }
  async function token(who = a) {
    const name = who === a ? "operator" : who === peer ? "peer" : "foreign";
    const response = await fetch(identity.baseUrl + "/_fixture/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-fixture-control": identity.controlKey },
      body: new URLSearchParams({ account: name }), redirect: "error" });
    if (response.status !== 200) throw new Error("store_node_fixture_token_failed");
    return z.object({ access_token: z.string().min(1) }).strict().parse(await response.json()).access_token;
  }
  async function http(path: string, input?: unknown, who = a) {
    if (!/^\/v1\/(?:marketplace-accounts\/|identity\/session)/.test(path) || path.includes("?") || path.includes("#")) throw new Error("store_node_fixture_http_path_invalid");
    const response = await fetch(origin + path, { method: input === undefined ? "GET" : "POST", redirect: "error", headers: { authorization: "Bearer " + await token(who),
      ...(input === undefined ? {} : { "content-type": "application/json" }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: await response.json() as unknown };
  }
  async function tls(path: "/v1/store-nodes/enroll" | "/v1/store-nodes/runtime/heartbeat", body: unknown, socket: SocketIdentity = {}, headers: Record<string, string> = {}) {
    const url = new URL(path, path.endsWith("enroll") ? pkiFiles.env.STORE_NODE_ENROLLMENT_ORIGIN : pkiFiles.env.STORE_NODE_RUNTIME_ORIGIN);
    return new Promise<{ status: number; body: unknown }>((done, reject) => {
      const request = httpsRequest(url, { method: "POST", ca: socket.ca ?? pkiFiles.ca, cert: socket.cert, key: socket.key, passphrase: socket.passphrase,
        agent: socket.agent ?? false, rejectUnauthorized: true, timeout: 15_000, headers: { "content-type": "application/json", ...headers } }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 65536) response.destroy(new Error("store_node_fixture_response_oversized")); else chunks.push(chunk); });
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
      if (count?.value !== 179) throw new Error("store_node_fixture_requires_current179");
      await mkdir(lane, { recursive: true }); pkiFiles = await createPki(isolated.nonce); evidence.pkiDirectory = pkiFiles.directory;
      a = await actor(); peer = await actor(a.tenantId); foreign = await actor();
      identity = await startFactoryIdentityFixture(a.tenantId, a.subject, "http://localhost:3130", { application: "erp", clientId: "yummyai-web", accounts: {
        operator: { subject: a.subject, name: "Synthetic node operator" }, peer: { subject: peer.subject, name: "Synthetic node peer" },
        foreign: { subject: foreign.subject, name: "Synthetic unrelated node operator", tenantId: foreign.tenantId } } });
      const values = { ...pkiFiles.env, OIDC_ISSUER: identity.baseUrl, OIDC_AUDIENCE: "yummyai-api", OIDC_JWKS_URI: identity.baseUrl + "/protocol/openid-connect/certs" };
      const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
      restoreEnvironment = () => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; };
      provider = await startMarketplaceAuthorityProvider(); restoreProvider = provider.installAuthorizationTransport(); restoreSynthetic = installMarketplaceAuthoritySyntheticEnvironment();
      capabilities = new MarketplaceCapabilityService(database, vault, new HttpMarketplaceCapabilityGateway(provider.request), authorization, audit);
      pki = await StoreNodePki.fromEnvironment(process.env); service = new StoreNodeService(database, audit, pki);
      const { AppModule } = await import("../app.module.js"); app = await NestFactory.create(AppModule, { logger: false });
      appDatabase = app.get<DatabaseConnection>(DATABASE_CONNECTION); await app.listen(0, "127.0.0.1"); origin = await app.getUrl();
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
    const process = launchNode("init", { directory, passphrase }); children.add(process); await authorityBounded(process.done, "store_node_cli_init_deadline", 30_000);
    if (process.evidence.exitCode !== 0 || process.evidence.leaked) throw new Error("store_node_real_cli_init_failed");
    const publicKeyPem = (await readFile(resolve(directory, "public-key.pem"), "utf8")).replaceAll("\r\n", "\n");
    return { id, directory, publicKeyPem, passphrase };
  }
  async function enrollNode(accountId: string, keys: NodeKeys, who = a) {
    const before = service.workspace(await current(who), accountId), view = await before;
    const raw = { expectedAuthorizationGeneration: view.authorizationGeneration, expectedBindingRevision: view.binding.revision,
      label: "Synthetic node " + keys.id, publicKeyPem: keys.publicKeyPem, idempotencyKey: nodeIdentitySha("node-request:" + keys.id) };
    const response = await http(`/v1/marketplace-accounts/${accountId}/nodes/enrollments`, raw, who);
    if (response.status !== 201) {
      const code = z.object({ code: z.string().regex(/^store_node_[a-z_]{1,100}$/) }).safeParse(response.body);
      throw new Error(`store_node_real_enrollment_create_failed status=${response.status} code=${code.success ? code.data.code : "unavailable"}`);
    }
    const created = StoreNodeEnrollmentCreatedSchema.parse(response.body), bundlePath = resolve(keys.directory, "enrollment.json");
    await writeFile(bundlePath, JSON.stringify(created.enrollment), { flag: "wx", mode: 0o600 });
    const child = launchNode("enroll", keys, bundlePath, [created.enrollment.ticketToken]); children.add(child); await authorityBounded(child.done, "store_node_cli_enroll_deadline", 45_000);
    if (child.evidence.exitCode !== 0 || child.evidence.leaked) {
      const node = (await rows(created.enrollment.nodeId, who)).node;
      const [clock] = await database.client.unsafe("select clock_timestamp()::text as database_now");
      throw new Error("store_node_real_cli_enroll_failed:" + JSON.stringify({ code: child.evidence.stderrCode, exitCode: child.evidence.exitCode,
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
  async function runNode(keys: NodeKeys, loseFirstHeartbeat = false) {
    let preload: string | undefined;
    if (loseFirstHeartbeat) {
      preload = owned(`loss-preload-${isolated.nonce}-${keys.id}.mjs`);
      await writeFile(preload, `import https from 'node:https';import {syncBuiltinESMExports} from 'node:module';\nconst original=https.request;let used=false;https.request=function(...args){let selected=false;try{const u=new URL(args[0]);selected=!used&&u.origin==='https://127.0.0.1:8142'&&u.pathname==='/v1/store-nodes/runtime/heartbeat'&&!u.search&&args[1]?.method==='POST'}catch{}const callback=args.at(-1);if(selected&&typeof callback==='function')args[args.length-1]=function(response){const value=Reflect.apply(callback,this,[response]);if(!used&&response.statusCode===200){used=true;response.destroy(new Error('synthetic_store_node_response_loss'))}return value};return Reflect.apply(original,this,args)};syncBuiltinESMExports();\n`, { flag: "wx", mode: 0o600 });
    }
    const child = launchNode("run", keys, undefined, [], preload); children.add(child); return child;
  }
  async function heldHeartbeat(body: StoreNodeHeartbeatInput, socket: SocketIdentity) {
    const bytes = Buffer.from(JSON.stringify(StoreNodeHeartbeatInputSchema.parse(body))), entered = nodeIdentityLatch();
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
    void result.catch(() => {}); await authorityBounded(Promise.race([entered.promise, result.then(() => { throw new Error("store_node_hold_settled_early"); })]), "store_node_tls_handshake_deadline");
    return { release, result };
  }
  async function close() {
    if (closed) return; closed = true; const errors: unknown[] = [];
    for (const child of children) try { await child.close(); evidence.childExits.push({ ...child.evidence }); } catch (error) { errors.push(error); }
    for (const agent of agents) agent.destroy();
    for (const who of [a, peer, foreign].filter(Boolean)) try { await rights(who); } catch (error) { errors.push(error); }
    for (const [id, who] of stores) try { await authorization.revoke(await current(who), id); } catch (error) { errors.push(error); }
    try { if (bootstrap) { bootstrap.closeAllConnections(); await new Promise<void>((done, reject) => bootstrap!.close(error => error ? reject(error) : done())); } evidence.bootstrapClosed = true; } catch (error) { errors.push(error); }
    try { await app?.close(); evidence.apiClosed = true; } catch (error) { errors.push(error); }
    try { if (appDatabase && appDatabase !== database) await appDatabase.client.end(); } catch (error) { errors.push(error); }
    try { await provider?.close(); evidence.providerClosed = true; } catch (error) { errors.push(error); }
    try { await identity?.close(); evidence.identityClosed = true; } catch (error) { errors.push(error); }
    restoreProvider?.(); restoreSynthetic?.(); restoreEnvironment?.();
    if (errors.length) throw new AggregateError(errors, "Store node fixture cleanup failed");
  }
  return { initialize, close, current, rights, createStore, token, http, tls, heldHeartbeat, initNode, enrollNode, runNode, rows, expire, accounts, authorization, evidence,
    get a() { return a; }, get peer() { return peer; }, get foreign() { return foreign; }, get service() { return service; }, get pki() { return pki; },
    get provider() { return provider; }, get ca() { return pkiFiles.ca; }, get foreignCa() { return pkiFiles.foreignCa; }, get origin() { return origin; },
    issuerGate() {
      const entered = nodeIdentityLatch(), released = nodeIdentityLatch();
      const issuer: StoreNodeCertificateIssuer = { configuration: () => pki.configuration(), caCertificatePem: () => pki.caCertificatePem(), issue: async input => {
        const certificate = await pki.issue(input); entered.release(); await released.promise; return certificate; } };
      return { entered: entered.promise, release: released.release, service: new StoreNodeService(database, audit, issuer) };
    },
    keepAlive(socket: SocketIdentity) { const agent = new Agent({ keepAlive: true, ca: pkiFiles.ca, ...socket, rejectUnauthorized: true }); agents.add(agent); return { ...socket, agent }; },
  };
}

function launchNode(command: "init" | "enroll" | "run", keys: { directory: string; passphrase: string }, bundle?: string, secrets: string[] = [], preload?: string) {
  const rel = relative(lane, keys.directory); if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("store_node_child_directory_invalid");
  const env = { ...systemEnvironment(), TSX_DISABLE_CACHE: "1", STORE_NODE_KEY_PASSPHRASE: keys.passphrase };
  const args = ["--import", pathToFileURL(resolve(root, "apps/store-api-node/node_modules/tsx/dist/loader.mjs")).href, ...(preload ? ["--import", pathToFileURL(preload).href] : []),
    resolve(root, "apps/store-api-node/src/main.ts"), command, "--dir=" + keys.directory,
    ...(bundle ? ["--bundle=" + bundle] : []), ...(command === "run" ? ["--interval-ms=1000"] : [])];
  const child = spawn(process.execPath, args, { cwd: resolve(root, "apps/store-api-node"), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
  const evidence = { command, pid: child.pid ?? null, exitCode: null as number | null, signal: null as NodeJS.Signals | null, exited: false, forced: false,
    stdoutBytes: 0, stderrBytes: 0, stderrCode: null as string | null, leaked: false, environmentKeys: Object.keys(env).sort(), explicitResponseLossPreload: Boolean(preload),
    states: [] as Array<{ state: string; execution: "not_integrated"; sequence?: number; code?: string }> };
  let tail = "", lineBuffer = "", stderrLine = ""; const needles = [keys.passphrase, ...secrets];
  const observe = (chunk: Buffer, stream: "stdoutBytes" | "stderrBytes") => { evidence[stream] += chunk.length; const text = tail + chunk.toString("utf8");
    evidence.leaked ||= needles.some(value => value && text.includes(value)) || text.includes("-----BEGIN PRIVATE KEY-----") || text.includes("-----BEGIN ENCRYPTED PRIVATE KEY-----");
    tail = text.slice(-Math.max(512, ...needles.map(value => value.length)));
    if (stream === "stderrBytes") { stderrLine += chunk.toString("utf8"); let end: number;
      while ((end = stderrLine.indexOf("\n")) !== -1) { const line = stderrLine.slice(0, end).replace(/\r$/, ""); stderrLine = stderrLine.slice(end + 1);
        if (/^store_node_[a-z_]{1,100}$/.test(line)) evidence.stderrCode = line;
      } if (stderrLine.length > 256) stderrLine = "";
    }
    if (stream === "stdoutBytes") { lineBuffer += chunk.toString("utf8"); let end: number;
      while ((end = lineBuffer.indexOf("\n")) !== -1) { const line = lineBuffer.slice(0, end); lineBuffer = lineBuffer.slice(end + 1);
        try { const parsed = z.object({ state: z.enum(["initialized", "enrolled", "online", "offline", "stopped"]), execution: z.literal("not_integrated"),
          sequence: z.int().positive().optional(), publicKeySpkiSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), code: z.string().regex(/^store_node_[a-z_]+$/).optional() }).strict().safeParse(JSON.parse(line));
          if (parsed.success) { evidence.states.push({ state: parsed.data.state, execution: parsed.data.execution, ...(parsed.data.sequence === undefined ? {} : { sequence: parsed.data.sequence }),
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
    try { await authorityBounded(done, "store_node_real_cli_exit_timeout", 10_000); }
    catch { evidence.forced = true; child.kill("SIGKILL"); await authorityBounded(done, "store_node_real_cli_kill_timeout", 5_000); }
    if (evidence.leaked || !evidence.exited) throw new Error("store_node_real_cli_cleanup_failed");
  } };
}

export function storeNodeSignedEnrollment(bundle: StoreNodeEnrollmentBundle, privateKey: Buffer, passphrase: string) {
  const publicKey = createPublicKey(createPrivateKey({ key: privateKey, passphrase })), publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const text = storeNodeEnrollmentProofText(bundle.nodeId, nodeIdentitySha(bundle.ticketToken), nodeIdentitySha(publicKey.export({ type: "spki", format: "der" })));
  return { protocol: STORE_NODE_PROTOCOL, nodeId: bundle.nodeId, ticketToken: bundle.ticketToken, publicKeyPem,
    signature: sign("RSA-SHA256", Buffer.from(text), createPrivateKey({ key: privateKey, passphrase })).toString("base64url") };
}

export async function migrateStoreNodeIdentityLegacyDatabase(database: DatabaseConnection, name: string, env: NodeJS.ProcessEnv) {
  const target = requireStoreNodeIdentityEnvironment(env, "pre-0179"); if (name !== target.name) throw new Error("store_node_original178_database_mismatch");
  await assertStoreNodeOriginal178Graph(env.E2E_STORE_NODE_LEGACY_SOURCE!);
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== name || actual.ledger !== null || actual.populated !== false) throw new Error("store_node_original178_database_not_empty");
  const original = createRequire(pathToFileURL(resolve(legacyRoot, "packages/database/package.json")));
  const { readMigrationFiles } = original("drizzle-orm/migrator") as { readMigrationFiles(input: { migrationsFolder: string }): Array<{ sql: string[]; hash: string; folderMillis: number }> };
  const migrations = readMigrationFiles({ migrationsFolder: resolve(legacyRoot, "packages/database/migrations") }); if (migrations.length !== 178) throw new Error("store_node_original178_migrations_changed");
  await database.client.begin(async tx => { await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle"); await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) { for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at)values($1,$2)", [migration.hash, migration.folderMillis]); } });
}
