import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createEntityId, type ExportManifest } from "@yummyai/contracts";
import type { JobEnvelope } from "@yummyai/jobs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  AssetChecksumMismatchError,
  ExportProcessor,
  ResearchAssetExportError,
  type ApprovedExportSnapshot,
  type ExportPackageStore,
  type ExportSnapshotRepository,
} from "./export.processor.js";

const ids = { job: createEntityId(), tenant: createEntityId(), user: createEntityId(), correlation: createEntityId(), idempotency: createEntityId(), export: createEntityId(), review: createEntityId(), listing: createEntityId(), version: createEntityId(), asset: createEntityId() };

describe("export processor", () => {
  it("rejects an export that references a research-domain media file", async () => {
    const snapshot = validSnapshot(); snapshot.assets[0]!.domain = "research";
    await expect(processor(snapshot).process(envelope())).rejects.toBeInstanceOf(ResearchAssetExportError);
  });

  it("rejects bytes that differ from the approved asset checksum", async () => {
    const snapshot = validSnapshot(); snapshot.assets[0]!.bytes = new TextEncoder().encode("tampered");
    await expect(processor(snapshot).process(envelope())).rejects.toBeInstanceOf(AssetChecksumMismatchError);
  });

  it("creates an immutable ZIP with a pinned manifest and matching file checksums", async () => {
    const store = new MemoryPackageStore(); const result = await processor(validSnapshot(), store).process(envelope());
    expect(store.saved?.immutable).toBe(true);
    expect(store.saved?.objectKey).toContain(result.sha256);
    expect(result.manifest).toMatchObject({ exportId: ids.export, listingVersionId: ids.version, ruleVersion: "amazon-us-2026-07" });
    const zip = await JSZip.loadAsync(store.saved!.body);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as ExportManifest;
    const media = await zip.file(manifest.files[0]!.path)!.async("uint8array");
    expect(sha(media)).toBe(manifest.files[0]!.sha256);
    expect(manifest.files[0]).toMatchObject({ assetId: ids.asset, assetVersion: 3 });

    const artifact = resolve(import.meta.dirname, "../../../../.artifacts/sample-export.zip");
    await mkdir(resolve(artifact, ".."), { recursive: true });
    await writeFile(artifact, store.saved!.body);
  });
});

class MemoryPackageStore implements ExportPackageStore {
  saved?: Parameters<ExportPackageStore["save"]>[1];
  async save(_context: { tenantId: string; userId: string }, input: Parameters<ExportPackageStore["save"]>[1]) { this.saved = input; }
}

function processor(snapshot: ApprovedExportSnapshot, store: ExportPackageStore = new MemoryPackageStore()) {
  const repository: ExportSnapshotRepository = { load: async () => snapshot };
  return new ExportProcessor(repository, store);
}

function envelope(): JobEnvelope { return { jobId: ids.job, tenantId: ids.tenant, requestedBy: ids.user, traceId: "23456789abcdef0123456789abcdef01", correlationId: ids.correlation, idempotencyKey: ids.idempotency, requestedAt: "2026-07-18T04:00:00.000Z", attempt: 0, maxAttempts: 3, payload: { exportId: ids.export, reviewId: ids.review, listingId: ids.listing, listingVersionId: ids.version } }; }

function validSnapshot(): ApprovedExportSnapshot & { assets: Array<ApprovedExportSnapshot["assets"][number]> } {
  const bytes = new TextEncoder().encode("approved image bytes");
  return { reviewId: ids.review, reviewStatus: "approved", platform: "amazon", listingId: ids.listing, listingVersionId: ids.version, ruleVersion: "amazon-us-2026-07", content: { title: "Personalized travel mug" }, assets: [{ id: ids.asset, version: 3, domain: "authorized", rightsStatus: "approved", fileName: "main image.png", mediaType: "image/png", sha256: sha(bytes), bytes }] };
}

function sha(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
