import { sql } from "drizzle-orm";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { recordAuditInTransaction } from "./audit.js";
import type { TenantTransaction } from "./tenant-transaction.js";

export const FACTORY_ERP_RETENTION_ACTOR = "00000000-0000-7000-8000-000000000009";
export const factoryErpRetentionContext = (tenantId: string): TenantContext => ({ tenantId, userId: FACTORY_ERP_RETENTION_ACTOR, permissions: [], dataScope: "tenant" });
export type FactoryErpPurgeTicket = {
  tenantId: string; importId: string; objectKey: string; storedChecksum: string; leaseToken: string; leaseExpiresAt: string; attempts: number;
};
const limitValue = (limit = 5) => { if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Invalid source retention batch size"); return limit; };
async function tenant(tx: TenantTransaction) {
  const [row] = await tx.execute<{ tenant: string; actor: string }>(sql`select current_setting('app.tenant_id') as tenant,current_setting('app.user_id') as actor`);
  if (!row || row.actor !== FACTORY_ERP_RETENTION_ACTOR) throw new Error("FACTORY_ERP_RETENTION_ACTOR_REQUIRED");
  return row.tenant;
}
const iso = (value: Date | string) => new Date(value).toISOString();

/** Caller commits redaction/outbox and claims before any object-store I/O. */
export async function redactExpiredFactoryErpSources(tx: TenantTransaction, options: { limit?: number; importId?: string } = {}) {
  const tenantId = await tenant(tx), limit = limitValue(options.limit);
  const due = await tx.execute<{ id: string; object_key: string; stored_checksum: string }>(sql`
    select id,object_key,stored_checksum from factory_erp_imports where expires_at<=factory_erp_source_now() and private_redacted_at is null
      ${options.importId ? sql`and id=${options.importId}::uuid` : sql``} order by expires_at,id limit ${limit} for update skip locked`);
  for (const source of due) {
    const observations = await tx.execute<{ id: string }>(sql`update factory_erp_observations set encrypted_payload=null,private_redacted_at=factory_erp_source_now()
      where import_id=${source.id}::uuid and encrypted_payload is not null returning id`);
    const bindings = await tx.execute<{ id: string }>(sql`update factory_erp_bindings b set encrypted_payload=null,private_redacted_at=factory_erp_source_now()
      from factory_erp_applications a where a.tenant_id=b.tenant_id and a.id=b.application_id and a.import_id=${source.id}::uuid and b.encrypted_payload is not null returning b.id`);
    const [updated] = await tx.execute<{ id: string }>(sql`update factory_erp_imports set encrypted_payload=null,private_redacted_at=factory_erp_source_now() where id=${source.id}::uuid returning id`);
    if (!updated) throw new Error("FACTORY_ERP_REDACTION_SOURCE_MISSING");
    await tx.execute(sql`insert into factory_erp_source_purges(import_id,tenant_id,object_key,stored_checksum,redacted_at,creation_transaction_id)
      select id,tenant_id,object_key,stored_checksum,private_redacted_at,pg_current_xact_id()::text from factory_erp_imports where id=${source.id}::uuid`);
    await recordAuditInTransaction(tx, factoryErpRetentionContext(tenantId), { action: "factory_erp.source_redacted", resourceType: "factory_erp_source", resourceId: source.id,
      result: "success", metadata: { observations: observations.length, bindings: bindings.length } });
  }
  return due.length;
}

export async function claimFactoryErpSourcePurges(tx: TenantTransaction, options: { limit?: number; leaseMs?: number; importId?: string } = {}): Promise<FactoryErpPurgeTicket[]> {
  const tenantId = await tenant(tx), limit = limitValue(options.limit), leaseMs = options.leaseMs ?? 60_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 30_000 || leaseMs > 300_000) throw new RangeError("Invalid source purge lease duration");
  const due = await tx.execute<{ import_id: string }>(sql`select import_id from factory_erp_source_purges where purged_at is null and next_attempt_at<=factory_erp_source_now()
    and(lease_token is null or lease_expires_at<=factory_erp_source_now()) ${options.importId ? sql`and import_id=${options.importId}::uuid` : sql``}
    order by next_attempt_at,import_id limit ${limit} for update skip locked`);
  const result: FactoryErpPurgeTicket[] = [];
  for (const row of due) {
    const token = createEntityId();
    const [claimed] = await tx.execute<{ object_key: string; stored_checksum: string; lease_expires_at: Date | string; attempts: number }>(sql`
      update factory_erp_source_purges set lease_token=${token}::uuid,lease_expires_at=factory_erp_source_now()+${leaseMs}*interval '1 millisecond',attempts=attempts+1,last_failure_code=null
      where import_id=${row.import_id}::uuid returning object_key,stored_checksum,lease_expires_at,attempts`);
    if (!claimed) throw new Error("FACTORY_ERP_PURGE_CLAIM_MISSING");
    result.push({ tenantId, importId: row.import_id, objectKey: claimed.object_key, storedChecksum: claimed.stored_checksum,
      leaseToken: token, leaseExpiresAt: iso(claimed.lease_expires_at), attempts: claimed.attempts });
  }
  return result;
}

