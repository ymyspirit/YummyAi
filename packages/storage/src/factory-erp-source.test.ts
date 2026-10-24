import { DeleteObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@yummyai/contracts";
import { objectKey } from "./asset-policy.js";
import { Storage } from "./storage.js";
describe("factory ERP exact receipt compensation", () => {
  const context: TenantContext = { tenantId: "019b0000-0000-7000-8000-000000000001", userId: "019b0000-0000-7000-8000-000000000002", permissions: ["order:write", "order:pii:read", "asset:read"], dataScope: "tenant" };
  const id = "019b0000-0000-7000-8000-000000000003";
  it("cannot delete another tenant, domain, request, source filename or arbitrary order asset", async () => {
    const send = vi.fn(async (command: DeleteObjectCommand) => ({ command })), storage = new Storage({ send } as unknown as S3Client, "synthetic-private");
    const key = objectKey({ tenantId: context.tenantId, domain: "order", sha256: "a".repeat(64), fileName: `${id}-factory-erp-source.pe` });
    for (const invalid of [key.replace(context.tenantId, context.userId), key.replace("/order/", "/research/"), key.replace(id, context.userId), key.replace("factory-erp-source.pe", "buyer-photo.jpg"), `${key}/child`])
      await expect(storage.discardFactoryErpSource(context, id, invalid)).rejects.toThrow();
    await expect(storage.discardFactoryErpSource({ ...context, permissions: ["asset:read", "order:pii:read"] }, id, key)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled(); await storage.discardFactoryErpSource(context, id, key);
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.any(DeleteObjectCommand));
    expect(send.mock.calls[0]![0].input).toEqual({ Bucket: "synthetic-private", Key: key });
  });
});
