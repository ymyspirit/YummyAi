import { PodToolCatalogViewSchema } from "@yummyai/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assertPodArtworkInputPolicy, PodArtworkInputAssetError } from "./pod-artwork-task.service.js";
import { PodToolActivationPolicy, PodWorkbenchService } from "./pod-workbench.service.js";

describe("PodWorkbenchService", () => {
  const catalog = new PodWorkbenchService().getToolCatalog();

  afterEach(() => vi.unstubAllEnvs());

  it("returns the canonical seven-module Amazon and Etsy catalog", () => {
    expect(PodToolCatalogViewSchema.parse(catalog)).toStrictEqual(catalog);
    expect(catalog.supportedMarketplaces).toEqual(["amazon", "etsy"]);
    expect(catalog.modules.map((module) => module.label)).toEqual([
      "印花提取",
      "印花设计",
      "图案处理",
      "侵权检测",
      "套图&标题",
      "来图定制",
      "生产图",
    ]);
    expect(new Set(catalog.tools.map((tool) => tool.key))).toHaveProperty("size", 37);
  });

  it("keeps research evidence out of creative and production tools", () => {
    const evidenceTools = catalog.tools.filter((tool) => tool.assetPolicy === "risk_evidence_allowed");
    expect(evidenceTools.map((tool) => tool.key)).toEqual(["rights_risk_scan"]);
    expect(catalog.tools.filter((tool) => tool.assetPolicy === "order_context_only").every(
      (tool) => ["personalization", "production_artwork"].includes(tool.module),
    )).toBe(true);
  });

  it("marks only POD-1 tools as active implementation work", () => {
    expect(catalog.tools.filter((tool) => tool.availability === "implementation_active").every(
      (tool) => tool.phase === "pod_1",
    )).toBe(true);
    expect(catalog.tools.filter((tool) => tool.phase !== "pod_1").every(
      (tool) => tool.availability === "definition_ready",
    )).toBe(true);
  });

  it("enables tools only with an explicit processor deployment and allowlist", () => {
    vi.stubEnv("POD_PROCESSOR_DEPLOYMENT_ID", "pod-processor-2026-08-03");
    vi.stubEnv("POD_PROCESSOR_URL", "http://127.0.0.1:8090/v1/process");
    vi.stubEnv("POD_PROCESSOR_API_KEY", "test-secret");
    vi.stubEnv("POD_ENABLED_TOOLS", "pattern_crop,background_remove");
    const service = new PodWorkbenchService(new PodToolActivationPolicy());
    const enabled = service.getToolCatalog().tools.filter((tool) => tool.availability === "enabled");
    expect(enabled.map((tool) => tool.key)).toEqual(["pattern_crop", "background_remove"]);
    expect(service.isToolEnabled("pattern_crop")).toBe(true);
    expect(service.isToolEnabled("print_extract")).toBe(false);
  });

  it("does not honor a tool allowlist without a processor deployment", () => {
    vi.stubEnv("POD_PROCESSOR_DEPLOYMENT_ID", "");
    vi.stubEnv("POD_PROCESSOR_URL", "http://127.0.0.1:8090/v1/process");
    vi.stubEnv("POD_PROCESSOR_API_KEY", "test-secret");
    vi.stubEnv("POD_ENABLED_TOOLS", "pattern_crop");
    expect(new PodWorkbenchService(new PodToolActivationPolicy()).isToolEnabled("pattern_crop")).toBe(false);
  });

  it("keeps risk evidence separate from creative inputs", () => {
    const research = [{ id: "asset", version: 1, checksumSha256: "a".repeat(64), domain: "research" as const, rightsStatus: "unverified" as const }];
    expect(() => assertPodArtworkInputPolicy("rights_risk_scan", research)).not.toThrow();
    expect(() => assertPodArtworkInputPolicy("pattern_crop", research)).toThrow(PodArtworkInputAssetError);
    expect(() => assertPodArtworkInputPolicy("text_to_image", [])).not.toThrow();
    expect(() => assertPodArtworkInputPolicy("design_variation", [])).toThrow(PodArtworkInputAssetError);
    expect(() => assertPodArtworkInputPolicy("design_variation", [{
      id: "customer-file",
      version: 1,
      checksumSha256: "b".repeat(64),
      domain: "authorized",
      rightsStatus: "approved",
      rightsSourceKind: "customer_provided",
    }])).toThrow("order-scoped personalization workflow");
  });

  it("can enable POD-2 tools only through the same explicit deployment allowlist", () => {
    vi.stubEnv("POD_PROCESSOR_DEPLOYMENT_ID", "pod-processor-2026-08-03");
    vi.stubEnv("POD_PROCESSOR_URL", "http://127.0.0.1:8090/v1/process");
    vi.stubEnv("POD_PROCESSOR_API_KEY", "test-secret");
    vi.stubEnv("POD_ENABLED_TOOLS", "text_to_image,title_draft");
    const service = new PodWorkbenchService(new PodToolActivationPolicy());
    expect(service.isToolEnabled("text_to_image")).toBe(true);
    expect(service.isToolEnabled("title_draft")).toBe(true);
    expect(service.isToolEnabled("pattern_crop")).toBe(false);
  });

  it("can enable standalone POD-3 tools but rejects order-context tools from the generic processor", () => {
    vi.stubEnv("POD_PROCESSOR_DEPLOYMENT_ID", "pod-processor-2026-08-03");
    vi.stubEnv("POD_PROCESSOR_URL", "http://127.0.0.1:8090/v1/process");
    vi.stubEnv("POD_PROCESSOR_API_KEY", "test-secret");
    vi.stubEnv("POD_ENABLED_TOOLS", "product_video,piece_extract,piece_compose,uv_layers");
    const service = new PodWorkbenchService(new PodToolActivationPolicy());
    expect(service.isToolEnabled("product_video")).toBe(true);
    expect(service.isToolEnabled("piece_compose")).toBe(true);
    expect(service.isToolEnabled("text_to_image")).toBe(false);

    vi.stubEnv("POD_ENABLED_TOOLS", "image_composite");
    expect(() => new PodWorkbenchService(new PodToolActivationPolicy()).getToolCatalog()).toThrow();
  });

  it("enables order-context tools only through the separate order processor allowlist", () => {
    vi.stubEnv("POD_ORDER_PROCESSOR_DEPLOYMENT_ID", "order-render-2026-08-04");
    vi.stubEnv("POD_ORDER_PROCESSOR_URL", "https://processor.example.test/order-render");
    vi.stubEnv("POD_ORDER_PROCESSOR_API_KEY", "order-test-secret");
    vi.stubEnv("POD_ORDER_ENABLED_TOOLS", "image_composite,group_photo,pet_outfit,fulfillment_composite,vector_fulfillment");
    const service = new PodWorkbenchService(new PodToolActivationPolicy());
    expect(service.isToolEnabled("image_composite")).toBe(true);
    expect(service.isToolEnabled("group_photo")).toBe(true);
    expect(service.isToolEnabled("pet_outfit")).toBe(true);
    expect(service.isToolEnabled("fulfillment_composite")).toBe(true);
    expect(service.isToolEnabled("vector_fulfillment")).toBe(true);
    expect(service.isToolEnabled("pattern_crop")).toBe(false);
  });
});
