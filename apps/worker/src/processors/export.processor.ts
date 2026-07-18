import { createHash } from "node:crypto";

import { ExportManifestSchema, type ExportManifest } from "@yummyai/contracts";
import { ExportJobPayloadSchema, type JobEnvelope } from "@yummyai/jobs";
import JSZip from "jszip";

export interface ExportAssetSnapshot {
  id: string;
  version: number;
  domain: "research" | "authorized";
  rightsStatus: "unverified" | "approved" | "rejected";
  fileName: string;
  mediaType: string;
  sha256: string;
  bytes: Uint8Array;
}

export interface ApprovedExportSnapshot {
  reviewId: string;
  reviewStatus: "approved" | "pending" | "rejected" | "invalidated";
  platform: "amazon" | "etsy";
  listingId: string;
  listingVersionId: string;
  ruleVersion: string;
  content: unknown;
  assets: readonly ExportAssetSnapshot[];
}

export interface ExportSnapshotRepository {
  load(context: { tenantId: string; userId: string }, input: { reviewId: string; listingId: string; listingVersionId: string }): Promise<ApprovedExportSnapshot | undefined>;
}

export interface ExportPackageStore {
  save(context: { tenantId: string; userId: string }, input: {
    exportId: string;
    objectKey: string;
    body: Uint8Array;
    sha256: string;
    manifest: ExportManifest;
    immutable: true;
  }): Promise<void>;
}

export class ResearchAssetExportError extends Error {
  constructor(readonly assetId: string) { super(`Research-domain asset ${assetId} cannot be exported`); this.name = "ResearchAssetExportError"; }
}

export class UnapprovedAssetExportError extends Error {
  constructor(readonly assetId: string) { super(`Asset ${assetId} does not have approved rights`); this.name = "UnapprovedAssetExportError"; }
}

export class ExportSnapshotMismatchError extends Error {
  constructor(message: string) { super(message); this.name = "ExportSnapshotMismatchError"; }
}

export class AssetChecksumMismatchError extends Error {
  constructor(readonly assetId: string) { super(`Asset ${assetId} bytes do not match the pinned checksum`); this.name = "AssetChecksumMismatchError"; }
}

export interface ExportProcessResult {
  exportId: string;
  objectKey: string;
  sha256: string;
  byteSize: number;
  manifest: ExportManifest;
}

export class ExportProcessor {
  constructor(private readonly snapshots: ExportSnapshotRepository, private readonly packages: ExportPackageStore) {}

  async process(envelope: JobEnvelope): Promise<ExportProcessResult> {
    const payload = ExportJobPayloadSchema.parse(envelope.payload);
    const context = { tenantId: envelope.tenantId, userId: envelope.requestedBy };
    const snapshot = await this.snapshots.load(context, payload);
    if (!snapshot) throw new ExportSnapshotMismatchError("Approved export snapshot not found");
    if (snapshot.reviewId !== payload.reviewId || snapshot.reviewStatus !== "approved") throw new ExportSnapshotMismatchError("Export review is not approved");
    if (snapshot.listingId !== payload.listingId || snapshot.listingVersionId !== payload.listingVersionId) throw new ExportSnapshotMismatchError("Export job does not match its pinned Listing version");
    assertExportableAssets(snapshot.assets);

    const createdAt = envelope.requestedAt;
    const fixedDate = new Date(createdAt);
    const zip = new JSZip();
    zip.file("listing.json", JSON.stringify({
      platform: snapshot.platform,
      listingId: snapshot.listingId,
      listingVersionId: snapshot.listingVersionId,
      ruleVersion: snapshot.ruleVersion,
      content: snapshot.content,
    }, null, 2), { date: fixedDate });

    const files = snapshot.assets.map((asset) => {
      const path = `media/${asset.id}-v${asset.version}-${safeName(asset.fileName)}`;
      zip.file(path, asset.bytes, { date: fixedDate, binary: true });
      return { path, sha256: asset.sha256, assetId: asset.id, assetVersion: asset.version };
    });
    const manifest = ExportManifestSchema.parse({
      exportId: payload.exportId,
      tenantId: envelope.tenantId,
      platform: snapshot.platform,
      listingId: snapshot.listingId,
      listingVersionId: snapshot.listingVersionId,
      ruleVersion: snapshot.ruleVersion,
      files,
      createdBy: envelope.requestedBy,
      createdAt,
    });
    zip.file("manifest.json", JSON.stringify(manifest, null, 2), { date: fixedDate });
    const body = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 }, platform: "UNIX" });
    const sha256 = checksum(body);
    const objectKey = `tenants/${envelope.tenantId}/exports/${payload.exportId}/${sha256}.zip`;
    await this.packages.save(context, { exportId: payload.exportId, objectKey, body, sha256, manifest, immutable: true });
    return { exportId: payload.exportId, objectKey, sha256, byteSize: body.byteLength, manifest };
  }
}

function assertExportableAssets(assets: readonly ExportAssetSnapshot[]) {
  for (const asset of assets) {
    if (asset.domain === "research") throw new ResearchAssetExportError(asset.id);
    if (asset.rightsStatus !== "approved") throw new UnapprovedAssetExportError(asset.id);
    if (checksum(asset.bytes) !== asset.sha256) throw new AssetChecksumMismatchError(asset.id);
  }
}

function checksum(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
function safeName(fileName: string) { const sanitized = fileName.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""); return sanitized || "asset.bin"; }
