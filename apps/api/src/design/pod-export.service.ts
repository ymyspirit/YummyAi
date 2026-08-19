import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import {
  CreatePodExportInputSchema,
  CreativeDesignQualityCheckSnapshotSchema,
  CreativeDesignToolKeySchema,
  ListingAssetQualityCheckSnapshotSchema,
  ListingAssetToolKeySchema,
  PatternCropQualityCheckSnapshotSchema,
  PatternProcessingQualityCheckSnapshotSchema,
  PodExportViewSchema,
  PrintExtractQualityCheckSnapshotSchema,
  ProductVideoQualityCheckSnapshotSchema,
  RightsRiskQualityCheckSnapshotSchema,
  UvLayersQualityCheckSnapshotSchema,
  createEntityId,
  type CreatePodExportInput,
  type TenantContext,
} from "@yummyai/contracts";
import {
  assetFiles,
  designVersionFiles,
  designVersions,
  podArtworkTasks,
  podExportPackages,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { and, desc, eq } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, POD_EXPORT_ENQUEUER, PRIVATE_STORAGE } from "../platform.tokens.js";

export interface PodExportEnqueuer {
  enqueue(input: { exportId: string; tenantId: string; requestedBy: string }): Promise<void>;
}

@Injectable()
export class PodExportService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(POD_EXPORT_ENQUEUER) private readonly enqueuer: PodExportEnqueuer,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async request(context: TenantContext, taskId: string, rawInput: CreatePodExportInput) {
    const input = CreatePodExportInputSchema.parse(rawInput);
    const prepared = await withTenant(this.database.db, context, async (tx) => {
      const [replayed] = await tx.select().from(podExportPackages)
        .where(eq(podExportPackages.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) return { row: replayed, replayed: true };
      const [task] = await tx.select().from(podArtworkTasks).where(eq(podArtworkTasks.id, taskId)).limit(1);
      if (!task) throw new NotFoundException("POD artwork task not found");
      if (task.status !== "approved" || !task.resultVersionId) {
        throw new ConflictException("An approved POD task result is required before export");
      }
      assertPodTaskQualityAllowsExport(task);
      const [version] = await tx.select().from(designVersions).where(eq(designVersions.id, task.resultVersionId)).limit(1);
      if (!version || version.status !== "approved") throw new ConflictException("An approved design version is required before export");
      const files = await tx.select({ file: designVersionFiles, asset: assetFiles })
        .from(designVersionFiles)
        .innerJoin(assetFiles, eq(designVersionFiles.assetFileId, assetFiles.id))
        .where(eq(designVersionFiles.versionId, version.id));
      if (!files.length) throw new ConflictException("Approved design version has no exportable files");
      const invalid = files.filter(({ asset }) => asset.assetDomain !== "authorized" || asset.rightsStatus !== "approved");
      if (invalid.length) throw new ConflictException("Every exported asset requires approved rights in the authorized domain");
      const [row] = await tx.insert(podExportPackages).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        taskId,
        designVersionId: version.id,
        idempotencyKey: input.idempotencyKey,
        requestedBy: context.userId,
      }).returning();
      return { row: row!, replayed: false };
    });

    if (!prepared.replayed) {
      try {
        await this.enqueuer.enqueue({ exportId: prepared.row.id, tenantId: context.tenantId, requestedBy: context.userId });
      } catch {
        await withTenant(this.database.db, context, (tx) => tx.update(podExportPackages).set({
          status: "failed",
          errorCode: "QUEUE_UNAVAILABLE",
          errorMessage: "POD export queue is unavailable",
          completedAt: new Date(),
        }).where(eq(podExportPackages.id, prepared.row.id)));
        throw new ServiceUnavailableException("POD export queue is unavailable");
      }
      await this.audit.record(context, {
        action: "pod.export.request",
        resourceType: "pod_export_package",
        resourceId: prepared.row.id,
        result: "success",
        metadata: { taskId, designVersionId: prepared.row.designVersionId },
      });
    }
    return mapExport(prepared.row);
  }

  async get(context: TenantContext, id: string) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(podExportPackages)
      .where(eq(podExportPackages.id, id)).limit(1));
    if (!row) throw new NotFoundException("POD export package not found");
    return mapExport(row);
  }

  async listForTask(context: TenantContext, taskId: string) {
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(podExportPackages)
      .where(eq(podExportPackages.taskId, taskId)).orderBy(desc(podExportPackages.createdAt)).limit(100));
    return { items: rows.map(mapExport) };
  }

  async signDownload(context: TenantContext, id: string) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(podExportPackages)
      .where(and(eq(podExportPackages.id, id), eq(podExportPackages.status, "completed"))).limit(1));
    if (!row?.objectKey) throw new NotFoundException("Completed POD export package not found");
    const url = await this.storage.signRead(context, {
      id: row.id,
      tenantId: row.tenantId,
      assetDomain: "authorized",
      objectKey: row.objectKey,
    }, { requiredDomain: "authorized" });
    await this.audit.record(context, {
      action: "pod.export.download",
      resourceType: "pod_export_package",
      resourceId: id,
      result: "success",
    });
    return { url, expiresInSeconds: 600 };
  }
}

