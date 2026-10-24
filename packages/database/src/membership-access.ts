import type { TenantContext } from "@yummyai/contracts";
import { summarizeRoleGrants } from "@yummyai/authz";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  memberships,
  membershipRoles,
  roles,
  organizationTeams,
  organizationTeamMembers,
} from "./schema/identity.js";
import type { TenantTransaction } from "./tenant-transaction.js";

// Call inside withTenant(); this loads grants, it does not grant an operation.
export async function loadCurrentMembershipContext(
  tx: TenantTransaction,
  base: Pick<TenantContext, "tenantId" | "userId">,
  options: { lock?: boolean } = {},
): Promise<TenantContext> {
  const query = tx
    .select({ permissions: roles.permissions, scope: roles.dataScope })
    .from(memberships)
    .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
    .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
    .where(and(eq(memberships.userId, base.userId), eq(memberships.status, "active")));
  const grants = await (options.lock ? query.for("share") : query);
  const teamQuery = tx
    .select({
      id: organizationTeamMembers.id,
      teamId: organizationTeams.id,
      revision: organizationTeamMembers.revision,
      teamRevision: organizationTeams.accessGeneration,
    })
    .from(organizationTeamMembers)
    .innerJoin(organizationTeams, eq(organizationTeams.id, organizationTeamMembers.teamId))
    .innerJoin(memberships, eq(memberships.id, organizationTeamMembers.membershipId))
    .where(
      and(
        eq(memberships.userId, base.userId),
        eq(memberships.status, "active"),
        eq(organizationTeamMembers.active, true),
        eq(organizationTeams.status, "active"),
      ),
    );
  const teams = (await (options.lock ? teamQuery.for("share") : teamQuery)).sort((a, b) =>
    a.teamId.localeCompare(b.teamId),
  );
  return {
    ...base,
    ...summarizeRoleGrants(grants),
    teamIds: teams.map((t) => t.teamId),
    teamAuthority: createHash("sha256").update(JSON.stringify(teams)).digest("hex"),
  };
}
