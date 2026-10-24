import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { createPillowPipeline } from "@yummyai/contracts/pod/design-automation";
import type { ProductionEditorDocument, ProductionEditorExportOptions } from "@yummyai/contracts/pod/production-editor";
import { preflightProductionDocument, renderProductionDocument } from "@yummyai/production-editor";
import { measurePillowSubject, planPillowSubjectPlacement, type PillowSubjectMeasurement } from "@yummyai/production-editor/pillow-subject";
import { createDefaultProductionDocument, productionExportDefaults } from "@yummyai/production-editor/products";
import { createSyntheticCenterDocument, placeSyntheticCenterImage, syntheticProductionPng, productionEditorFixtureFailureDiagnostic } from "../../../e2e/production-editor-fixture";

// Use the image package's installed decoder; this Web unit neither starts the
// exported Worker fixture nor connects to an API, a database or object storage.
const sharp = createRequire(new URL("../../../../../packages/production-editor/package.json", import.meta.url))("sharp");
type Decoded = { bytes: Buffer; data: Buffer; width: number; height: number; channels: number;
  metadata: { format?: string; width?: number; height?: number; channels?: number; hasAlpha?: boolean; density?: number } };
async function decode(bytes: Buffer): Promise<Decoded> {
  const metadata: Decoded["metadata"] = await sharp(bytes, { failOn: "error" }).metadata();
  const result = await sharp(bytes, { failOn: "error" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true }) as {
    data: Buffer; info: { width: number; height: number; channels: number } };
  return { bytes, metadata, data: result.data, ...result.info };
}
const pixel = (image: Decoded, x: number, y: number) => [...image.data.subarray((y * image.width + x) * image.channels, (y * image.width + x) * image.channels + image.channels)];
const measurement = (image: Decoded) => measurePillowSubject({ width: image.width, height: image.height, rgba: image.data });
const imagePath = "production-editor/projects/019f7600-0000-7000-8000-000000000001/images";

