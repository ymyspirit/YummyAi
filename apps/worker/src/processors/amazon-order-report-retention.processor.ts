import type { TenantContext } from "@yummyai/contracts";
import {
  amazonOrderReportBatches, purgeExpiredAmazonOrderReports,
  type DatabaseConnection, withTenant,
} from "@yummyai/database";
import { AmazonOrderReportRetentionJobPayloadSchema, type JobEnvelope } from "@yummyai/jobs";
import { eq } from "drizzle-orm";

export interface AmazonOrderReportRetentionRepository {
  expiry(context: TenantContext, batchId: string): Promise<Date | undefined>;
  purge(context: TenantContext, now: Date): Promise<void>;
}

export class AmazonOrderReportRetentionProcessor {
  constructor(private readonly repository: AmazonOrderReportRetentionRepository) {}

  async process(envelope: JobEnvelope, now = new Date()): Promise<{ status: "ignored" | "completed" }> {
    const { batchId } = AmazonOrderReportRetentionJobPayloadSchema.parse(envelope.payload);
    const context: TenantContext = { tenantId: envelope.tenantId, userId: envelope.requestedBy, permissions: [], dataScope: "tenant" };
    const expiresAt = await this.repository.expiry(context, batchId);
    if (!expiresAt) return { status: "ignored" };
    if (expiresAt > now) {
      const error = new Error("Amazon report retention is not due") as Error & { retryAfterMs: number };
      error.retryAfterMs = expiresAt.getTime() - now.getTime();
      throw error;
    }
    await this.repository.purge(context, now);
    return { status: "completed" };
  }
}

export class DrizzleAmazonOrderReportRetentionRepository implements AmazonOrderReportRetentionRepository {
  constructor(private readonly database: DatabaseConnection) {}

  async expiry(context: TenantContext, batchId: string): Promise<Date | undefined> {
    const [batch] = await withTenant(this.database.db, context, (tx) => tx.select({ expiresAt: amazonOrderReportBatches.expiresAt })
      .from(amazonOrderReportBatches).where(eq(amazonOrderReportBatches.id, batchId)).limit(1));
    return batch?.expiresAt;
  }

  purge(context: TenantContext, now: Date): Promise<void> { return purgeExpiredAmazonOrderReports(this.database, context, now); }
}
