import { createHash } from "node:crypto";

import {
  RecordCustomizationFileScanInputSchema,
  createEntityId,
  type RecordCustomizationFileScanInput,
  type TenantContext,
} from "@yummyai/contracts";
import {
  orderCustomizationFileIntakes,
  orderCustomizationFileScanEvents,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { CustomizationFileScanJobPayloadSchema, type JobEnvelope } from "@yummyai/jobs";
import type { Storage } from "@yummyai/storage";
import { desc, eq, sql } from "drizzle-orm";

export interface CustomizationFileScanIntake {
  byteSize: number;
  checksumSha256: string;
  id: string;
  mediaType: string;
  objectKey: string;
  safeFileName: string;
}

export interface CustomizationFileScanRepository {
  claim(context: TenantContext, intakeId: string): Promise<CustomizationFileScanIntake | null>;
  record(context: TenantContext, intakeId: string, evidence: RecordCustomizationFileScanInput): Promise<"recorded" | "already_final">;
}

export interface MalwareScanner {
  readonly engine: string;
  scan(input: { body: Uint8Array; fileName: string; mediaType: string }): Promise<RecordCustomizationFileScanInput>;
}

export class CustomizationFileScanProcessor {
  constructor(
    private readonly repository: CustomizationFileScanRepository,
    private readonly storage: Storage,
    private readonly scanner: MalwareScanner,
  ) {}

  async process(envelope: JobEnvelope) {
    const payload = CustomizationFileScanJobPayloadSchema.parse(envelope.payload);
    const context: TenantContext = {
      tenantId: envelope.tenantId,
      userId: envelope.requestedBy,
      permissions: ["asset:read"],
      dataScope: "tenant",
    };
    const intake = await this.repository.claim(context, payload.intakeId);
    if (!intake) return { intakeId: payload.intakeId, status: "already_final" as const };
    const body = await this.storage.readPrivate(context, {
      id: intake.id,
      tenantId: context.tenantId,
      assetDomain: "quarantine",
      objectKey: intake.objectKey,
    }, { requiredDomain: "quarantine" });
    if (body.byteLength !== intake.byteSize || sha256(body) !== intake.checksumSha256) {
      await this.repository.record(context, intake.id, {
        result: "failed", engine: "integrity-check", signatureVersion: "sha256-v1", scannedAt: new Date().toISOString(),
      });
      throw new Error("Quarantined customization file failed integrity verification");
    }
    let evidence: RecordCustomizationFileScanInput;
    try {
      evidence = RecordCustomizationFileScanInputSchema.parse(await this.scanner.scan({
        body, fileName: intake.safeFileName, mediaType: intake.mediaType,
      }));
    } catch (error) {
      await this.repository.record(context, intake.id, {
        result: "failed", engine: this.scanner.engine, signatureVersion: "unavailable", scannedAt: new Date().toISOString(),
      });
      throw error;
    }
    const recorded = await this.repository.record(context, intake.id, evidence);
    if (evidence.result === "failed") throw new Error("Customization malware scan returned a failed result");
    return { intakeId: intake.id, status: recorded === "already_final" ? "already_final" as const : evidence.result };
  }
}

export class DrizzleCustomizationFileScanRepository implements CustomizationFileScanRepository {
  constructor(private readonly database: DatabaseConnection) {}

  async claim(context: TenantContext, intakeId: string): Promise<CustomizationFileScanIntake | null> {
    const [intake] = await withTenant(this.database.db, context, (tx) => tx.select().from(orderCustomizationFileIntakes)
      .where(eq(orderCustomizationFileIntakes.id, intakeId)).limit(1));
    if (!intake || ["clean", "infected", "unsupported", "promoted"].includes(intake.scanStatus)) return null;
    return {
      id: intake.id, objectKey: intake.objectKey, safeFileName: intake.safeFileName, mediaType: intake.mediaType,
      byteSize: intake.byteSize, checksumSha256: intake.checksumSha256,
    };
  }

  async record(context: TenantContext, intakeId: string, rawEvidence: RecordCustomizationFileScanInput): Promise<"recorded" | "already_final"> {
    const evidence = RecordCustomizationFileScanInputSchema.parse(rawEvidence);
    return withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${intakeId}:scan`}, 0))`);
      const [intake] = await tx.select().from(orderCustomizationFileIntakes).where(eq(orderCustomizationFileIntakes.id, intakeId)).limit(1);
      if (!intake) throw new Error("Customization file intake not found");
      if (["clean", "infected", "unsupported", "promoted"].includes(intake.scanStatus)) return "already_final";
      const [latest] = await tx.select({ sequence: orderCustomizationFileScanEvents.sequence })
        .from(orderCustomizationFileScanEvents).where(eq(orderCustomizationFileScanEvents.intakeId, intakeId))
        .orderBy(desc(orderCustomizationFileScanEvents.sequence)).limit(1);
      await tx.insert(orderCustomizationFileScanEvents).values({
        id: createEntityId(), tenantId: context.tenantId, intakeId, sequence: (latest?.sequence ?? 0) + 1,
        result: evidence.result, engine: evidence.engine, signatureVersion: evidence.signatureVersion,
        scannedAt: new Date(evidence.scannedAt),
      });
      await tx.update(orderCustomizationFileIntakes).set({ scanStatus: evidence.result, updatedAt: new Date() })
        .where(eq(orderCustomizationFileIntakes.id, intakeId));
      return "recorded";
    });
  }
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
