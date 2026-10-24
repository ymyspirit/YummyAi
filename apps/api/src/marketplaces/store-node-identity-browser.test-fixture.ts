import "reflect-metadata";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NestFactory } from "@nestjs/core";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { createEntityId, CreateMarketplaceAccountInputSchema, SyncMarketplaceCapabilitiesInputSchema, TenantContextSchema } from "@yummyai/contracts";
import { StoreNodeEnrollmentBundleSchema } from "@yummyai/contracts/marketplace/store-node";
import { connectDatabase, withTenant, roles, marketplaceStoreNodes, marketplaceStoreNodeBindings, loadCurrentMembershipContext, type DatabaseConnection } from "@yummyai/database";
import { HttpMarketplaceAuthorizationGateway, HttpMarketplaceCapabilityGateway, createMarketplaceSecretVault } from "@yummyai/marketplace-connectors";
import { requireStoreNodeIdentityEnvironment } from "../../../../tools/testing/require-store-node-identity-environment.mjs";
import { authorityBounded, startMarketplaceAuthorityProvider, installMarketplaceAuthoritySyntheticEnvironment } from "../../../../tools/testing/marketplace-authority-legacy-upgrade.mjs";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { MarketplaceAccountService } from "./marketplace-account.service.js";
import { MarketplaceAuthorizationService } from "./marketplace-authorization.service.js";
import { MarketplaceCapabilityService } from "./marketplace-capability.service.js";
import { StoreNodeService } from "./store-node.service.js";
import { StoreNodePki } from "./store-node-pki.js";
import { nodeIdentityPermissions } from "./store-node-identity.test-fixture.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url)), lane = resolve(root, "tmp/store-node-identity-20261022-c7e3a6d2/qa");
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const systemEnvironment = () => Object.fromEntries(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
const Id = z.uuidv7(), Actor = z.object({ userId: Id, tenantId: Id, roleId: Id, membershipId: Id }).passthrough();
const Input = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("seed") }).strict(),
  z.object({ operation: z.literal("init"), groupId: Id }).strict(),
  z.object({ operation: z.literal("enroll"), groupId: Id, keyId: Id, bundle: StoreNodeEnrollmentBundleSchema }).strict(),
  z.object({ operation: z.literal("run"), groupId: Id, keyId: Id }).strict(),
  z.object({ operation: z.literal("stop"), groupId: Id, keyId: Id }).strict(),
  z.object({ operation: z.literal("snapshot"), groupId: Id }).strict(),
  z.object({ operation: z.literal("expire"), groupId: Id, nodeId: Id }).strict(),
  z.object({ operation: z.literal("rights"), groupId: Id, enabled: z.boolean() }).strict(),
  z.object({ operation: z.literal("close"), groupId: Id }).strict(),
]);
async function pkiFiles(nonce: string) {
  const directory = resolve(lane, "browser-pki-" + nonce); await mkdir(directory, { recursive: false });
  const path = (name: string) => resolve(directory, name);
  const openssl = (args: string[]) => new Promise<string>((done, reject) => execFile("D:/Git/usr/bin/openssl.exe", args, { windowsHide: true, timeout: 30_000, maxBuffer: 131072, env: systemEnvironment() },
    (error, stdout) => error ? reject(new Error("store_node_browser_openssl_failed")) : done(stdout)));
  if (!/^OpenSSL 3\.5\.4\b/.test(await openssl(["version"]))) throw new Error("store_node_browser_openssl_version_changed");
  await openssl(["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-keyout", path("ca-key.pem"), "-out", path("ca.pem"), "-days", "2", "-sha256",
    "-subj", "/CN=Synthetic-browser-store-node-CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  await openssl(["req", "-new", "-newkey", "rsa:3072", "-nodes", "-keyout", path("server-key.pem"), "-out", path("server.csr"), "-subj", "/CN=localhost"]);
  await writeFile(path("server.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n", { flag: "wx" });
  await openssl(["x509", "-req", "-in", path("server.csr"), "-CA", path("ca.pem"), "-CAkey", path("ca-key.pem"), "-set_serial", "0x" + randomBytes(16).toString("hex"), "-days", "1", "-sha256", "-extfile", path("server.ext"), "-out", path("server.pem")]);
  const temp = path("temporary"); await mkdir(temp);
  Object.assign(process.env, { STORE_NODE_RUNTIME_ENABLED: "1", STORE_NODE_OPENSSL_PATH: "D:/Git/usr/bin/openssl.exe", STORE_NODE_CA_CERT_PATH: path("ca.pem"),
    STORE_NODE_CA_KEY_PATH: path("ca-key.pem"), STORE_NODE_SERVER_CERT_PATH: path("server.pem"), STORE_NODE_SERVER_KEY_PATH: path("server-key.pem"),
    STORE_NODE_ENROLLMENT_ORIGIN: "https://127.0.0.1:8141", STORE_NODE_RUNTIME_ORIGIN: "https://127.0.0.1:8142", STORE_NODE_RUNTIME_HOST: "127.0.0.1", STORE_NODE_RUNTIME_PORT: "8142", TEMP: temp, TMP: temp });
  return { directory, key: await readFile(path("server-key.pem")), cert: await readFile(path("server.pem")), ca: await readFile(path("ca.pem"), "utf8") };
}
function nodeProcess(command: "init" | "enroll" | "run", key: { directory: string; passphrase: string }, bundle?: string) {
  const rel = relative(lane, key.directory); if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("store_node_browser_child_directory_invalid");
  const child = spawn(process.execPath, ["--import", pathToFileURL(resolve(root, "apps/store-api-node/node_modules/tsx/dist/loader.mjs")).href,
    resolve(root, "apps/store-api-node/src/main.ts"), command, "--dir=" + key.directory, ...(bundle ? ["--bundle=" + bundle] : []), ...(command === "run" ? ["--interval-ms=1000"] : [])], {
    cwd: resolve(root, "apps/store-api-node"), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...systemEnvironment(), TSX_DISABLE_CACHE: "1", STORE_NODE_KEY_PASSPHRASE: key.passphrase } });
  const evidence = { command, exited: false, code: null as number | null, leaked: false, stdoutBytes: 0, stderrBytes: 0, states: [] as Array<{ state: string; sequence?: number; code?: string }> };
  let buffer = "", tail = "";
  const observe = (bytes: Buffer, stdout: boolean) => { if (stdout) evidence.stdoutBytes += bytes.length; else evidence.stderrBytes += bytes.length;
    const text = tail + bytes.toString("utf8"); evidence.leaked ||= text.includes(key.passphrase) || /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(text); tail = text.slice(-512);
    if (!stdout) return; buffer += bytes.toString("utf8"); let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const item = z.object({ state: z.enum(["initialized", "enrolled", "online", "offline", "stopped"]), execution: z.literal("not_integrated"),
        sequence: z.int().positive().optional(), code: z.string().regex(/^store_node_[a-z_]+$/).optional(), publicKeySpkiSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().safeParse(JSON.parse(line));
        if (item.success) { evidence.states.push({ state: item.data.state, ...(item.data.sequence ? { sequence: item.data.sequence } : {}), ...(item.data.code ? { code: item.data.code } : {}) }); if (evidence.states.length > 20) evidence.states.shift(); }
      } catch { /* Never retain raw child output. */ } } if (buffer.length > 32768) buffer = "";
  };
  child.stdout.on("data", (bytes: Buffer) => observe(bytes, true)); child.stderr.on("data", (bytes: Buffer) => observe(bytes, false));
  const done = new Promise<void>((yes, no) => { child.once("error", () => no(new Error("store_node_browser_cli_spawn_failed"))); child.once("exit", code => { evidence.exited = true; evidence.code = code; tail = ""; yes(); }); }); void done.catch(() => {});
  return { evidence, done, async close() { if (!evidence.exited) child.kill("SIGTERM");
    try { await authorityBounded(done, "store_node_browser_cli_close_timeout", 10_000); } catch { child.kill("SIGKILL"); await authorityBounded(done, "store_node_browser_cli_kill_timeout", 5_000); }
    if (evidence.leaked) throw new Error("store_node_browser_cli_secret_output"); } };
}

async function browserApi() {
  const isolated = requireStoreNodeIdentityEnvironment(process.env, "current", true), actor = Actor.parse(JSON.parse(process.env.ERP_FIXTURE_ACTORS!).operator);
  const startupCleanup: Array<() => Promise<void>> = [];
  try {
  await mkdir(lane, { recursive: true }); const files = await pkiFiles(isolated.nonce);
  const provider = await startMarketplaceAuthorityProvider(), restoreFetch = provider.installAuthorizationTransport(), restoreEnvironment = installMarketplaceAuthoritySyntheticEnvironment();
  startupCleanup.push(async () => { try { await provider.close(); } finally { restoreFetch(); restoreEnvironment(); } });
  const database = connectDatabase(isolated.url), audit = new AuditService(database), vault = createMarketplaceSecretVault(), accounts = new MarketplaceAccountService(database, audit);
  startupCleanup.push(() => database.client.end());
  const authorization = new MarketplaceAuthorizationService(database, vault, new HttpMarketplaceAuthorizationGateway(), audit);
  const capabilities = new MarketplaceCapabilityService(database, vault, new HttpMarketplaceCapabilityGateway(provider.request), authorization, audit);
  const ceiling = TenantContextSchema.parse({ tenantId: actor.tenantId, userId: actor.userId, permissions: nodeIdentityPermissions, dataScope: "tenant" });
  const original = await withTenant(database.db, ceiling, async tx => (await tx.select().from(roles).where(and(eq(roles.tenantId, actor.tenantId), eq(roles.id, actor.roleId))))[0]);
  if (!original) throw new Error("store_node_browser_original_role_missing");
  startupCleanup.push(async () => { await withTenant(database.db, ceiling, tx => tx.update(roles).set({ permissions: original.permissions, dataScope: original.dataScope }).where(eq(roles.id, original.id))); });
  const permissions = [...new Set([...original.permissions, ...nodeIdentityPermissions])];
  const rights = (enabled: boolean) => withTenant(database.db, ceiling, tx => tx.update(roles).set({ permissions: enabled ? permissions : permissions.filter(value => value !== "store:authorize"), dataScope: original.dataScope }).where(eq(roles.id, original.id)));
  await rights(true);
  const current = () => withTenant(database.db, ceiling, async tx => TenantContextSchema.parse(await loadCurrentMembershipContext(tx, { tenantId: actor.tenantId, userId: actor.userId })));
  const pki = await StoreNodePki.fromEnvironment(process.env), nodes = new StoreNodeService(database, audit, pki);
  const { AppModule } = await import("../app.module.js"); const app = await NestFactory.create(AppModule, { logger: false });
  const appDatabase = app.get<DatabaseConnection>(DATABASE_CONNECTION);
  startupCleanup.push(async () => { try { await app.close(); } finally { if (appDatabase !== database) await appDatabase.client.end(); } });
  let ready = false;
  app.getHttpAdapter().get("/__store_node_fixture_ready", (_request: unknown, response: { status(value: number): { json(value: object): void } }) => response.status(ready ? 200 : 503).json({ ready }));
  await app.listen(8130, "127.0.0.1");
  const bootstrap = createHttpsServer({ key: files.key, cert: files.cert, minVersion: "TLSv1.3" }, async (request, response) => {
    if (request.url !== "/v1/store-nodes/enroll" || request.method !== "POST") { response.writeHead(404); response.end(); return; }
    try { let size = 0; const chunks: Buffer[] = []; for await (const bytes of request) { size += bytes.length; if (size > 32768) throw new Error(); chunks.push(Buffer.from(bytes)); }
      const actual = await fetch("http://127.0.0.1:8130/v1/store-nodes/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks), redirect: "error", signal: AbortSignal.timeout(30_000) });
      response.writeHead(actual.status, { "content-type": "application/json" }); response.end(Buffer.from(await actual.arrayBuffer()));
    } catch { response.writeHead(502); response.end(); }
  });
  await new Promise<void>((done, reject) => { bootstrap.once("error", reject); bootstrap.listen(8141, "127.0.0.1", done); });
  startupCleanup.push(async () => { bootstrap.closeAllConnections(); await new Promise<void>((done, reject) => bootstrap.close(error => error ? reject(error) : done())); });
  type Key = { id: string; directory: string; passphrase: string; publicKeyPem: string; nodeId?: string; child?: ReturnType<typeof nodeProcess> };
  const groups = new Map<string, { ids: string[]; keys: Map<string, Key>; processes: ReturnType<typeof nodeProcess>[]; closed: boolean }>();
  async function closeGroup(groupId: string) {
    const group = groups.get(groupId); if (!group || group.closed) throw new Error("store_node_browser_group_unavailable"); const failures: unknown[] = []; await rights(true);
    for (const child of group.processes) try { await child.close(); } catch (error) { failures.push(error); }
    for (const accountId of group.ids) try { const view = await nodes.workspace(await current(), accountId);
      for (const node of view.nodes) if (node.status !== "revoked") await nodes.revoke(await current(), accountId, node.id, { expectedAuthorizationGeneration: view.authorizationGeneration,
        expectedBindingRevision: (await nodes.workspace(await current(), accountId)).binding.revision, expectedCertificateGeneration: node.certificateGeneration });
      await authorization.revoke(await current(), accountId);
    } catch (error) { failures.push(error); }
    group.closed = true; if (failures.length) throw new AggregateError(failures, "store_node_browser_group_cleanup_failed");
    return { ids: group.ids, childCount: group.processes.length, childrenExited: group.processes.every(value => value.evidence.exited), noSecretOutput: group.processes.every(value => !value.evidence.leaked), originalAuthorizationRevoked: true };
  }
  const key = randomBytes(32).toString("base64url");
  const control = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json"); const received = request.headers["x-fixture-control"];
    if (request.method !== "POST" || request.url !== "/" || typeof received !== "string" || received.length !== key.length || !timingSafeEqual(Buffer.from(received), Buffer.from(key))) { response.writeHead(404); response.end(); return; }
    try { const bytes: Buffer[] = []; let size = 0; for await (const part of request) { size += part.length; if (size > 65536) throw new Error(); bytes.push(Buffer.from(part)); }
      const input = Input.parse(JSON.parse(Buffer.concat(bytes).toString("utf8"))); let output: unknown;
      if (input.operation === "seed") { const groupId = createEntityId(), group = { ids: [] as string[], keys: new Map<string, Key>(), processes: [] as ReturnType<typeof nodeProcess>[], closed: false }; groups.set(groupId, group);
        for (let index = 0; index < 2; index++) { const account = await accounts.create(await current(), CreateMarketplaceAccountInputSchema.parse({ platform: "etsy", authorizationMode: "etsy_oauth", region: "GLOBAL", marketplaceIds: ["etsy"], requestedScopes: ["listings_r", "shops_r"], displayName: "Synthetic node browser " + createEntityId() }));
          group.ids.push(account.id); const started = await authorization.startOAuth(await current(), account.id); await authorization.completeOAuth(await current(), account.id, provider.code(started.authorizationUrl));
          await capabilities.sync(await current(), account.id, SyncMarketplaceCapabilitiesInputSchema.parse({})); if ((await accounts.get(await current(), account.id)).status !== "active") throw new Error(); }
        output = { groupId, ids: group.ids, actorId: actor.userId, tenantId: actor.tenantId };
      } else { const group = groups.get(input.groupId); if (!group || group.closed) throw new Error();
        if (input.operation === "init") { const id = createEntityId(), directory = resolve(lane, `browser-node-${isolated.nonce}-${id}`), passphrase = randomBytes(32).toString("base64url");
          const child = nodeProcess("init", { directory, passphrase }); group.processes.push(child); await authorityBounded(child.done, "store_node_browser_cli_init_timeout", 30_000); if (child.evidence.code !== 0 || child.evidence.leaked) throw new Error();
          const publicKeyPem = (await readFile(resolve(directory, "public-key.pem"), "utf8")).replaceAll("\r\n", "\n"); group.keys.set(id, { id, directory, passphrase, publicKeyPem }); output = { keyId: id, publicKeyPem };
        } else if (input.operation === "enroll" || input.operation === "run" || input.operation === "stop") { const keys = group.keys.get(input.keyId); if (!keys) throw new Error();
          if (input.operation === "enroll") { if (!group.ids.includes(input.bundle.accountId) || input.bundle.publicKeySpkiSha256 !== sha((await import("node:crypto")).createPublicKey(keys.publicKeyPem).export({ format: "der", type: "spki" }))) throw new Error();
            const path = resolve(keys.directory, "bundle-" + input.bundle.certificateGeneration + ".json"); await writeFile(path, JSON.stringify(input.bundle), { flag: "wx", mode: 0o600 });
            const child = nodeProcess("enroll", keys, path); group.processes.push(child); await authorityBounded(child.done, "store_node_browser_cli_enroll_timeout", 45_000);
            if (child.evidence.code !== 0 || child.evidence.leaked) throw new Error(); keys.nodeId = input.bundle.nodeId; output = { nodeId: keys.nodeId, enrolled: true };
          } else if (input.operation === "run") { if (!keys.nodeId || keys.child && !keys.child.evidence.exited) throw new Error(); keys.child = nodeProcess("run", keys); group.processes.push(keys.child); output = { nodeId: keys.nodeId, started: true }; }
          else { await keys.child?.close(); output = { exited: keys.child?.evidence.exited ?? true }; }
        } else if (input.operation === "expire") { const [node] = await withTenant(database.db, ceiling, tx => tx.select().from(marketplaceStoreNodes).where(eq(marketplaceStoreNodes.id, input.nodeId))); if (!node || !group.ids.includes(node.accountId)) throw new Error();
          await withTenant(database.db, ceiling, tx => tx.update(marketplaceStoreNodeBindings).set({ leaseExpiresAt: sql`clock_timestamp()-interval '1 second'` }).where(and(eq(marketplaceStoreNodeBindings.accountId, node.accountId), eq(marketplaceStoreNodeBindings.nodeId, node.id)))); output = { nodeId: node.id, ownedLeaseExpired: true };
        } else if (input.operation === "rights") { await rights(input.enabled); output = { updated: true }; }
        else if (input.operation === "close") output = await closeGroup(input.groupId);
        else { const data = await withTenant(database.db, ceiling, async tx => { const [business] = await tx.execute(sql`select (select count(*)::int from ai_budget_ledger) as paid,(select count(*)::int from marketplace_publication_requests) as publications,(select count(*)::int from marketplace_listing_sync_requests) as syncs`);
            const rows = await tx.select().from(marketplaceStoreNodes); return { business, nodes: rows.filter(value => group.ids.includes(value.accountId)).map(value => ({ id: value.id, accountId: value.accountId, status: value.status,
              generation: value.certificateGeneration, sequence: value.lastSequence, sessionId: value.sessionId, creationRequestKey: value.creationRequestKey })), originalRowsSha: sha(JSON.stringify(rows.filter(value => group.ids.includes(value.accountId)))) }; });
          output = { ...data, counts: { ...provider.counts }, children: group.processes.map(value => value.evidence) }; }
      }
      response.writeHead(200); response.end(JSON.stringify(output));
    } catch { response.writeHead(409); response.end('{"code":"store_node_browser_control_rejected"}'); }
  });
  await new Promise<void>((done, reject) => { control.once("error", reject); control.listen(0, "127.0.0.1", done); });
  startupCleanup.push(() => new Promise<void>((done, reject) => control.close(error => error ? reject(error) : done())));
  const address = control.address(); if (!address || typeof address === "string") throw new Error("store_node_browser_control_address_invalid");
  await writeFile(resolve(lane, "browser-control-" + isolated.nonce + ".json"), JSON.stringify({ nonce: isolated.nonce, pid: process.pid, origin: "http://127.0.0.1:" + address.port, key }), { flag: "wx", mode: 0o600 });
  ready = true;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { const failures: unknown[] = [];
    for (const [groupId, group] of groups) if (!group.closed) try { await closeGroup(groupId); } catch (error) { failures.push(error); }
    try { await withTenant(database.db, ceiling, tx => tx.update(roles).set({ permissions: original.permissions, dataScope: original.dataScope }).where(eq(roles.id, original.id))); } catch (error) { failures.push(error); }
    try { await new Promise<void>((done, reject) => control.close(error => error ? reject(error) : done())); } catch (error) { failures.push(error); }
    try { bootstrap.closeAllConnections(); await new Promise<void>((done, reject) => bootstrap.close(error => error ? reject(error) : done())); } catch (error) { failures.push(error); }
    try { await app.close(); } catch (error) { failures.push(error); }
    try { if (appDatabase !== database) await appDatabase.client.end(); await database.client.end(); } catch (error) { failures.push(error); }
    try { await provider.close(); } catch (error) { failures.push(error); } restoreFetch(); restoreEnvironment();
    if (failures.length) throw new AggregateError(failures, "store_node_browser_api_cleanup_failed"); })();
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void close().then(() => process.exit(0), () => process.exit(1)); });
  } catch {
    let cleanupFailures = 0;
    for (const close of startupCleanup.reverse()) try { await close(); } catch { cleanupFailures++; }
    await writeFile(resolve(lane, "browser-startup-" + isolated.nonce + ".json"), JSON.stringify({ failed: true, cleanupFailures, noRawErrorRetained: true })).catch(() => {});
    throw new Error("store_node_browser_startup_failed");
  }
}
if (process.argv.includes("--store-node-identity-api")) void browserApi().catch(() => { process.stderr.write("store_node_browser_startup_failed\n"); process.exitCode = 1; });
