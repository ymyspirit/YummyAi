import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "../../packages/database/src/client.js";
import type * as OriginalDatabase from "../../packages/database/src/index.js";
import type * as OriginalContracts from "../../packages/contracts/src/index.js";
import type * as OriginalConnectors from "../../packages/marketplace-connectors/src/index.js";
import type * as OriginalAccount from "../../apps/api/src/marketplaces/marketplace-account.service.js";
import type * as OriginalAuthorization from "../../apps/api/src/marketplaces/marketplace-authorization.service.js";
import type * as OriginalCapability from "../../apps/api/src/marketplaces/marketplace-capability.service.js";
import type * as OriginalAudit from "../../apps/api/src/audit/audit.service.js";
import { requireMarketplaceAuthorityEnvironment } from "./require-marketplace-authority-environment.mjs";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-22-marketplace-authority-d8b7a3c6");
const expectedRoot = resolve(workspace, "tmp/marketplace-authority-20261022-d8b7a3c6/old177-source");
export function requireMarketplaceAuthorityLegacyEnvironment(env: NodeJS.ProcessEnv, target: "pre-0178" | "current") {
  const isolated = requireMarketplaceAuthorityEnvironment(env, target), root = env.E2E_MARKETPLACE_AUTHORITY_LEGACY_SOURCE;
  if (!root || !isAbsolute(root) || resolve(root) !== expectedRoot) throw new Error("Exact original177 source required");
  return { ...isolated, root: resolve(root) };
}
export async function assertMarketplaceAuthorityOriginal177Graph(root: string) {
  if (resolve(root) !== expectedRoot) throw new Error("Original177 root mismatch");
  const source = JSON.parse(await readFile(prefix + "-source-before.json", "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
  const graph = JSON.parse(await readFile(prefix + "-old177-source.json", "utf8")) as { operation: string; sourceRoot: string; sourceFiles: number;
    sourceSha256: string; links: Array<{ path: string; target: string }>; workspaceDependenciesPinned: boolean; authorityGenerationPresent: boolean };
  if (source.files.length !== 3461 || source.sha256 !== "8a246acb67763846a0b472d46795d831eb108b15cf7c299cf909913bdb7598d0" || graph.operation !== "d8b7a3c6" ||
    resolve(graph.sourceRoot) !== expectedRoot || graph.sourceFiles !== source.files.length || graph.sourceSha256 !== source.sha256 || graph.links.length !== 392 ||
    !graph.workspaceDependenciesPinned || graph.authorityGenerationPresent) throw new Error("Original177 manifest mismatch");
  for (const file of source.files) {
    const name = resolve(root, file.path); if (relative(root, name).startsWith("..") || isAbsolute(relative(root, name))) throw new Error("Original177 file escaped");
    if (createHash("sha256").update(await readFile(name)).digest("hex") !== file.sha256) throw new Error("Original177 source bytes differ");
  }
  for (const link of graph.links) if (await realpath(link.path) !== await realpath(link.target)) throw new Error("Original177 dependency mismatch");
  for (const name of ["contracts", "database", "ai-core", "authz", "marketplace-connectors"])
    if (await realpath(resolve(root, "apps/api/node_modules/@yummyai", name)) !== await realpath(resolve(root, "packages", name))) throw new Error("Original177 workspace dependency escaped");
  const schema = await readFile(resolve(root, "packages/database/src/schema/marketplace.ts"), "utf8");
  if (schema.includes("authorizationGeneration")) throw new Error("New authority schema reachable from old177");
  const journal = JSON.parse(await readFile(resolve(root, "packages/database/migrations/meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  if (journal.entries.length !== 177 || !journal.entries.at(-1)?.tag.startsWith("0177_")) throw new Error("Original177 journal mismatch");
}
export async function migrateMarketplaceAuthorityLegacyDatabase(database: DatabaseConnection, name: string, env: NodeJS.ProcessEnv) {
  const target = requireMarketplaceAuthorityLegacyEnvironment(env, "pre-0178"); if (target.name !== name) throw new Error("Original177 database mismatch");
  await assertMarketplaceAuthorityOriginal177Graph(target.root);
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== name || actual.ledger !== null || actual.populated !== false) throw new Error("Original177 migration refuses populated database");
  const require = createRequire(pathToFileURL(resolve(target.root, "packages/database/package.json")));
  const { readMigrationFiles } = require("drizzle-orm/migrator") as { readMigrationFiles(input: { migrationsFolder: string }): Array<{ folderMillis: number; hash: string; sql: string[] }> };
  const migrations = readMigrationFiles({ migrationsFolder: resolve(target.root, "packages/database/migrations") });
  if (migrations.length !== 177) throw new Error("Original177 migrations required");
  await database.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle"); await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) { for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at)values($1,$2)", [migration.hash, migration.folderMillis]); }
  });
}
export function authorityLatch() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
export function installMarketplaceAuthoritySyntheticEnvironment() {
  const values = { ETSY_APP_KEYSTRING: "synthetic-authority-client", ETSY_APP_SHARED_SECRET: "SYNTHETIC-AUTHORITY-SHARED-SECRET", ETSY_OAUTH_REDIRECT_URI: "https://erp-fixture.invalid/store-callback" };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  return () => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; };
}
export async function authorityBounded<T>(promise: Promise<T>, code: string, ms = 20_000) {
  let timer: NodeJS.Timeout | undefined; try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(code)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
/** Synthetic external HTTP only. Native gateways parse every real response; owner facts are never stubbed. */
export async function startMarketplaceAuthorityProvider() {
  const codes = new Map<string, { challenge: string; redirect: string; clientId: string; user: number }>();
  const grants = new Map<string, number>(), access = new Map<string, number>(); let user = 100_000 + randomBytes(3).readUIntBE(0, 3);
  const counts = { oauth: 0, private: 0, refresh: 0, read: 0, rejected: 0 };
  const controls = { rotate: false, failRead: false, loseRefresh: false };
  type Gate = { kind: "oauth" | "private" | "refresh" | "read"; entered: ReturnType<typeof authorityLatch>; release: ReturnType<typeof authorityLatch>; used: boolean };
  let gate: Gate | undefined;
  const tokens = (id: number, refresh: string) => { const token = id + "." + randomBytes(16).toString("hex"); access.set(token, id);
    return { access_token: token, refresh_token: refresh, expires_in: 3600, token_type: "Bearer" }; };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost"), chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 64_000) throw new Error("provider_input_too_large"); chunks.push(Buffer.from(chunk)); }
      const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const kind = req.method === "POST" && url.pathname === "/auth/o2/token" ? "private" : req.method === "POST" && url.pathname === "/v3/public/oauth/token"
        ? body.get("grant_type") === "authorization_code" ? "oauth" : "refresh" : "read";
      counts[kind]++; const held = gate; if (held && !held.used && held.kind === kind) { held.used = true; held.entered.resolve(); await held.release.promise; }
      let output: unknown;
      if (kind === "private") output = tokens(++user, "SYNTHETIC-PRIVATE-" + randomBytes(12).toString("hex"));
      else if (kind === "oauth") {
        const code = codes.get(body.get("code") ?? ""); codes.delete(body.get("code") ?? "");
        if (!code || code.clientId !== body.get("client_id") || code.redirect !== body.get("redirect_uri") ||
          createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url") !== code.challenge) {
          counts.rejected++; res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"invalid_grant"}'); return;
        }
        const refresh = "SYNTHETIC-REFRESH-" + randomBytes(16).toString("hex"); grants.set(refresh, code.user); output = tokens(code.user, refresh);
      } else if (kind === "refresh") {
        const original = body.get("refresh_token") ?? "", id = grants.get(original);
        if (!id) { counts.rejected++; res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"invalid_grant"}'); return; }
        const refresh = controls.rotate ? "SYNTHETIC-REFRESH-" + randomBytes(16).toString("hex") : original;
        if (controls.rotate) grants.delete(original); grants.set(refresh, id); output = tokens(id, refresh);
        if (controls.loseRefresh) { res.destroy(); return; }
      } else {
        if (controls.failRead) { res.writeHead(503, { "content-type": "application/json" }); res.end('{"error":"SYNTHETIC_PROVIDER_PRIVATE_ERROR"}'); return; }
        const id = access.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
        if (!id) { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"unauthorized"}'); return; }
        const shop = /^\/v3\/application\/users\/([0-9]+)\/shops$/.exec(url.pathname);
        output = shop ? { shop_id: id + 1_000_000, user_id: id, shop_name: "Synthetic authority shop" } : { count: 0, results: [] };
        if (shop && Number(shop[1]) !== id) { res.writeHead(403, { "content-type": "application/json" }); res.end('{"error":"wrong_owner"}'); return; }
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(output));
    } catch { if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"synthetic_provider_failure"}'); }
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Provider address missing");
  const origin = `http://127.0.0.1:${address.port}`, originalFetch = globalThis.fetch;
  const request: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!["https://api.amazon.com", "https://api.etsy.com", "https://openapi.etsy.com"].includes(url.origin)) throw new Error("Synthetic provider refuses unregistered origin");
    return originalFetch(origin + url.pathname + url.search, { ...init, redirect: "error" });
  };
  return { origin, request, controls, counts,
    code(authorizationUrl: string) { const url = new URL(authorizationUrl), code = "SYNTHETIC-CODE-" + randomBytes(12).toString("hex");
      if (url.origin !== "https://www.etsy.com" || url.pathname !== "/oauth/connect" || url.searchParams.get("code_challenge_method") !== "S256") throw new Error("Original Etsy PKCE request required");
      codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect: url.searchParams.get("redirect_uri")!, clientId: url.searchParams.get("client_id")!, user: ++user });
      return { state: url.searchParams.get("state")!, code }; },
    arm(kind: Gate["kind"]) { if (gate && !gate.used) throw new Error("Previous provider gate unused"); gate = { kind, entered: authorityLatch(), release: authorityLatch(), used: false }; return gate; },
    installAuthorizationTransport() { const previous = globalThis.fetch;
      const bridge: typeof fetch = (input, init) => { const url = new URL(input instanceof Request ? input.url : String(input));
        return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? originalFetch(input, init) : request(input, init); };
      globalThis.fetch = bridge; return () => { if (globalThis.fetch === bridge) globalThis.fetch = previous; }; },
    async close() { gate?.release.resolve(); server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); },
  };
}

