import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assertSkuSpecCompatible } from "./canvas-print-spec-policy.js";
import { assertAuthorizedAssets, creativeBatchConfigured } from "./pod-batch-workflow.service.js";

const id = "01987654-3210-7abc-8def-0123456789ab";
const asset = {
  id,
  assetDomain: "authorized" as const,
  rightsStatus: "approved" as const,
  rightsMetadata: { source: { kind: "owned" } },
};
const spec = { id, aspectWidth: 4, aspectHeight: 3 };

describe("POD batch workflow policy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts only rights-approved authorized references", () => {
    expect(() => assertAuthorizedAssets([id], [asset], "References")).not.toThrow();
    expect(() => assertAuthorizedAssets([id], [{ ...asset, assetDomain: "research" }], "References")).toThrow(BadRequestException);
    expect(() => assertAuthorizedAssets([id], [{ ...asset, rightsStatus: "unverified" }], "References")).toThrow(BadRequestException);
    expect(() => assertAuthorizedAssets([id], [{ ...asset, rightsMetadata: { source: { kind: "customer_provided" } } }], "References")).toThrow(/order-private/);
    expect(() => assertAuthorizedAssets([id], [{ ...asset, rightsMetadata: { source: { kind: "competitor" } } }], "References")).toThrow(/competitor/);
    expect(() => assertAuthorizedAssets([id], [], "References")).toThrow(NotFoundException);
  });

  it("supports pinned specification, ratio, or physical-size compatibility", () => {
    expect(() => assertSkuSpecCompatible("SKU-A", { canvas_print_spec_version_id: id }, spec)).not.toThrow();
    expect(() => assertSkuSpecCompatible("SKU-B", { canvas_aspect_ratio: "8:6" }, spec)).not.toThrow();
    expect(() => assertSkuSpecCompatible("SKU-C", { canvas_width_mm: "800", canvas_height_mm: "600" }, spec)).not.toThrow();
    expect(() => assertSkuSpecCompatible("SKU-D", { canvas_aspect_ratio: "1:1" }, spec)).toThrow(ConflictException);
  });

  it("keeps batch creation disabled until both creative tools and deployment are explicit", () => {
    vi.stubEnv("POD_BATCH_WORKFLOWS_ENABLED", "true");
    vi.stubEnv("POD_PROCESSOR_DEPLOYMENT_ID", "processor-v1");
    vi.stubEnv("POD_PROCESSOR_URL", "https://processor.example.test/process");
    vi.stubEnv("POD_PROCESSOR_API_KEY", "test-only-secret");
    vi.stubEnv("POD_ENABLED_TOOLS", "text_to_image");
    expect(creativeBatchConfigured()).toBe(false);
    vi.stubEnv("POD_ENABLED_TOOLS", "text_to_image,canvas_extend");
    expect(creativeBatchConfigured()).toBe(true);
  });
});
