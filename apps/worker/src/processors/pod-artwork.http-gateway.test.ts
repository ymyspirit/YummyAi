import { describe, expect, it } from "vitest";

import { HttpPodArtworkGateway } from "./pod-artwork.http-gateway.js";
import type { PodArtworkExecutionRecord } from "./pod-artwork.processor.js";

describe("HttpPodArtworkGateway", () => {
  it("rejects insecure non-loopback processor endpoints and embedded credentials", () => {
    expect(() => new HttpPodArtworkGateway("http://processor.example/v1/process", "secret"))
      .toThrow("must use HTTPS");
    expect(() => new HttpPodArtworkGateway("https://user:secret@processor.example/v1/process", "secret"))
      .toThrow("must not contain credentials");
  });

  it("sends pinned inputs and parses provenance without forwarding tenant identity", async () => {
    let requestBody: Record<string, unknown> | undefined;
    let requestHeaders: Headers | undefined;
    const gateway = new HttpPodArtworkGateway(
      "https://processor.example/v1/process",
      "processor-secret",
      async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requestHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({
          outputs: [{
            dataBase64: Buffer.from("result").toString("base64"),
            mediaType: "image/png",
            role: "effect",
            fileName: "crop.png",
            metadata: {
              width: 2400,
              height: 3000,
              unit: "px",
              dpi: 300,
              colorMode: "rgb",
              transparent: true,
              aiInference: "none",
            },
          }],
          modelKey: "pod.crop.v1",
          modelVersion: "2026-08-03",
          seed: "42",
          qualityCheckSnapshot: { dimensionsValid: true },
          partial: false,
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      50 * 1024 * 1024,
      "pod-test-2026-08-03",
    );

    const result = await gateway.execute(
      { tenantId: "019f0000-0000-7000-8000-000000000003", userId: "019f0000-0000-7000-8000-000000000004" },
      task(),
      new AbortController().signal,
    );

    expect(requestHeaders?.get("authorization")).toBe("Bearer processor-secret");
    expect(requestHeaders?.get("x-yummyai-processor-deployment")).toBe("pod-test-2026-08-03");
    expect(requestBody).toMatchObject({
      taskId: task().id,
      toolKey: "pattern_crop",
      parameterSnapshot: patternCropParameters(),
      inputs: [{ assetId: task().inputAssets[0]!.id, version: 2, checksumSha256: "a".repeat(64) }],
    });
    expect(requestBody).not.toHaveProperty("tenantId");
    expect(result).toMatchObject({
      modelKey: "pod.crop.v1",
      modelVersion: "2026-08-03",
      seed: "42",
      qualityCheckSnapshot: { dimensionsValid: true, processorDeploymentId: "pod-test-2026-08-03" },
    });
    expect(Buffer.from(result.outputs[0]!.bytes).toString()).toBe("result");
  });

  it("rejects oversized output before decoding it", async () => {
    const gateway = new HttpPodArtworkGateway(
      "http://127.0.0.1:8090/v1/process",
      "secret",
      async () => new Response(JSON.stringify({
        outputs: [{
          dataBase64: "a".repeat(100),
          mediaType: "image/png",
          role: "effect",
          fileName: "large.png",
          metadata: { width: 10, height: 10, unit: "px", colorMode: "rgb", transparent: false, aiInference: "none" },
        }],
        modelKey: "pod.crop.v1",
        modelVersion: "1",
        qualityCheckSnapshot: {},
        partial: false,
      }), { status: 200 }),
      16,
    );
    await expect(gateway.execute(
      { tenantId: "019f0000-0000-7000-8000-000000000003", userId: "019f0000-0000-7000-8000-000000000004" },
      task(),
      new AbortController().signal,
    )).rejects.toThrow("exceeds the configured byte limit");
  });

  it("accepts traced video and production-package outputs", async () => {
    const gateway = new HttpPodArtworkGateway(
      "http://127.0.0.1:8090/v1/process",
      "secret",
      async () => new Response(JSON.stringify({
        outputs: [{
          dataBase64: Buffer.from("video").toString("base64"),
          mediaType: "video/mp4",
          role: "effect",
          fileName: "product-video.mp4",
          metadata: {
            width: 1080,
            height: 1920,
            unit: "px",
            colorMode: "rgb",
            transparent: false,
            durationSeconds: 15,
            fps: 30,
            videoCodec: "h264",
            audioCodec: "aac",
            aiInference: "full",
          },
        }, {
          dataBase64: Buffer.from("package").toString("base64"),
          mediaType: "application/zip",
          role: "production",
          fileName: "production-files.zip",
          metadata: { aiInference: "none" },
        }],
        modelKey: "pod.production.v1",
        modelVersion: "2026-08-03",
        qualityCheckSnapshot: { dimensionsValid: true, manifestComplete: true },
        partial: false,
      }), { status: 200 }),
      1024,
      "pod-production-test",
    );

    const result = await gateway.execute(
      { tenantId: "019f0000-0000-7000-8000-000000000003", userId: "019f0000-0000-7000-8000-000000000004" },
      { ...task(), toolKey: "piece_compose" },
      new AbortController().signal,
    );

    expect(result.outputs.map((output) => output.mediaType)).toEqual(["video/mp4", "application/zip"]);
    expect(result.outputs[0]?.metadata).toMatchObject({ durationSeconds: 15, fps: 30, videoCodec: "h264", audioCodec: "aac" });
    expect(result.outputs[1]?.metadata).toEqual({ aiInference: "none" });
  });
});

function task(): PodArtworkExecutionRecord {
  return {
    id: "019f0000-0000-7000-8000-000000000001",
    designTaskId: "019f0000-0000-7000-8000-000000000002",
    toolKey: "pattern_crop",
    parameterSnapshot: patternCropParameters(),
    inputAssets: [{
      id: "019f0000-0000-7000-8000-000000000005",
      version: 2,
      checksumSha256: "a".repeat(64),
      domain: "authorized",
      rightsStatus: "approved",
      bytes: Uint8Array.from([1, 2, 3]),
      mediaType: "image/png",
    }],
    modelKey: "pod.crop.v1",
    maxAttempts: 3,
  };
}

function patternCropParameters() {
  return {
    mode: "general", multiCrop: false, maximumCropsPerInput: 1, outputFormat: "png",
    background: "preserved", perspectiveCorrection: true, cropPaddingPercent: 2,
  };
}
