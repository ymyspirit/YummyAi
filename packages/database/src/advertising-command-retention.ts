import { sql } from "drizzle-orm";
import type { DatabaseConnection } from "./client.js";
import { organizations } from "./schema/identity.js";
import { withTenant, type TenantTransaction } from "./tenant-transaction.js";

/** Privacy maintenance does not execute a prepared command or remove actual evidence. */
export async function expireAdvertisingCommandInputs(tx: TenantTransaction,
  options: { actorId?: string; accountId?: string; targetId?: string; commandId?: string; limit?: number } = {}) {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("Invalid advertising retention batch size");
  const rows = await tx.execute<{ id: string }>(sql`with due as (
    select id from advertising_commands where encrypted_input is not null and expires_at<=advertising_command_now()
      ${options.actorId ? sql`and created_by=${options.actorId}::uuid` : sql``}
      ${options.accountId ? sql`and account_id=${options.accountId}::uuid` : sql``}
      ${options.targetId ? sql`and target_id=${options.targetId}::uuid` : sql``}
      ${options.commandId ? sql`and id=${options.commandId}::uuid` : sql``}
    order by expires_at,id limit ${limit} for update skip locked
  ) update advertising_commands c set encrypted_input=null,redacted_at=advertising_command_now(),
    status=case when c.status='prepared' then 'expired' else c.status end,
    completed_at=case when c.status='prepared' then advertising_command_now() else c.completed_at end
  from due where c.id=due.id returning c.id`);
  return rows.length;
}

export class AdvertisingCommandRetentionDispatcher {
  constructor(private readonly database: DatabaseConnection) {}
  async dispatch() {
    const result = { tenants: 0, redacted: 0, failures: 0 };
    const tenants = await this.database.db.select({ id: organizations.id }).from(organizations);
    for (const tenant of tenants) {
      try {
        const redacted = await withTenant(this.database.db, { tenantId: tenant.id,
          userId: "00000000-0000-7000-8000-000000000008", permissions: [], dataScope: "tenant" }, tx => expireAdvertisingCommandInputs(tx));
        result.tenants++;
        result.redacted += redacted;
      } catch { result.failures++; }
    }
    return result;
  }
}
