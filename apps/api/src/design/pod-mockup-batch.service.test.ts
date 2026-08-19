import { BadRequestException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assertTemplateSourceAsset, mockupRendererConfigured } from "./pod-mockup-batch.service.js";

const source = {
  assetDomain: "authorized" as const,
  rightsStatus: "approved" as const,
  rightsMetadata: { source: { kind: "owned" } },
  byteSize: 1024,
  fileName: "canvas-room.psd",
  mediaType: "image/vnd.adobe.photoshop",
};

describe("mockup batch policy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts controlled PSD sources and blocks unsafe domains, origins, types, and sizes", () => {
    expect(() => assertTemplateSourceAsset(source)).not.toThrow();
    expect(() => assertTemplateSourceAsset({ ...source, assetDomain: "research" })).toThrow(BadRequestException);
    expect(() => assertTemplateSourceAsset({ ...source, rightsMetadata: { source: { kind: "customer_provided" } } })).toThrow(BadRequestException);
    expect(() => assertTemplateSourceAsset({ ...source, fileName: "canvas-room.psb" })).toThrow(/PSD file/);
    expect(() => assertTemplateSourceAsset({ ...source, byteSize: 250 * 1024 * 1024 + 1 })).toThrow(/250 MB/);
  });

  it("requires both feature flags before exposing the renderer", () => {
    vi.stubEnv("POD_BATCH_WORKFLOWS_ENABLED", "true");
    vi.stubEnv("POD_MOCKUP_RENDERER_ENABLED", "false");
    expect(mockupRendererConfigured()).toBe(false);
    vi.stubEnv("POD_MOCKUP_RENDERER_ENABLED", "true");
    expect(mockupRendererConfigured()).toBe(true);
  });
});
