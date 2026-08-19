import { createHash } from "node:crypto";

import { Permission } from "@yummyai/authz";
import { PodExportManifestSchema, type PodExecutableToolKey, type PodExportManifest, type TenantContext } from "@yummyai/contracts";
import {
  assetFiles,
  designTasks,
  designVersionFiles,
  designVersions,
  podArtworkTaskInputs,
  podArtworkTasks,
  podExportPackages,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { PodExportJobPayloadSchema, type JobEnvelope } from "@yummyai/jobs";
import type { Storage } from "@yummyai/storage";
import { and, asc, eq, inArray } from "drizzle-orm";
import JSZip from "jszip";

export interface PodExportSnapshot {
  exportId: string;
  taskId: string;
  designTaskId: string;
  designVersionId: string;
  taskStatus: string;
  designVersionStatus: string;
  toolKey: PodExecutableToolKey;
  modelKey?: string;
  modelVersion?: string;
  seed?: string;
  qualityCheckSnapshot: Record<string, unknown>;
  createdAt: Date;
  requestedBy: string;
  inputAssets: Array<{ assetId: string; assetVersion: number; checksumSha256: string }>;
  files: Array<{
    assetId: string;
    assetVersion: number;
    domain: string;
    rightsStatus: string;
    fileName: string;
    mediaType: string;
    checksumSha256: string;
    bytes: Uint8Array;
  }>;
}

export class PodExportPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PodExportPolicyError";
  }
}

export interface PodExportRepository {
  claimAndLoad(context: { tenantId: string; userId: string }, exportId: string): Promise<PodExportSnapshot | undefined>;
  complete(context: { tenantId: string; userId: string }, exportId: string, result: { objectKey: string; checksumSha256: string; byteSize: number; manifest: PodExportManifest }): Promise<void>;
  fail(context: { tenantId: string; userId: string }, exportId: string, input: { terminal: boolean; code: string; message: string }): Promise<void>;
}

export interface PodExportPackageStorage {
  putPrivate(context: TenantContext, input: { body: Uint8Array; domain: "authorized"; fileName: string; mediaType: string }): Promise<{ objectKey: string; checksumSha256: string }>;
}

export class PodExportProcessor {
  constructor(
    private readonly repository: PodExportRepository,
    private readonly storage: PodExportPackageStorage,
  ) {}

  async process(envelope: JobEnvelope) {
    const { exportId } = PodExportJobPayloadSchema.parse(envelope.payload);
    const context = { tenantId: envelope.tenantId, userId: envelope.requestedBy };
    try {
      const snapshot = await this.repository.claimAndLoad(context, exportId);
      if (!snapshot) return { exportId, disposition: "already_claimed" as const };
      validateSnapshot(snapshot);
      const built = await buildPodExportPackage(snapshot, envelope.tenantId);
      const stored = await this.storage.putPrivate(workerContext(context), {
        body: built.body,
        domain: "authorized",
        fileName: `${exportId}.zip`,
        mediaType: "application/zip",
      });
      await this.repository.complete(context, exportId, {
        objectKey: stored.objectKey,
        checksumSha256: stored.checksumSha256,
        byteSize: built.body.byteLength,
        manifest: built.manifest,
      });
      return { exportId, disposition: "completed" as const, checksumSha256: stored.checksumSha256 };
    } catch (error) {
      const terminal = error instanceof PodExportPolicyError || envelope.attempt + 1 >= envelope.maxAttempts;
      await this.repository.fail(context, exportId, {
        terminal,
        code: errorCode(error),
        message: error instanceof Error ? error.message.slice(0, 500) : "POD export failed",
      });
      throw error;
    }
  }
}

