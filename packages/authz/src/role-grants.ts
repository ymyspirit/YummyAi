import type { TenantContext } from "@yummyai/contracts";

type DataScope = TenantContext["dataScope"];
const ranks: Record<DataScope, number> = { self: 0, team: 1, tenant: 2 };

/** Union roles per operation, never borrow another operation's broader scope. */
export function summarizeRoleGrants(
  grants: readonly {
    permissions: readonly string[];
    scope: string;
  }[],
): Pick<TenantContext, "permissions" | "dataScope"> & {
  permissionScopes: Record<string, DataScope>;
} {
  const scopes = new Map<string, DataScope>();
  for (const grant of grants) {
    if (grant.scope !== "self" && grant.scope !== "team" && grant.scope !== "tenant") continue;
    for (const permission of grant.permissions) {
      const previous = scopes.get(permission);
      if (!previous || ranks[grant.scope] > ranks[previous]) scopes.set(permission, grant.scope);
    }
  }
  const permissions = [...scopes.keys()].sort();
  return {
    permissions,
    permissionScopes: Object.fromEntries(permissions.map((p) => [p, scopes.get(p)!])),
    dataScope: [...scopes.values()].reduce<DataScope>(
      (scope, next) => (ranks[next] > ranks[scope] ? next : scope),
      "self",
    ),
  };
}

/** Retain both the request ceiling and current grants for the same actor. */
export function intersectPermissionContexts(
  input: TenantContext,
  current: TenantContext,
): TenantContext {
  if (input.tenantId !== current.tenantId || input.userId !== current.userId)
    throw new Error("Permission contexts have different identities");
  const grants = current.permissions.flatMap((permission) => {
    if (!input.permissions.includes(permission)) return [];
    const before =
      input.permissionScopes === undefined ? input.dataScope : input.permissionScopes[permission];
    const now =
      current.permissionScopes === undefined
        ? current.dataScope
        : current.permissionScopes[permission];
    if (!before || !now) return [];
    return [{ permissions: [permission], scope: ranks[before] < ranks[now] ? before : now }];
  });
  const teams = (context: TenantContext) =>
    context.teamIds ?? (context.teamId ? [context.teamId] : []);
  const currentTeams = new Set(teams(current));
  return {
    ...current,
    ...summarizeRoleGrants(grants),
    teamId: undefined,
    teamIds: teams(input).filter((id) => currentTeams.has(id)),
  };
}
