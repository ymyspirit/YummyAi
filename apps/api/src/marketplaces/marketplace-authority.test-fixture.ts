import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { Permission } from "@yummyai/authz";
import { CreateMarketplaceAccountInputSchema, SyncMarketplaceCapabilitiesInputSchema, TenantContextSchema, createEntityId, type TenantContext } from "@yummyai/contracts";
import { marketplaceAccounts, marketplaceCredentials, marketplaceAuthorizationSessions, marketplaceCapabilitySnapshots, auditEvents,
  memberships, membershipRoles, roles, loadCurrentMembershipContext, withTenant, connectDatabase, type DatabaseConnection } from "@yummyai/database";
import { HttpMarketplaceAuthorizationGateway, HttpMarketplaceCapabilityGateway, createMarketplaceSecretVault } from "@yummyai/marketplace-connectors";
import { requireMarketplaceAuthorityEnvironment } from "../../../../tools/testing/require-marketplace-authority-environment.mjs";
import { authorityBounded, startMarketplaceAuthorityProvider, installMarketplaceAuthoritySyntheticEnvironment } from "../../../../tools/testing/marketplace-authority-legacy-upgrade.mjs";
import { AuditService } from "../audit/audit.service.js";
import { MarketplaceAccountService } from "./marketplace-account.service.js";
import { MarketplaceAuthorizationService } from "./marketplace-authorization.service.js";
import { MarketplaceCapabilityService } from "./marketplace-capability.service.js";
import { MarketplaceAuthorityWorkspaceService } from "./marketplace-authority-workspace.service.js";

