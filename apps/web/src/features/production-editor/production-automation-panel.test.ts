import { PILLOW_CONTOUR_GRAPH_VERSION, type DesignAutomationRecipe, type PillowUpscalePolicy } from "@yummyai/contracts/pod/design-automation";
import { describe, expect, it } from "vitest";

import { changeAutomationModelRoute, pillowPipelineBlockers, setPillowContourWorkflow, setPillowPipeline } from "./production-automation-panel";

const recipe: DesignAutomationRecipe = { schemaVersion: 1, workflow: "template", imagePolicy: "faithful_enhancement", modelRouteId: "019f7600-0000-7000-8000-000000000001", allowOrderImageTransfer: true, modelCallLimit: 4, estimatedCostPerCallUsd: 0.2, maxEstimatedCostUsd: 1 };
const upscale: PillowUpscalePolicy = { engine: "realesrgan-ncnn-vulkan", release: "20220424", model: "realesrgan-x4plus", scale: 4, tileSize: 256,
  threads: "1:1:1", alphaStrategy: "source-alpha-lanczos3-rgb-nearest-fill-v1", binarySha256: "a".repeat(64), modelBinSha256: "b".repeat(64), modelParamSha256: "c".repeat(64) };

describe("automation provider changes", () => {
  it("requires new consent and price evidence when choosing another provider route", () => {
    const original = structuredClone(recipe);
    const changed = changeAutomationModelRoute(recipe, "019f7600-0000-7000-8000-000000000002");
    expect(changed).toEqual({ ...recipe, modelRouteId: "019f7600-0000-7000-8000-000000000002", allowOrderImageTransfer: false, estimatedCostPerCallUsd: null });
    expect(changed.modelCallLimit).toBe(4);
    expect(changed.maxEstimatedCostUsd).toBe(1);
    expect(recipe).toEqual(original);
  });

  it("clears the prior authorization when removing a model but preserves an unchanged selection", () => {
    expect(changeAutomationModelRoute(recipe, null)).toMatchObject({ modelRouteId: null, allowOrderImageTransfer: false, estimatedCostPerCallUsd: null });
    expect(changeAutomationModelRoute(recipe, recipe.modelRouteId)).toBe(recipe);
  });
  it("enables only the explicit versioned pillow recipe and pins the safe runtime policy", () => {
    const original = { ...recipe, imagePolicy: "preserve" as const };
    const enabled = setPillowPipeline(original, upscale);
    expect(original).not.toHaveProperty("pillowPipeline");
    expect(enabled).toMatchObject({ workflow: "pillow_photo", imagePolicy: "faithful_enhancement", pillowPipeline: { version: "pillow-subject-v1-2026-09-19", upscale } });
    expect(enabled.pillowPipeline?.contour).not.toHaveProperty("workflow");
    expect(setPillowPipeline(enabled, null)).not.toHaveProperty("pillowPipeline");
    expect(enabled.pillowPipeline).toBeDefined();
  });
  it("requires a separate contour opt-in and removes it without changing factory parameters", () => {
    expect(setPillowContourWorkflow(recipe, true)).toBe(recipe);
    const parent = setPillowPipeline(recipe, upscale);
    const enabled = setPillowContourWorkflow(parent, true);
    expect(enabled.pillowPipeline?.contour.workflow).toBe(PILLOW_CONTOUR_GRAPH_VERSION);
    expect(parent.pillowPipeline?.contour).not.toHaveProperty("workflow");
    expect(setPillowContourWorkflow(enabled, false)).toEqual(parent);
    expect(setPillowPipeline(enabled, upscale).pillowPipeline?.contour).not.toHaveProperty("workflow");
    expect(setPillowPipeline(enabled, null)).not.toHaveProperty("pillowPipeline");
  });
  it("shows unknown, missing and changed runtime or route configurations as blocking", () => {
    const enabled = setPillowPipeline(recipe, upscale);
    expect(pillowPipelineBlockers(enabled, [], undefined)).toHaveLength(2);
    expect(pillowPipelineBlockers({ ...enabled, modelRouteId: null }, [], { available: false, upscale: null })).toHaveLength(2);
    const models = [{ id: recipe.modelRouteId!, label: "Image", capability: "image", model: "gpt-image-2.5" }];
    expect(pillowPipelineBlockers(enabled, models, { available: true, upscale })).toEqual([]);
    expect(pillowPipelineBlockers(enabled, models, { available: true, upscale: { ...upscale, binarySha256: "d".repeat(64) } })).toHaveLength(1);
    expect(pillowPipelineBlockers(recipe, [], undefined)).toEqual([]);
  });
});
