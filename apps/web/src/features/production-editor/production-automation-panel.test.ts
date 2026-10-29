import { createPillowPipeline, DesignAutomationRecipeSchema, PILLOW_CONTOUR_GRAPH_VERSION, type DesignAutomationRecipe, type PillowUpscalePolicy } from "@yummyai/contracts/pod/design-automation";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { changeAutomationModelRoute, pillowPipelineBlockers, ProductionAutomationPanel, setAutomationUnlimitedCost, setPillowContourWorkflow, setPillowPipeline } from "./production-automation-panel";
import { createProductionDocument } from "./production-editor-model";

const recipe: DesignAutomationRecipe = { schemaVersion: 1, workflow: "template", imagePolicy: "faithful_enhancement", modelRouteId: "019f7600-0000-7000-8000-000000000001", allowOrderImageTransfer: true, modelCallLimit: 4, estimatedCostPerCallUsd: 0.2, maxEstimatedCostUsd: 1 };
const upscale: PillowUpscalePolicy = { engine: "realesrgan-ncnn-vulkan", release: "20220424", model: "realesrgan-x4plus", scale: 4, tileSize: 256,
  threads: "1:1:1", alphaStrategy: "source-alpha-lanczos3-rgb-nearest-fill-v1", binarySha256: "a".repeat(64), modelBinSha256: "b".repeat(64), modelParamSha256: "c".repeat(64) };

function panelMarkup(automation: DesignAutomationRecipe) {
  const document = { ...createProductionDocument("shaped_pillow"), automation };
  return renderToStaticMarkup(createElement(ProductionAutomationPanel, { document, onChange: () => { throw new Error("Rendering cannot edit a frozen recipe"); } }));
}

describe("automation provider changes", () => {
  it("requires new consent, price evidence and spending cap when choosing another provider route", () => {
    const original = structuredClone(recipe);
    const changed = changeAutomationModelRoute(recipe, "019f7600-0000-7000-8000-000000000002");
    expect(changed).toEqual({ ...recipe, modelRouteId: "019f7600-0000-7000-8000-000000000002", allowOrderImageTransfer: false, estimatedCostPerCallUsd: null, maxEstimatedCostUsd: null });
    expect(changed.modelCallLimit).toBe(4);
    expect(recipe).toEqual(original);
  });

  it("clears the prior authorization when removing a model but preserves an unchanged selection", () => {
    expect(changeAutomationModelRoute(recipe, null)).toMatchObject({ modelRouteId: null, allowOrderImageTransfer: false, estimatedCostPerCallUsd: null, maxEstimatedCostUsd: null });
    expect(changeAutomationModelRoute(recipe, recipe.modelRouteId)).toBe(recipe);
  });
  it("drops prior unlimited permission and the model pin instead of silently inheriting them on another route", () => {
    const original = setAutomationUnlimitedCost({ ...recipe, pillowPipeline: createPillowPipeline(upscale) }, true);
    const changed = changeAutomationModelRoute(original, "019f7600-0000-7000-8000-000000000002");
    expect(changed).not.toHaveProperty("costPolicy");
    expect(changed).not.toHaveProperty("pillowPipeline");
    expect(changed).toMatchObject({ allowOrderImageTransfer: false, estimatedCostPerCallUsd: null, maxEstimatedCostUsd: null, modelCallLimit: 4 });
    expect(original.costPolicy).toBe("unlimited");
    expect(original.pillowPipeline?.version).toBe("pillow-subject-v1-2026-09-19");
    expect(changeAutomationModelRoute(original, original.modelRouteId)).toBe(original);
  });

  it.each(["gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const)("explicitly enables v2 with the exact selected %s model and safe runtime policy", model => {
    const original = { ...recipe, imagePolicy: "preserve" as const };
    const enabled = setPillowPipeline(original, upscale, model);
    expect(original).not.toHaveProperty("pillowPipeline");
    expect(enabled).toMatchObject({ workflow: "pillow_photo", imagePolicy: "faithful_enhancement", pillowPipeline: { version: "pillow-subject-v2-2026-10-29", requiredModel: model, upscale } });
    expect(enabled.pillowPipeline?.contour).not.toHaveProperty("workflow");
    expect(setPillowPipeline(enabled, null)).not.toHaveProperty("pillowPipeline");
    expect(enabled.pillowPipeline).toBeDefined();
  });

  it("cannot invent a base-model pin while the route or its verified model is unknown", () => {
    expect(setPillowPipeline(recipe, upscale)).toBe(recipe);
    const unselected = { ...recipe, modelRouteId: null };
    expect(setPillowPipeline(unselected, upscale, "gpt-image-2.5-flare")).toBe(unselected);
  });

  it("leaves existing v1 configuration unchanged until the operator explicitly reenables a new version", () => {
    const legacy = { ...recipe, workflow: "pillow_photo" as const, pillowPipeline: createPillowPipeline(upscale) };
    const original = structuredClone(legacy);
    expect(panelMarkup(legacy)).toContain("pillow-subject-v1-2026-09-19");
    expect(panelMarkup(legacy)).not.toContain("pillow-subject-v2-2026-10-29");
    expect(legacy).toEqual(original);
    expect(changeAutomationModelRoute(legacy, legacy.modelRouteId)).toBe(legacy);
  });
  it("requires a separate contour opt-in and removes it without changing factory parameters", () => {
    expect(setPillowContourWorkflow(recipe, true)).toBe(recipe);
    const parent = setPillowPipeline(recipe, upscale, "gpt-image-2.5");
    const enabled = setPillowContourWorkflow(parent, true);
    expect(enabled.pillowPipeline?.contour.workflow).toBe(PILLOW_CONTOUR_GRAPH_VERSION);
    expect(parent.pillowPipeline?.contour).not.toHaveProperty("workflow");
    expect(setPillowContourWorkflow(enabled, false)).toEqual(parent);
    expect(setPillowPipeline(enabled, upscale, "gpt-image-2.5").pillowPipeline?.contour).not.toHaveProperty("workflow");
    expect(setPillowPipeline(enabled, null)).not.toHaveProperty("pillowPipeline");
  });
  it("shows unknown, missing and changed runtime or route configurations as blocking", () => {
    const enabled = setPillowPipeline(recipe, upscale, "gpt-image-2.5");
    expect(pillowPipelineBlockers(enabled, [], undefined)).toHaveLength(2);
    expect(pillowPipelineBlockers({ ...enabled, modelRouteId: null }, [], { available: false, upscale: null })).toHaveLength(2);
    const models = [{ id: recipe.modelRouteId!, label: "Image", capability: "image", model: "gpt-image-2.5" }];
    expect(pillowPipelineBlockers(enabled, models, { available: true, upscale })).toEqual([]);
    expect(pillowPipelineBlockers(enabled, models, { available: true, upscale: { ...upscale, binarySha256: "d".repeat(64) } })).toHaveLength(1);
    expect(pillowPipelineBlockers(recipe, [], undefined)).toEqual([]);
  });

  it("blocks a variant mismatch without aliasing flare or sunburst into the base model", () => {
    const enabled = setPillowPipeline(recipe, upscale, "gpt-image-2.5-flare");
    const model = { id: recipe.modelRouteId!, label: "Synthetic flare", capability: "image", model: "gpt-image-2.5-flare" };
    expect(pillowPipelineBlockers(enabled, [model], { available: true, upscale })).toEqual([]);
    expect(pillowPipelineBlockers(enabled, [{ ...model, model: "gpt-image-2.5" }], { available: true, upscale })).toEqual([
      "当前模型尚未验证为已固定的 gpt-image-2.5-flare，不能派发。",
    ]);
  });
});

