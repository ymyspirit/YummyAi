import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { auditEvents } from "./schema/audit.js";
import { withTenant, type TenantTransaction } from "./tenant-transaction.js";
import type { DatabaseConnection } from "./client.js";

export type AuditResult = "success" | "failure" | "denied";
export interface RecordAuditEvent {
  action: string;
  metadata?: Record<string, unknown>;
  resourceId?: string;
  resourceType: string;
  result: AuditResult;
  traceId?: string;
}
export async function recordAuditInTransaction(
  tx: TenantTransaction,
  context: TenantContext,
  event: RecordAuditEvent,
): Promise<string> {
  const id = createEntityId();
  await tx
    .insert(auditEvents)
    .values({
      id,
      tenantId: context.tenantId,
      actorUserId: context.userId,
      action: event.action,
      entityType: event.resourceType,
      entityId: event.resourceId,
      result: event.result,
      traceId: event.traceId,
      metadata: redactMetadata(event.metadata ?? {}),
    });
  return id;
}
export function recordAuditEvent(
  database: DatabaseConnection,
  context: TenantContext,
  event: RecordAuditEvent,
) {
  return withTenant(database.db, context, (tx) => recordAuditInTransaction(tx, context, event));
}
export function redactMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return redact(value) as Record<string, unknown>;
}
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /(authorization|cookie|credential|password|secret|token|api[-_]?key)/i.test(key)
        ? "[REDACTED]"
        : redact(entry),
    ]),
  );
}
