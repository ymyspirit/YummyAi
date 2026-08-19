import type { TenantContext } from "@yummyai/contracts";

import type { Permission } from "./permissions.js";

export interface AuthorizedResource {
  ownerId?: string;
  teamId?: string;
}

export class ForbiddenError extends Error {
  readonly code = "FORBIDDEN";
  readonly status = 403;

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

  if (context.dataScope === "self" && resource?.ownerId && resource.ownerId !== context.userId) {
    throw new ForbiddenError(permission, "outside_data_scope");
  }

  if (
    context.dataScope === "team" &&
    resource?.teamId &&
    (!context.teamId || resource.teamId !== context.teamId)
  ) {
    throw new ForbiddenError(permission, "outside_data_scope");
  }
}
