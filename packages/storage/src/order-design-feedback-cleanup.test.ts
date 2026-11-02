import { DeleteObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectVersionsCommand, type S3Client } from "@aws-sdk/client-s3";
import type { TenantContext } from "@yummyai/contracts";
import { describe, expect, it, vi } from "vitest";
import { Storage } from "./storage.js";
const tenantId = "019b0000-0000-7000-8000-000000000001", attachmentId = "019b0000-0000-7000-8000-000000000002";
const context: TenantContext = { tenantId, userId: "019b0000-0000-7000-8000-000000000003", permissions: ["asset:read", "order:pii:read"], dataScope: "tenant" };
const key = `tenants/${tenantId}/order/${"a".repeat(64)}/${attachmentId}-revision-feedback.pe`;
const missing = () => Object.assign(new Error("Synthetic absence"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
describe("Private operator revision feedback cleanup", () => {
  it("cannot delete buyer originals, response checkpoints, a foreign tenant or an unowned object", async () => {
    const send = vi.fn(), storage = new Storage({ send } as unknown as S3Client, "synthetic");
    for (const objectKey of [key.replace("revision-feedback.pe", "response-quarantine.pe"), key.replace("-revision-feedback", ""),
      key.replace(tenantId, attachmentId), `${key}/extra`, key.replace("/order/", "/authorized/")]) {
      await expect(storage.discardOrderDesignFeedback(context, attachmentId, objectKey, { assertCurrent: async () => undefined })).rejects.toThrow();
      await expect(storage.purgeExpiredOrderDesignFeedback({ tenantId, attachmentId, objectKey }, { assertExpired: async () => undefined })).rejects.toThrow();
    }
    await expect(storage.discardOrderDesignFeedback({ ...context, permissions: [] }, attachmentId, key, { assertCurrent: async () => undefined })).rejects.toThrow();
    await expect(storage.purgeExpiredOrderDesignFeedback({ tenantId, attachmentId, objectKey: key }, { assertExpired: async () => { throw new Error("live_order"); } })).rejects.toThrow("live_order");
    expect(send).not.toHaveBeenCalled();
  });
  it("purges exact data versions before markers, preserving neighboring objects and rechecking expiry", async () => {
    let listed = 0;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadBucketCommand || command instanceof DeleteObjectCommand) return {};
      if (command instanceof HeadObjectCommand) throw missing();
      if (command instanceof ListObjectVersionsCommand) return ++listed === 1 ? { IsTruncated: false,
        Versions: [{ Key: key, VersionId: "v1" }, { Key: `${key}-neighbor`, VersionId: "keep" }], DeleteMarkers: [{ Key: key, VersionId: "marker" }] } : { IsTruncated: false };
      throw new Error("Unexpected storage call");
    });
    const storage = new Storage({ send } as unknown as S3Client, "synthetic"), assertExpired = vi.fn(async () => undefined);
    await storage.purgeExpiredOrderDesignFeedback({ tenantId, attachmentId, objectKey: key }, { assertExpired });
    const deletes = send.mock.calls.map(([command]) => command).filter((command): command is DeleteObjectCommand => command instanceof DeleteObjectCommand);
    expect(deletes.map(command => command.input)).toEqual([{ Bucket: "synthetic", Key: key, VersionId: "v1" }, { Bucket: "synthetic", Key: key, VersionId: "marker" }]);
    expect(assertExpired.mock.calls.length).toBeGreaterThan(2);
  });
  it("does not report a successful purge when object absence is unconfirmed", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ListObjectVersionsCommand) return { IsTruncated: false };
      if (command instanceof HeadObjectCommand) throw Object.assign(new Error("Unavailable"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
      return {};
    });
    const storage = new Storage({ send } as unknown as S3Client, "synthetic");
    await expect(storage.purgeExpiredOrderDesignFeedback({ tenantId, attachmentId, objectKey: key }, { assertExpired: async () => undefined })).rejects.toThrow();
  });
});
