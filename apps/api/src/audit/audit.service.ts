import { Inject, Injectable } from "@nestjs/common";
import type { TenantContext } from "@yummyai/contracts";
import { createEntityId } from "@yummyai/contracts";
import {
  auditEvents,
  type DatabaseConnection,
  type TenantTransaction,
  withTenant,
} from "@yummyai/database";

import { DATABASE_CONNECTION } from "../platform.tokens.js";

export type AuditResult = "success" | "failure" | "denied";

export interface RecordAuditEvent {
  action: string;
  metadata?: Record<string, unknown>;
  resourceId?: string;
  resourceType: string;
  result: AuditResult;
  traceId?: string;
}

@Injectable()
export class AuditService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly database: DatabaseConnection,
  ) {}

  async record(context: TenantContext, event: RecordAuditEvent): Promise<string> {
    return withTenant(this.database.db, context, (tx) =>
      this.recordInTransaction(tx, context, event),
    );
  }

  async recordInTransaction(
    tx: TenantTransaction,
    context: TenantContext,
    event: RecordAuditEvent,
  ): Promise<string> {
    const id = createEntityId();
    await tx.insert(auditEvents).values({
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
}

const sensitiveKey = /(authorization|cookie|credential|password|secret|token|api[-_]?key)/i;

export function redactMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return redact(value) as Record<string, unknown>;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : redact(entry)]),
  );
}
