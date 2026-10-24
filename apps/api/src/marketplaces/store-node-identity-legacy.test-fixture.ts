import "reflect-metadata";
import { resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { requireStoreNodeIdentityEnvironment } from "../../../../tools/testing/require-store-node-identity-environment.mjs";
import { authorityBounded, startMarketplaceAuthorityProvider, installMarketplaceAuthoritySyntheticEnvironment } from "../../../../tools/testing/marketplace-authority-legacy-upgrade.mjs";
import { assertStoreNodeOriginal178Graph } from "./store-node-identity-graph.test-fixture.js";
import type * as Database from "@yummyai/database";
import type * as Contracts from "@yummyai/contracts";
import type * as Accounts from "./marketplace-account.service.js";
import type * as Authorization from "./marketplace-authorization.service.js";
import type * as Capabilities from "./marketplace-capability.service.js";
import type * as Audits from "../audit/audit.service.js";
import type * as Connectors from "@yummyai/marketplace-connectors";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
async function send(value: object) { await new Promise<void>((done, reject) => process.send?.(value, error => error ? reject(new Error("store_node_original178_ipc_failed")) : done())); }
async function original178() {
  let phase = "original178_guard", close: (() => Promise<void>) | undefined;
  try {
    const isolated = requireStoreNodeIdentityEnvironment(process.env, "pre-0179"), source = process.env.E2E_STORE_NODE_LEGACY_SOURCE!;
    phase = "original178_graph"; await assertStoreNodeOriginal178Graph(source);
    const load = (path: string) => import(pathToFileURL(resolve(source, path)).href);
    const [d, c, a, auth, caps, audits, connectors] = await Promise.all([
      load("packages/database/src/index.ts") as Promise<typeof Database>,
      load("packages/contracts/src/index.ts") as Promise<typeof Contracts>,
      load("apps/api/src/marketplaces/marketplace-account.service.ts") as Promise<typeof Accounts>,
      load("apps/api/src/marketplaces/marketplace-authorization.service.ts") as Promise<typeof Authorization>,
      load("apps/api/src/marketplaces/marketplace-capability.service.ts") as Promise<typeof Capabilities>,
      load("apps/api/src/audit/audit.service.ts") as Promise<typeof Audits>,
      load("packages/marketplace-connectors/src/index.ts") as Promise<typeof Connectors>,
    ]);
    const database = d.connectDatabase(isolated.url), provider = await startMarketplaceAuthorityProvider();
    const restoreFetch = provider.installAuthorizationTransport(), restoreEnvironment = installMarketplaceAuthoritySyntheticEnvironment();
    let closed = false;
    close = async () => { if (closed) return; closed = true; const failures: unknown[] = [];
      try { await provider.close(); } catch (error) { failures.push(error); } restoreFetch(); restoreEnvironment();
      try { await database.client.end(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "store_node_original178_cleanup_failed"); };
    phase = "original178_database";
    const [migration] = await database.client.unsafe("select count(*)::int as count from drizzle.__drizzle_migrations");
    if (migration?.count !== 178) throw new Error("store_node_original178_requires178");
    const tenantId = c.createEntityId(), userId = c.createEntityId(), membershipId = c.createEntityId(), roleId = c.createEntityId();
    const context = c.TenantContextSchema.parse({ tenantId, userId, permissions: ["store:read", "store:manage", "store:authorize"], dataScope: "tenant" });
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic original178 node tenant',$2)", [tenantId, "node-old-" + tenantId]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic original178 node operator')", [userId, "node-old-" + userId, userId + "@example.invalid"]);
    await d.withTenant(database.db, context, async tx => { await tx.insert(d.memberships).values({ id: membershipId, tenantId, userId, status: "active" });
      await tx.insert(d.roles).values({ id: roleId, tenantId, name: "Original178 node authority", permissions: [...context.permissions], dataScope: "tenant" });
      await tx.insert(d.membershipRoles).values({ tenantId, membershipId, roleId }); });
    const audit = new audits.AuditService(database), vault = connectors.createMarketplaceSecretVault();
    const accounts = new a.MarketplaceAccountService(database, audit), authorization = new auth.MarketplaceAuthorizationService(database, vault, new connectors.HttpMarketplaceAuthorizationGateway(), audit);
    const requestKinds: string[] = [];
    const request: typeof provider.request = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if ((init?.method ?? "GET") === "GET") {
        const prefix = "/v3/application", path = url.pathname;
        const kind = /^\/v3\/application\/users\/\d+\/shops$/.test(path) ? "shop"
          : /^\/v3\/application\/shops\/\d+\/sections$/.test(path) ? "sections"
          : /^\/v3\/application\/shops\/\d+\/policies\/return$/.test(path) ? "return_policies"
          : path === prefix + "/seller-taxonomy/nodes" ? "taxonomy"
          : /^\/v3\/application\/shops\/\d+\/shipping-profiles$/.test(path) ? "shipping_profiles"
          : /^\/v3\/application\/shops\/\d+\/readiness-state-definitions$/.test(path) && url.search === "?limit=100" ? "readiness_profiles" : "unexpected";
        requestKinds.push(kind);
      }
      return provider.request(input, init);
    };
    const capabilities = new caps.MarketplaceCapabilityService(database, vault, new connectors.HttpMarketplaceCapabilityGateway(request), authorization, audit);
    const create = () => accounts.create(context, c.CreateMarketplaceAccountInputSchema.parse({ platform: "etsy", displayName: "Synthetic-original178-" + c.createEntityId(), region: "GLOBAL",
      marketplaceIds: ["etsy"], authorizationMode: "etsy_oauth", requestedScopes: ["listings_r", "shops_r"] }));
    phase = "original178_owner_seed";
    const active = await create(), started = await authorization.startOAuth(context, active.id);
    await authorization.completeOAuth(context, active.id, provider.code(started.authorizationUrl));
    await capabilities.sync(context, active.id, c.SyncMarketplaceCapabilitiesInputSchema.parse({}));
    if ((await accounts.get(context, active.id)).status !== "active") throw new Error("store_node_original178_not_active");
    const pending = await create(), pendingStart = await authorization.startOAuth(context, pending.id), pendingInput = provider.code(pendingStart.authorizationUrl);
    const rows = await d.withTenant(database.db, context, async tx => ({ accounts: await tx.select().from(d.marketplaceAccounts), credentials: await tx.select().from(d.marketplaceCredentials),
      sessions: await tx.select().from(d.marketplaceAuthorizationSessions), capabilities: await tx.select().from(d.marketplaceCapabilitySnapshots) }));
    await send({ type: "store.node.seeded178", nonce: isolated.nonce, context, activeId: active.id, pendingId: pending.id, rows: JSON.parse(JSON.stringify(rows)),
      latest: await capabilities.latest(context, active.id), counts: { ...provider.counts } });
    phase = "original178_wait_current";
    await authorityBounded(new Promise<void>((done, reject) => { process.on("message", raw => {
      if (!raw || typeof raw !== "object" || !("nonce" in raw) || raw.nonce !== isolated.nonce || !("type" in raw)) return;
      if (raw.type === "store.node.check178") void (async () => {
        try { phase = "original178_post179_owner";
          const beforeOwnerReads = { ...provider.counts }, requestStart = requestKinds.length;
          const current = await accounts.get(context, active.id), latest = await capabilities.latest(context, active.id), afterOwnerReads = { ...provider.counts };
          await authorization.completeOAuth(context, pending.id, pendingInput);
          const afterOAuth = { ...provider.counts };
          await capabilities.sync(context, pending.id, c.SyncMarketplaceCapabilitiesInputSchema.parse({}));
          await send({ type: "store.node.checked178", nonce: isolated.nonce, activeId: current.id, status: current.status, latest,
            pendingStatus: (await accounts.get(context, pending.id)).status, counts: { ...provider.counts },
            stages: { beforeOwnerReads, afterOwnerReads, afterOAuth, afterSync: { ...provider.counts } }, requestKinds: requestKinds.slice(requestStart) }); done();
        } catch (error) { reject(error); }
      })();
    }); }), "store_node_original178_wait_timeout", 120_000);
    await close(); process.exitCode = 0;
  } catch (error) {
    let code: string | null = null, location: { file: string; line: number } | null = null;
    if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code)) code = error.code;
    if (error instanceof Error) {
      const match = /(?:file:\/\/\/)?([A-Za-z]:[\\/][^\r\n()]+\.(?:m?ts|js)):(\d+):\d+/.exec(error.stack ?? "");
      if (match) { const path = relative(root, match[1]!).replaceAll("\\", "/"); if (!path.startsWith("..") && /^[A-Za-z0-9_./-]+$/.test(path)) location = { file: path, line: Number(match[2]) }; }
    }
    await send({ type: "store.node.failed178", phase, code, errorName: error instanceof Error ? error.name.replace(/[^A-Za-z]/g, "").slice(0, 40) : "Unknown", location }).catch(() => {});
    await close?.().catch(() => {}); process.exitCode = 1;
  } finally { process.disconnect?.(); }
}
if (process.argv.includes("--store-node-original178-child")) await original178();
export const original178SeedDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
