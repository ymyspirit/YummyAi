import { createHash } from "node:crypto";

import { Permission } from "@yummyai/authz";
import type { TemplateCanvas, TemplateSourceInspectionSlot, TemplateSourceInspectionWarning, TenantContext } from "@yummyai/contracts";
import {
  assetFiles,
  personalizationTemplateSourceInspections,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { PersonalizationTemplateSourceInspectionJobPayloadSchema, type JobEnvelope } from "@yummyai/jobs";
import type { Storage } from "@yummyai/storage";
import { and, eq, inArray } from "drizzle-orm";

import {
  inspectPersonalizationTemplateSource,
  TemplateSourceParseError,
} from "./personalization-template-source-parser.js";

const MAX_SOURCE_BYTES = 128 * 1024 * 1024;

export interface TemplateSourceInspectionSnapshot {
  id: string;
  source: "png" | "psd";
  bytes: Uint8Array;
}

export interface TemplateSourceInspectionRepository {
  claimAndLoad(context: Pick<TenantContext, "tenantId" | "userId">, inspectionId: string): Promise<TemplateSourceInspectionSnapshot | undefined>;
  complete(context: Pick<TenantContext, "tenantId" | "userId">, inspectionId: string, result: {
    canvas: TemplateCanvas;
    slots: TemplateSourceInspectionSlot[];
    warnings: TemplateSourceInspectionWarning[];
  }): Promise<void>;
  fail(context: Pick<TenantContext, "tenantId" | "userId">, inspectionId: string, input: {
    terminal: boolean;
    code: string;
    message: string;
  }): Promise<void>;
}

export class TemplateSourceInspectionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateSourceInspectionPolicyError";
  }
}

export class PersonalizationTemplateSourceInspectionProcessor {
  constructor(private readonly repository: TemplateSourceInspectionRepository) {}

  async process(envelope: JobEnvelope) {
    const { inspectionId } = PersonalizationTemplateSourceInspectionJobPayloadSchema.parse(envelope.payload);
    const context = { tenantId: envelope.tenantId, userId: envelope.requestedBy };
    try {
      const snapshot = await this.repository.claimAndLoad(context, inspectionId);
      if (!snapshot) return { inspectionId, disposition: "already_claimed" as const };
      const result = inspectPersonalizationTemplateSource(snapshot.bytes, snapshot.source);
      await this.repository.complete(context, inspectionId, result);
      return { inspectionId, disposition: "completed" as const, slotCount: result.slots.length };
    } catch (error) {
      const terminal = error instanceof TemplateSourceParseError
        || error instanceof TemplateSourceInspectionPolicyError
        || envelope.attempt + 1 >= envelope.maxAttempts;
      await this.repository.fail(context, inspectionId, {
        terminal,
        code: inspectionErrorCode(error),
        message: error instanceof Error ? error.message.slice(0, 500) : "Template source inspection failed",
      });
      throw error;
    }
  }
}

export class DrizzleTemplateSourceInspectionRepository implements TemplateSourceInspectionRepository {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly storage: Storage,
  ) {}

  async claimAndLoad(context: Pick<TenantContext, "tenantId" | "userId">, inspectionId: string) {
    const tenantContext = workerContext(context);
    const loaded = await withTenant(this.database.db, tenantContext, async (tx) => {
      const [inspection] = await tx.update(personalizationTemplateSourceInspections).set({
        status: "running",
        startedAt: new Date(),
        completedAt: null,
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      }).where(and(
        eq(personalizationTemplateSourceInspections.id, inspectionId),
        inArray(personalizationTemplateSourceInspections.status, ["queued"]),
      )).returning();
      if (!inspection) return undefined;
      const [asset] = await tx.select().from(assetFiles).where(eq(assetFiles.id, inspection.sourceAssetId)).limit(1);
      if (!asset) throw new TemplateSourceInspectionPolicyError("Pinned template source asset was not found");
      return { inspection, asset };
    });
    if (!loaded) return undefined;
    const { inspection, asset } = loaded;
    const rightsSourceKind = (asset.rightsMetadata as { source?: { kind?: string } }).source?.kind;
    if (
      asset.version !== inspection.sourceAssetVersion
      || asset.checksumSha256 !== inspection.checksumSha256
      || asset.assetDomain !== inspection.assetDomain
      || asset.rightsStatus !== inspection.rightsStatus
      || (inspection.rightsSourceKind ?? undefined) !== rightsSourceKind
      || asset.deletedAt
    ) throw new TemplateSourceInspectionPolicyError("Template source asset no longer matches the pinned inspection snapshot");
    if (asset.assetDomain !== "authorized" || asset.rightsStatus !== "approved" || rightsSourceKind === "customer_provided") {
      throw new TemplateSourceInspectionPolicyError("Template source inspection requires a rights-approved non-customer asset in the authorized domain");
    }
    if (asset.byteSize > MAX_SOURCE_BYTES) throw new TemplateSourceInspectionPolicyError("Template source exceeds the 128 MiB inspection limit");
    const bytes = await this.storage.readPrivate(tenantContext, {
      id: asset.id,
      tenantId: asset.tenantId,
      assetDomain: "authorized",
      objectKey: asset.objectKey,
    }, { requiredDomain: "authorized" });
    if (bytes.byteLength !== asset.byteSize || sha256(bytes) !== inspection.checksumSha256) {
      throw new TemplateSourceInspectionPolicyError("Template source bytes do not match the pinned asset snapshot");
    }
    return { id: inspection.id, source: inspection.source, bytes };
  }

  async complete(
    context: Pick<TenantContext, "tenantId" | "userId">,
    inspectionId: string,
    result: { canvas: TemplateCanvas; slots: TemplateSourceInspectionSlot[]; warnings: TemplateSourceInspectionWarning[] },
  ) {
    await withTenant(this.database.db, workerContext(context), (tx) => tx.update(personalizationTemplateSourceInspections).set({
      status: "completed",
      canvas: result.canvas,
      slotSnapshot: result.slots,
      warningSnapshot: result.warnings,
      errorCode: null,
      errorMessage: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(personalizationTemplateSourceInspections.id, inspectionId),
      eq(personalizationTemplateSourceInspections.status, "running"),
    )));
  }

  async fail(
    context: Pick<TenantContext, "tenantId" | "userId">,
    inspectionId: string,
    input: { terminal: boolean; code: string; message: string },
  ) {
    await withTenant(this.database.db, workerContext(context), (tx) => tx.update(personalizationTemplateSourceInspections).set({
      status: input.terminal ? "failed" : "queued",
      errorCode: input.terminal ? input.code : null,
      errorMessage: input.terminal ? input.message : null,
      completedAt: input.terminal ? new Date() : null,
      updatedAt: new Date(),
    }).where(and(
      eq(personalizationTemplateSourceInspections.id, inspectionId),
      inArray(personalizationTemplateSourceInspections.status, ["queued", "running"]),
    )));
  }
}

function workerContext(context: Pick<TenantContext, "tenantId" | "userId">): TenantContext {
  return { ...context, permissions: [Permission.AssetRead], dataScope: "tenant" };
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inspectionErrorCode(error: unknown) {
  if (error instanceof TemplateSourceParseError) return error.code;
  if (error instanceof TemplateSourceInspectionPolicyError) return "TEMPLATE_SOURCE_POLICY_BLOCKED";
  return error instanceof Error
    ? error.name.replaceAll(/[^A-Za-z0-9_]/g, "_").toUpperCase().slice(0, 80)
    : "TEMPLATE_SOURCE_INSPECTION_FAILED";
}
