import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { normalizeModelTokenUsage, type SecretVault } from "@yummyai/ai-core";
import { withTenant, type DatabaseConnection } from "@yummyai/database";
import type * as DatabaseModule from "@yummyai/database";
import sharp from "sharp";
import { OrderDesignStudioGateway } from "./order-design.processor.js";
import type { StudioGateway, StudioOutput } from "./studio-generation.gateway.js";
import type { OrderDesignImageGateway } from "@yummyai/order-design";

vi.mock("@yummyai/database", async original => ({ ...await original<typeof DatabaseModule>(), withTenant: vi.fn() }));

describe("order design original provider receipt", () => {
  const database = { db: {} } as DatabaseConnection;
  const vault = { withSecret: <T>(_value: string, callback: (secret: string) => T): T => callback("synthetic") } as SecretVault;
  beforeEach(() => {
    vi.mocked(withTenant).mockReset();
    vi.mocked(withTenant).mockResolvedValue({ encryptedApiKey: "synthetic-encrypted", endpoint: "https://example.test/v1" });
  });
  async function fixture() {
    const controller = new AbortController();
    const input: Parameters<OrderDesignImageGateway["generate"]>[0] = {
      context: { tenantId: createEntityId(), userId: createEntityId() } as TenantContext,
      requestId: createEntityId(), model: { routeId: createEntityId(), providerConfigId: createEntityId(), model: "image-fixture", endpoint: "https://example.test/v1" },
      prompt: "Synthetic image", bytes: await sharp({ create: { width: 1, height: 1, channels: 4, background: "#ffffff" } }).png().toBuffer(),
      size: "1024x1024", transparent: false, signal: controller.signal, onReceipt: vi.fn(),
    };
    return { input, controller };
  }
  const receipt = () => ({ version: "pod-response-v1" as const, responseChecksum: "a".repeat(64), providerRequestId: "request-fixture",
    modelKey: "image-fixture", modelVersion: "image-fixture-v1", costUsd: "0.04000000", metadataValid: true, receivedAt: new Date().toISOString(),
    tokenUsage: normalizeModelTokenUsage({ input_tokens: 100, output_tokens: 200, total_tokens: 300 }) });

  it("retains original usage before a post-response cancellation and submits once", async () => {
    const { input, controller } = await fixture();
    const generate = vi.fn<StudioGateway["generate"]>(async (_execution, _remember, onReceipt) => {
      await onReceipt!(receipt()); controller.abort();
      return { bytes: Buffer.from("synthetic-result"), mediaType: "image/png" };
    });
    await expect(new OrderDesignStudioGateway(database, vault, { generate }).generate(input)).rejects.toThrow();
    expect(input.onReceipt).toHaveBeenCalledOnce();
    expect(input.onReceipt).toHaveBeenCalledWith({ requestId: input.requestId, actualCostUsd: 0.04, tokenUsage: receipt().tokenUsage });
    expect(generate).toHaveBeenCalledOnce();
  });
  it("retains usage when a provider returns an unusable output and does not adopt it", async () => {
    const { input } = await fixture();
    const generate = vi.fn<StudioGateway["generate"]>(async (_execution, _remember, onReceipt) => {
      await onReceipt!(receipt()); return { text: "unusable-output" } satisfies StudioOutput;
    });
    await expect(new OrderDesignStudioGateway(database, vault, { generate }).generate(input)).rejects.toMatchObject({ code: "agent_model_invalid_output", uncertain: true });
    expect(input.onReceipt).toHaveBeenCalledOnce(); expect(generate).toHaveBeenCalledOnce();
  });
  it("passes the same receipt into the bytes checkpoint and keeps missing usage unknown", async () => {
    const { input } = await fixture();
    const bytes = Buffer.from("synthetic-result");
    const generate = vi.fn<StudioGateway["generate"]>(async (_execution, _remember, onReceipt) => {
      await onReceipt!(receipt()); return { bytes, mediaType: "image/png" };
    });
    expect(await new OrderDesignStudioGateway(database, vault, { generate }).generate(input)).toEqual({ bytes, actualCostUsd: 0.04, tokenUsage: receipt().tokenUsage });
    const unsupported = vi.fn<StudioGateway["generate"]>(async () => ({ bytes, mediaType: "image/png" }));
    expect(await new OrderDesignStudioGateway(database, vault, { generate: unsupported }).generate(input)).toEqual({ bytes, tokenUsage: null });
    expect(input.onReceipt).toHaveBeenCalledOnce();
  });
});