async function originalTicket(tx: TenantTransaction, ticket: FactoryErpPurgeTicket) {
  const tenantId = await tenant(tx);
  if (tenantId !== ticket.tenantId) throw new Error("FACTORY_ERP_PURGE_TICKET_SCOPE_CHANGED");
  const [row] = await tx.execute<{ object_key: string; stored_checksum: string; lease_token: string | null; lease_expires_at: Date | string | null; attempts: number; purged_at: Date | string | null; active: boolean }>(sql`
    select object_key,stored_checksum,lease_token,lease_expires_at,attempts,purged_at,lease_expires_at>factory_erp_source_now() as active
    from factory_erp_source_purges where import_id=${ticket.importId}::uuid for update`);
  if (!row || row.object_key !== ticket.objectKey || row.stored_checksum !== ticket.storedChecksum || row.lease_token !== ticket.leaseToken ||
      row.lease_expires_at === null || iso(row.lease_expires_at) !== ticket.leaseExpiresAt || row.attempts !== ticket.attempts)
    throw new Error("FACTORY_ERP_PURGE_TICKET_CHANGED");
  return { tenantId, row };
}

export async function finishFactoryErpSourcePurge(tx: TenantTransaction, ticket: FactoryErpPurgeTicket, proof: { verifiedAbsent: true; deletedVersions: number }) {
  if (proof.verifiedAbsent !== true || !Number.isSafeInteger(proof.deletedVersions) || proof.deletedVersions < 0 || proof.deletedVersions > 100000) throw new Error("FACTORY_ERP_PURGE_ABSENCE_REQUIRED");
  const { tenantId, row } = await originalTicket(tx, ticket);
  if (row.purged_at !== null) return { importId: ticket.importId, purgedAt: iso(row.purged_at), replayed: true };
  if (!row.active) throw new Error("FACTORY_ERP_PURGE_LEASE_EXPIRED");
  const [completed] = await tx.execute<{ purged_at: Date | string }>(sql`update factory_erp_source_purges set purged_at=factory_erp_source_now(),deleted_versions=${proof.deletedVersions},completion_transaction_id=pg_current_xact_id()::text
    where import_id=${ticket.importId}::uuid returning purged_at`);
  if (!completed) throw new Error("FACTORY_ERP_PURGE_COMPLETION_MISSING");
  await recordAuditInTransaction(tx, factoryErpRetentionContext(tenantId), { action: "factory_erp.source_purged", resourceType: "factory_erp_source", resourceId: ticket.importId,
    result: "success", metadata: { verifiedAbsent: true, deletedVersions: proof.deletedVersions } });
  return { importId: ticket.importId, purgedAt: iso(completed.purged_at), replayed: false };
}

export async function failFactoryErpSourcePurge(tx: TenantTransaction, ticket: FactoryErpPurgeTicket, code: "storage_delete_failed" | "absence_unconfirmed") {
  if (!["storage_delete_failed", "absence_unconfirmed"].includes(code)) throw new Error("FACTORY_ERP_PURGE_SAFE_FAILURE_REQUIRED");
  const { row } = await originalTicket(tx, ticket);
  if (row.purged_at !== null || !row.active) return false;
  const delaySeconds = Math.min(900, 30 * 2 ** Math.min(5, row.attempts - 1));
  await tx.execute(sql`update factory_erp_source_purges set lease_token=null,lease_expires_at=null,last_failure_code=${code},next_attempt_at=factory_erp_source_now()+${delaySeconds}*interval '1 second'
    where import_id=${ticket.importId}::uuid`);
  return true;
}
