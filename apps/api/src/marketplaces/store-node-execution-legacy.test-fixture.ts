import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:https";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { INestApplication } from "@nestjs/common";
import type * as NestCore from "@nestjs/core";
import type * as OriginalDatabase from "@yummyai/database";
import type * as OriginalContracts from "@yummyai/contracts";
import type * as OriginalConnectors from "@yummyai/marketplace-connectors";
import type * as OriginalAccount from "./marketplace-account.service.js";
import type * as OriginalAuthorization from "./marketplace-authorization.service.js";
import type * as OriginalCapability from "./marketplace-capability.service.js";
import type * as OriginalAudit from "../audit/audit.service.js";
import type * as OriginalPki from "./store-node-pki.js";
import type * as OriginalNodes from "./store-node.service.js";
import { requireStoreNodeExecutionEnvironment } from "../../../../tools/testing/require-store-node-execution-environment.mjs";
import { assertStoreNodeExecutionOriginal179Graph } from "./store-node-execution-graph.test-fixture.js";
import { executionBounded, startStoreNodeExecutionProvider } from "./store-node-execution-provider.test-fixture.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url)), lane = resolve(root, "tmp/store-node-execution-20261022-e6f2c8a1/qa");
const systemEnvironment = () => Object.fromEntries(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
const send = (data: object) => new Promise<void>((done, fail) => { if (!process.send) return fail(new Error("store_node_execution_legacy_ipc_required")); process.send(data, error => error ? fail(error) : done()); });
function safeDiagnostic(error: unknown, phase: string) {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES)$/.test(error.code) ? error.code : null;
  let location: { file: string; line: number } | null = null;
  if (error instanceof Error) { const match = /(?:file:\/\/\/)?([A-Za-z]:[\\/][^\r\n()]+\.(?:m?ts|js)):(\d+):\d+/.exec(error.stack ?? "");
    if (match) { const file = relative(root, match[1]!).replaceAll("\\", "/"); if (!file.startsWith("..") && /^[A-Za-z0-9_./-]+$/.test(file)) location = { file, line: Number(match[2]) }; } }
  return { type: "store.node.execution.failed179", phase, code, errorName: error instanceof Error ? error.name.replace(/[^A-Za-z]/g, "").slice(0, 40) : "Unknown", location };
}
/** This entry never imports current database/services. Every runtime import below is rooted in the sealed 179 graph. */
async function original179() {
  let phase = "original179_entry", database: OriginalDatabase.DatabaseConnection | undefined, appDatabase: OriginalDatabase.DatabaseConnection | undefined, app: INestApplication | undefined;
  let provider: Awaited<ReturnType<typeof startStoreNodeExecutionProvider>> | undefined, bootstrap: ReturnType<typeof createServer> | undefined;
  let restoreFetch: (() => void) | undefined, restoreEnvironment: (() => void) | undefined;
  const children: Array<{ child: ReturnType<typeof spawn>; done: Promise<void> }> = [];
  const close = async () => { for (const value of children) { if (value.child.exitCode === null && value.child.signalCode === null) value.child.kill("SIGTERM"); await executionBounded(value.done, "store_node_legacy_child_exit_timeout", 10_000); }
    if (bootstrap) { bootstrap.closeAllConnections(); await new Promise<void>(done => bootstrap!.close(() => done())); bootstrap = undefined; }
    await app?.close(); app = undefined; if (appDatabase && appDatabase !== database) await appDatabase.client.end(); appDatabase = undefined;
    await provider?.close(); provider = undefined; restoreFetch?.(); restoreEnvironment?.(); await database?.client.end(); database = undefined; };
  try {
    const target = requireStoreNodeExecutionEnvironment(process.env, "pre-0180"), source = process.env.E2E_STORE_NODE_EXECUTION_LEGACY_SOURCE!;
    if (!process.connected) throw new Error("store_node_execution_legacy_ipc_required");
    phase = "original179_graph"; await assertStoreNodeExecutionOriginal179Graph(source);
    const original = createRequire(pathToFileURL(resolve(source, "apps/api/package.json"))); original("reflect-metadata");
    const load = (file: string) => import(pathToFileURL(resolve(source, file)).href);
    phase = "original179_imports";
    const d = await load("packages/database/src/index.ts") as typeof OriginalDatabase, c = await load("packages/contracts/src/index.ts") as typeof OriginalContracts;
    const connectors = await load("packages/marketplace-connectors/src/index.ts") as typeof OriginalConnectors;
    const a = await load("apps/api/src/marketplaces/marketplace-account.service.ts") as typeof OriginalAccount;
    const auth = await load("apps/api/src/marketplaces/marketplace-authorization.service.ts") as typeof OriginalAuthorization;
    const cap = await load("apps/api/src/marketplaces/marketplace-capability.service.ts") as typeof OriginalCapability;
    const audits = await load("apps/api/src/audit/audit.service.ts") as typeof OriginalAudit;
    const p = await load("apps/api/src/marketplaces/store-node-pki.ts") as typeof OriginalPki, n = await load("apps/api/src/marketplaces/store-node.service.ts") as typeof OriginalNodes;
    database = d.connectDatabase(target.url); if ((await d.readMigrationEvidence(database)).actualRows.length !== 179) throw new Error("store_node_original179_schema_required");
    phase = "original179_pki";
    const directory = resolve(lane, "original179-" + target.nonce); await mkdir(directory, { recursive: false }); const path = (name: string) => resolve(directory, name);
    const openssl = (args: string[]) => new Promise<string>((done, fail) => execFile("D:/Git/usr/bin/openssl.exe", args, { windowsHide: true, timeout: 30_000, env: systemEnvironment() }, (error, out) => error ? fail(new Error("store_node_original179_pki_failed")) : done(out)));
    if (!/^OpenSSL 3\.5\.4\b/.test(await openssl(["version"]))) throw new Error("store_node_original179_openssl_changed");
    await openssl(["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-keyout", path("ca-key.pem"), "-out", path("ca.pem"), "-days", "2", "-sha256", "-subj", "/CN=Synthetic-original179-CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
    await openssl(["req", "-new", "-newkey", "rsa:3072", "-nodes", "-keyout", path("server-key.pem"), "-out", path("server.csr"), "-subj", "/CN=localhost"]);
    await writeFile(path("server.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n", { flag: "wx" });
    await openssl(["x509", "-req", "-in", path("server.csr"), "-CA", path("ca.pem"), "-CAkey", path("ca-key.pem"), "-set_serial", "0x" + randomBytes(16).toString("hex"), "-days", "1", "-sha256", "-extfile", path("server.ext"), "-out", path("server.pem")]);
    provider = await startStoreNodeExecutionProvider({ key: await readFile(path("server-key.pem")), cert: await readFile(path("server.pem"), "utf8"), ca: await readFile(path("ca.pem"), "utf8") }, directory);
    const values = { ...provider.environment, ETSY_APP_SHARED_SECRET: provider.nodeEnvironment.STORE_NODE_ETSY_APP_SHARED_SECRET, STORE_NODE_RUNTIME_ENABLED: "1", STORE_NODE_EXECUTION_ENABLED: "0",
      STORE_NODE_OPENSSL_PATH: "D:/Git/usr/bin/openssl.exe", STORE_NODE_CA_CERT_PATH: path("ca.pem"), STORE_NODE_CA_KEY_PATH: path("ca-key.pem"), STORE_NODE_SERVER_CERT_PATH: path("server.pem"),
      STORE_NODE_SERVER_KEY_PATH: path("server-key.pem"), STORE_NODE_ENROLLMENT_ORIGIN: "https://127.0.0.1:8141", STORE_NODE_RUNTIME_ORIGIN: "https://127.0.0.1:8142", STORE_NODE_RUNTIME_HOST: "127.0.0.1", STORE_NODE_RUNTIME_PORT: "8142" };
    const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
    restoreEnvironment = () => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; };
    restoreFetch = provider.installAuthorizationTransport();
    phase = "original179_owners";
    const tenantId = c.createEntityId(), userId = c.createEntityId(), membershipId = c.createEntityId(), roleId = c.createEntityId();
    const context: OriginalContracts.TenantContext = { tenantId, userId, permissions: ["store:read", "store:manage", "store:authorize"], dataScope: "tenant" };
    await database.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic original179 node',$2)", [tenantId, "execution-old179-" + tenantId]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic old179 operator')", [userId, "execution-old179-" + userId, userId + "@example.invalid"]);
    await d.withTenant(database.db, context, async tx => { await tx.insert(d.memberships).values({ id: membershipId, tenantId, userId, status: "active" });
      await tx.insert(d.roles).values({ id: roleId, tenantId, name: "Synthetic original179 node role", permissions: [...context.permissions], dataScope: "tenant" }); await tx.insert(d.membershipRoles).values({ tenantId, membershipId, roleId }); });
    const audit = new audits.AuditService(database), vault = connectors.createMarketplaceSecretVault(), accounts = new a.MarketplaceAccountService(database, audit);
    const authorization = new auth.MarketplaceAuthorizationService(database, vault, new connectors.HttpMarketplaceAuthorizationGateway(), audit);
    const capabilities = new cap.MarketplaceCapabilityService(database, vault, new connectors.HttpMarketplaceCapabilityGateway(provider.request), authorization, audit);
    const pki = await p.StoreNodePki.fromEnvironment(process.env), nodes = new n.StoreNodeService(database, audit, pki);
    const account = await accounts.create(context, c.CreateMarketplaceAccountInputSchema.parse({ platform: "etsy", authorizationMode: "etsy_oauth", region: "GLOBAL", marketplaceIds: ["etsy"], requestedScopes: ["listings_r", "shops_r"], displayName: "Synthetic old179 active " + c.createEntityId() }));
    const started = await authorization.startOAuth(context, account.id); await authorization.completeOAuth(context, account.id, provider.code(started.authorizationUrl));
    await capabilities.sync(context, account.id, c.SyncMarketplaceCapabilitiesInputSchema.parse({}));
    const nest = original("@nestjs/core") as typeof NestCore, module = await load("apps/api/src/app.module.ts") as { AppModule: unknown };
    app = await nest.NestFactory.create(module.AppModule as Parameters<typeof nest.NestFactory.create>[0], { logger: false });
    const tokens = await load("apps/api/src/platform.tokens.ts") as { DATABASE_CONNECTION: symbol }; appDatabase = app.get<OriginalDatabase.DatabaseConnection>(tokens.DATABASE_CONNECTION);
    await app.listen(0, "127.0.0.1"); const origin = await app.getUrl();
    bootstrap = createServer({ key: await readFile(path("server-key.pem")), cert: await readFile(path("server.pem")), minVersion: "TLSv1.3" }, async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/store-nodes/enroll") { res.writeHead(404); res.end(); return; }
      try { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 32768) throw new Error("bounded"); chunks.push(Buffer.from(chunk)); }
        const response = await fetch(origin + req.url, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks), redirect: "error" });
        res.writeHead(response.status, { "content-type": "application/json" }); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(503); res.end(); } });
    await new Promise<void>((done, fail) => { bootstrap!.once("error", fail); bootstrap!.listen(8141, "127.0.0.1", done); });
    const nodeDirectory = path("node"), passphrase = randomBytes(32).toString("base64url");
    const launch = (command: "init" | "enroll" | "run", bundle?: string) => {
      const child = spawn(process.execPath, ["--import", pathToFileURL(resolve(source, "apps/store-api-node/node_modules/tsx/dist/loader.mjs")).href, resolve(source, "apps/store-api-node/src/main.ts"), command,
        "--dir=" + nodeDirectory, ...(bundle ? ["--bundle=" + bundle] : []), ...(command === "run" ? ["--interval-ms=1000"] : [])], { cwd: resolve(source, "apps/store-api-node"), windowsHide: true,
        env: { ...systemEnvironment(), TSX_DISABLE_CACHE: "1", STORE_NODE_KEY_PASSPHRASE: passphrase }, stdio: ["ignore", "pipe", "pipe"] });
      let leaked = false; const check = (bytes: Buffer) => { const text = bytes.toString("utf8"); leaked ||= text.includes(passphrase) || provider!.secretValues.some(value => text.includes(value)) || /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(text); };
      child.stdout!.on("data", check); child.stderr!.on("data", check);
      const done = new Promise<void>((yes, no) => { child.once("error", () => no(new Error("store_node_original179_cli_spawn_failed"))); child.once("exit", code => leaked ? no(new Error("store_node_original179_secret_output")) : command !== "run" && code !== 0 ? no(new Error("store_node_original179_cli_failed")) : yes()); });
      void done.catch(() => {}); const entry = { child, done }; children.push(entry); return entry;
    };
    phase = "original179_cli"; await executionBounded(launch("init").done, "store_node_original179_init_timeout");
    const publicKeyPem = (await readFile(resolve(nodeDirectory, "public-key.pem"), "utf8")).replaceAll("\r\n", "\n"), view = await nodes.workspace(context, account.id);
    const created = await nodes.createEnrollment(context, account.id, { label: "Synthetic original179 CLI", publicKeyPem,
      expectedAuthorizationGeneration: view.authorizationGeneration, expectedBindingRevision: view.binding.revision, idempotencyKey: createHash("sha256").update(nodeDirectory).digest("hex") });
    const bundlePath = path("enrollment.json"); await writeFile(bundlePath, JSON.stringify(created.enrollment), { flag: "wx", mode: 0o600 }); await executionBounded(launch("enroll", bundlePath).done, "store_node_original179_enroll_timeout", 45_000);
    const pulse = launch("run"); await executionBounded((async () => { while (!(await nodes.workspace(context, account.id)).nodes.some(value => value.id === created.enrollment.nodeId && value.reachability === "online")) {
      if (pulse.child.exitCode !== null) throw new Error("store_node_original179_run_exited"); await new Promise(done => setTimeout(done, 100));
    } })(), "store_node_original179_heartbeat_timeout", 15_000); pulse.child.kill("SIGTERM"); await executionBounded(pulse.done, "store_node_original179_stop_timeout");
    const online = await nodes.workspace(context, account.id); await nodes.bind(context, account.id, { nodeId: created.enrollment.nodeId, expectedAuthorizationGeneration: online.authorizationGeneration,
      expectedBindingRevision: online.binding.revision, expectedCertificateGeneration: created.enrollment.certificateGeneration });
    const snapshot = await capabilities.latest(context, account.id), oldNode = (await nodes.workspace(context, account.id)).nodes.find(value => value.id === created.enrollment.nodeId)!;
    const rows = await d.withTenant(database.db, context, async tx => ({ accounts: await tx.select().from(d.marketplaceAccounts), credentials: await tx.select().from(d.marketplaceCredentials),
      sessions: await tx.select().from(d.marketplaceAuthorizationSessions), capabilities: await tx.select().from(d.marketplaceCapabilitySnapshots), nodes: await tx.select().from(d.marketplaceStoreNodes), bindings: await tx.select().from(d.marketplaceStoreNodeBindings) }));
    await send({ type: "store.node.execution.seeded179", nonce: target.nonce, context, accountId: account.id, nodeId: oldNode.id, rows: JSON.parse(JSON.stringify(rows)), latest: snapshot, sequence: await d.withTenant(database.db, context, async tx => (await tx.select().from(d.marketplaceStoreNodes))[0]!.lastSequence) });
    phase = "original179_wait_migration";
    await executionBounded(new Promise<void>((done, fail) => { process.on("message", raw => { if (!raw || typeof raw !== "object" || !("type" in raw) || raw.type !== "store.node.execution.check179" || !("nonce" in raw) || raw.nonce !== target.nonce) return;
      void (async () => { try { phase = "original179_post180_heartbeat"; const counts = provider!.counts(false), originalSnapshot = await capabilities.latest(context, account.id), before = await nodes.workspace(context, account.id);
        const resumed = launch("run"); await executionBounded((async () => { for (;;) { const [node] = await d.withTenant(database!.db, context, tx => tx.select().from(d.marketplaceStoreNodes));
          if (node!.lastSequence > (rows.nodes[0]!.lastSequence ?? 0)) break; if (resumed.child.exitCode !== null) throw new Error("store_node_original179_restart_exited"); await new Promise(yes => setTimeout(yes, 100)); } })(), "store_node_original179_resume_timeout", 15_000);
        resumed.child.kill("SIGTERM"); await executionBounded(resumed.done, "store_node_original179_resume_close_timeout");
        await send({ type: "store.node.execution.checked179", nonce: target.nonce, latest: originalSnapshot, beforeExecution: before.execution, after: await nodes.workspace(context, account.id), providerUnchanged: JSON.stringify(counts) === JSON.stringify(provider!.counts(false)), originalCli: true }); done();
      } catch (error) { fail(error); } })(); }); }), "store_node_original179_wait_timeout", 120_000);
    await close(); process.exitCode = 0;
  } catch (error) { await send(safeDiagnostic(error, phase)).catch(() => {}); await close().catch(() => {}); process.exitCode = 1; }
  finally { process.disconnect?.(); }
}
if (process.argv.includes("--store-node-execution-original179-child")) await original179();
