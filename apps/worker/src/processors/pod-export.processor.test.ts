import { createHash } from "node:crypto";

import { createEntityId } from "@yummyai/contracts";
import type { JobEnvelope } from "@yummyai/jobs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  PodExportPolicyError,
  PodExportProcessor,
  buildPodExportPackage,
  type PodExportPackageStorage,
  type PodExportRepository,
  type PodExportSnapshot,
} from "./pod-export.processor.js";

describe("POD immutable export", () => {
  it("builds a deterministic package with pinned provenance", async () => {
    const first = await buildPodExportPackage(snapshot(), ids.tenant);
    const second = await buildPodExportPackage(snapshot(), ids.tenant);
    expect(Buffer.from(first.body).equals(Buffer.from(second.body))).toBe(true);
    const zip = await JSZip.loadAsync(first.body);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      exportId: ids.export,
      taskId: ids.task,
      designVersionId: ids.version,
      toolKey: "pattern_crop",
      modelKey: "pod.crop.v1",
    });
    expect(Object.keys(zip.files)).toContain(`artwork/${ids.asset}-v1-result.png`);
  });

  it("fails closed before storage when an output loses rights approval", async () => {
    const source = snapshot();
    source.files[0]!.rightsStatus = "rejected";
    const repository = memoryRepository(source);
    const storage = memoryStorage();
    await expect(new PodExportProcessor(repository, storage).process(envelope()))
      .rejects.toBeInstanceOf(PodExportPolicyError);
    expect(storage.called).toBe(false);
    expect(repository.failure).toMatchObject({ terminal: true, code: "EXPORT_POLICY_BLOCKED" });
  });

  it("stores once and completes the immutable export record", async () => {
    const repository = memoryRepository(snapshot());
    const storage = memoryStorage();
    await expect(new PodExportProcessor(repository, storage).process(envelope()))
      .resolves.toMatchObject({ disposition: "completed" });
    expect(storage.called).toBe(true);
    expect(repository.completed?.manifest.files).toHaveLength(1);
  });
});

const ids = {
  export: "019f0000-0000-7000-8000-000000000001",
  tenant: "019f0000-0000-7000-8000-000000000002",
  user: "019f0000-0000-7000-8000-000000000003",
  task: "019f0000-0000-7000-8000-000000000004",
  designTask: "019f0000-0000-7000-8000-000000000005",
  version: "019f0000-0000-7000-8000-000000000006",
  asset: "019f0000-0000-7000-8000-000000000007",
  input: "019f0000-0000-7000-8000-000000000008",
};

function snapshot(): PodExportSnapshot {
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  return {
    exportId: ids.export,
    taskId: ids.task,
    designTaskId: ids.designTask,
    designVersionId: ids.version,
    taskStatus: "approved",
    designVersionStatus: "approved",
    toolKey: "pattern_crop",
    modelKey: "pod.crop.v1",
    modelVersion: "2026-08-03",
    seed: "17",
    qualityCheckSnapshot: { passed: true },
    createdAt: new Date("2026-08-03T08:00:00.000Z"),
    requestedBy: ids.user,
    inputAssets: [{ assetId: ids.input, assetVersion: 2, checksumSha256: "b".repeat(64) }],
    files: [{
      assetId: ids.asset,
      assetVersion: 1,
      domain: "authorized",
      rightsStatus: "approved",
      fileName: "result.png",
      mediaType: "image/png",
      checksumSha256: checksum(bytes),
      bytes,
    }],
  };
}

function memoryRepository(source: PodExportSnapshot): PodExportRepository & {
  completed?: { manifest: { files: unknown[] } };
  failure?: { terminal: boolean; code: string; message: string };
} {
  const repository: PodExportRepository & {
    completed?: { manifest: { files: unknown[] } };
    failure?: { terminal: boolean; code: string; message: string };
  } = {
    claimAndLoad: async () => source,
    complete: async (_context, _id, result) => { repository.completed = result; },
    fail: async (_context, _id, input) => { repository.failure = input; },
  };
  return repository;
}

function memoryStorage(): PodExportPackageStorage & { called: boolean } {
  const storage: PodExportPackageStorage & { called: boolean } = {
    called: false,
    putPrivate: async (_context, input) => {
      storage.called = true;
      return { objectKey: `tenants/${ids.tenant}/authorized/${checksum(input.body)}/${ids.export}.zip`, checksumSha256: checksum(input.body) };
    },
  };
  return storage;
}

function envelope(): JobEnvelope {
  return {
    jobId: createEntityId(),
    tenantId: ids.tenant,
    requestedBy: ids.user,
    traceId: "0123456789abcdef0123456789abcdef",
    correlationId: ids.export,
    idempotencyKey: ids.export,
    requestedAt: "2026-08-03T08:00:00.000Z",
    attempt: 0,
    maxAttempts: 3,
    payload: { exportId: ids.export },
  };
}

function checksum(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
