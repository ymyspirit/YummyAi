import type { TenantContext } from "@yummyai/contracts";
import type { TenantTransaction } from "@yummyai/database";
import { sql } from "drizzle-orm";

/** All Studio writers and complete-document readers use this before row locks. */
export async function lockStudioScopes(tx: TenantTransaction, context: TenantContext, scopes: readonly string[]) {
  for (const scope of [...new Set(scopes)].sort())
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`studio-scope:${context.tenantId}:${context.userId}:${scope}`}, 0))`);
}
