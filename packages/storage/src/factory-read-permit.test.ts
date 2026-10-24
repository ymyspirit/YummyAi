import type { S3Client } from "@aws-sdk/client-s3";
import type { TenantContext } from "@yummyai/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "./storage.js";
import { createFactoryReadPermit, type FactoryReadPermit } from "./factory-read-permit.js";
const context: TenantContext = {
  tenantId: "019b0000-0000-7000-8000-000000000001",
  userId: "019b0000-0000-7000-8000-000000000002",
  permissions: ["factory_task:read"],
  dataScope: "self",
};
const asset = {
  id: "019b0000-0000-7000-8000-000000000003",
  tenantId: context.tenantId,
  assetDomain: "order" as const,
  objectKey: `tenants/${context.tenantId}/order/${"a".repeat(64)}/approved.pe`,
};
function response(bytes = Uint8Array.from([1, 2, 3])) {
  return {
    ContentLength: bytes.length,
    Body: {
      transformToWebStream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
    },
  };
}
describe("assigned factory private reads", () => {
  afterEach(() => vi.restoreAllMocks());
  it("reads only the owner-authorized object without granting ordinary order or asset access", async () => {
    const send = vi.fn(async () => response()),
      storage = new Storage({ send } as unknown as S3Client, "private-assets"),
      assertCurrent = vi.fn(async () => {});
    const permit = await createFactoryReadPermit(context, asset, { maxBytes: 10, assertCurrent });
    await expect(
      storage.readPrivate(context, asset, { requiredDomain: "order" }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    await expect(storage.readFactoryAssignedPrivate(context, asset, permit)).resolves.toEqual(
      Uint8Array.from([1, 2, 3]),
    );
    expect(send).toHaveBeenCalledOnce();
    expect(assertCurrent).toHaveBeenCalledTimes(3);
  });
  it("rejects JSON copies, other users, tenants and different stored objects before contacting storage", async () => {
    const send = vi.fn(),
      storage = new Storage({ send } as unknown as S3Client, "private-assets"),
      permit = await createFactoryReadPermit(context, asset, {
        maxBytes: 10,
        assertCurrent: async () => {},
      });
    await expect(
      storage.readFactoryAssignedPrivate(
        context,
        asset,
        JSON.parse(JSON.stringify(permit)) as FactoryReadPermit,
      ),
    ).rejects.toThrow();
    await expect(
      storage.readFactoryAssignedPrivate(
        { ...context, userId: "019b0000-0000-7000-8000-000000000004" },
        asset,
        permit,
      ),
    ).rejects.toThrow();
    await expect(
      storage.readFactoryAssignedPrivate(
        { ...context, tenantId: "019b0000-0000-7000-8000-000000000005" },
        asset,
        permit,
      ),
    ).rejects.toThrow();
    await expect(
      storage.readFactoryAssignedPrivate(
        context,
        { ...asset, objectKey: asset.objectKey + ".other" },
        permit,
      ),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it("does not return bytes when authority is revoked during the actual object read", async () => {
    let allowed = true;
    const assertCurrent = vi.fn(async () => {
        if (!allowed) throw new Error("Synthetic assignment revoked");
      }),
      send = vi.fn(async () => {
        allowed = false;
        return response();
      }),
      storage = new Storage({ send } as unknown as S3Client, "private-assets");
    const permit = await createFactoryReadPermit(context, asset, { maxBytes: 10, assertCurrent });
    await expect(storage.readFactoryAssignedPrivate(context, asset, permit)).rejects.toThrow(
      "Synthetic assignment revoked",
    );
    expect(send).toHaveBeenCalledOnce();
    expect(assertCurrent).toHaveBeenCalledTimes(3);
  });
  it("rejects missing current authority, non-order domains and oversized capabilities", async () => {
    const denied = async () => {
      throw new Error("Synthetic assignment unavailable");
    };
    await expect(
      createFactoryReadPermit(context, asset, { maxBytes: 10, assertCurrent: denied }),
    ).rejects.toThrow("Synthetic assignment unavailable");
    await expect(
      createFactoryReadPermit(
        context,
        { ...asset, assetDomain: "research" },
        { maxBytes: 10, assertCurrent: async () => {} },
      ),
    ).rejects.toThrow();
    await expect(
      createFactoryReadPermit(context, asset, {
        maxBytes: 64 * 1024 * 1024 + 1,
        assertCurrent: async () => {},
      }),
    ).rejects.toThrow();
    await expect(
      createFactoryReadPermit({ ...context, permissions: [] }, asset, {
        maxBytes: 10,
        assertCurrent: async () => {},
      }),
    ).rejects.toThrow();
  });
  it("uses a monotonic lifetime and does not refresh a permit after its deadline", async () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const send = vi.fn(),
      storage = new Storage({ send } as unknown as S3Client, "private-assets"),
      permit = await createFactoryReadPermit(context, asset, {
        maxBytes: 10,
        assertCurrent: async () => {},
      });
    now += 60_001;
    await expect(storage.readFactoryAssignedPrivate(context, asset, permit)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it("enforces the bounded capability while streaming even if the content-length is absent", async () => {
    const send = vi.fn(async () => ({ ...response(), ContentLength: undefined })),
      storage = new Storage({ send } as unknown as S3Client, "private-assets"),
      permit = await createFactoryReadPermit(context, asset, {
        maxBytes: 2,
        assertCurrent: async () => {},
      });
    await expect(storage.readFactoryAssignedPrivate(context, asset, permit)).rejects.toThrow(
      "byte limit",
    );
    expect(send).toHaveBeenCalledOnce();
  });
});
