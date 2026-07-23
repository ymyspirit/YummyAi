import { createHash } from "node:crypto";

import { createEntityId, type RecordCustomizationFileScanInput } from "@yummyai/contracts";
import { createTraceId, type JobEnvelope } from "@yummyai/jobs";
import type { Storage } from "@yummyai/storage";
import { describe, expect, it, vi } from "vitest";

import {
  CustomizationFileScanProcessor,
  type CustomizationFileScanRepository,
  type MalwareScanner,
} from "./customization-file-scan.processor.js";

const body = Uint8Array.from([1, 2, 3, 4]);

describe("customization file scan processor", () => {
  const intakeId = createEntityId();

  it("reads only the tenant quarantine object and records clean evidence", async () => {
    const repository = fakeRepository();
    const storage = { readPrivate: vi.fn(async () => body) } as unknown as Storage;
    const scanner = fakeScanner(async () => evidence("clean"));
    await expect(new CustomizationFileScanProcessor(repository, storage, scanner).process(envelope({ intakeId })))
      .resolves.toEqual({ intakeId, status: "clean" });
    expect(storage.readPrivate).toHaveBeenCalledWith(expect.objectContaining({ dataScope: "tenant" }), expect.objectContaining({ assetDomain: "quarantine" }), { requiredDomain: "quarantine" });
    expect(repository.record).toHaveBeenCalledWith(expect.anything(), intakeId, expect.objectContaining({ result: "clean", engine: "clamav-clamd" }));
  });

  it("records integrity failure and never sends altered bytes to the scanner", async () => {
    const repository = fakeRepository({ checksumSha256: "0".repeat(64) });
    const storage = { readPrivate: vi.fn(async () => body) } as unknown as Storage;
    const scanner = fakeScanner(async () => evidence("clean"));
    await expect(new CustomizationFileScanProcessor(repository, storage, scanner).process(envelope({ intakeId }))).rejects.toThrow(/integrity/);
    expect(scanner.scan).not.toHaveBeenCalled();
    expect(repository.record).toHaveBeenCalledWith(expect.anything(), intakeId, expect.objectContaining({ result: "failed", engine: "integrity-check" }));
  });

  it("records scanner outages as retryable failed evidence", async () => {
    const repository = fakeRepository();
    const storage = { readPrivate: vi.fn(async () => body) } as unknown as Storage;
    const scanner = fakeScanner(async () => { throw new Error("clamd unavailable"); });
    await expect(new CustomizationFileScanProcessor(repository, storage, scanner).process(envelope({ intakeId }))).rejects.toThrow("clamd unavailable");
    expect(repository.record).toHaveBeenCalledWith(expect.anything(), intakeId, expect.objectContaining({ result: "failed", signatureVersion: "unavailable" }));
  });

  it("rejects job payloads that contain private object metadata", async () => {
    const repository = fakeRepository();
    const storage = { readPrivate: vi.fn(async () => body) } as unknown as Storage;
    await expect(new CustomizationFileScanProcessor(repository, storage, fakeScanner(async () => evidence("clean"))).process(envelope({ intakeId, objectKey: "private", fileName: "buyer.png" }))).rejects.toThrow();
    expect(repository.claim).not.toHaveBeenCalled();
  });
});

function fakeRepository(overrides: Partial<{ byteSize: number; checksumSha256: string }> = {}): CustomizationFileScanRepository {
  return {
    claim: vi.fn(async (_context, id) => ({
      id, objectKey: `tenants/${createEntityId()}/quarantine/object`, safeFileName: "portrait.png", mediaType: "image/png",
      byteSize: overrides.byteSize ?? body.byteLength,
      checksumSha256: overrides.checksumSha256 ?? createHash("sha256").update(body).digest("hex"),
    })),
    record: vi.fn(async (): Promise<"recorded"> => "recorded"),
  };
}

function fakeScanner(scan: MalwareScanner["scan"]): MalwareScanner {
  return { engine: "clamav-clamd", scan: vi.fn(scan) };
}

function evidence(result: RecordCustomizationFileScanInput["result"]): RecordCustomizationFileScanInput {
  return { result, engine: "clamav-clamd", signatureVersion: "ClamAV 1.4 / 27500", scannedAt: "2026-07-22T12:00:00.000Z" };
}

function envelope(payload: Record<string, unknown>): JobEnvelope {
  const correlationId = createEntityId();
  return {
    jobId: createEntityId(), tenantId: createEntityId(), requestedBy: createEntityId(), traceId: createTraceId(),
    correlationId, idempotencyKey: correlationId, requestedAt: new Date().toISOString(), attempt: 0, maxAttempts: 3, payload,
  };
}
