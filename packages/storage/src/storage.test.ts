import { CopyObjectCommand, HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
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