export class DrizzlePodExportRepository implements PodExportRepository {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly storage: Storage,
  ) {}

  async claimAndLoad(context: { tenantId: string; userId: string }, exportId: string): Promise<PodExportSnapshot | undefined> {
    const tenantContext = workerContext(context);
    const loaded = await withTenant(this.database.db, tenantContext, async (tx) => {
      const [claimed] = await tx.update(podExportPackages).set({
        status: "running",
        errorCode: null,
        errorMessage: null,
        completedAt: null,
      }).where(and(
        eq(podExportPackages.id, exportId),
        inArray(podExportPackages.status, ["queued", "failed"]),
      )).returning();
      if (!claimed) return undefined;
      const [source] = await tx.select({
        task: podArtworkTasks,
        designTask: designTasks,
        designVersion: designVersions,
      }).from(podArtworkTasks)
        .innerJoin(designTasks, eq(podArtworkTasks.designTaskId, designTasks.id))
        .innerJoin(designVersions, eq(podArtworkTasks.resultVersionId, designVersions.id))
        .where(eq(podArtworkTasks.id, claimed.taskId)).limit(1);
      if (!source || source.designVersion.id !== claimed.designVersionId) throw new PodExportPolicyError("Export source version no longer matches the approved task");
      const inputs = await tx.select().from(podArtworkTaskInputs)
        .where(eq(podArtworkTaskInputs.taskId, source.task.id)).orderBy(asc(podArtworkTaskInputs.ordinal));
      const files = await tx.select({ file: designVersionFiles, asset: assetFiles })
        .from(designVersionFiles)
        .innerJoin(assetFiles, eq(designVersionFiles.assetFileId, assetFiles.id))
        .where(eq(designVersionFiles.versionId, claimed.designVersionId))
        .orderBy(asc(designVersionFiles.role), asc(assetFiles.id));
      return { claimed, source, inputs, files };
    });
    if (!loaded) return undefined;

    const files = await Promise.all(loaded.files.map(async ({ asset }) => {
      if (asset.assetDomain !== "authorized" || asset.rightsStatus !== "approved") {
        throw new PodExportPolicyError(`Asset ${asset.id} is not approved for export`);
      }
      return {
        assetId: asset.id,
        assetVersion: asset.version,
        domain: asset.assetDomain,
        rightsStatus: asset.rightsStatus,
        fileName: asset.fileName,
        mediaType: asset.mediaType,
        checksumSha256: asset.checksumSha256,
        bytes: await this.storage.readPrivate(tenantContext, {
          id: asset.id,
          tenantId: asset.tenantId,
          assetDomain: "authorized",
          objectKey: asset.objectKey,
        }, { requiredDomain: "authorized" }),
      };
    }));

    return {
      exportId: loaded.claimed.id,
      taskId: loaded.source.task.id,
      designTaskId: loaded.source.designTask.id,
      designVersionId: loaded.source.designVersion.id,
      taskStatus: loaded.source.task.status,
      designVersionStatus: loaded.source.designVersion.status,
      toolKey: loaded.source.task.toolKey,
      modelKey: loaded.source.task.modelKey ?? undefined,
      modelVersion: loaded.source.task.modelVersion ?? undefined,
      seed: loaded.source.task.seed ?? undefined,
      qualityCheckSnapshot: loaded.source.task.qualityCheckSnapshot ?? {},
      createdAt: loaded.claimed.createdAt,
      requestedBy: loaded.claimed.requestedBy ?? context.userId,
      inputAssets: loaded.inputs.map((input) => ({
        assetId: input.assetFileId,
        assetVersion: input.assetVersion,
        checksumSha256: input.checksumSha256,
      })),
      files,
    };
  }

  async complete(
    context: { tenantId: string; userId: string },
    exportId: string,
    result: { objectKey: string; checksumSha256: string; byteSize: number; manifest: PodExportManifest },
  ) {
    await withTenant(this.database.db, workerContext(context), (tx) => tx.update(podExportPackages).set({
      status: "completed",
      objectKey: result.objectKey,
      checksumSha256: result.checksumSha256,
      byteSize: result.byteSize,
      manifest: result.manifest,
      completedAt: new Date(),
    }).where(and(eq(podExportPackages.id, exportId), eq(podExportPackages.status, "running"))));
  }

  async fail(context: { tenantId: string; userId: string }, exportId: string, input: { terminal: boolean; code: string; message: string }) {
    await withTenant(this.database.db, workerContext(context), (tx) => tx.update(podExportPackages).set({
      status: input.terminal ? "failed" : "queued",
      errorCode: input.code,
      errorMessage: input.message,
      completedAt: input.terminal ? new Date() : null,
    }).where(eq(podExportPackages.id, exportId)));
  }
}

export async function buildPodExportPackage(snapshot: PodExportSnapshot, tenantId: string) {
  const fixedDate = snapshot.createdAt;
  const zip = new JSZip();
  const files = snapshot.files.map((file) => {
    const path = `artwork/${file.assetId}-v${file.assetVersion}-${safeName(file.fileName)}`;
    zip.file(path, file.bytes, { date: fixedDate, binary: true });
    return {
      path,
      sha256: file.checksumSha256,
      assetId: file.assetId,
      assetVersion: file.assetVersion,
      mediaType: file.mediaType,
    };
  });
  const manifest = PodExportManifestSchema.parse({
    exportId: snapshot.exportId,
    tenantId,
    taskId: snapshot.taskId,
    designTaskId: snapshot.designTaskId,
    designVersionId: snapshot.designVersionId,
    toolKey: snapshot.toolKey,
    inputAssets: snapshot.inputAssets,
    files,
    modelKey: snapshot.modelKey,
    modelVersion: snapshot.modelVersion,
    seed: snapshot.seed,
    qualityCheckSnapshot: snapshot.qualityCheckSnapshot,
    createdBy: snapshot.requestedBy,
    createdAt: fixedDate.toISOString(),
  });
  zip.file("manifest.json", JSON.stringify(manifest, null, 2), { date: fixedDate });
  const body = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 }, platform: "UNIX" });
  return { body, manifest };
}

function validateSnapshot(snapshot: PodExportSnapshot) {
  if (snapshot.taskStatus !== "approved" || snapshot.designVersionStatus !== "approved") {
    throw new PodExportPolicyError("POD export requires an approved task and design version");
  }
  if (!snapshot.files.length) throw new PodExportPolicyError("POD export has no files");
  for (const file of snapshot.files) {
    if (file.domain !== "authorized" || file.rightsStatus !== "approved") {
      throw new PodExportPolicyError(`Asset ${file.assetId} is not approved for export`);
    }
    if (checksum(file.bytes) !== file.checksumSha256) throw new PodExportPolicyError(`Asset ${file.assetId} checksum changed`);
  }
}

function workerContext(context: { tenantId: string; userId: string }): TenantContext {
  return { ...context, permissions: [Permission.AssetRead], dataScope: "tenant" };
}

function checksum(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeName(fileName: string) {
  return fileName.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "asset.bin";
}

function errorCode(error: unknown) {
  return error instanceof PodExportPolicyError ? "EXPORT_POLICY_BLOCKED" : error instanceof Error
    ? error.name.replaceAll(/[^A-Za-z0-9_]/g, "_").toUpperCase().slice(0, 80)
    : "POD_EXPORT_FAILED";
}