export function marketplaceAuthorityLegacyDiagnostic(error: unknown, phase: string) {
  const value = error && typeof error === "object" ? error : {};
  const code = "code" in value && typeof value.code === "string" && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES)$/.test(value.code) ? value.code : null;
  let location: { file: string; line: number } | null = null;
  if ("stack" in value && typeof value.stack === "string") for (const line of value.stack.split(/\r?\n/).slice(1, 10)) {
    const match = /((?:file:\/\/\/)?[A-Za-z]:[\\/][^()\r\n]*?\.[cm]?[jt]sx?):([1-9][0-9]*):[0-9]+\)?$/.exec(line.trim()); if (!match) continue;
    try { const file = relative(workspace, match[1]!.startsWith("file:") ? fileURLToPath(match[1]!) : match[1]!).replaceAll("\\", "/");
      if (!isAbsolute(file) && !file.startsWith("../") && /^[A-Za-z0-9_./-]+$/.test(file)) { location = { file, line: Number(match[2]) }; break; }
    } catch { /* Only recognized owned file locations are retained. */ }
  }
  const names = ["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError", "ZodError", "PostgresError", "ConflictException", "UnauthorizedException", "ForbiddenException", "NotFoundException"];
  return { type: "marketplace.authority.failed" as const, phase: /^original177_[a-z_]{1,60}$/.test(phase) ? phase : "original177_unknown", code,
    errorName: error instanceof Error && names.includes(error.name) ? error.name : "Error", location };
}
async function seedOriginal177() {
  let phase = "original177_entry", database: OriginalDatabase.DatabaseConnection | undefined, provider: Awaited<ReturnType<typeof startMarketplaceAuthorityProvider>> | undefined;
  let restoreFetch: (() => void) | undefined, restoreEnvironment: (() => void) | undefined, failure: unknown;
  const send = (value: object) => new Promise<void>((done, reject) => { if (!process.send) return reject(new Error("Original177 IPC missing")); process.send(value, error => error ? reject(error) : done()); });
  try {
    phase = "original177_environment"; const target = requireMarketplaceAuthorityLegacyEnvironment(process.env, "current");
    if (!process.connected) throw new Error("Original177 seed requires parent");
    phase = "original177_graph"; await assertMarketplaceAuthorityOriginal177Graph(target.root);
    const require = createRequire(pathToFileURL(resolve(target.root, "apps/api/package.json"))); require("reflect-metadata");
    const load = (file: string) => import(pathToFileURL(resolve(target.root, file)).href);
    phase = "original177_imports";
    const d = await load("packages/database/src/index.ts") as typeof OriginalDatabase, c = await load("packages/contracts/src/index.ts") as typeof OriginalContracts;
    const connectors = await load("packages/marketplace-connectors/src/index.ts") as typeof OriginalConnectors;
    const a = await load("apps/api/src/marketplaces/marketplace-account.service.ts") as typeof OriginalAccount;
    const auth = await load("apps/api/src/marketplaces/marketplace-authorization.service.ts") as typeof OriginalAuthorization;
    const cap = await load("apps/api/src/marketplaces/marketplace-capability.service.ts") as typeof OriginalCapability, audits = await load("apps/api/src/audit/audit.service.ts") as typeof OriginalAudit;
    database = d.connectDatabase(target.url); await d.assertDatabaseMigrationsCurrent(database);
    if ((await d.readMigrationEvidence(database)).actualRows.length !== 177) throw new Error("Actual177 schema required");
    const tenantId = c.createEntityId(), userId = c.createEntityId(), memberId = c.createEntityId(), roleId = c.createEntityId();
    const bootstrap: OriginalContracts.TenantContext = { tenantId, userId, permissions: ["store:read", "store:manage", "store:authorize"], dataScope: "tenant" };
    await database.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic original177 authority',$2)", [tenantId, tenantId]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic original177 authority')", [userId, userId, userId + "@example.invalid"]);
    await d.withTenant(database.db, bootstrap, async tx => {
      await tx.insert(d.memberships).values({ id: memberId, tenantId, userId, status: "active" });
      await tx.insert(d.roles).values({ id: roleId, tenantId, name: "Synthetic original177 role", permissions: [...bootstrap.permissions], dataScope: "tenant" });
      await tx.insert(d.membershipRoles).values({ tenantId, membershipId: memberId, roleId });
    });
    const context = c.TenantContextSchema.parse(await d.withTenant(database.db, bootstrap, tx => d.loadCurrentMembershipContext(tx, { tenantId, userId })));
    provider = await startMarketplaceAuthorityProvider(); restoreFetch = provider.installAuthorizationTransport(); restoreEnvironment = installMarketplaceAuthoritySyntheticEnvironment();
    const vault = connectors.createMarketplaceSecretVault(), audit = new audits.AuditService(database), accounts = new a.MarketplaceAccountService(database, audit);
    const authorization = new auth.MarketplaceAuthorizationService(database, vault, new connectors.HttpMarketplaceAuthorizationGateway(), audit);
    const capabilities = new cap.MarketplaceCapabilityService(database, vault, new connectors.HttpMarketplaceCapabilityGateway(provider.request), authorization, audit);
    const create = async (platform: "amazon" | "etsy") => accounts.create(context, c.CreateMarketplaceAccountInputSchema.parse({ platform, displayName: "Synthetic177-" + c.createEntityId(), region: platform === "amazon" ? "NA" : "GLOBAL",
      marketplaceIds: platform === "amazon" ? ["ATVPDKIKX0DER"] : ["etsy"], authorizationMode: platform === "amazon" ? "amazon_private" : "etsy_oauth", requestedScopes: platform === "amazon" ? ["product-listing"] : ["listings_r", "listings_w", "shops_r"] }));
    const oauth = async (id: string) => { const begin = await authorization.startOAuth(context, id); const input = provider!.code(begin.authorizationUrl); await authorization.completeOAuth(context, id, input); };
    const cases: Array<{ kind: string; accountId: string; priorStatus: string; finalStatus: string; credentialRows: number; snapshots: number; defectObserved: boolean }> = [];
    for (const kind of ["oauth_after_revoke", "private_after_revoke", "normalcaps_after_revoke", "rotatedcaps_after_disable"]) {
      phase = "original177_" + kind; const account = await create(kind.startsWith("private") ? "amazon" : "etsy");
      if (kind.includes("caps")) await oauth(account.id);
      provider.controls.rotate = kind.startsWith("rotated"); const gate = provider.arm(kind.startsWith("oauth") ? "oauth" : kind.startsWith("private") ? "private" : "read");
      const input = kind.startsWith("oauth") ? provider.code((await authorization.startOAuth(context, account.id)).authorizationUrl) : null;
      const pending = (kind.startsWith("oauth") ? authorization.completeOAuth(context, account.id, input!) : kind.startsWith("private")
        ? authorization.authorizeAmazonPrivate(context, account.id, { sellingPartnerId: "SYNTHETIC177-SELLER", clientId: "synthetic", clientSecret: "SYNTHETIC177-CLIENT-SECRET", refreshToken: "SYNTHETIC177-PRIVATE-REFRESH" })
        : capabilities.sync(context, account.id, c.SyncMarketplaceCapabilitiesInputSchema.parse({}))).then(value => ({ ok: true, value }), () => ({ ok: false, value: null }));
      try {
        await authorityBounded(Promise.race([gate.entered.promise, pending.then(() => { throw new Error("Original177 provider gate not reached"); })]), "original177_gate_missing");
        const before = kind.startsWith("rotated") ? await accounts.update(context, account.id, { enabled: false }) : await authorization.revoke(context, account.id);
        gate.release.resolve(); const result = await pending, final = await accounts.get(context, account.id);
        const rows = await d.withTenant(database.db, context, tx => tx.select().from(d.marketplaceCredentials));
        const snapshots = await d.withTenant(database.db, context, tx => tx.select().from(d.marketplaceCapabilitySnapshots));
        cases.push({ kind, accountId: account.id, priorStatus: before.status, finalStatus: final.status, credentialRows: rows.filter(row => row.accountId === account.id).length,
          snapshots: snapshots.filter(row => row.accountId === account.id).length, defectObserved: result.ok && ["pending_authorization", "active"].includes(final.status) });
      } finally { gate.release.resolve(); await pending; }
    }
    if (cases.some(row => !row.defectObserved)) throw new Error("Original177 defects did not reproduce");
    phase = "original177_history"; provider.controls.rotate = false;
    const history = await create("etsy"); await oauth(history.id); await capabilities.sync(context, history.id, c.SyncMarketplaceCapabilitiesInputSchema.parse({}));
    const begin = await authorization.startOAuth(context, history.id), pendingInput = provider.code(begin.authorizationUrl);
    const rows = await d.withTenant(database.db, context, async tx => ({ accounts: await tx.select().from(d.marketplaceAccounts), credentials: await tx.select().from(d.marketplaceCredentials),
      sessions: await tx.select().from(d.marketplaceAuthorizationSessions), capabilities: await tx.select().from(d.marketplaceCapabilitySnapshots) }));
    await send({ type: "marketplace.authority.seeded177", context, memberId, roleId, cases, historyAccountId: history.id, pendingInput, rows, providerCounts: { ...provider.counts } });
  } catch (error) { failure = error; await send(marketplaceAuthorityLegacyDiagnostic(error, phase)); }
  const errors: unknown[] = []; for (const done of [() => provider?.close(), () => database?.client.end()]) try { await done(); } catch (error) { errors.push(error); }
  restoreFetch?.(); restoreEnvironment?.(); if (errors.length) { await send(marketplaceAuthorityLegacyDiagnostic(new AggregateError(errors), "original177_cleanup")); failure ??= errors[0]; }
  if (process.connected) process.disconnect(); process.exitCode = failure ? 1 : 0;
}
if (process.env.E2E_MARKETPLACE_AUTHORITY_LEGACY_CHILD === "177") void seedOriginal177().catch(error => {
  process.send?.(marketplaceAuthorityLegacyDiagnostic(error, "original177_unhandled"), () => { if (process.connected) process.disconnect(); process.exitCode = 1; });
});
