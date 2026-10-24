import { Inject, Injectable } from "@nestjs/common";
import type { TenantContext } from "@yummyai/contracts";
import { recordAuditEvent, recordAuditInTransaction, type DatabaseConnection, type TenantTransaction, type RecordAuditEvent } from "@yummyai/database";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
export { redactMetadata, type AuditResult, type RecordAuditEvent } from "@yummyai/database";

@Injectable()
export class AuditService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}
  record(context: TenantContext, event: RecordAuditEvent): Promise<string> { return recordAuditEvent(this.database, context, event); }
  recordInTransaction(tx: TenantTransaction, context: TenantContext, event: RecordAuditEvent): Promise<string> {
    return recordAuditInTransaction(tx, context, event);
  }
}