describe("synthetic production image bytes and safe fixture diagnostics", () => {
  let cutout: Decoded, subject: PillowSubjectMeasurement;
  beforeAll(async () => { cutout = await decode(syntheticProductionPng(2048, true)); subject = measurement(cutout); });

  it("actually decodes the default PNG and its two original opaque colours instead of trusting its requested size", async () => {
    const image = await decode(syntheticProductionPng());
    expect(image.metadata).toMatchObject({ format: "png", width: 512, height: 512, channels: 4, hasAlpha: true });
    expect(image).toMatchObject({ width: 512, height: 512, channels: 4 }); expect(image.data).toHaveLength(512 * 512 * 4);
    expect(pixel(image, 128, 256)).toEqual([225, 90, 80, 255]); expect(pixel(image, 384, 256)).toEqual([25, 90, 205, 255]);
    expect(measurement(image).bounds).toEqual({ x: 0, y: 0, width: 512, height: 512 });
  });

  it("measures a real transparent foreground from decoded alpha rather than counting the padded canvas as the subject", () => {
    expect(cutout.metadata).toMatchObject({ format: "png", width: 2048, height: 2048, hasAlpha: true });
    expect(pixel(cutout, 0, 0)[3]).toBe(0); expect(pixel(cutout, 2047, 2047)[3]).toBe(0);
    expect(pixel(cutout, 800, 1024)[3]).toBe(255); expect(pixel(cutout, 1200, 1024)[3]).toBe(255);
    expect(subject.bounds).toEqual({ x: 349, y: 287, width: 1147, height: 1475 });
    expect(subject.visiblePixelCount).toBeGreaterThan(0); expect(subject.visiblePixelCount).toBeLessThan(cutout.width * cutout.height);
    expect(subject.ignoredLowAlphaPixelCount).toBe(0); expect(subject.alphaThreshold).toBe(32);
  });

  it("keeps the current factory standard and strictly reports the actual 147.5 PPI shortfall at a physical ten inches", () => {
    const placement = planPillowSubjectPlacement(subject, { longestSideInches: 10 });
    expect(placement).toMatchObject({ targetLongestPx: 1500, dpi: 150, effectivePpi: 147.5, requiresUpscale: true });
    expect(Math.max(placement.subjectWidthMm, placement.subjectHeightMm)).toBeCloseTo(254, 10);
    expect(placement.requiredUpscaleFactor).toBeCloseTo(150 / 147.5, 12);
    expect(placement.artworkHeightMm).toBeGreaterThan(placement.subjectHeightMm); expect(placement.artworkOffsetYMm).toBeLessThan(0);
    const document = createDefaultProductionDocument("shaped_pillow");
    if (document.productType !== "shaped_pillow") throw new Error("Synthetic pillow document expected");
    expect(document.spec).toMatchObject({ factoryStandardId: "ps-pillow-2026-09-17", dpi: 150, sizeBasis: "artwork", artworkClipMode: "none" });
    expect(productionExportDefaults(document)).toEqual({ format: "jpeg", background: "white" });
    expect(Object.values(document.confirmations).every(value => value === false)).toBe(true);
  });

  it("distinguishes sufficient actual source pixels at ten inches from the same image's insufficient pixels at twelve inches", async () => {
    const larger = measurement(await decode(syntheticProductionPng(2304, true)));
    expect(Math.max(larger.bounds.width, larger.bounds.height)).toBe(1659);
    const ten = planPillowSubjectPlacement(larger, { longestSideInches: 10 }), twelve = planPillowSubjectPlacement(larger, { longestSideInches: 12 });
    expect(ten).toMatchObject({ targetLongestPx: 1500, effectivePpi: 165.9, requiresUpscale: false, requiredUpscaleFactor: 1 });
    expect(twelve).toMatchObject({ targetLongestPx: 1800, effectivePpi: 138.25, requiresUpscale: true });
    expect(Math.max(twelve.subjectWidthMm, twelve.subjectHeightMm)).toBeCloseTo(304.8, 10);
  });

  it("does not turn insufficient physical resolution into a pass by adding a 600-DPI metadata tag", async () => {
    const tagged = await decode(await sharp(cutout.bytes).withMetadata({ density: 600 }).png().toBuffer());
    expect(tagged.metadata.density).toBe(600); expect(tagged.width).toBe(cutout.width); expect(tagged.height).toBe(cutout.height);
    expect(measurement(tagged)).toEqual(subject);
    expect(planPillowSubjectPlacement(measurement(tagged), { longestSideInches: 10 })).toMatchObject({ effectivePpi: 147.5, requiresUpscale: true });
  });

  it("classifies only the actual allowlisted public 422 failures without exposing unrelated payload fields", () => {
    const known = [["安全扫描暂不可用，文件未保存", "scan_unavailable"], ["文件未通过安全扫描", "scan_rejected"],
      ["仅支持有效的单页 PNG/JPEG/TIFF，最多一亿像素", "image_decode_invalid"], ["仅支持有效的 TTF/OTF 字体", "font_decode_invalid"],
      ["图片最大 64 MiB", "upload_size_limit"], ["字体最大 10 MiB", "upload_size_limit"], ["文件编码无效", "base64_invalid"]];
    for (const [message, code] of known) {
      const result = productionEditorFixtureFailureDiagnostic(imagePath, 422, { message, token: "SYNTHETIC-PRIVATE-TOKEN", body: "SYNTHETIC-PRIVATE-BYTES" });
      expect(result).toBe(`production-editor/projects/:id/images: HTTP 422; diagnostic=${code}`);
      expect(result).not.toContain("SYNTHETIC-PRIVATE"); expect(result).not.toContain("019f7600");
    }
  });

  it("keeps session, permission and version errors separate from image or scanner failures", () => {
    for (const [status, reason] of [[401, "session_required"], [403, "permission_denied"], [409, "source_or_version_conflict"], [400, "request_rejected"]] as const)
      expect(productionEditorFixtureFailureDiagnostic(imagePath, status, { message: "安全扫描暂不可用，文件未保存" }))
        .toBe(`production-editor/projects/:id/images: HTTP ${status}; diagnostic=${reason}`);
  });

  it("never echoes arbitrary paths, query credentials, private body text or an untrusted upstream code", () => {
    const secret = "SYNTHETIC-PRIVATE-CREDENTIAL", paths = [`${imagePath}?access_token=${secret}`, `private/${secret}?token=${secret}`, `https://provider.invalid/${secret}`];
    for (const path of paths) for (const payload of [secret, `<html>${secret}</html>`, [secret], { message: secret, code: "scan_unavailable", detail: secret }, null]) {
      const result = productionEditorFixtureFailureDiagnostic(path, 422, payload);
      expect(result).toMatch(/^(?:production-editor\/projects\/:id\/images|fixture API request): HTTP 422; diagnostic=unclassified_rejection$/);
      expect(result).not.toContain(secret); expect(result).not.toContain("access_token"); expect(result).not.toContain("provider.invalid");
    }
  });

  it("does not infer a known classification from a substring, altered public text or a different HTTP status", () => {
    for (const message of [" 安全扫描暂不可用，文件未保存", "安全扫描暂不可用，文件未保存 trailing-private-data", "scan_unavailable"])
      expect(productionEditorFixtureFailureDiagnostic(imagePath, 422, { message })).toContain("diagnostic=unclassified_rejection");
    expect(productionEditorFixtureFailureDiagnostic(imagePath, 500, { message: "安全扫描暂不可用，文件未保存" }))
      .toBe("production-editor/projects/:id/images: HTTP 500; diagnostic=unclassified_rejection");
  });
});

