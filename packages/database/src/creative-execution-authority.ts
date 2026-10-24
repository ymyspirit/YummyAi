import { createHash } from "node:crypto";
import { authorize, ForbiddenError, intersectPermissionContexts, type PermissionValue } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { CreativeExecutionAuthoritySchema, type CreativeExecutionAuthority } from "@yummyai/contracts/harness";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { loadCurrentMembershipContext } from "./membership-access.js";
import type { TenantTransaction } from "./tenant-transaction.js";

export function creativeExecutionChecksum(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Invoke in the same owning transaction after its resource policy checks. */
export async function captureCreativeExecutionAuthority(tx: TenantTransaction, input: TenantContext, required: readonly PermissionValue[]) {
  for (const permission of required) authorize(input, permission);
  const current = input.permissionScopes === undefined ? input : await loadCurrentMembershipContext(tx, input, { lock: true });
  const context = intersectPermissionContexts(input, current);
  for (const permission of required) authorize(context, permission);
  const snapshot = CreativeExecutionAuthoritySchema.parse({ version: "creative-authority-v1",
    mode: input.permissionScopes === undefined ? "server_adapter" : "membership", context });
  return { snapshot, checksum: creativeExecutionChecksum(snapshot), authority: context };
}

/** A queued envelope never supplies or upgrades the original permission ceiling. */
export async function currentCreativeExecutionAuthority(tx: TenantTransaction,
  identity: Pick<TenantContext, "tenantId" | "userId">,
  original: { tenantId: string; requestedBy: string; authoritySnapshot: CreativeExecutionAuthority; authorityChecksum: string },
  required: readonly PermissionValue[]) {
  const parsed = CreativeExecutionAuthoritySchema.safeParse(original.authoritySnapshot);
  if (!parsed.success || original.tenantId !== identity.tenantId || original.requestedBy !== identity.userId ||
    parsed.data.context.tenantId !== identity.tenantId || parsed.data.context.userId !== identity.userId ||
    creativeExecutionChecksum(parsed.data) !== original.authorityChecksum)
    throw new ForbiddenError(required[0] ?? "design:read");
  // Legacy/server adapter ceilings are not permission to invent current membership.
  const current = await loadCurrentMembershipContext(tx, identity, { lock: true });
  const authority = intersectPermissionContexts(parsed.data.context, current);
  for (const permission of required) authorize(authority, permission);
  return authority;
}
