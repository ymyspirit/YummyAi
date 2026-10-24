import { createHash } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { authorize, erpPermissionContext, ForbiddenError, intersectPermissionContexts, permissionScope, Permission } from "@yummyai/authz";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import {
  IntegrationApiDelegationSchema, IntegrationApiScopeSchema, IntegrationClientAdmissionSchema,
  integrationApiClientRequestCanonical,
  type CreateIntegrationApiClientInput, type IntegrationApiDelegation, type IntegrationClientAdmission,
} from "@yummyai/contracts/integration";
import type { TenantContext } from "@yummyai/contracts/tenant/tenant-context";
import { loadCurrentMembershipContext, memberships, type TenantTransaction } from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";

const scopeRank = { self: 0, team: 1, tenant: 2 } as const;
type ClientPermission = typeof Permission.IntegrationRead | typeof Permission.IntegrationManage;

export async function currentIntegrationClientAuthority(tx: TenantTransaction, ceiling: TenantContext, permission: ClientPermission) {
  const [membership] = await tx.select({ id: memberships.id }).from(memberships)
    .where(and(eq(memberships.tenantId, ceiling.tenantId), eq(memberships.userId, ceiling.userId), eq(memberships.status, "active")))
    .limit(1).for("share");
  if (!membership) throw new ForbiddenError(permission);
  const current = intersectPermissionContexts(ceiling, await loadCurrentMembershipContext(tx, ceiling, { lock: true }));
  authorize(current, permission);
  return { current, membershipId: membership.id };
}

export async function integrationClientNow(tx: TenantTransaction) {
  const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
  if (!clock || !Number.isFinite(Date.parse(clock.now))) throw new Error("integration_client_clock_unavailable");
  return new Date(clock.now);
}

export function integrationClientContextAuthority(current: TenantContext) {
  return erpSessionAuthority(erpPermissionContext(current));
}

export function integrationClientAccessible(current: TenantContext, permission: ClientPermission, ownerId: string) {
  authorize(current, permission);
  // Keys have no trusted owning-team binding. Team grants retain only own keys.
  return ownerId === current.userId || permissionScope(current, permission) === "tenant";
}

export function integrationClientAdmission(current: TenantContext): IntegrationClientAdmission {
  return IntegrationClientAdmissionSchema.parse({
    scopes: IntegrationApiScopeSchema.options.flatMap(scope => current.permissions.includes(scope)
      ? [{ scope, maximumScope: permissionScope(current, scope) }] : []),
    teamIds: [...new Set(current.teamIds ?? (current.teamId ? [current.teamId] : []))].sort(),
    canManage: current.permissions.includes(Permission.IntegrationManage),
  });
}

export function integrationClientRequestChecksum(input: CreateIntegrationApiClientInput) {
  return createHash("sha256").update(integrationApiClientRequestCanonical(input)).digest("hex");
}

export function pinIntegrationApiDelegation(current: TenantContext, membershipId: string,
  input: CreateIntegrationApiClientInput, capturedAt: Date): IntegrationApiDelegation {
  const permissionScopes: IntegrationApiDelegation["permissionScopes"] = {};
  for (const scope of input.scopes) {
    if (!current.permissions.includes(scope)) throw new ConflictException("integration_client_scope_exceeded");
    const maximum = permissionScope(current, scope), selected = input.scopeLimits?.[scope] ?? maximum;
    if (scopeRank[selected] > scopeRank[maximum]) throw new ConflictException("integration_client_scope_exceeded");
    permissionScopes[scope] = selected;
  }
  const availableTeams = new Set(current.teamIds ?? (current.teamId ? [current.teamId] : []));
  const teamIds = input.teamIds ?? [...availableTeams];
  if (teamIds.some(id => !availableTeams.has(id))) throw new ConflictException("integration_client_team_exceeded");
  return IntegrationApiDelegationSchema.parse({
    version: "integration-api-delegation-v1", membershipId, permissionScopes,
    teamIds: [...teamIds].sort(), capturedAt: capturedAt.toISOString(), requestChecksum: integrationClientRequestChecksum(input),
  });
}
