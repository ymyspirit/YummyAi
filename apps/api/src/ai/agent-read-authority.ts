import { ForbiddenException } from "@nestjs/common";
import { authorize, intersectPermissionContexts, permissionScope, type PermissionValue } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { loadCurrentMembershipContext, type TenantTransaction } from "@yummyai/database";

/** Shared mechanics only; each business owner names its own required bit. */
export async function currentAgentReadAuthority(tx: TenantTransaction, ceiling: TenantContext, permission: PermissionValue) {
  const current = intersectPermissionContexts(ceiling, await loadCurrentMembershipContext(tx, ceiling, { lock: true }));
  authorize(current, permission);
  if (permissionScope(current, permission) !== "tenant")
    throw new ForbiddenException({ code: "agent_read_scope_not_verified", message: "当前读取需要此业务的全组织资料范围" });
  return current;
}
