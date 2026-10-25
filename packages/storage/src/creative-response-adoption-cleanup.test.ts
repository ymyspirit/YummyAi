import { DeleteObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectVersionsCommand, type S3Client } from "@aws-sdk/client-s3";
import type { TenantContext } from "@yummyai/contracts";
import { describe, expect, it, vi } from "vitest";

import { Storage } from "./storage.js";

const context: TenantContext = {
  tenantId: "019b0000-0000-7000-8000-000000000001",
  userId: "019b0000-0000-7000-8000-000000000002",
  permissions: ["asset:read"], dataScope: "tenant",
};
const adoptionId = "019b0000-0000-7000-8000-000000000003", bucket = "synthetic-private-assets";
const keyFor = (extension = "png") => `tenants/${context.tenantId}/authorized/${"a".repeat(64)}/${adoptionId}-pod-output-0.${extension}`;
const key = keyFor();
const missing = () => Object.assign(new Error("Synthetic missing object"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
const failed = "CREATIVE_RESPONSE_ADOPTION_ARTIFACT_CLEANUP_FAILED";
const unconfirmed = "CREATIVE_RESPONSE_ADOPTION_ARTIFACT_ABSENCE_UNCONFIRMED";
const aborted = "CREATIVE_RESPONSE_ADOPTION_ARTIFACT_CLEANUP_ABORTED";
type Send = (command: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;
function fixture(implementation: Send) {
  const send = vi.fn(implementation);
  return { send, storage: new Storage({ send } as unknown as S3Client, bucket) };
}
function deletions(value: ReturnType<typeof fixture>) {
  return value.send.mock.calls.flatMap(([command]) => command instanceof DeleteObjectCommand ? [command.input] : []);
}

describe("exact creative response adoption artifact cleanup", () => {
  it.each(["png", "jpg", "webp", "tiff"])("verifies an already absent %s artifact without creating a delete marker", async extension => {
    const exactKey = keyFor(extension);
    const value = fixture(async command => {
      if (command instanceof HeadBucketCommand) return {};
      if (command instanceof ListObjectVersionsCommand) return { IsTruncated: false };
      if (command instanceof HeadObjectCommand) throw missing();
      throw new Error("An absent artifact needs no deletion");
    });
    await expect(value.storage.discardCreativeResponseAdoptionArtifact(context, adoptionId, exactKey)).resolves.toBeUndefined();
    expect(deletions(value)).toEqual([]);
    const lists = value.send.mock.calls.flatMap(([command]) => command instanceof ListObjectVersionsCommand ? [command.input] : []);
    expect(lists).toEqual([1, 2].map(() => ({ Bucket: bucket, Prefix: exactKey, MaxKeys: 100 })));
    expect(value.send.mock.calls.filter(([command]) => command instanceof HeadBucketCommand)).toHaveLength(2);
    expect(value.send.mock.calls.filter(([command]) => command instanceof HeadObjectCommand)).toHaveLength(2);
  });

  it("inventories all pages before mutation, deletes data/null versions before markers, and preserves adjacent keys", async () => {
    let lists = 0;
    const value = fixture(async command => {
      if (command instanceof HeadBucketCommand) return {};
      if (command instanceof HeadObjectCommand) throw missing();
      if (command instanceof DeleteObjectCommand) {
        expect(lists).toBeGreaterThanOrEqual(2);
        return {};
      }
      if (!(command instanceof ListObjectVersionsCommand)) throw new Error("Unexpected unit command");
      lists++;
      if (lists === 1) return { Name: bucket, Prefix: key, IsTruncated: true,
        Versions: [{ Key: key, VersionId: "v1/+==" }, { Key: `${key}-neighbor`, VersionId: "neighbor" }],
        DeleteMarkers: [{ Key: key, VersionId: "marker1" }], NextKeyMarker: key, NextVersionIdMarker: "cursor1" };
      if (lists === 2) return { IsTruncated: false, Versions: [{ Key: key, VersionId: "null" }] };
      return { IsTruncated: false, Versions: [{ Key: `${key}-neighbor`, VersionId: "neighbor" }] };
    });
    await expect(value.storage.discardCreativeResponseAdoptionArtifact(context, adoptionId, key)).resolves.toBeUndefined();
    expect(deletions(value)).toEqual(["v1/+==", "null", "marker1"].map(VersionId => ({ Bucket: bucket, Key: key, VersionId })));
    const listsSent = value.send.mock.calls.flatMap(([command]) => command instanceof ListObjectVersionsCommand ? [command.input] : []);
    expect(listsSent[1]).toEqual({ Bucket: bucket, Prefix: key, MaxKeys: 100, KeyMarker: key, VersionIdMarker: "cursor1" });
    expect(listsSent[2]).toEqual({ Bucket: bucket, Prefix: key, MaxKeys: 100 });
    expect(value.send.mock.calls.filter(([command]) => command instanceof HeadObjectCommand)).toHaveLength(1);
  });

  it("deletes an existing unversioned object by exact key and proves its subsequent absence", async () => {
    let exists = true;
    const value = fixture(async command => {
      if (command instanceof HeadBucketCommand) return {};
      if (command instanceof ListObjectVersionsCommand) return { IsTruncated: false };
      if (command instanceof HeadObjectCommand) { if (exists) return {}; throw missing(); }
      if (command instanceof DeleteObjectCommand) { exists = false; return {}; }
      throw new Error("Unexpected unit command");
    });
    await expect(value.storage.discardCreativeResponseAdoptionArtifact(context, adoptionId, key)).resolves.toBeUndefined();
    expect(deletions(value)).toEqual([{ Bucket: bucket, Key: key }]);
    expect(value.send.mock.calls.filter(([command]) => command instanceof ListObjectVersionsCommand)).toHaveLength(2);
    expect(value.send.mock.calls.filter(([command]) => command instanceof HeadObjectCommand)).toHaveLength(2);
  });

  it("deletes a marker-only inventory by its VersionId without issuing a marker-creating delete", async () => {
    let lists = 0;
    const value = fixture(async command => {
      if (command instanceof HeadBucketCommand || command instanceof DeleteObjectCommand) return {};
      if (command instanceof HeadObjectCommand) throw missing();
      if (command instanceof ListObjectVersionsCommand) return ++lists === 1
        ? { IsTruncated: false, DeleteMarkers: [{ Key: key, VersionId: "only-marker" }] } : { IsTruncated: false };
      throw new Error("Unexpected unit command");
    });
    await expect(value.storage.discardCreativeResponseAdoptionArtifact(context, adoptionId, key)).resolves.toBeUndefined();
    expect(deletions(value)).toEqual([{ Bucket: bucket, Key: key, VersionId: "only-marker" }]);
  });

  it.each([
    ["another tenant", adoptionId, key.replace(context.tenantId, adoptionId)],
    ["quarantine", adoptionId, key.replace("/authorized/", "/quarantine/")],
    ["research", adoptionId, key.replace("/authorized/", "/research/")],
    ["another adoption", context.userId, key],
    ["non UUIDv7", adoptionId.replace("-7000-", "-4000-"), key],
    ["uppercase UUID", adoptionId.replace("019b", "019B"), key],
    ["invalid UUID", "not-an-adoption", key],
    ["short checksum", adoptionId, key.replace("a".repeat(64), "a".repeat(63))],
    ["uppercase checksum", adoptionId, key.replace("a".repeat(64), "A".repeat(64))],
    ["extra path", adoptionId, `${key}/extra`],
    ["other artifact index", adoptionId, key.replace("-output-0.", "-output-1.")],
    ["zero-padded index", adoptionId, key.replace("-output-0.", "-output-00.")],
    ["unreserved filename", adoptionId, key.replace(`${adoptionId}-pod-output-0.png`, "artwork.png")],
    ["unsupported extension", adoptionId, keyFor("svg")],
    ["long extension", adoptionId, keyFor("jpeg")],
    ["encoded filename", adoptionId, key.replace("-pod-output-0", "%2Dpod-output-0")],
  ])("rejects %s before S3", async (_label, id, objectKey) => {
    const value = fixture(async () => ({}));
    await expect(value.storage.discardCreativeResponseAdoptionArtifact(context, id!, objectKey!)).rejects.toThrow();
    expect(value.send).not.toHaveBeenCalled();
  });

  it("does not grant authorized asset access through a write-only context", async () => {
    const value = fixture(async () => ({}));
    for (const permissions of [[], ["asset:write"]]) {
      await expect(value.storage.discardCreativeResponseAdoptionArtifact({ ...context, permissions }, adoptionId, key)).rejects.toThrow();
    }
    expect(value.send).not.toHaveBeenCalled();
  });

  it.each([{ VersionId: "new-version" }, { VersionId: "null" }, { DeleteMarker: true }])(
    "does not hide a newly appeared version when the initial inventory was empty: %j", async head => {
      const value = fixture(async command => {
        if (command instanceof HeadBucketCommand) return {};
        if (command instanceof ListObjectVersionsCommand) return { IsTruncated: false };
        if (command instanceof HeadObjectCommand) return head;
        throw new Error("No destructive request is allowed");
      });
      await expect(value.storage.discardCreativeResponseAdoptionArtifact(context, adoptionId, key)).rejects.toThrow(failed);
      expect(deletions(value)).toEqual([]);
    });

  it.each(["missing_truncated", "invalid_truncated", "wrong_bucket", "wrong_prefix", "common_prefix", "common_prefix_not_array", "versions_not_array", "markers_not_array",
    "missing_key", "outside_prefix", "missing_version", "empty_version", "long_version", "duplicate", "duplicate_across_pages",
    "missing_cursor", "outside_cursor", "invalid_version_cursor", "long_version_cursor", "cycle", "oversized", "page_limit"] as const)(
    "refuses a malformed or unbounded inventory before deleting: %s", async mode => {
      let lists = 0;
      const value = fixture(async command => {
        if (command instanceof HeadBucketCommand) return {};
        if (!(command instanceof ListObjectVersionsCommand)) throw new Error("Inventory must finish before mutation");
        lists++;
        switch (mode) {
          case "missing_truncated": return {};
          case "invalid_truncated": return { IsTruncated: "false" };
          case "wrong_bucket": return { IsTruncated: false, Name: "another-bucket" };
          case "wrong_prefix": return { IsTruncated: false, Prefix: `${key}-other` };
          case "common_prefix": return { IsTruncated: false, CommonPrefixes: [{ Prefix: `${key}/` }] };
          case "common_prefix_not_array": return { IsTruncated: false, CommonPrefixes: {} };
          case "versions_not_array": return { IsTruncated: false, Versions: {} };
          case "markers_not_array": return { IsTruncated: false, DeleteMarkers: {} };
          case "missing_key": return { IsTruncated: false, Versions: [{ VersionId: "v1" }] };
          case "outside_prefix": return { IsTruncated: false, Versions: [{ Key: "unrelated", VersionId: "v1" }] };
          case "missing_version": return { IsTruncated: false, Versions: [{ Key: key }] };
          case "empty_version": return { IsTruncated: false, Versions: [{ Key: key, VersionId: "" }] };
          case "long_version": return { IsTruncated: false, Versions: [{ Key: key, VersionId: "v".repeat(1025) }] };
          case "duplicate": return { IsTruncated: false, Versions: [{ Key: key, VersionId: "v1" }], DeleteMarkers: [{ Key: key, VersionId: "v1" }] };
          case "duplicate_across_pages": return lists === 1
            ? { IsTruncated: true, Versions: [{ Key: key, VersionId: "v1" }], NextKeyMarker: key, NextVersionIdMarker: "cursor1" }
            : { IsTruncated: false, Versions: [{ Key: key, VersionId: "v1" }] };
          case "missing_cursor": return { IsTruncated: true };
          case "outside_cursor": return { IsTruncated: true, NextKeyMarker: "unrelated" };
          case "invalid_version_cursor": return { IsTruncated: true, NextKeyMarker: key, NextVersionIdMarker: 42 };
          case "long_version_cursor": return { IsTruncated: true, NextKeyMarker: key, NextVersionIdMarker: "v".repeat(1025) };
          case "oversized": return { IsTruncated: false, Versions: Array.from({ length: 101 }, (_, i) => ({ Key: key, VersionId: `v${i}` })) };
          case "cycle": return { IsTruncated: true, NextKeyMarker: key, NextVersionIdMarker: "same" };
          case "page_limit": return { IsTruncated: true, Versions: Array.from({ length: 100 }, (_, i) => ({ Key: key, VersionId: `v${lists}-${i}` })),
            NextKeyMarker: key, NextVersionIdMarker: `cursor${lists}` };
        }
      });
      await expect(value.storage.discardCreativeResponseAdoptionArtifact(context, adoptionId, key)).rejects.toThrow(failed);
      expect(deletions(value)).toEqual([]);
      expect(lists).toBeLessThanOrEqual(10);
      if (mode === "page_limit") expect(lists).toBe(10);
    });

  it.each(["AccessDenied", "NoSuchBucket", "NotImplemented", "ServiceUnavailable"])(
    "does not fall back to an unversioned delete when listing fails: %s", async name => {
      const value = fixture(async command => {
        if (command instanceof HeadBucketCommand) return {};
        throw Object.assign(new Error("Synthetic private server text"), { name, $metadata: { httpStatusCode: name === "NoSuchBucket" ? 404 : 403 } });
      });
      await expect(value.storage.discardCreativeResponseAdoptionArtifact(context, adoptionId, key)).rejects.toThrow(failed);
      expect(deletions(value)).toEqual([]);
      expect(value.send.mock.calls.some(([command]) => command instanceof HeadObjectCommand)).toBe(false);
    });

  it("fails on a data-version delete without bypassing Object Lock or removing its marker", async () => {
    const value = fixture(async command => {
      if (command instanceof HeadBucketCommand) return {};
      if (command instanceof ListObjectVersionsCommand) return { IsTruncated: false,
        Versions: [{ Key: key, VersionId: "retained" }], DeleteMarkers: [{ Key: key, VersionId: "keep-marker" }] };
      throw Object.assign(new Error("Synthetic private retention error"), { name: "AccessDenied" });
    });
    await expect(value.storage.discardCreativeResponseAdoptionArtifact(context, adoptionId, key)).rejects.toThrow(failed);
    expect(deletions(value)).toEqual([{ Bucket: bucket, Key: key, VersionId: "retained" }]);
  });

  it.each(["data", "marker"])("does not claim completion when a %s version remains after deletion", async kind => {
    let lists = 0;
    const value = fixture(async command => {
      if (command instanceof HeadBucketCommand || command instanceof DeleteObjectCommand) return {};
      if (command instanceof ListObjectVersionsCommand) {
        if (++lists === 1) return { IsTruncated: false, Versions: [{ Key: key, VersionId: "v1" }] };
        return kind === "data" ? { IsTruncated: false, Versions: [{ Key: key, VersionId: "late" }] }
          : { IsTruncated: false, DeleteMarkers: [{ Key: key, VersionId: "late-marker" }] };
      }
      throw new Error("A residual version must prevent success");
    });
    await expect(value.storage.discardCreativeResponseAdoptionArtifact(context, adoptionId, key)).rejects.toThrow(unconfirmed);
    expect(deletions(value)).toEqual([{ Bucket: bucket, Key: key, VersionId: "v1" }]);
  });

  it("requires a complete second paginated inventory rather than checking only its first page", async () => {
    let lists = 0;
    const value = fixture(async command => {
      if (command instanceof HeadBucketCommand || command instanceof DeleteObjectCommand) return {};
      if (command instanceof ListObjectVersionsCommand) {
        lists++;
        if (lists === 1) return { IsTruncated: false, Versions: [{ Key: key, VersionId: "v1" }] };
        if (lists === 2) return { IsTruncated: true, NextKeyMarker: key, NextVersionIdMarker: "verify-cursor" };
        return { IsTruncated: false, DeleteMarkers: [{ Key: key, VersionId: "hidden-on-page-two" }] };
      }
      throw new Error("Residual markers must prevent a success HEAD");
    });
    await expect(value.storage.discardCreativeResponseAdoptionArtifact(context, adoptionId, key)).rejects.toThrow(unconfirmed);
    const listInputs = value.send.mock.calls.flatMap(([command]) => command instanceof ListObjectVersionsCommand ? [command.input] : []);
    expect(listInputs[2]).toEqual({ Bucket: bucket, Prefix: key, MaxKeys: 100, KeyMarker: key, VersionIdMarker: "verify-cursor" });
  });

  it.each(["present", "denied", "bucket_missing", "404_without_name", "name_without_404", "final_bucket_missing", "verify_listing_failed"] as const)(
    "requires genuine object absence and a live bucket at verification: %s", async mode => {
      let lists = 0, buckets = 0;
      const value = fixture(async command => {
        if (command instanceof HeadBucketCommand) {
          if (++buckets === 2 && mode === "final_bucket_missing") throw Object.assign(new Error("Synthetic"), { name: "NoSuchBucket", $metadata: { httpStatusCode: 404 } });
          return {};
        }
        if (command instanceof DeleteObjectCommand) return {};
        if (command instanceof ListObjectVersionsCommand) {
          if (++lists === 1) return { IsTruncated: false, Versions: [{ Key: key, VersionId: "v1" }] };
          if (mode === "verify_listing_failed") throw new Error("Synthetic private listing error");
          return { IsTruncated: false };
        }
        if (command instanceof HeadObjectCommand) {
          if (mode === "present") return {};
          if (mode === "denied") throw Object.assign(new Error("Synthetic"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
          if (mode === "bucket_missing") throw Object.assign(new Error("Synthetic"), { name: "NoSuchBucket", $metadata: { httpStatusCode: 404 } });
          if (mode === "404_without_name") throw Object.assign(new Error("Synthetic"), { $metadata: { httpStatusCode: 404 } });
          if (mode === "name_without_404") throw Object.assign(new Error("Synthetic"), { name: "NotFound" });
          throw missing();
        }
        throw new Error("Unexpected unit command");
      });
      await expect(value.storage.discardCreativeResponseAdoptionArtifact(context, adoptionId, key)).rejects.toThrow(unconfirmed);
    });

  it("does not mistake a marker created during an unversioned-delete race for successful cleanup", async () => {
    let lists = 0, deleted = false;
    const value = fixture(async command => {
      if (command instanceof HeadBucketCommand) return {};
      if (command instanceof ListObjectVersionsCommand) return ++lists === 1 ? { IsTruncated: false }
        : { IsTruncated: false, DeleteMarkers: [{ Key: key, VersionId: "new-marker" }] };
      if (command instanceof HeadObjectCommand) return {};
      if (command instanceof DeleteObjectCommand) { deleted = true; return {}; }
      throw new Error("Unexpected unit command");
    });
    await expect(value.storage.discardCreativeResponseAdoptionArtifact(context, adoptionId, key)).rejects.toThrow(unconfirmed);
    expect(deleted).toBe(true);
    expect(deletions(value)).toEqual([{ Bucket: bucket, Key: key }]);
  });

  it("does not access S3 when cancellation was already requested", async () => {
    const controller = new AbortController(); controller.abort("Synthetic private reason");
    const value = fixture(async () => ({}));
    await expect(value.storage.discardCreativeResponseAdoptionArtifact(context, adoptionId, key, { signal: controller.signal })).rejects.toThrow(aborted);
    expect(value.send).not.toHaveBeenCalled();
  });

  it.each(["bucket", "inventory", "delete", "verify_inventory", "verify_head", "verify_bucket"] as const)(
    "checks cancellation after %s I/O and never claims success", async stage => {
      const controller = new AbortController(); let lists = 0, buckets = 0;
      const value = fixture(async command => {
        if (command instanceof HeadBucketCommand) {
          const current = ++buckets === 1 ? "bucket" : "verify_bucket";
          if (stage === current) controller.abort("Synthetic private reason");
          return {};
        }
        if (command instanceof ListObjectVersionsCommand) {
          const first = ++lists === 1;
          if (stage === (first ? "inventory" : "verify_inventory")) controller.abort();
          return first ? { IsTruncated: false, Versions: [{ Key: key, VersionId: "v1" }] } : { IsTruncated: false };
        }
        if (command instanceof DeleteObjectCommand) { if (stage === "delete") controller.abort(); return {}; }
        if (command instanceof HeadObjectCommand) { if (stage === "verify_head") controller.abort(); throw missing(); }
        throw new Error("Unexpected unit command");
      });
      await expect(value.storage.discardCreativeResponseAdoptionArtifact(context, adoptionId, key, { signal: controller.signal })).rejects.toThrow(aborted);
      expect(value.send.mock.calls.every(([, options]) => options?.abortSignal === controller.signal)).toBe(true);
      expect(value.send.mock.calls).toHaveLength({ bucket: 1, inventory: 2, delete: 3, verify_inventory: 4, verify_head: 5, verify_bucket: 6 }[stage]);
    });

  it("propagates AbortSignal to an in-flight request and awaits its rejection", async () => {
    const controller = new AbortController(); let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const value = fixture((command, options) => {
      if (command instanceof HeadBucketCommand) return Promise.resolve({});
      started();
      return new Promise((_resolve, reject) => options?.abortSignal?.addEventListener("abort", () => reject(new Error("Synthetic cancelled request")), { once: true }));
    });
    const pending = value.storage.discardCreativeResponseAdoptionArtifact(context, adoptionId, key, { signal: controller.signal });
    const result = expect(pending).rejects.toThrow(aborted);
    await ready; controller.abort(); await result;
    expect(value.send.mock.calls).toHaveLength(2);
    expect(value.send.mock.calls.every(([, options]) => options?.abortSignal === controller.signal)).toBe(true);
    expect(deletions(value)).toEqual([]);
  });
});