export const marketplaceAuthorityPermissions = [Permission.StoreRead, Permission.StoreManage, Permission.StoreAuthorize];
export type AuthorityActor = { tenantId: string; userId: string; membershipId: string; roleId: string; ceiling: TenantContext };
const root = fileURLToPath(new URL("../../../../", import.meta.url));
export function marketplaceAuthorityFixture(database: DatabaseConnection) {
  requireMarketplaceAuthorityEnvironment();
  const vault = createMarketplaceSecretVault(), audit = new AuditService(database), accounts = new MarketplaceAccountService(database, audit);
  const authorization = new MarketplaceAuthorizationService(database, vault, new HttpMarketplaceAuthorizationGateway(), audit);
  const workspace = new MarketplaceAuthorityWorkspaceService(database);
  let provider: Awaited<ReturnType<typeof startMarketplaceAuthorityProvider>>, capabilities: MarketplaceCapabilityService;
  let restoreFetch: (() => void) | undefined, restoreEnvironment: (() => void) | undefined;
  let a: AuthorityActor, peer: AuthorityActor, foreign: AuthorityActor, closed = false;
  const owned = new Set<string>();
  async function actor(tenantId = createEntityId()) {
    const userId = createEntityId(), membershipId = createEntityId(), roleId = createEntityId();
    const ceiling: TenantContext = { tenantId, userId, permissions: [...marketplaceAuthorityPermissions], dataScope: "tenant" };
    await database.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic authority tenant',$2)on conflict(id)do nothing", [tenantId, "authority-" + tenantId]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic authority member')", [userId, "authority-" + userId, userId + "@example.invalid"]);
    await withTenant(database.db, ceiling, async tx => {
      await tx.insert(memberships).values({ id: membershipId, tenantId, userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId, name: "Synthetic authority " + roleId, permissions: [...marketplaceAuthorityPermissions], dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId, membershipId, roleId });
    });
    return { tenantId, userId, membershipId, roleId, ceiling };
  }
  async function current(who = a) { return TenantContextSchema.parse(await withTenant(database.db, who.ceiling,
    tx => loadCurrentMembershipContext(tx, { tenantId: who.tenantId, userId: who.userId }))); }
  async function rights(who: AuthorityActor, permissions = marketplaceAuthorityPermissions, scope: "tenant" | "self" = "tenant") {
    await withTenant(database.db, who.ceiling, tx => tx.update(roles).set({ permissions: [...permissions], dataScope: scope }).where(eq(roles.id, who.roleId)));
  }
  async function create(platform: "amazon" | "etsy" = "etsy", who = a) {
    const value = await accounts.create(await current(who), CreateMarketplaceAccountInputSchema.parse({ platform, displayName: "Synthetic-authority-" + createEntityId(),
      region: platform === "amazon" ? "NA" : "GLOBAL", marketplaceIds: platform === "amazon" ? ["ATVPDKIKX0DER"] : ["etsy"],
      authorizationMode: platform === "amazon" ? "amazon_private" : "etsy_oauth", requestedScopes: platform === "amazon" ? ["product-listing"] : ["listings_r", "listings_w", "shops_r"] }));
    owned.add(value.id); return value;
  }
  async function oauth(accountId: string, who = a) {
    const context = await current(who), begin = await authorization.startOAuth(context, accountId), input = provider.code(begin.authorizationUrl);
    return authorization.completeOAuth(context, accountId, input);
  }
  const privateInput = () => ({ sellingPartnerId: "SYNTHETIC-SELLER-" + createEntityId(), clientId: "synthetic-authority-client",
    clientSecret: "SYNTHETIC-AUTHORITY-CLIENT-SECRET", refreshToken: "SYNTHETIC-AUTHORITY-PRIVATE-" + randomBytes(12).toString("hex") });
  async function rows(accountId: string, who = a) {
    return withTenant(database.db, who.ceiling, async tx => ({
      accounts: await tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, accountId)),
      credentials: await tx.select().from(marketplaceCredentials).where(eq(marketplaceCredentials.accountId, accountId)),
      sessions: await tx.select().from(marketplaceAuthorizationSessions).where(eq(marketplaceAuthorizationSessions.accountId, accountId)),
      capabilities: await tx.select().from(marketplaceCapabilitySnapshots).where(eq(marketplaceCapabilitySnapshots.accountId, accountId)),
      audits: await tx.select().from(auditEvents).where(and(eq(auditEvents.entityId, accountId), eq(auditEvents.tenantId, who.tenantId))),
    }));
  }
  async function initialize() {
    try {
      a = await actor(); peer = await actor(a.tenantId); foreign = await actor();
      provider = await startMarketplaceAuthorityProvider(); restoreFetch = provider.installAuthorizationTransport(); restoreEnvironment = installMarketplaceAuthoritySyntheticEnvironment();
      capabilities = new MarketplaceCapabilityService(database, vault, new HttpMarketplaceCapabilityGateway(provider.request), authorization, audit);
    } catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Authority fixture initialization failed"); } throw error; }
  }
  async function crashableRefresh(accountId: string) {
    const { nonce } = requireMarketplaceAuthorityEnvironment();
    const child = spawn(process.execPath, ["--import", pathToFileURL(resolve(root, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
      fileURLToPath(import.meta.url), "--marketplace-authority-refresh-child"], { cwd: resolve(root, "apps/api"), windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json") } });
    const evidence = { exited: false, killed: false, code: null as number | null, signal: null as NodeJS.Signals | null };
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    const ready = new Promise<void>((yes, no) => { readyResolve = yes; readyReject = no; });
    const result = new Promise<void>(done => child.once("exit", (code, signal) => { Object.assign(evidence, { exited: true, code, signal }); readyReject(new Error("Authority refresh child exited before ready")); done(); }));
    child.once("error", () => readyReject(new Error("Authority refresh child spawn failed")));
    child.on("message", raw => { if (raw && typeof raw === "object" && "nonce" in raw && raw.nonce === nonce && "type" in raw && raw.type === "marketplace.authority.refresh.ready") readyResolve(); });
    async function kill() { if (!evidence.exited) { evidence.killed = true; child.kill("SIGKILL"); } await authorityBounded(result, "authority_refresh_child_exit_timeout", 10_000); }
    try { await authorityBounded(ready, "authority_refresh_child_ready_timeout");
      const context = await current(); child.send({ nonce, accountId, context, providerOrigin: provider.origin });
    } catch (error) { await kill(); throw error; }
    return { result, evidence, kill, close: kill };
  }
  async function close() {
    if (closed) return; closed = true; const errors: unknown[] = [];
    for (const who of [a, peer, foreign].filter(Boolean)) try { await rights(who); } catch (error) { errors.push(error); }
    for (const id of owned) try { await authorization.revoke(await current(), id); } catch (error) { errors.push(error); }
    try { await provider?.close(); } catch (error) { errors.push(error); } restoreFetch?.(); restoreEnvironment?.();
    if (errors.length) throw new AggregateError(errors, "Authority fixture cleanup failed");
  }
  return { initialize, close, current, rights, create, oauth, privateInput, rows, accounts, authorization, workspace, vault, crashableRefresh,
    get provider() { return provider; }, get capabilities() { return capabilities; }, get a() { return a; }, get peer() { return peer; }, get foreign() { return foreign; },
    sync: async (id: string, who = a) => capabilities.sync(await current(who), id, SyncMarketplaceCapabilitiesInputSchema.parse({})),
    gateEntered: <T>(gate: ReturnType<typeof provider.arm>, pending: Promise<T>) => authorityBounded(Promise.race([gate.entered.promise,
      pending.then(() => { throw new Error("Authority operation settled before provider gate"); }, () => { throw new Error("Authority operation rejected before provider gate"); })]), "authority_provider_gate_missing"),
  };
}
async function refreshChild() {
  const { nonce, url } = requireMarketplaceAuthorityEnvironment();
  if (!process.send || !process.connected) throw new Error("Authority refresh child requires IPC");
  const input = await new Promise<Record<string, unknown>>(done => { process.once("message", raw => done(raw as Record<string, unknown>));
    process.send!({ type: "marketplace.authority.refresh.ready", nonce }); });
  if (input.nonce !== nonce || typeof input.accountId !== "string" || typeof input.providerOrigin !== "string") throw new Error("Authority refresh IPC mismatch");
  const origin = new URL(input.providerOrigin); if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/") throw new Error("Authority provider must be owned loopback");
  const context = TenantContextSchema.parse(input.context), database = connectDatabase(url), vault = createMarketplaceSecretVault(), audit = new AuditService(database);
  const request: typeof fetch = (raw, init) => { const target = new URL(raw instanceof Request ? raw.url : String(raw));
    if (!["https://api.amazon.com", "https://api.etsy.com", "https://openapi.etsy.com"].includes(target.origin)) throw new Error("Authority refresh refuses foreign provider");
    return fetch(origin.origin + target.pathname + target.search, { ...init, redirect: "error" }); };
  const restoreEnvironment = installMarketplaceAuthoritySyntheticEnvironment();
  try { const authorization = new MarketplaceAuthorizationService(database, vault, new HttpMarketplaceAuthorizationGateway(), audit);
    await new MarketplaceCapabilityService(database, vault, new HttpMarketplaceCapabilityGateway(request), authorization, audit)
      .sync(context, input.accountId, SyncMarketplaceCapabilitiesInputSchema.parse({}));
  } finally { restoreEnvironment(); await database.client.end(); }
}
if (process.argv.includes("--marketplace-authority-refresh-child")) void refreshChild().then(() => {
  if (process.connected) process.disconnect(); process.exitCode = 0;
}, () => { if (process.connected) process.disconnect(); process.exitCode = 1; });

/** Browser-only bridge: original AppModule/OIDC/owners, synthetic upstream HTTP only. */
async function browserAuthorityApi() {
  const { nonce, url } = requireMarketplaceAuthorityEnvironment(process.env, "current", true);
  if (process.env.PORT !== "8130") throw new Error("Authority browser API requires its original port");
  const actor = z.object({ tenantId: z.uuidv7(), userId: z.uuidv7(), membershipId: z.uuidv7(), roleId: z.uuidv7() }).passthrough()
    .parse((JSON.parse(process.env.ERP_FIXTURE_ACTORS!) as Record<string, unknown>).operator);
  const ceiling: TenantContext = { tenantId: actor.tenantId, userId: actor.userId, permissions: [...marketplaceAuthorityPermissions], dataScope: "tenant" };
  const database = connectDatabase(url), vault = createMarketplaceSecretVault(), audit = new AuditService(database);
  const accounts = new MarketplaceAccountService(database, audit), authorization = new MarketplaceAuthorizationService(database, vault, new HttpMarketplaceAuthorizationGateway(), audit);
  let provider: Awaited<ReturnType<typeof startMarketplaceAuthorityProvider>>;
  try { provider = await startMarketplaceAuthorityProvider(); }
  catch (error) { try { await database.client.end(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Authority bridge provider initialization failed"); } throw error; }
  const restoreFetch = provider.installAuthorizationTransport(), restoreEnvironment = installMarketplaceAuthoritySyntheticEnvironment();
  const current = () => withTenant(database.db, ceiling, async tx => TenantContextSchema.parse(await loadCurrentMembershipContext(tx, { tenantId: actor.tenantId, userId: actor.userId })));
  const owned = new Set<string>(), key = randomBytes(32).toString("base64url"), groups = new Map<string, string[]>();
  const file = resolve(root, "tmp/marketplace-authority-20261022-d8b7a3c6/qa", "provider-" + nonce + ".json");
  let gate: ReturnType<typeof provider.arm> | undefined, closing: Promise<void> | undefined;
  let originalRole: typeof roles.$inferSelect | undefined;
  try {
    [originalRole] = await withTenant(database.db, ceiling, tx => tx.select().from(roles).where(eq(roles.id, actor.roleId)));
    if (!originalRole) throw new Error("Authority browser actual operator role missing");
  } catch (error) {
    const cleanup: unknown[] = [];
    try { await provider.close(); } catch (failure) { cleanup.push(failure); } restoreFetch(); restoreEnvironment();
    try { await database.client.end(); } catch (failure) { cleanup.push(failure); }
    if (cleanup.length) throw new AggregateError([error, ...cleanup], "Authority bridge membership initialization failed"); throw error;
  }
  async function restoreRole() { await withTenant(database.db, ceiling, tx => tx.update(roles).set({ permissions: [...originalRole!.permissions], dataScope: originalRole!.dataScope }).where(eq(roles.id, actor.roleId))); }
  const Id = z.uuidv7();
  const Input = z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("seed"), platforms: z.array(z.enum(["amazon", "etsy"])).min(1).max(3) }).strict(),
    z.object({ operation: z.literal("oauth"), accountId: Id, authorizationUrl: z.string().min(1).max(16384) }).strict(),
    z.object({ operation: z.literal("snapshot"), groupId: Id }).strict(),
    z.object({ operation: z.literal("cleanup"), groupId: Id }).strict(),
    z.object({ operation: z.literal("hold"), kind: z.enum(["oauth", "private", "refresh", "read"]) }).strict(),
    z.object({ operation: z.literal("entered") }).strict(), z.object({ operation: z.literal("release") }).strict(),
    z.object({ operation: z.literal("rights"), mode: z.enum(["no_read", "restore"]) }).strict(),
    z.object({ operation: z.literal("controls"), rotate: z.boolean(), loseRefresh: z.boolean() }).strict(),
  ]);
  const control = createServer(async (request, response) => {
    try {
      const supplied = request.headers["x-fixture-control"];
      if (request.method !== "POST" || request.url !== "/" || typeof supplied !== "string" || supplied.length !== key.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(key))) { response.writeHead(404); response.end(); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 32768) throw new Error("authority_control_too_large"); chunks.push(Buffer.from(chunk)); }
      const input = Input.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); let output: unknown;
      if (input.operation === "seed") {
        const groupId = createEntityId(), ids: string[] = []; groups.set(groupId, ids);
        const context = await current();
        for (const platform of input.platforms) { const row = await accounts.create(context, CreateMarketplaceAccountInputSchema.parse({ platform,
          displayName: "Synthetic-browser-authority-" + createEntityId(), region: platform === "amazon" ? "NA" : "GLOBAL",
          marketplaceIds: platform === "amazon" ? ["ATVPDKIKX0DER"] : ["etsy"], authorizationMode: platform === "amazon" ? "amazon_private" : "etsy_oauth",
          requestedScopes: platform === "amazon" ? ["product-listing"] : ["listings_r", "listings_w", "shops_r"] })); ids.push(row.id); owned.add(row.id); }
        output = { groupId, ids, actorId: actor.userId, tenantId: actor.tenantId };
      } else if (input.operation === "oauth") {
        if (!owned.has(input.accountId)) throw new Error("authority_control_foreign_account");
        await accounts.get(await current(), input.accountId); output = provider.code(input.authorizationUrl);
      } else if (input.operation === "hold") { gate = provider.arm(input.kind); output = { held: true }; }
      else if (input.operation === "entered") { if (!gate) throw new Error("authority_control_gate_missing"); await authorityBounded(gate.entered.promise, "authority_browser_gate_timeout"); output = { entered: true }; }
      else if (input.operation === "release") { gate?.release.resolve(); output = { released: true }; }
      else if (input.operation === "controls") { provider.controls.rotate = input.rotate; provider.controls.loseRefresh = input.loseRefresh; output = { updated: true }; }
      else if (input.operation === "rights") {
        if (input.mode === "restore") await restoreRole(); else await withTenant(database.db, ceiling, tx => tx.update(roles).set({
          permissions: originalRole!.permissions.filter(value => value !== Permission.StoreRead),
        }).where(eq(roles.id, actor.roleId)));
        output = { updated: true };
      } else {
        const ids = groups.get(input.groupId); if (!ids) throw new Error("authority_control_group_missing");
        if (input.operation === "cleanup") {
          gate?.release.resolve(); await restoreRole();
          for (const id of ids) await authorization.revoke(await current(), id);
          groups.delete(input.groupId); output = { cleaned: true, ids };
        } else output = await withTenant(database.db, ceiling, async tx => {
          const accountRows = await tx.select().from(marketplaceAccounts), credentialRows = await tx.select().from(marketplaceCredentials), caps = await tx.select().from(marketplaceCapabilitySnapshots);
          const [business] = await tx.execute<{ paid: number; publications: number; listingSyncs: number }>(sql`select
            (select count(*)::int from ai_budget_ledger) as paid,
            (select count(*)::int from marketplace_publication_requests) as publications,
            (select count(*)::int from marketplace_listing_sync_requests) as "listingSyncs"`);
          return { ids, counts: { ...provider.counts }, business, accounts: accountRows.filter(row => ids.includes(row.id)).map(row => ({ id: row.id, status: row.status,
            generation: row.authorizationGeneration, refreshState: row.credentialRefreshState, useId: row.credentialUseId,
            credentialVersion: credentialRows.find(credential => credential.accountId === row.id)?.version ?? null,
            credentialHash: credentialRows.find(credential => credential.accountId === row.id)?.encryptedEnvelope
              ? createHash("sha256").update(credentialRows.find(credential => credential.accountId === row.id)!.encryptedEnvelope).digest("hex") : null,
            snapshots: caps.filter(snapshot => snapshot.accountId === row.id).length })) };
        });
      }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(output));
    } catch { response.writeHead(400, { "content-type": "application/json" }); response.end('{"code":"authority_control_failed"}'); }
  });
  const close = () => closing ??= (async () => {
    const errors: unknown[] = []; gate?.release.resolve();
    try { await restoreRole(); for (const id of owned) await authorization.revoke(await current(), id); } catch (error) { errors.push(error); }
    try { control.closeAllConnections(); await new Promise<void>((done, reject) => control.close(error => error ? reject(error) : done())); } catch (error) { errors.push(error); }
    try { await provider.close(); } catch (error) { errors.push(error); }
    restoreFetch(); restoreEnvironment(); try { await database.client.end(); } catch (error) { errors.push(error); }
    try { await unlink(file); } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Authority browser bridge cleanup failed");
  })();
  try {
    await new Promise<void>((done, reject) => { control.once("error", reject); control.listen(0, "127.0.0.1", done); });
    const address = control.address(); if (!address || typeof address === "string") throw new Error("Authority control address missing");
    await mkdir(resolve(root, "tmp/marketplace-authority-20261022-d8b7a3c6/qa"), { recursive: true });
    await writeFile(file, JSON.stringify({ nonce, pid: process.pid, origin: `http://127.0.0.1:${address.port}`, key }), { mode: 0o600 });
    const shutdown = () => { void close().catch(() => { process.exitCode = 1; }); };
    process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
    await import("../main.js");
  } catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Authority browser bootstrap failed"); } throw error; }
}
if (process.argv.includes("--marketplace-authority-api")) void browserAuthorityApi().catch(() => { process.exitCode = 1; });
