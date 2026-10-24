import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "../../packages/database/src/client.js";
import type * as Database from "../../packages/database/src/index.js";
import type * as Core from "../../packages/ai-core/src/index.js";
import type * as Owner from "../../apps/api/src/integrations/integration.service.js";
import type * as Audit from "../../apps/api/src/audit/audit.service.js";
import type * as Auth from "../../apps/api/src/auth/tenant-context.guard.js";
import type { TenantContext } from "../../packages/contracts/src/tenant/tenant-context.js";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

function legacyEnvironment(environment: NodeJS.ProcessEnv, target: "current" | "pre-0171") {
  const url = new URL(requireDisposableIntegrationEnvironment(environment));
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const root = environment.E2E_AGENT_DELEGATION_LEGACY_SOURCE;
  const expected = fileURLToPath(new URL("../../tmp/agent-delegation-20261022-a23e7b91/old170-source", import.meta.url));
  if (!nonce || environment.E2E_AGENT_DELEGATION_ISOLATED !== "1" || environment.E2E_LEGACY_SCHEMA_TARGET !== target ||
      environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !root || !isAbsolute(root) || resolve(root) !== resolve(expected))
    throw new Error("Actual170 delegation requires its pinned source and exact isolated nonce database and private bucket");
  return { root, nonce, databaseName: url.pathname.slice(1) };
}

export async function migrateAgentDelegationLegacyDatabase(database: DatabaseConnection, name: string, environment: NodeJS.ProcessEnv) {
  const value = legacyEnvironment(environment, "pre-0171");
  if (value.databaseName !== name) throw new Error("Actual170 delegation database identity mismatch");
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== name || actual.ledger !== null || actual.populated !== false)
    throw new Error("Actual170 delegation refuses a populated or different database");
  const oldRequire = createRequire(pathToFileURL(resolve(value.root, "packages/database/package.json")));
  const { readMigrationFiles } = oldRequire("drizzle-orm/migrator") as { readMigrationFiles(input: { migrationsFolder: string }): Array<{ folderMillis: number; sql: string[]; hash: string }> };
  const journal = JSON.parse(await readFile(resolve(value.root, "packages/database/migrations/meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  const migrations = readMigrationFiles({ migrationsFolder: resolve(value.root, "packages/database/migrations") });
  if (journal.entries.length !== 170 || !journal.entries.at(-1)?.tag.startsWith("0170_") || migrations.length !== 170)
    throw new Error("Actual frozen170 migration prefix required");
  await database.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle");
    await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) {
      for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]);
    }
  });
}

async function seedActual170() {
  const environment = legacyEnvironment(process.env, "current");
  if (!process.connected || process.env.E2E_AGENT_DELEGATION_LEGACY_CHILD !== "170")
    throw new Error("Actual170 delegation requires its isolated IPC parent before module loading");
  const send = (value: object) => new Promise<void>((done, reject) => process.send!(value, error => error ? reject(error) : done()));
  let phase = "old170-module-load", cleanup = async () => {};
  try {
    const load = (path: string) => import(pathToFileURL(resolve(environment.root, path)).href);
    const oldRequire = createRequire(pathToFileURL(resolve(environment.root, "apps/api/package.json")));
    oldRequire("reflect-metadata");
    const d = await load("packages/database/src/index.ts") as typeof Database;
    const core = await load("packages/ai-core/src/index.ts") as typeof Core;
    const owner = await load("apps/api/src/integrations/integration.service.ts") as typeof Owner;
    const audit = await load("apps/api/src/audit/audit.service.ts") as typeof Audit;
    const auth = await load("apps/api/src/auth/tenant-context.guard.ts") as typeof Auth;
    const database = d.connectDatabase(); cleanup = async () => { await database.client.end(); };
    phase = "old170-real-membership";
    const ledger = await d.readMigrationEvidence(database);
    if (ledger.actualRows.length !== 170) throw new Error("Actual170 ledger required");
    await d.assertDatabaseMigrationsCurrent(database);
    const tenantId = randomUUID(), userId = randomUUID();
    // Application identity IDs require v7; use the frozen implementation rather
    // than altering old constraints or importing the current constructor.
    const ids = await load("packages/contracts/src/common/ids.ts") as { createEntityId(): string };
    const tenant = ids.createEntityId(), user = ids.createEntityId(), member = ids.createEntityId(), role = ids.createEntityId();
    const context: TenantContext = { tenantId: tenant, userId: user, permissions: ["integration:read", "integration:manage", "inventory:read", "finance:read"], dataScope: "tenant" };
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic original170 delegation',$2)", [tenant, tenantId]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic original170 member')", [user, userId, `${user}@example.invalid`]);
    await d.withTenant(database.db, context, async tx => {
      await tx.insert(d.memberships).values({ id: member, tenantId: tenant, userId: user, status: "active" });
      await tx.insert(d.roles).values({ id: role, tenantId: tenant, name: "Synthetic original170 integration role", permissions: context.permissions, dataScope: "tenant" });
      await tx.insert(d.membershipRoles).values({ tenantId: tenant, membershipId: member, roleId: role });
    });
    const current = await d.withTenant(database.db, context, tx => d.loadCurrentMembershipContext(tx, context));
    const service = new owner.IntegrationService(database, new core.SecretVault(Buffer.alloc(32, 39)), { enqueue: async () => {} }, new audit.AuditService(database));
    phase = "old170-real-client-owner";
    const activeInput = { label: "Synthetic original170 active reader", scopes: ["inventory:read" as const, "finance:read" as const], expiresAt: null, idempotencyKey: randomUUID() };
    const active = await service.createApiClient(current, activeInput);
    const retired = await service.createApiClient(current, { ...activeInput, label: "Synthetic original170 revoked reader", idempotencyKey: randomUUID() });
    await service.revokeApiClient(current, retired.client.id, { expectedStatus: "active", reasonCode: "SYNTHETIC_OLD170_REVOCATION", idempotencyKey: randomUUID() });
    if (!active.bearerToken || !(await new auth.DatabaseApiClientContextLoader(database).load(active.bearerToken)))
      throw new Error("Actual170 client owner and original authentication required");
    // The credential travels only through the private IPC channel. Never write it
    // to stdout, an artifact, snapshots or assertion diagnostics.
    await send({ type: "agent.delegation.seeded170", context: current, membershipId: member, roleId: role,
      activeInput, activeClient: active.client, activeToken: active.bearerToken, retiredClientId: retired.client.id });
  } catch (error) {
    const codes: string[] = []; let cause: unknown = error;
    for (let depth = 0; depth < 6 && cause && typeof cause === "object"; depth++) {
      if ("code" in cause && typeof cause.code === "string" && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(cause.code)) codes.push(cause.code);
      cause = "cause" in cause ? cause.cause : null;
    }
    await send({ type: "agent.delegation.failed", phase, codes, errorName: error instanceof Error ? error.name : "Error" });
    throw new Error("Synthetic genuine170 delegation fixture failed");
  } finally { await cleanup(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await seedActual170();
