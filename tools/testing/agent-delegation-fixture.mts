import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { SecretVault } from "../../packages/ai-core/src/secrets.js";
import { Permission } from "../../packages/authz/src/index.js";
import { createEntityId } from "../../packages/contracts/src/common/ids.js";
import type { TenantContext } from "../../packages/contracts/src/tenant/tenant-context.js";
import { CreateIntegrationApiClientInputSchema } from "../../packages/contracts/src/integration/integration.js";
import {
  integrationApiClients, loadCurrentMembershipContext, memberships, membershipRoles,
  organizationTeamMembers, organizationTeams, roles, withTenant, type DatabaseConnection,
} from "../../packages/database/src/index.js";
import type * as Drizzle from "../../packages/database/node_modules/drizzle-orm/index.js";
import { AuditService } from "../../apps/api/src/audit/audit.service.js";
import { DatabaseApiClientContextLoader } from "../../apps/api/src/auth/tenant-context.guard.js";
import { IntegrationService } from "../../apps/api/src/integrations/integration.service.js";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

const { eq, sql } = createRequire(new URL("../../packages/database/package.json", import.meta.url))("drizzle-orm") as typeof Drizzle;
export type DelegationScope = TenantContext["dataScope"];
export type DelegationActor = { tenantId: string; userId: string; membershipId: string; subject: string;
  roleIds: Map<string, string>; context: TenantContext };
export const agentDelegationSha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export function requireAgentDelegationEnvironment(target: "current" | "pre-0171", environment: NodeJS.ProcessEnv = process.env) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment));
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (!nonce || environment.E2E_AGENT_DELEGATION_ISOLATED !== "1" || environment.E2E_LEGACY_SCHEMA_TARGET !== target ||
      environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Agent delegation requires its exact isolated schema, nonce database and private bucket before connecting");
  return { nonce, databaseName: url.pathname.slice(1) };
}

/** Identity rows are explicit synthetic admission. Every credential, authentication,
 * event and audit under test uses its real owner and the application RLS role.
 * This suite owns no marketplace, model, object upload or ordinary runtime. */
