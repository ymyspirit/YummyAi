import { sql } from "drizzle-orm";
import { organizations, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";

/** Tenant-scoped input redaction only. It cannot execute or reverse a material fact. */
export async function expireMaterialCommandInputs(tx: TenantTransaction, options: { actorId?: string; productionOrderId?: string; limit?: number } = {}) {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("Invalid material retention batch size");
  const rows = await tx.execute<{ id: string }>(sql`with due as (
    select id from production_material_commands where encrypted_input is not null and expires_at<=clock_timestamp()
      ${options.actorId ? sql`and created_by=${options.actorId}::uuid` : sql``}
      ${options.productionOrderId ? sql`and production_order_id=${options.productionOrderId}::uuid` : sql``}
    order by expires_at,id limit ${limit} for update skip locked
  ) update production_material_commands c set encrypted_input=null,redacted_at=clock_timestamp(),
    status=case when c.status='prepared' then 'expired' else c.status end,
    completed_at=case when c.status='prepared' then clock_timestamp() else c.completed_at end
  from due where c.id=due.id returning c.id`);
  return rows.length;
}

/** Independent privacy maintenance. No queues, provider calls, or business execution. */
export class MaterialCommandRetentionDispatcher {
  constructor(private readonly database: DatabaseConnection) {}
  async dispatch() {
    const result = { tenants: 0, redacted: 0, failures: 0 };
    const tenants = await this.database.db.select({ id: organizations.id }).from(organizations);
    for (const tenant of tenants) {
      try {
        const redacted = await withTenant(this.database.db, { tenantId: tenant.id,
          userId: "00000000-0000-7000-8000-000000000005", permissions: [], dataScope: "tenant" }, tx => expireMaterialCommandInputs(tx));
        result.tenants++; result.redacted += redacted;
      } catch { result.failures++; }
    }
    return result;
  }
}
