import type { TenantContext } from "@yummyai/contracts";

import { Permission } from "@yummyai/authz/permissions";

export interface AuthorizedResource {
  ownerId?: string | null;
  teamId?: string | null;
}

export class ForbiddenError extends Error {
  readonly code = "FORBIDDEN";
  readonly status = 403;
  // Nest's default unknown-error bridge recognizes the standard http-errors shape.
  readonly statusCode = 403;

  constructor(
    readonly permission: Permission,
    readonly reason: "missing_permission" | "outside_data_scope" = "missing_permission",
  ) {
    super(`Permission denied: ${permission}`);
    this.name = "ForbiddenError";
  }
}

export function authorize(
  context: TenantContext,
  permission: Permission,
  resource?: AuthorizedResource,
): void {
  if (!context.permissions.includes(permission)) {
    throw new ForbiddenError(permission);
  }

  const scope = permissionScope(context, permission);
  if (!resource || scope === "tenant") return;

  if (resource.ownerId === context.userId) return;
  if (scope === "self") {
    throw new ForbiddenError(permission, "outside_data_scope");
  }

  const teams = context.teamIds ?? (context.teamId ? [context.teamId] : []);
  if (!resource.teamId || !teams.includes(resource.teamId)) {
    throw new ForbiddenError(permission, "outside_data_scope");
  }
}

export function permissionScope(
  context: TenantContext,
  permission: Permission,
): TenantContext["dataScope"] {
  if (context.permissionScopes === undefined) return context.dataScope;
  const scope = context.permissionScopes[permission];
  if (!scope) throw new ForbiddenError(permission);
  return scope;
}

/** Pass an operation-specific context to repositories that filter by dataScope. */
export function permissionContext(context: TenantContext, permission: Permission): TenantContext {
  authorize(context, permission);
  return { ...context, dataScope: permissionScope(context, permission) };
}

/** Orders have no trusted owner/team binding; assignment alone does not grant access. */
export function requireTenantOrderPermissions(context: TenantContext, required: readonly Permission[]) {
  for (const permission of required) {
    authorize(context, permission);
    if (permission.startsWith("order:") && permissionScope(context, permission) !== "tenant")
      throw new ForbiddenError(permission, "outside_data_scope");
  }
}

/** Pure asset policy shared by API and execution adapters. */
export function requireAssetAuthority(context: TenantContext, permission: Permission,
  asset: { ownerUserId: string | null; assetDomain: string }) {
  authorize(context, permission, { ownerId: asset.ownerUserId });
  if (asset.assetDomain === "order") requireTenantOrderPermissions(context, [Permission.OrderRead, Permission.OrderPiiRead]);
}