export function agentDelegationFixture(database: DatabaseConnection) {
  requireAgentDelegationEnvironment("current");
  const vault = new SecretVault(Buffer.alloc(32, 39)), audit = new AuditService(database);
  let enqueued = 0;
  const enqueue = async () => { enqueued++; };
  const service = new IntegrationService(database, vault, { enqueue }, audit);
  const loader = new DatabaseApiClientContextLoader(database);
  const defaults = Object.fromEntries(Object.values(Permission).map(permission => [permission, "tenant" as const]));

  async function current(actor: Pick<DelegationActor, "tenantId" | "userId">) {
    return withTenant(database.db, { ...actor, permissions: [], dataScope: "self" }, tx => loadCurrentMembershipContext(tx, actor));
  }
  async function setScopes(actor: DelegationActor, permissionScopes: Record<string, DelegationScope>) {
    await withTenant(database.db, actor.context, async tx => {
      for (const [permission, roleId] of actor.roleIds) if (!Object.hasOwn(permissionScopes, permission))
        await tx.update(roles).set({ permissions: [] }).where(eq(roles.id, roleId));
      for (const [permission, dataScope] of Object.entries(permissionScopes)) {
        const id = actor.roleIds.get(permission);
        if (id) await tx.update(roles).set({ permissions: [permission], dataScope }).where(eq(roles.id, id));
        else {
          const roleId = createEntityId(); actor.roleIds.set(permission, roleId);
          await tx.insert(roles).values({ id: roleId, tenantId: actor.tenantId, name: `Synthetic delegation ${roleId}`, permissions: [permission], dataScope });
          await tx.insert(membershipRoles).values({ tenantId: actor.tenantId, membershipId: actor.membershipId, roleId });
        }
      }
    });
    return current(actor);
  }
  async function actor(permissionScopes: Record<string, DelegationScope> = defaults, tenantId?: string): Promise<DelegationActor> {
    const ownTenant = tenantId ?? createEntityId(), userId = createEntityId(), membershipId = createEntityId(), subject = randomUUID();
    if (!tenantId) await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic agent delegation',$2)", [ownTenant, randomUUID()]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic delegation member')",
      [userId, subject, `${userId}@example.invalid`]);
    const value: DelegationActor = { tenantId: ownTenant, userId, membershipId, subject, roleIds: new Map(),
      context: { tenantId: ownTenant, userId, permissions: Object.keys(defaults), permissionScopes: defaults, dataScope: "tenant", teamIds: [] } };
    await withTenant(database.db, value.context, tx => tx.insert(memberships).values({ id: membershipId, tenantId: ownTenant, userId, status: "active" }));
    value.context = await setScopes(value, permissionScopes);
    return value;
  }
  async function team(actor: DelegationActor) {
    const teamId = createEntityId(), memberId = createEntityId();
    await withTenant(database.db, actor.context, async tx => {
      await tx.insert(organizationTeams).values({ id: teamId, tenantId: actor.tenantId, name: `Synthetic team ${teamId}`, createdBy: actor.userId });
      await tx.insert(organizationTeamMembers).values({ id: memberId, tenantId: actor.tenantId, teamId, membershipId: actor.membershipId, createdBy: actor.userId });
    });
    return { teamId, memberId };
  }
  async function teamActive(actor: DelegationActor, memberId: string, active: boolean) {
    await withTenant(database.db, actor.context, tx => tx.update(organizationTeamMembers)
      .set({ active, revision: sql`${organizationTeamMembers.revision}+1` }).where(eq(organizationTeamMembers.id, memberId)));
  }
  async function memberStatus(actor: DelegationActor, status: "active" | "disabled") {
    await withTenant(database.db, actor.context, tx => tx.update(memberships).set({ status }).where(eq(memberships.id, actor.membershipId)));
  }
  const input = (patch: Partial<ReturnType<typeof CreateIntegrationApiClientInputSchema.parse>> = {}) => CreateIntegrationApiClientInputSchema.parse({
    label: "Synthetic bounded agent reader", scopes: ["inventory:read"], expiresAt: null, idempotencyKey: randomUUID(), ...patch });
  const rebuild = () => new IntegrationService(database, vault, { enqueue }, new AuditService(database));
  async function state(actor: Pick<DelegationActor, "context">) {
    const [value] = await withTenant(database.db, actor.context, tx => tx.execute<{ clients: number; events: number; audits: number; checksum: string }>(sql`select
      (select count(*)::int from integration_api_clients) as clients,
      (select count(*)::int from integration_api_client_events) as events,
      (select count(*)::int from audit_events where action like 'integration.api_client.%') as audits,
      md5((select coalesce(jsonb_agg(to_jsonb(c) order by id)::text,'[]') from integration_api_clients c)) as checksum`));
    return value!;
  }
  async function row(actor: DelegationActor, id: string) {
    return (await withTenant(database.db, actor.context, tx => tx.select().from(integrationApiClients).where(eq(integrationApiClients.id, id))))[0];
  }
  async function now() {
    const [value] = await database.client.unsafe<{ now: string }[]>("select clock_timestamp()::text as now");
    return new Date(value!.now);
  }
  async function waitExpired(expiresAt: string) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const [value] = await database.client.unsafe<{ expired: boolean }[]>("select clock_timestamp()>$1::timestamptz as expired", [expiresAt]);
      if (value?.expired) return;
      // The assertion is the database clock, not a guessed sleep or changed row.
      await new Promise<void>(resolve => setTimeout(resolve, 15));
    }
    throw new Error("Synthetic credential did not reach its actual database expiry");
  }
  return { database, vault, audit, service, loader, defaults, actor, current, setScopes, team, teamActive, memberStatus, input,
    rebuild, state, row, now, waitExpired, enqueued: () => enqueued };
}
