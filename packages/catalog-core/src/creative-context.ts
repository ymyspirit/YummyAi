import { authorize, intersectPermissionContexts, type PermissionValue } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { loadCurrentMembershipContext, type TenantTransaction } from "@yummyai/database";
import { sql } from "drizzle-orm";

export async function currentCreativeAuthority(
  tx: TenantTransaction,
  context: TenantContext,
  required: readonly PermissionValue[],
) {
  for (const permission of required) authorize(context, permission);
  // Non-membership adapters retain their explicit server-provided ceiling.
  const current = context.permissionScopes === undefined
    ? context
    : await loadCurrentMembershipContext(tx, context, { lock: true });
  // Preserve an explicit adapter's origin: normalizing it into membership scopes
  // would make a downstream owner incorrectly reload a membership it never had.
  const authority = context.permissionScopes === undefined ? context : intersectPermissionContexts(context, current);
  for (const permission of required) authorize(authority, permission);
  const [clock] = await tx.execute<{ now: string }>(sql`select extract(epoch from clock_timestamp()) * 1000 as now`);
  const checkedAt = Number(clock?.now);
  if (!Number.isFinite(checkedAt)) throw new Error("Design authority clock is unavailable");
  return { authority, checkedAt };
}