describe("automation explicit spending policy", () => {
  it("stores unlimited consent with a null cap and does not invent a zero unit price", () => {
    const unpriced = { ...recipe, estimatedCostPerCallUsd: null };
    const unlimited = setAutomationUnlimitedCost(unpriced, true);
    expect(DesignAutomationRecipeSchema.parse(unlimited)).toMatchObject({ costPolicy: "unlimited", estimatedCostPerCallUsd: null, maxEstimatedCostUsd: null });
    expect(unpriced).not.toHaveProperty("costPolicy");
    expect(unpriced.maxEstimatedCostUsd).toBe(1);
  });

  it("removes unlimited consent when returning to priced-and-capped mode and requires a new cap", () => {
    const unlimited = setAutomationUnlimitedCost(recipe, true);
    const limited = setAutomationUnlimitedCost(unlimited, false);
    expect(limited).not.toHaveProperty("costPolicy");
    expect(limited.estimatedCostPerCallUsd).toBe(recipe.estimatedCostPerCallUsd);
    expect(limited.maxEstimatedCostUsd).toBeNull();
    expect(unlimited.costPolicy).toBe("unlimited");
  });

  it("renders unlimited mode as explicit, with optional unit price and a disabled absent cap", () => {
    const html = panelMarkup(setAutomationUnlimitedCost({ ...recipe, estimatedCostPerCallUsd: null }, true));
    expect(html).toContain('<option value="unlimited" selected="">不限费用 记录实际用量</option>');
    const unitPrice = html.match(/<label>每次调用预估费用（USD）<input[^>]+/)?.[0];
    const cap = html.match(/<label>每单预估费用上限（USD）<input[^>]+/)?.[0];
    expect(unitPrice).toContain('value=""');
    expect(unitPrice).not.toContain('required=""');
    expect(cap).toContain('disabled=""');
    expect(cap).toContain('value=""');
    expect(html).toContain("实际费用以渠道账单为准");
  });

  it("preserves legacy limited mode and shows both price and cap as required", () => {
    const html = panelMarkup(recipe);
    expect(html).toContain('<option value="limited" selected="">按预估费用限额</option>');
    expect(html.match(/<label>每次调用预估费用（USD）<input[^>]+/)?.[0]).toContain('required=""');
    expect(html.match(/<label>每单预估费用上限（USD）<input[^>]+/)?.[0]).toContain('required=""');
    expect(html).toContain("限额模式必须填写每次调用预估费用和每单预估费用上限");
    expect(recipe).not.toHaveProperty("costPolicy");
  });
});