export function assertPodTaskQualityAllowsExport(task: { toolKey: string; qualityCheckSnapshot: unknown }) {
  if (task.toolKey === "pattern_crop") {
    if (!PatternCropQualityCheckSnapshotSchema.safeParse(task.qualityCheckSnapshot).success) {
      throw new ConflictException("Pattern crop requires complete bounds and input coverage evidence before export");
    }
    return;
  }
  if (task.toolKey === "print_extract") {
    if (!PrintExtractQualityCheckSnapshotSchema.safeParse(task.qualityCheckSnapshot).success) {
      throw new ConflictException("Print extraction requires complete correction and marked AI-region evidence before export");
    }
    return;
  }
  if (["background_remove", "super_resolution", "outpaint", "crop_compress", "vectorize", "authorized_watermark_remove"].includes(task.toolKey)) {
    const quality = PatternProcessingQualityCheckSnapshotSchema.safeParse(task.qualityCheckSnapshot);
    const checks = quality.success ? quality.data.outputChecks : [];
    const ordinals = new Set(checks.map((check) => check.inputOrdinal));
    const operationsMatch = checks.every((check) => check.operation === task.toolKey);
    const generatedEvidencePresent = !["super_resolution", "outpaint", "authorized_watermark_remove"].includes(task.toolKey)
      || checks.every((check) => check.generatedRegions.length > 0);
    const safeVectorEvidencePresent = task.toolKey !== "vectorize"
      || checks.every((check) => Boolean(check.pathCount) && check.pathsClosed === true);
    if (
      !quality.success
      || quality.data.toolKey !== task.toolKey
      || ordinals.size !== checks.length
      || !operationsMatch
      || !generatedEvidencePresent
      || !safeVectorEvidencePresent
    ) {
      throw new ConflictException("Pattern processing requires complete per-input file and marked AI-region evidence before export");
    }
    return;
  }
  if (CreativeDesignToolKeySchema.safeParse(task.toolKey).success) {
    const quality = CreativeDesignQualityCheckSnapshotSchema.safeParse(task.qualityCheckSnapshot);
    const checks = quality.success ? quality.data.outputChecks : [];
    const seamless = task.toolKey === "seamless_pattern" || task.toolKey === "seamless_stitch";
    const aiEvidenceMatches = checks.every((check) => task.toolKey === "seamless_stitch"
      ? check.aiInference === "none" && check.generatedRegions.length === 0
      : task.toolKey === "canvas_extend"
        ? check.aiInference === "partial" && check.generatedRegions.length > 0
        : check.aiInference === "full");
    const seamEvidenceMatches = !seamless || checks.every((check) => (
      check.horizontalSeamPassed === true
      && check.tilePreviewValidated === true
      && check.verticalSeamPassed !== false
    ));
    if (
      !quality.success
      || quality.data.toolKey !== task.toolKey
      || !checks.length
      || !aiEvidenceMatches
      || !seamEvidenceMatches
    ) {
      throw new ConflictException("Creative design requires matching prompt, safety, input, AI-region, and seamless evidence before export");
    }
    return;
  }
  if (ListingAssetToolKeySchema.safeParse(task.toolKey).success) {
    const quality = ListingAssetQualityCheckSnapshotSchema.safeParse(task.qualityCheckSnapshot);
    if (
      !quality.success
      || quality.data.toolKey !== task.toolKey
      || !quality.data.outputChecks.length
      || (task.toolKey !== "product_suite" && quality.data.failedOutputCount > 0)
    ) {
      throw new ConflictException("Listing assets require matching fact, identity, safety, license, and per-output evidence before export");
    }
    return;
  }
  if (task.toolKey === "product_video") {
    if (!ProductVideoQualityCheckSnapshotSchema.safeParse(task.qualityCheckSnapshot).success) {
      throw new ConflictException("Product video requires complete playback and rights evidence before export");
    }
    return;
  }
  if (task.toolKey === "rights_risk_scan") {
    const quality = RightsRiskQualityCheckSnapshotSchema.safeParse(task.qualityCheckSnapshot);
    if (
      !quality.success
      || quality.data.highRiskDetected
      || quality.data.unknownRiskDetected
      || new Date(quality.data.validUntil).getTime() <= Date.now()
    ) {
      throw new ConflictException("Rights risk reports must be current and free of high or unknown risk before export");
    }
    return;
  }
  if (task.toolKey === "uv_layers") {
    const quality = UvLayersQualityCheckSnapshotSchema.safeParse(task.qualityCheckSnapshot);
    if (!quality.success || !quality.data.exportReady || quality.data.conflictRegions.length) {
      throw new ConflictException("UV layer conflicts require a new reviewed version before export");
    }
  }
}

function mapExport(row: typeof podExportPackages.$inferSelect) {
  return PodExportViewSchema.parse({
    id: row.id,
    taskId: row.taskId,
    designVersionId: row.designVersionId,
    status: row.status,
    checksumSha256: row.checksumSha256 ?? undefined,
    byteSize: row.byteSize ?? undefined,
    manifest: row.manifest ?? undefined,
    errorCode: row.errorCode ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString(),
  });
}
