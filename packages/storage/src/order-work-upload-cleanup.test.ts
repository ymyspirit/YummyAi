import { DeleteObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectVersionsCommand, type S3Client } from "@aws-sdk/client-s3";
import type { TenantContext } from "@yummyai/contracts";
import { describe, expect, it, vi } from "vitest";
import { Storage } from "./storage.js";

const context: TenantContext = { tenantId: "019b0000-0000-7000-8000-000000000001",
  userId: "019b0000-0000-7000-8000-000000000002", permissions: ["asset:read", "order:pii:read"], dataScope: "tenant" };
const imageId = "019b0000-0000-7000-8000-000000000003";
const key = `tenants/${context.tenantId}/order/${"a".repeat(64)}/${imageId}.pe`;
const missing = () => Object.assign(new Error("synthetic missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });

describe("unregistered order work upload cleanup", () => {
  it("rejects other tenants, domains, identities and filenames before storage I/O", async () => {
    const send = vi.fn(), storage = new Storage({ send } as unknown as S3Client, "synthetic");
    for (const invalid of [key.replace(context.tenantId, imageId), key.replace("/order/", "/authorized/"),
      key.replace(`${imageId}.pe`, "buyer.png"), key.replace(imageId + ".pe", context.userId + ".pe"), `${key}/extra`])
      await expect(storage.discardOrderWorkUpload(context, imageId, invalid, { assertCurrent: async () => undefined })).rejects.toThrow();
    await expect(storage.discardOrderWorkUpload({ ...context, permissions: ["asset:read"] }, imageId, key,
      { assertCurrent: async () => undefined })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("never accesses storage when the owner finds a committed reference", async () => {
    const send = vi.fn(), storage = new Storage({ send } as unknown as S3Client, "synthetic");
    await expect(storage.discardOrderWorkUpload(context, imageId, key, { assertCurrent: async () => { throw new Error("registered"); } })).rejects.toThrow("registered");
    expect(send).not.toHaveBeenCalled();
  });

  it.each([key, key.replace(`${imageId}.pe`, `${imageId}-preview.pe`)])("deletes and verifies only the unversioned object %s", async exactKey => {
    let exists = true;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadBucketCommand) return {};
      if (command instanceof ListObjectVersionsCommand) return { IsTruncated: false };
      if (command instanceof HeadObjectCommand) { if (exists) return {}; throw missing(); }
      if (command instanceof DeleteObjectCommand) { expect(command.input).toEqual({ Bucket: "synthetic", Key: exactKey }); exists = false; return {}; }
      throw new Error("unexpected command");
    });
    const assertCurrent = vi.fn(async () => undefined), storage = new Storage({ send } as unknown as S3Client, "synthetic");
    await storage.discardOrderWorkUpload(context, imageId, exactKey, { assertCurrent });
    expect(exists).toBe(false);
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });

  it("removes exact data versions before delete markers and leaves adjacent objects alone", async () => {
    let listed = 0;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadBucketCommand || command instanceof DeleteObjectCommand) return {};
      if (command instanceof HeadObjectCommand) throw missing();
      if (command instanceof ListObjectVersionsCommand) return ++listed === 1 ? { IsTruncated: false,
        Versions: [{ Key: key, VersionId: "v1" }, { Key: `${key}-neighbor`, VersionId: "keep" }],
        DeleteMarkers: [{ Key: key, VersionId: "marker" }] } : { IsTruncated: false };
      throw new Error("unexpected command");
    });
    const storage = new Storage({ send } as unknown as S3Client, "synthetic");
    await storage.discardOrderWorkUpload(context, imageId, key, { assertCurrent: async () => undefined });
    expect(send.mock.calls.flatMap(([command]) => command instanceof DeleteObjectCommand ? [command.input] : [])).toEqual([
      { Bucket: "synthetic", Key: key, VersionId: "v1" }, { Bucket: "synthetic", Key: key, VersionId: "marker" },
    ]);
  });

  it("reports cleanup as unconfirmed when the exact object remains", async () => {
    const send = vi.fn(async (command: unknown) => command instanceof ListObjectVersionsCommand ? { IsTruncated: false } : {});
    const storage = new Storage({ send } as unknown as S3Client, "synthetic");
    await expect(storage.discardOrderWorkUpload(context, imageId, key, { assertCurrent: async () => undefined }))
      .rejects.toThrow("ORDER_WORK_UPLOAD_CLEANUP_UNCONFIRMED");
  });
});
