import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createPillowPipeline } from "@yummyai/contracts/pod/design-automation";
import type { ProductionEditorImageLayer, ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";
import { createDefaultProductionDocument } from "./products.js";
import { preflightProductionDocument } from "./renderer.js";

const assetId = "019f7600-0000-7000-8000-000000000001";
const options = { format: "jpeg", background: "white", purpose: "production" } as const;
const pipeline = createPillowPipeline({ engine: "realesrgan-ncnn-vulkan", release: "20220424", model: "realesrgan-x4plus", scale: 4, tileSize: 256, threads: "1:1:1", alphaStrategy: "source-alpha-lanczos3-rgb-nearest-fill-v1", binarySha256: "a".repeat(64), modelBinSha256: "b".repeat(64), modelParamSha256: "c".repeat(64) });

function document(subjectPx = 1500): ShapedPillowDocument {
  const original = createDefaultProductionDocument("shaped_pillow") as ShapedPillowDocument;
  const mm = (px: number) => px * 25.4 / 150;
  const contour = [[1710, 210, -90], [1710, 1710, 0], [210, 1710, 90], [210, 210, 180]].flatMap(([x, y, start]) => Array.from({ length: 17 }, (_, i) => {
    const angle = (start! + i * 90 / 16) * Math.PI / 180;
    return { xMm: mm(x! + Math.cos(angle) * 210), yMm: mm(y! + Math.sin(angle) * 210), smooth: false };
  }));
  return {
    ...original, spec: { ...original.spec, widthMm: mm(1920), heightMm: mm(1920), declaredLongestMm: 254, barcodeTab: { ...original.spec.barcodeTab, centerXMm: mm(960) } },
    contour,
    layers: [{ kind: "image", id: "photo", name: "Synthetic", assetId, assetVersion: 1, xMm: mm(210) - 250 * 254 / subjectPx, yMm: mm(210) - 250 * 254 / subjectPx, widthMm: 2000 * 254 / subjectPx, heightMm: 2000 * 254 / subjectPx, rotationDeg: 0, flipX: false, flipY: false, opacity: 1, visible: true, locked: true }],
    automation: { schemaVersion: 1, workflow: "pillow_photo", imagePolicy: "faithful_enhancement", modelRouteId: null, allowOrderImageTransfer: true, modelCallLimit: 2, estimatedCostPerCallUsd: 0.1, maxEstimatedCostUsd: 0.2, pillowPipeline: pipeline },
  };
}

async function subject(subjectPx = 1500, residue = true) {
  const rgba = Buffer.alloc(2000 * 2000 * 4);
  for (let y = 250; y < 250 + subjectPx; y++) for (let x = 250; x < 250 + subjectPx; x++) {
    const offset = (y * 2000 + x) * 4;
    rgba[offset] = 58; rgba[offset + 1] = 83; rgba[offset + 2] = 137; rgba[offset + 3] = 255;
  }
  if (residue) { rgba[3] = 31; rgba[rgba.length - 1] = 1; }
  return sharp(rgba, { raw: { width: 2000, height: 2000, channels: 4 } }).png().withMetadata({ density: 600 }).toBuffer();
}

async function preflight(value: ShapedPillowDocument, bytes: Buffer) {
  return preflightProductionDocument(value, options, { resolveAsset: async () => ({ bytes }), resolveFont: async () => { throw new Error("fixture_has_no_fonts"); } });
}

describe("server verification of the opt-in pillow measurement", () => {
  it("uses alpha32 visible bounds instead of full canvas or faint residue", async () => {
    const bytes = await subject();
    const correct = await preflight(document(), bytes);
    expect(correct.issues.filter(issue => issue.severity === "error")).toEqual([]);
    expect(correct.productionReady).toBe(false);
    expect(correct.issues).toContainEqual(expect.objectContaining({ code: "visual_review_required", severity: "manual" }));
    const canvasSized = document();
    (canvasSized.layers[0] as ProductionEditorImageLayer).widthMm = 254;
    (canvasSized.layers[0] as ProductionEditorImageLayer).heightMm = 254;
    expect((await preflight(canvasSized, bytes)).issues).toContainEqual(expect.objectContaining({ code: "pillow_subject_size_mismatch", severity: "error" }));
  });

  it("strictly rejects a 1499-pixel subject at 10 inches even with a 600-DPI tag; legacy tolerance is unchanged", async () => {
    const bytes = await subject(1499);
    const current = document(1499);
    expect((await preflight(current, bytes)).issues).toContainEqual(expect.objectContaining({ code: "insufficient_image_resolution", severity: "error" }));
    const legacy = structuredClone(current); delete legacy.automation;
    expect((await preflight(legacy, bytes)).issues.some(issue => issue.code === "insufficient_image_resolution")).toBe(false);
  });

  it("refuses stretched or unlocked source artwork", async () => {
    const bytes = await subject();
    const stretched = document();
    (stretched.layers[0] as ProductionEditorImageLayer).heightMm *= 0.9;
    expect((await preflight(stretched, bytes)).issues).toContainEqual(expect.objectContaining({ code: "pillow_artwork_aspect_mismatch" }));
    const unlocked = document(); unlocked.layers[0]!.locked = false;
    expect((await preflight(unlocked, bytes)).issues).toContainEqual(expect.objectContaining({ code: "pillow_artwork_not_locked" }));
  });

  it("requires real input alpha for the new workflow", async () => {
    const bytes = await sharp({ create: { width: 1500, height: 1500, channels: 3, background: "#547289" } }).png().toBuffer();
    const value = document();
    (value.layers[0] as ProductionEditorImageLayer).widthMm = 254;
    (value.layers[0] as ProductionEditorImageLayer).heightMm = 254;
    expect((await preflight(value, bytes)).issues).toContainEqual(expect.objectContaining({ code: "pillow_subject_alpha_required" }));
  });

  it.each([0.96, 1.15])("server blocks a manually changed contour (%s) without changing legacy behavior", async factor => {
    const bytes = await subject(), value = document();
    const center = value.spec.widthMm / 2;
    value.contour = value.contour.map(point => ({ ...point, xMm: center + (point.xMm - center) * factor, yMm: center + (point.yMm - center) * factor }));
    if (factor > 1) {
      const offset = center * (factor - 1);
      value.contour = value.contour.map(point => ({ ...point, xMm: point.xMm + offset, yMm: point.yMm + offset }));
      value.layers = value.layers.map(layer => ({ ...layer, xMm: layer.xMm + offset, yMm: layer.yMm + offset }));
      value.spec.widthMm *= factor; value.spec.heightMm *= factor; value.spec.barcodeTab.centerXMm += offset;
    }
    expect((await preflight(value, bytes)).issues).toContainEqual(expect.objectContaining({ code: "pillow_contour_seam_envelope_failed", severity: "error" }));
    delete value.automation;
    expect((await preflight(value, bytes)).issues.some(issue => issue.code === "pillow_contour_seam_envelope_failed")).toBe(false);
  });
});
