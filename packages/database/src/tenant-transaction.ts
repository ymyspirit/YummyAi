import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { sql } from "drizzle-orm";

import type { Database } from "./client.js";

type TransactionCallback = Parameters<Database["transaction"]>[0];
export type TenantTransaction = Parameters<TransactionCallback>[0];

export async function withTenant<T>(
  db: Database,
  context: TenantContext,
  callback: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  const validatedContext = TenantContextSchema.parse(context);

  return db.transaction(async (tx) => {
    await tx.execute(sql.raw("set local role yummyai_app"));
    await tx.execute(sql`select set_config('app.tenant_id', ${validatedContext.tenantId}, true)`);
    await tx.execute(sql`select set_config('app.user_id', ${validatedContext.userId}, true)`);
    return callback(tx);
  });
}
