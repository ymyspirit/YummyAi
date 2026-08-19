import { createEntityId } from "@yummyai/contracts";
import { describe, expect, it, vi } from "vitest";

import { HttpOrderPersonalizationRenderGateway } from "./order-personalization-render.http-gateway.js";
import type { OrderPersonalizationRenderExecutionRecord } from "./order-personalization-render.processor.js";

describe("HttpOrderPersonalizationRenderGateway", () => {
  it("sends only render-scoped content and validates the processor response", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const request = vi.fn(async (_url: URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        outputs: [{
          dataBase64: Buffer.from([1, 2, 3]).toString("base64"),
          mediaType: "image/png",
          role: "effect",
          fileName: "preview.png",
          metadata: {
            width: 1000,
            height: 1000,
            unit: "px",
            dpi: 300,
            colorMode: "rgb",
            transparent: true,
            aiInference: "none",
          },
        }],
        modelKey: "order-renderer",
        modelVersion: "1.0.0",
        qualityCheckSnapshot: { passed: true },
        partial: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const gateway = new HttpOrderPersonalizationRenderGateway(
      "https://processor.example.test/render",
      "secret-order-key",
      "order-render-2026-08-04",
      request as typeof fetch,
    );
    const result = await gateway.execute(execution(), new AbortController().signal);

    expect(result.outputs[0]?.bytes).toEqual(Uint8Array.from([1, 2, 3]));
    expect(JSON.stringify(requestBody)).toContain("Private Customer");
    expect(requestBody).not.toHaveProperty("tenantId");
    expect(requestBody).not.toHaveProperty("orderId");
    expect(result.qualityCheckSnapshot).toMatchObject({ processorDeploymentId: "order-render-2026-08-04" });
  });

  it("rejects a non-loopback plaintext processor endpoint", () => {
    expect(() => new HttpOrderPersonalizationRenderGateway(
      "http://processor.example.test/render",
      "secret-order-key",
      "deployment",
    )).toThrow("must use HTTPS");
  });

  it("accepts a bounded SVG production response", async () => {
    const svg = '<svg viewBox="0 0 300 400"><path d="M0 0H1V1Z"/></svg>';
    const request = vi.fn(async () => new Response(JSON.stringify({
      outputs: [{
        dataBase64: Buffer.from(svg).toString("base64"),
        mediaType: "image/svg+xml",
        role: "production",
        fileName: "production.svg",
        metadata: {
          width: 300,
          height: 400,
          unit: "mm",
          colorMode: "spot",
          transparent: true,
          aiInference: "none",
        },
      }],
      modelKey: "vector-renderer",
      modelVersion: "1.0.0",
      qualityCheckSnapshot: { passed: true },
      partial: false,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const gateway = new HttpOrderPersonalizationRenderGateway(
      "https://processor.example.test/render",
      "secret-order-key",
      "vector-deployment",
      request as typeof fetch,
    );
    const input = execution();
    input.toolKey = "vector_fulfillment";

    const result = await gateway.execute(input, new AbortController().signal);

    expect(result.outputs[0]).toMatchObject({ mediaType: "image/svg+xml", role: "production", fileName: "production.svg" });
    expect(new TextDecoder().decode(result.outputs[0]!.bytes)).toBe(svg);
  });
});

function execution(): OrderPersonalizationRenderExecutionRecord {
  const templateVersionId = createEntityId();
  const orderId = createEntityId();
  const orderLineId = createEntityId();
  const customizationVersionId = createEntityId();
  const assetId = createEntityId();
  return {
    id: createEntityId(),
    designTaskId: createEntityId(),
    batchItemId: createEntityId(),
    toolKey: "image_composite",
    parameterSnapshot: {
      outputFormat: "png",
      fitMode: "template",
      autoComposition: "off",
      allowAiEnhancement: false,
      identityMode: "standard",
      customerAssetUsage: "mapped",
      referenceIdentityTransfer: "not_applicable",
    },
    encryptedResolution: "not-forwarded",
    resolutionChecksum: "a".repeat(64),
    orderId,
    orderLineId,
    customizationVersionId,
    templateVersionId,
    maxAttempts: 3,
    resolution: {
      version: 2,
      orderId,
      orderLineId,
      customizationVersionId,
      templateVersionId,
      slots: [
        { slotId: createEntityId(), stableKey: "customer.name", kind: "text", value: "Private Customer" },
        {
          slotId: createEntityId(),
          stableKey: "customer.photo",
          kind: "image",
          assetId,
          assetVersion: 1,
          checksumSha256: "b".repeat(64),
          mediaType: "image/png",
        },
      ],
    },
    canvas: { width: 1000, height: 1000, dpi: 300, colorMode: "rgb" },
    slots: [],
    customerAssets: [{
      id: assetId,
      version: 1,
      checksumSha256: "b".repeat(64),
      mediaType: "image/png",
      bytes: Uint8Array.from([4, 5, 6]),
    }],
  };
}
