import { describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@yummyai/contracts";
import { Storage } from "@yummyai/storage";

const context: TenantContext = { tenantId: "019b0000-0000-7000-8000-000000000001", userId: "019b0000-0000-7000-8000-000000000002", permissions: ["asset:read"], dataScope: "tenant" };
const asset = { id: "019b0000-0000-7000-8000-000000000003", tenantId: context.tenantId, assetDomain: "authorized" as const,
  objectKey: `tenants/${context.tenantId}/authorized/${"a".repeat(64)}/original.png` };
const storageFor = (send: unknown) => new Storage({ send } as ConstructorParameters<typeof Storage>[0], "synthetic-private");

describe("bounded original storage reads", () => {
  it("cancels a declared oversized original before consuming the body", async () => {
    const cancelled = vi.fn(), stream = new ReadableStream({ cancel: cancelled });
    const storage = storageFor(vi.fn(async () => ({ ContentLength: 5, Body: { transformToWebStream: () => stream } })));
    await expect(storage.readPrivate(context, asset, { requiredDomain: "authorized", maxBytes: 4 })).rejects.toThrow("byte limit");
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it("cancels a lying stream when actual received bytes cross the limit", async () => {
    const cancelled = vi.fn(), stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel: cancelled });
    const storage = storageFor(vi.fn(async () => ({ ContentLength: 1, Body: { transformToWebStream: () => stream } })));
    await expect(storage.readPrivate(context, asset, { requiredDomain: "authorized", maxBytes: 4 })).rejects.toThrow("byte limit");
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it("forwards cancellation to S3 and stops a body that never completes", async () => {
    const cancelled = vi.fn(), stream = new ReadableStream({ cancel: cancelled }), controller = new AbortController();
    const send = vi.fn(async (_command: unknown, options?: { abortSignal: AbortSignal }) => {
      expect(options?.abortSignal).toBe(controller.signal);
      return { Body: { transformToWebStream: () => stream } };
    });
    const pending = storageFor(send).readPrivate(context, asset, { requiredDomain: "authorized", maxBytes: 4, signal: controller.signal });
    await Promise.resolve(); controller.abort(new Error("synthetic original read cancelled"));
    await expect(pending).rejects.toThrow("synthetic original read cancelled");
    expect(cancelled).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
});