describe("synthetic center renderer preflight", () => {
  const assetId = "019f7600-0000-7000-8000-000000000001";
  let artwork: Decoded;
  beforeAll(async () => { artwork = await decode(syntheticProductionPng(2048)); });
  function pillow(image = artwork) {
    const document = createSyntheticCenterDocument("shaped_pillow");
    if (document.productType !== "shaped_pillow") throw new Error("Synthetic pillow document expected");
    document.layers = [placeSyntheticCenterImage(document, { id: assetId, name: "Decoded synthetic artwork", width: image.width, height: image.height })];
    return document;
  }
  function confirmSyntheticGeometry(document: ProductionEditorDocument) {
    // These confirmations apply only to the decoded, known synthetic geometry
    // checked below; they are not operator approval of any real production file.
    document.confirmations = { physicalSize: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true, visualReview: true };
  }
  async function preflight(document: ProductionEditorDocument, image = artwork,
    options: ProductionEditorExportOptions = { ...productionExportDefaults(document), purpose: "production" }) {
    return preflightProductionDocument(document, options, {
      resolveAsset: async (id, version) => {
        expect(id).toBe(assetId); expect(version).toBe(1);
        return { bytes: image.bytes };
      },
      resolveFont: async () => { throw new Error("fixture_has_no_fonts"); },
    });
  }

  it("keeps a new decoded-image draft manual while checking the actual ten-inch artwork, seams and sheet pixels", async () => {
    const document = pillow(), layer = document.layers[0]!;
    expect(artwork.metadata).toMatchObject({ format: "png", width: 2048, height: 2048 });
    expect(measurement(artwork)).toMatchObject({ bounds: { x: 0, y: 0, width: 2048, height: 2048 }, visiblePixelCount: 2048 * 2048 });
    expect(document.spec).toMatchObject({ factoryStandardId: "ps-pillow-2026-09-17", dpi: 150, sizeBasis: "artwork", declaredLongestMm: 254 });
    expect(layer).toMatchObject({ kind: "image", assetId, assetVersion: 1, locked: true, widthMm: 254, heightMm: 254 });
    expect(layer.xMm * 150 / 25.4).toBeCloseTo(200, 10); expect(layer.yMm * 150 / 25.4).toBeCloseTo(200, 10);
    expect(document.spec.widthMm * 150 / 25.4).toBeCloseTo(1900, 10);
    expect(document.spec.heightMm * 150 / 25.4).toBeCloseTo(1900, 10);
    expect(document.spec.barcodeTab.widthMm! * 150 / 25.4).toBeCloseTo(600, 10);
    expect(document.spec.barcodeTab.heightMm! * 150 / 25.4).toBeCloseTo(200, 10);
    expect(Object.values(document.confirmations).every(value => value === false)).toBe(true);
    const result = await preflight(document);
    expect(result).toMatchObject({ productionReady: false, widthPx: 4012, heightPx: 2206 });
    expect(result.issues.filter(issue => issue.severity === "error")).toEqual([]);
    expect(result.issues.filter(issue => issue.severity === "manual").map(issue => issue.code)).toEqual([
      "physical_size_unconfirmed", "visual_review_required", "narrow_parts_unconfirmed", "white_border_unconfirmed", "barcode_rule_unconfirmed",
    ]);
    expect(Object.values(document.confirmations).every(value => value === false)).toBe(true);
  });

  it("passes actual renderer preflight only after explicitly confirming the checked synthetic geometry with JPEG white output", async () => {
    const document = pillow();
    expect(measurement(artwork).bounds).toEqual({ x: 0, y: 0, width: 2048, height: 2048 });
    expect(artwork.width / (document.spec.declaredLongestMm! / 25.4)).toBe(204.8);
    expect(document.layers[0]).toMatchObject({ widthMm: 254, heightMm: 254, locked: true });
    expect(productionExportDefaults(document)).toEqual({ format: "jpeg", background: "white" });
    confirmSyntheticGeometry(document);
    const result = await preflight(document);
    expect(result).toMatchObject({ productionReady: true, widthPx: 4012, heightPx: 2206 });
    expect(result.issues.filter(issue => issue.severity === "error" || issue.severity === "manual")).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "manual_factory_preflight", severity: "warning" }));
  });

  it("rejects PNG transparent production output even when the same synthetic geometry is explicitly confirmed", async () => {
    const document = pillow(); confirmSyntheticGeometry(document);
    const result = await preflight(document, artwork, { format: "png", background: "transparent", purpose: "production" });
    expect(result.productionReady).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "factory_jpg_required", severity: "error" }));
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "factory_white_background", severity: "error" }));
  });

  it("rejects genuinely low source pixels at the same physical size despite a 600-DPI tag and explicit synthetic confirmations", async () => {
    const low = await decode(await sharp(syntheticProductionPng(512)).withMetadata({ density: 600 }).png().toBuffer());
    const document = pillow(low); confirmSyntheticGeometry(document);
    expect(low.metadata).toMatchObject({ width: 512, height: 512, density: 600 });
    expect(low.width / (document.spec.declaredLongestMm! / 25.4)).toBe(51.2);
    expect(document.layers[0]).toMatchObject({ widthMm: 254, heightMm: 254 });
    const result = await preflight(document, low);
    expect(result.productionReady).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "insufficient_image_resolution", severity: "error" }));
  });

  it("preserves an existing pipeline through placement and real preflight instead of deleting it to evade its alpha requirement", async () => {
    const opaque = await decode(await sharp(artwork.bytes).removeAlpha().png().toBuffer());
    expect(opaque.metadata.hasAlpha).toBe(false);
    const document = pillow(opaque);
    document.automation = { schemaVersion: 1, workflow: "pillow_photo", imagePolicy: "faithful_enhancement", modelRouteId: null,
      allowOrderImageTransfer: true, modelCallLimit: 2, estimatedCostPerCallUsd: 0.1, maxEstimatedCostUsd: 0.2,
      pillowPipeline: createPillowPipeline({ engine: "realesrgan-ncnn-vulkan", release: "20220424", model: "realesrgan-x4plus", scale: 4,
        tileSize: 256, threads: "1:1:1", alphaStrategy: "source-alpha-lanczos3-rgb-nearest-fill-v1",
        binarySha256: "a".repeat(64), modelBinSha256: "b".repeat(64), modelParamSha256: "c".repeat(64) }) };
    const originalAutomation = document.automation, originalPipeline = originalAutomation.pillowPipeline;
    const originalBody = structuredClone(originalAutomation);
    document.layers = [placeSyntheticCenterImage(document, { id: assetId, name: "Actual opaque PNG", width: opaque.width, height: opaque.height })];
    confirmSyntheticGeometry(document);
    const result = await preflight(document, opaque);
    expect(document.automation).toBe(originalAutomation); expect(document.automation.pillowPipeline).toBe(originalPipeline);
    expect(document.automation).toEqual(originalBody);
    expect(result.productionReady).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "pillow_subject_alpha_required", severity: "error" }));
  });

  it.each(["tire_cover", "rectangular_print"] as const)("keeps the non-pillow %s placement valid under real renderer preflight", async kind => {
    const document = createSyntheticCenterDocument(kind);
    const body = document.productType === "tire_cover" ? { width: document.spec.diameterMm, height: document.spec.diameterMm }
      : document.productType === "rectangular_print" ? { width: document.spec.widthMm, height: document.spec.heightMm } : null;
    if (!body) throw new Error("Synthetic non-pillow document expected");
    const layer = placeSyntheticCenterImage(document, { id: assetId, name: "Decoded non-pillow artwork", width: artwork.width, height: artwork.height });
    document.layers = [layer];
    expect(layer.widthMm).toBeCloseTo(Math.min(body.width, body.height) * 0.68, 10);
    expect(layer.heightMm).toBeCloseTo(layer.widthMm, 10);
    expect(layer.xMm + layer.widthMm / 2).toBeCloseTo(body.width / 2, 10);
    expect(layer.yMm + layer.heightMm / 2).toBeCloseTo(body.height / 2, 10);
    expect(artwork.width / (layer.widthMm / 25.4)).toBeGreaterThanOrEqual(document.spec.dpi);
    expect(Object.values(document.confirmations).every(value => value === false)).toBe(true);
    confirmSyntheticGeometry(document);
    const result = await preflight(document);
    expect(result.productionReady).toBe(true); expect(result.issues).toEqual([]);
    expect(result.widthPx).toBe(kind === "tire_cover" ? 295 : 354); expect(result.heightPx).toBe(kind === "tire_cover" ? 295 : 236);
  });
});

