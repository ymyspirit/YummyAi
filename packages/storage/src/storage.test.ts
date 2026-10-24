import { CopyObjectCommand, DeleteObjectCommand, HeadBucketCommand, HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { TenantContext } from "@yummyai/contracts";
import { describe, expect, it, vi } from "vitest";

import { Storage } from "./storage.js";

const context: TenantContext = {
  tenantId: "019b0000-0000-7000-8000-000000000001",
  userId: "019b0000-0000-7000-8000-000000000002",
  permissions: ["asset:read"],
  dataScope: "tenant",
};

describe("private asset reads", () => {
  it("checks the domain and tenant before a bounded metadata-only HEAD", async () => {
    const send = vi.fn().mockResolvedValue({ ContentLength: 23, ContentType: "image/png",
      Metadata: { "tenant-id": context.tenantId, "asset-domain": "authorized", sha256: "a".repeat(64) } });
    const storage = new Storage({ send } as unknown as S3Client, "private-assets");
    const asset = { id: context.userId, tenantId: context.tenantId, assetDomain: "authorized" as const,
      objectKey: `tenants/${context.tenantId}/authorized/${"a".repeat(64)}/original.png` };
    await expect(storage.inspectPrivate(context, { ...asset, tenantId: context.userId }, { requiredDomain: "authorized" })).rejects.toThrow();
    await expect(storage.inspectPrivate(context, { ...asset, assetDomain: "research" }, { requiredDomain: "authorized" })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(await storage.inspectPrivate(context, asset, { requiredDomain: "authorized" })).toEqual({ byteSize: 23, mediaType: "image/png",
      checksumSha256: "a".repeat(64), tenantId: context.tenantId, assetDomain: "authorized" });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[0]![1].abortSignal).toBeInstanceOf(AbortSignal);
  });
  it("does not invent missing object metadata from an ETag or asset identifier", async () => {
    const send = vi.fn().mockResolvedValue({ ETag: "untrusted-etag" });
    const storage = new Storage({ send } as unknown as S3Client, "private-assets");
    expect(await storage.inspectPrivate(context, { id: context.userId, tenantId: context.tenantId, assetDomain: "authorized",
      objectKey: `tenants/${context.tenantId}/authorized/a/file.png` }, { requiredDomain: "authorized" }))
      .toEqual({ byteSize: null, mediaType: null, checksumSha256: null, tenantId: null, assetDomain: null });
  });
  it("cleans the exact advertising upload with Write alone without granting CSV reads", async () => {
    const send = vi.fn(async (command: unknown) => ({ command }));
    const storage = new Storage({ send } as unknown as S3Client, "private-assets");
    const writer: TenantContext = { ...context, permissions: ["customer_intelligence:write"] };
    const id = "019b0000-0000-7000-8000-000000000003";
    const key = `tenants/${context.tenantId}/advertising/${"a".repeat(64)}/${id}.csv`;
    await expect(storage.discardAdvertisingSource(context, id, key)).rejects.toThrow();
    for (const invalid of [key.replace(context.tenantId, id), key.replace("/advertising/", "/authorized/"), key.replace(`${id}.csv`, "other.csv"), `${key}/extra`])
      await expect(storage.discardAdvertisingSource(writer, id, invalid)).rejects.toThrow();
    await expect(storage.readPrivate(writer, { id, tenantId: context.tenantId, assetDomain: "advertising", objectKey: key }, { requiredDomain: "advertising" })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    await storage.discardAdvertisingSource(writer, id, key);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toBeInstanceOf(DeleteObjectCommand);
  });
  it("checks bucket readiness without creating or repairing a missing deployment bucket", async () => {
    const unavailable = new Error("synthetic missing bucket");
    const send = vi.fn().mockRejectedValueOnce(unavailable).mockResolvedValueOnce({});
    const storage = new Storage({ send } as unknown as S3Client, "private-assets");
    await expect(storage.assertBucketReady()).rejects.toBe(unavailable);
    await expect(storage.assertBucketReady()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    for (const [command] of send.mock.calls) {
      expect(command).toBeInstanceOf(HeadBucketCommand);
      expect(command.input).toEqual({ Bucket: "private-assets" });
    }
  });

  it("deletes only reserved POD checkpoint/output keys inside the current tenant", async () => {
    const send = vi.fn(async () => ({})), storage = new Storage({ send } as unknown as S3Client, "private-assets");
    const task = "019b0000-0000-7000-8000-000000000003";
    const raw = `tenants/${context.tenantId}/quarantine/${"a".repeat(64)}/${task}-pod-response.pe`;
    const output = `tenants/${context.tenantId}/authorized/${"b".repeat(64)}/${task}-pod-output-0.png`;
    for (const invalid of [raw.replace(context.tenantId, task), raw.replace("quarantine", "authorized"), `${raw}/extra`, raw.replace("-pod-response.pe", ".png")]) await expect(storage.discardPodExecutionArtifact(context, task, invalid, "response")).rejects.toThrow();
    await expect(storage.discardPodExecutionArtifact(context, task, output.replace("-pod-output-0", "-user-artwork"), "output")).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    await storage.discardPodExecutionArtifact(context, task, raw, "response"); await storage.discardPodExecutionArtifact(context, task, output, "output");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("bounds a private streamed body even when the declared content length is absent", async () => {
    const cancel = vi.fn(), stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(3)); }, cancel });
    const send = vi.fn(async () => ({ Body: { transformToWebStream: () => stream } }));
    const storage = new Storage({ send } as unknown as S3Client, "private-assets");
    await expect(storage.readPrivate(context, { id: context.userId, tenantId: context.tenantId, assetDomain: "authorized", objectKey: `tenants/${context.tenantId}/authorized/${"a".repeat(64)}/output.png` }, { requiredDomain: "authorized", maxBytes: 4 })).rejects.toThrow("byte limit");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("discards only a tenant-owned order response quarantine with PII permission", async () => {
    const send = vi.fn(async (command: unknown) => ({ command })), storage = new Storage({ send } as unknown as S3Client, "private-assets");
    const request = "019b0000-0000-7000-8000-000000000003";
    const key = `tenants/${context.tenantId}/order/${"a".repeat(64)}/${request}-response-quarantine.pe`;
    const allowed = { ...context, permissions: ["asset:read", "order:pii:read"] };
    await expect(storage.discardOrderDesignResponse(context, request, key)).rejects.toThrow();
    for (const invalid of [key.replace(context.tenantId, "019b0000-0000-7000-8000-000000000004"), key.replace("/order/", "/research/"), key.replace(`${request}-response-quarantine.pe`, "buyer.png"), `${key}/extra`])
      await expect(storage.discardOrderDesignResponse(allowed, request, invalid)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    await storage.discardOrderDesignResponse(allowed, request, key);
    expect(send).toHaveBeenCalledOnce(); expect(send.mock.calls[0]![0]).toBeInstanceOf(DeleteObjectCommand);
  });
  it("returns authorized bytes after tenant and object-prefix checks", async () => {
    const send = vi.fn(async () => ({
      Body: { transformToByteArray: async () => Uint8Array.from([1, 2, 3]) },
    }));
    const storage = new Storage({ send } as unknown as S3Client, "private-assets");
    await expect(storage.readPrivate(context, {
      id: "019b0000-0000-7000-8000-000000000003",
      tenantId: context.tenantId,
      assetDomain: "authorized",
      objectKey: `tenants/${context.tenantId}/authorized/${"a".repeat(64)}/sample.png`,
    }, { requiredDomain: "authorized" })).resolves.toEqual(Uint8Array.from([1, 2, 3]));
    expect(send).toHaveBeenCalledOnce();
  });

  it("blocks research-domain bytes before contacting S3", async () => {
    const send = vi.fn();
    const storage = new Storage({ send } as unknown as S3Client, "private-assets");
    await expect(storage.readPrivate(context, {
      id: "019b0000-0000-7000-8000-000000000003",
      tenantId: context.tenantId,
      assetDomain: "research",
      objectKey: `tenants/${context.tenantId}/research/${"a".repeat(64)}/sample.png`,
    }, { requiredDomain: "authorized" })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("requires order PII permission before reading an order-private object", async () => {
    const send = vi.fn();
    const storage = new Storage({ send } as unknown as S3Client, "private-assets");
    const asset = {
      id: "019b0000-0000-7000-8000-000000000003",
      tenantId: context.tenantId,
      assetDomain: "order" as const,
      objectKey: `tenants/${context.tenantId}/order/${"a".repeat(64)}/customer.png`,
    };
    await expect(storage.readPrivate(context, asset, { requiredDomain: "order" })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    const authorized = { ...context, permissions: ["asset:read", "order:pii:read"] };
    const allowedSend = vi.fn(async () => ({
      Body: { transformToByteArray: async () => Uint8Array.from([4, 5, 6]) },
    }));
    const allowedStorage = new Storage({ send: allowedSend } as unknown as S3Client, "private-assets");
    await expect(allowedStorage.readPrivate(authorized, asset, { requiredDomain: "order" }))
      .resolves.toEqual(Uint8Array.from([4, 5, 6]));
  });

  it("promotes only a tenant-owned quarantine object into the authorized prefix", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) throw Object.assign(new Error("missing"), { name: "NotFound" });
      if (command instanceof CopyObjectCommand) return {};
      throw new Error("unexpected command");
    });
    const storage = new Storage({ send } as unknown as S3Client, "private-assets");
    const checksum = "c".repeat(64);
    await expect(storage.promoteQuarantineToAuthorized(context, {
      id: "019b0000-0000-7000-8000-000000000003", tenantId: context.tenantId, assetDomain: "quarantine",
      objectKey: `tenants/${context.tenantId}/quarantine/${checksum}/customer.png`, checksumSha256: checksum,
      fileName: "customer.png", mediaType: "image/png",
    })).resolves.toMatchObject({ objectKey: `tenants/${context.tenantId}/authorized/${checksum}/customer.png` });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
