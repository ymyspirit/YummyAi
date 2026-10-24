import { DeleteObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectVersionsCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { FactoryErpSourcePurger, FactoryErpSourcePurgeError, type FactoryErpSourcePurgeTicket } from "./factory-erp-source-purger.js";

const tenantId = "019b0000-0000-7000-8000-000000000001", importId = "019b0000-0000-7000-8000-000000000002";
const ticket: FactoryErpSourcePurgeTicket = { tenantId, importId, storedChecksum: "a".repeat(64),
  objectKey: `tenants/${tenantId}/order/${"a".repeat(64)}/${importId}-factory-erp-source.pe`,
  leaseToken: "019b0000-0000-7000-8000-000000000003", leaseExpiresAt: "2001-01-01T00:00:00.000Z", attempts: 1 };
const missing = () => Object.assign(new Error("synthetic missing object"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
const errorCode = (code: string) => (error: unknown) => error instanceof FactoryErpSourcePurgeError && error.message === code && error.code === code;

describe("exact permanent factory ERP source purging", () => {
  it("deletes exact null/data versions before markers, follows both cursors, and verifies independently without deleting neighbors", async () => {
    let lists = 0;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadBucketCommand || command instanceof DeleteObjectCommand) return {};
      if (command instanceof HeadObjectCommand) throw missing();
      if (!(command instanceof ListObjectVersionsCommand)) throw new Error("Unexpected unit command");
      lists++;
      if (lists === 1) return { Versions: [{ Key: ticket.objectKey, VersionId: "v1" }, { Key: `${ticket.objectKey}-neighbor`, VersionId: "near" }],
        DeleteMarkers: [{ Key: ticket.objectKey, VersionId: "marker1" }], IsTruncated: true, NextKeyMarker: ticket.objectKey, NextVersionIdMarker: "cursor1" };
      if (lists === 2) return { Versions: [{ Key: ticket.objectKey, VersionId: "null" }], IsTruncated: false };
      return { IsTruncated: false };
    });
    const destroy = vi.fn(), purger = new FactoryErpSourcePurger({ send, destroy } as unknown as S3Client, "synthetic-bucket");
    await expect(purger.purge(ticket)).resolves.toEqual({ verifiedAbsent: true, deletedVersions: 3 });
    const deletions = send.mock.calls.map(([command]) => command).filter(command => command instanceof DeleteObjectCommand);
    expect(deletions.map(command => command.input)).toEqual(["v1", "null", "marker1"].map(VersionId => ({ Bucket: "synthetic-bucket", Key: ticket.objectKey, VersionId })));
    const requests = send.mock.calls.map(([command]) => command).filter(command => command instanceof ListObjectVersionsCommand);
    expect(requests[1]!.input).toMatchObject({ Prefix: ticket.objectKey, KeyMarker: ticket.objectKey, VersionIdMarker: "cursor1", MaxKeys: 100 });
    expect(requests[2]!.input).not.toHaveProperty("KeyMarker");
    expect(send.mock.calls.filter(([command]) => command instanceof HeadBucketCommand)).toHaveLength(2);
    purger.close(); expect(destroy).toHaveBeenCalledOnce();
  });

  it("recovers already absent bytes without relying on local lease wall time or issuing an unversioned delete", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ListObjectVersionsCommand) return { IsTruncated: false };
      if (command instanceof HeadObjectCommand) throw missing();
      if (command instanceof HeadBucketCommand) return {};
      throw new Error("An absent object must not be deleted again");
    });
    await expect(new FactoryErpSourcePurger({ send } as unknown as S3Client, "synthetic-bucket").purge(ticket))
      .resolves.toEqual({ verifiedAbsent: true, deletedVersions: 0 });
    expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(false);
  });

  it("rejects tenant, domain, import, checksum, receipt and lease identity mismatches before S3", async () => {
    const send = vi.fn(), purger = new FactoryErpSourcePurger({ send } as unknown as S3Client, "synthetic-bucket");
    for (const changed of [{ tenantId: importId }, { importId: tenantId }, { storedChecksum: "b".repeat(64) },
      { objectKey: `${ticket.objectKey}/extra` }, { objectKey: ticket.objectKey.replace("/order/", "/authorized/") },
      { leaseToken: "not-a-lease" }, { leaseExpiresAt: "invalid" }, { attempts: 0 }])
      await expect(purger.purge({ ...ticket, ...changed })).rejects.toSatisfy(errorCode("storage_delete_failed"));
    expect(send).not.toHaveBeenCalled();
  });

  it("does not translate access, Object Lock, MFA, bucket loss or unsupported version listings into success", async () => {
    for (const name of ["AccessDenied", "InvalidRequest", "NoSuchBucket", "NotImplemented", "ServiceUnavailable"]) {
      const send = vi.fn(async (command: unknown) => {
        if (command instanceof HeadBucketCommand) return {};
        throw Object.assign(new Error("synthetic private body must not escape"), { name, $metadata: { httpStatusCode: name === "NoSuchBucket" ? 404 : 403 } });
      });
      await expect(new FactoryErpSourcePurger({ send } as unknown as S3Client, "synthetic-bucket").purge(ticket))
        .rejects.toSatisfy(errorCode("storage_delete_failed"));
      expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(false);
    }
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadBucketCommand) return {};
      if (command instanceof ListObjectVersionsCommand) return { Versions: [{ Key: ticket.objectKey, VersionId: "retained" }], IsTruncated: false };
      throw Object.assign(new Error("synthetic object retention"), { name: "AccessDenied" });
    });
    await expect(new FactoryErpSourcePurger({ send } as unknown as S3Client, "synthetic-bucket").purge(ticket))
      .rejects.toSatisfy(errorCode("storage_delete_failed"));
    const deletion = send.mock.calls.map(([command]) => command).find(command => command instanceof DeleteObjectCommand)!;
    expect(deletion.input).not.toHaveProperty("BypassGovernanceRetention");
    expect(deletion.input).not.toHaveProperty("MFA");
  });

  it("refuses incomplete, cyclic, oversized or malformed version inventories before deleting anything", async () => {
    for (const mode of ["cycle", "limit", "version_missing", "oversized"] as const) {
      let page = 0;
      const send = vi.fn(async (command: unknown) => {
        if (command instanceof HeadBucketCommand) return {};
        if (!(command instanceof ListObjectVersionsCommand)) throw new Error("Inventory failure must precede deletion");
        page++;
        if (mode === "version_missing") return { Versions: [{ Key: ticket.objectKey }], IsTruncated: false };
        if (mode === "oversized") return { Versions: Array.from({ length: 101 }, (_, i) => ({ Key: ticket.objectKey, VersionId: `v${i}` })), IsTruncated: false };
        return { IsTruncated: true, NextKeyMarker: ticket.objectKey, NextVersionIdMarker: mode === "cycle" ? "same" : `page${page}` };
      });
      await expect(new FactoryErpSourcePurger({ send } as unknown as S3Client, "synthetic-bucket").purge(ticket))
        .rejects.toSatisfy(errorCode("storage_delete_failed"));
      expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(false);
      expect(page).toBeLessThanOrEqual(10);
    }
  });

  it("requires zero remaining versions and a genuine missing HeadObject, including a final live bucket check", async () => {
    for (const mode of ["remaining", "head_present", "head_denied", "head_bucket_missing", "bucket_vanished"] as const) {
      let lists = 0, buckets = 0;
      const send = vi.fn(async (command: unknown) => {
        if (command instanceof HeadBucketCommand) {
          if (++buckets === 2 && mode === "bucket_vanished") throw Object.assign(new Error("synthetic"), { name: "NoSuchBucket", $metadata: { httpStatusCode: 404 } });
          return {};
        }
        if (command instanceof ListObjectVersionsCommand) {
          lists++;
          return lists === 2 && mode === "remaining" ? { Versions: [{ Key: ticket.objectKey, VersionId: "new" }], IsTruncated: false } : { IsTruncated: false };
        }
        if (command instanceof HeadObjectCommand) {
          if (mode === "head_present") return {};
          if (mode === "head_denied" || mode === "head_bucket_missing") throw Object.assign(new Error("synthetic"), {
            name: mode === "head_denied" ? "AccessDenied" : "NoSuchBucket", $metadata: { httpStatusCode: mode === "head_denied" ? 403 : 404 } });
          throw missing();
        }
        throw new Error("Unexpected unit command");
      });
      await expect(new FactoryErpSourcePurger({ send } as unknown as S3Client, "synthetic-bucket").purge(ticket))
        .rejects.toSatisfy(errorCode("absence_unconfirmed"));
    }
  });

  it("passes AbortSignal to actual requests and waits for cancellation rather than claiming absence", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const send = vi.fn((command: unknown, options?: { abortSignal?: AbortSignal }) => {
      if (command instanceof HeadBucketCommand) return Promise.resolve({});
      started();
      return new Promise((_resolve, reject) => options?.abortSignal?.addEventListener("abort", () => reject(new Error("synthetic cancelled I/O")), { once: true }));
    });
    const pending = new FactoryErpSourcePurger({ send } as unknown as S3Client, "synthetic-bucket").purge(ticket, { signal: controller.signal });
    await ready; controller.abort();
    await expect(pending).rejects.toSatisfy(errorCode("storage_delete_failed"));
    expect(send.mock.calls.every(([, options]) => options?.abortSignal === controller.signal)).toBe(true);
    const before = send.mock.calls.length;
    await expect(new FactoryErpSourcePurger({ send } as unknown as S3Client, "synthetic-bucket").purge(ticket, { signal: controller.signal }))
      .rejects.toSatisfy(errorCode("storage_delete_failed"));
    expect(send.mock.calls).toHaveLength(before);
  });
});