describe("twelve-inch synthetic center geometry", () => {
  const assetId = "019f7600-0000-7000-8000-000000000001";
  let artwork: Decoded;
  beforeAll(async () => { artwork = await decode(syntheticProductionPng(2048)); });
  function twelveInchDocument() {
    const document = createSyntheticCenterDocument("shaped_pillow", { longestSideInches: 12 });
    if (document.productType !== "shaped_pillow") throw new Error("Synthetic twelve-inch pillow document expected");
    document.layers = [placeSyntheticCenterImage(document, { id: assetId, name: "Actual twelve-inch synthetic artwork", width: artwork.width, height: artwork.height })];
    return document;
  }
  const resolvers = () => ({ resolveAsset: async (id: string, version: number) => {
    expect(id).toBe(assetId); expect(version).toBe(1); return { bytes: artwork.bytes };
  }, resolveFont: async () => { throw new Error("fixture_has_no_fonts"); } });

  it("preflights actual twelve-inch artwork and a larger sheet without changing default ten-inch drafts", async () => {
    const ten = createSyntheticCenterDocument("shaped_pillow"), tenBefore = structuredClone(ten), twelve = twelveInchDocument();
    if (ten.productType !== "shaped_pillow") throw new Error("Synthetic ten-inch pillow document expected");
    expect(artwork.metadata).toMatchObject({ format: "png", width: 2048, height: 2048 });
    expect(measurement(artwork).bounds).toEqual({ x: 0, y: 0, width: 2048, height: 2048 });
    expect(twelve.spec.declaredLongestMm).toBeCloseTo(304.8, 10);
    expect(twelve.spec.widthMm * 150 / 25.4).toBeCloseTo(2200, 10);
    expect(twelve.spec.heightMm * 150 / 25.4).toBeCloseTo(2200, 10);
    expect(twelve.layers[0]).toMatchObject({ kind: "image", locked: true });
    const layer = twelve.layers[0]!;
    if (layer.kind !== "image") throw new Error("Synthetic image layer expected");
    expect(layer.widthMm).toBeCloseTo(304.8, 10); expect(layer.heightMm).toBeCloseTo(304.8, 10);
    expect(layer.xMm * 150 / 25.4).toBeCloseTo(200, 10); expect(layer.yMm * 150 / 25.4).toBeCloseTo(200, 10);
    expect(artwork.width / (layer.widthMm / 25.4)).toBeCloseTo(170.66666666666666, 10);
    expect(twelve.spec.barcodeTab.centerXMm * 150 / 25.4).toBeCloseTo(1100, 10);
    expect(Object.values(twelve.confirmations).every(value => value === false)).toBe(true);
    const options = { ...productionExportDefaults(twelve), purpose: "production" as const };
    expect(options).toEqual({ format: "jpeg", background: "white", purpose: "production" });
    const draft = await preflightProductionDocument(twelve, options, resolvers());
    expect(draft).toMatchObject({ productionReady: false, widthPx: 4612, heightPx: 2506 });
    expect(draft.issues.filter(issue => issue.severity === "error")).toEqual([]);
    expect(draft.issues).toContainEqual(expect.objectContaining({ code: "physical_size_unconfirmed", severity: "manual" }));
    expect(ten).toEqual(tenBefore); expect(createSyntheticCenterDocument("shaped_pillow")).toEqual(tenBefore);
    expect(ten.spec.declaredLongestMm).toBe(254); expect(ten.spec.widthMm * 150 / 25.4).toBeCloseTo(1900, 10);
    expect(ten.spec.barcodeTab.centerXMm * 150 / 25.4).toBeCloseTo(950, 10);
  });

  it("renders a full-resolution twelve-inch JPEG with actual white RGB pixels after explicit synthetic-only confirmation", async () => {
    const document = twelveInchDocument();
    expect(measurement(artwork).bounds).toEqual({ x: 0, y: 0, width: 2048, height: 2048 });
    expect(document.spec.declaredLongestMm).toBeCloseTo(304.8, 10);
    // Only this verified synthetic layout is confirmed, with no real operator,
    // supplier acceptance or production release implied by the unit fixture.
    document.confirmations = { physicalSize: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true, visualReview: true };
    const original = structuredClone(document);
    const result = await renderProductionDocument(document, { ...productionExportDefaults(document), purpose: "production" }, resolvers());
    expect(result).toMatchObject({ mediaType: "image/jpeg", widthPx: 4612, heightPx: 2506, dpi: 150, preflight: { productionReady: true } });
    expect(result.preflight.issues.filter(issue => issue.severity !== "warning")).toEqual([]);
    const jpeg = await decode(result.bytes), metadata = await sharp(result.bytes).metadata();
    expect(jpeg.metadata).toMatchObject({ format: "jpeg", width: 4612, height: 2506, channels: 3, hasAlpha: false, density: 150 });
    expect(metadata.space).toBe("srgb"); expect(metadata.icc?.length).toBeGreaterThan(0);
    expect(jpeg.data).toHaveLength(4612 * 2506 * 4);
    expect(pixel(jpeg, 0, 0)).toEqual([255, 255, 255, 255]); expect(pixel(jpeg, 4611, 2505)).toEqual([255, 255, 255, 255]);
    // Read well inside each real colour region, allowing JPEG quantization.
    for (const [x, expected] of [[703, [225, 90, 80]], [1603, [25, 90, 205]]] as const) {
      const actual = pixel(jpeg, x, 1153);
      expected.forEach((channel, index) => expect(Math.abs(actual[index]! - channel)).toBeLessThanOrEqual(2));
      expect(actual[3]).toBe(255);
    }
    expect(document).toEqual(original);
  }, 30_000);
});
