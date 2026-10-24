import { ProductionEditorDocumentSchema, ProductionEditorExportOptionsSchema, SHAPED_PILLOW_FACTORY_STANDARD, type ProductionEditorDocument, type ProductionEditorExportOptions, type ProductionEditorImageLayer, type ProductionEditorPreflight, type ProductionEditorPreflightIssue, type ProductionEditorTextLayer } from "@yummyai/contracts/pod/production-editor";
import { preflightProductionProduct } from "./product-preflight.js";
import { applyArtworkAudit, type ArtworkAuditReport } from "@yummyai/contracts/ai/artwork-audit";
import { renderProductionProductBody } from "./product-rendering.js";
import type opentype from "opentype.js";
import sharp from "sharp";

import { getProductionLayout, layoutArcGlyphs, MAX_PRODUCTION_PIXELS } from "./geometry.js";
import { buildProductionTextPaths, parseProductionFont, productionTextMetrics as textMetrics } from "./text.js";
import { measurePillowSubject, PILLOW_SUBJECT_MEASUREMENT_VERSION, type PillowSubjectMeasurement } from "./pillow-subject.js";
import { verifyPillowAutomationGeometry, type PillowAutomationGeometryVerification } from "./pillow-automation-geometry.js";

export interface ProductionEditorResolvers {
  /** Trusted server evidence; absent from all client document/options schemas. */
  artworkAudit?: ArtworkAuditReport | null;
  resolveAsset(assetId: string, assetVersion: number): Promise<{ bytes: Uint8Array }>;
  resolveFont(fontId: string): Promise<{ bytes: Uint8Array }>;
}
interface LoadedAsset { bytes: Buffer; width: number; height: number; hasAlpha: boolean; pillowSubject?: PillowSubjectMeasurement; pillowGeometry?: PillowAutomationGeometryVerification }
interface Prepared { document: ProductionEditorDocument; options: ProductionEditorExportOptions; preflight: ProductionEditorPreflight; assets: Map<string, LoadedAsset>; fonts: Map<string, opentype.Font> }
const MAX_INLINE_IMAGE_BYTES = 128 * 1024 * 1024;
export class ProductionEditorRenderError extends Error {
  constructor(public readonly preflight: ProductionEditorPreflight) { super("production_preflight_failed"); this.name = "ProductionEditorRenderError"; }
}

export async function preflightProductionDocument(rawDocument: ProductionEditorDocument, rawOptions: ProductionEditorExportOptions, resolvers: ProductionEditorResolvers): Promise<ProductionEditorPreflight> {
  return (await prepare(rawDocument, rawOptions, resolvers)).preflight;
}

async function prepare(rawDocument: ProductionEditorDocument, rawOptions: ProductionEditorExportOptions, resolvers: ProductionEditorResolvers): Promise<Prepared> {
  const document = ProductionEditorDocumentSchema.parse(rawDocument);
  const versionedPillow = document.productType === "shaped_pillow" && document.automation?.pillowPipeline?.version === PILLOW_SUBJECT_MEASUREMENT_VERSION;
  const options = ProductionEditorExportOptionsSchema.parse(rawOptions);
  const layout = getProductionLayout(document);
  const issues: ProductionEditorPreflightIssue[] = [];
  const issue = (code: string, message: string, severity: ProductionEditorPreflightIssue["severity"] = "error", layerId?: string) => issues.push({ code, message, severity, ...(layerId ? { layerId } : {}) });
  if (layout.widthPx * layout.heightPx > MAX_PRODUCTION_PIXELS) issue("pixel_limit", "生产文件超过 1 亿像素上限，请调整规格。");
  if (options.format === "jpeg" && options.background === "transparent") issue("jpeg_transparency", "JPEG 不支持透明背景，请选 PNG/TIFF 或明确白底。");
  if (document.productType === "shaped_pillow" && document.spec.factoryStandardId === SHAPED_PILLOW_FACTORY_STANDARD.id && options.purpose === "production") {
    if (options.format !== "jpeg") issue("factory_jpg_required", "异形抱枕工厂交付必须为 JPG。");
    if (options.background !== "white") issue("factory_white_background", "异形抱枕工厂交付必须为整张白底 RGB 图片。");
  }
  if (!document.layers.some((layer) => layer.visible)) issue("empty_artwork", "没有可见图层。");
  if (versionedPillow && document.productType === "shaped_pillow" && document.spec.factoryStandardId !== SHAPED_PILLOW_FACTORY_STANDARD.id) issue("pillow_pinned_factory_standard_required", "新版本抱枕流程必须使用订单固定的工厂工艺版本。");
  if (!document.confirmations.physicalSize) issue("physical_size_unconfirmed", "请核对并确认工厂要求的实际毫米尺寸与测量基准。", "manual");
  if (!document.confirmations.visualReview) issue("visual_review_required", "请核对服务端生产预览，包括文字、裁剪和正背片。", "manual");
  issues.push(...preflightProductionProduct(document));
  const assets = new Map<string, LoadedAsset>();
  const fonts = new Map<string, opentype.Font>();
  let totalAssetBytes = 0, totalSourcePixels = 0, totalFontBytes = 0;
  for (const layer of document.layers.filter((entry) => entry.visible)) {
    if (layer.kind === "image") {
      const key = `${layer.assetId}:${layer.assetVersion}`;
      try {
        let asset = assets.get(key);
        if (!asset) {
          const resolved = await resolvers.resolveAsset(layer.assetId, layer.assetVersion);
          const bytes = Buffer.from(resolved.bytes);
          if (!bytes.length || bytes.length > 64 * 1024 * 1024 || !isRaster(bytes)) throw new Error("unsupported_asset");
          totalAssetBytes += bytes.length;
          if (totalAssetBytes > 128 * 1024 * 1024) throw new Error("aggregate_asset_limit");
          const metadata = await sharp(bytes, { limitInputPixels: MAX_PRODUCTION_PIXELS }).metadata();
          if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new Error("unsupported_asset");
          totalSourcePixels += metadata.width * metadata.height;
          if (totalSourcePixels > 200_000_000) throw new Error("aggregate_pixel_limit");
          const rotated = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
          asset = { bytes, width: rotated ? metadata.height : metadata.width, height: rotated ? metadata.width : metadata.height, hasAlpha: metadata.hasAlpha ?? false };
          if (versionedPillow) {
            const rgba = await sharp(bytes, { limitInputPixels: MAX_PRODUCTION_PIXELS }).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            const raster = { width: rgba.info.width, height: rgba.info.height, rgba: rgba.data };
            if (document.productType === "shaped_pillow" && document.spec.declaredLongestMm && document.spec.factoryStandardId === SHAPED_PILLOW_FACTORY_STANDARD.id) {
              asset.pillowGeometry = verifyPillowAutomationGeometry(document, raster, { artworkLayerId: layer.id, longestSideInches: document.spec.declaredLongestMm / 25.4, roundingPx: document.automation!.pillowPipeline!.contour.maxExtraPx });
              asset.pillowSubject = asset.pillowGeometry.measurement;
            } else asset.pillowSubject = measurePillowSubject(raster);
          }
          assets.set(key, asset);
        }
        const effectiveDpi = Math.min(asset.width / (layer.widthMm / 25.4), asset.height / (layer.heightMm / 25.4));
        if (versionedPillow && document.productType === "shaped_pillow") {
          const bounds = asset.pillowSubject!.bounds;
          const subjectLongestMm = Math.max(bounds.width * layer.widthMm / asset.width, bounds.height * layer.heightMm / asset.height);
          if (!asset.hasAlpha) issue("pillow_subject_alpha_required", "新版本抱枕流程要求保留真实 alpha 的中间主体素材。", "error", layer.id);
          if (!layer.locked) issue("pillow_artwork_not_locked", "主体尺寸校准后须锁定图案，再单独调整裁线。", "error", layer.id);
          if (Math.abs(layer.widthMm / layer.heightMm / (asset.width / asset.height) - 1) > 1e-6) issue("pillow_artwork_aspect_mismatch", "主体图案必须按原始素材比例放置，不可拉伸适应裁线。", "error", layer.id);
          if (!document.spec.declaredLongestMm || Math.abs(subjectLongestMm - document.spec.declaredLongestMm) > 0.01) issue("pillow_subject_size_mismatch", `alpha≥32 的实际主体最长边为 ${Number(subjectLongestMm.toFixed(3))} mm，与订单声明尺寸不一致。`, "error", layer.id);
          for (const code of asset.pillowGeometry?.issues ?? []) issue(code, code === "pillow_contour_seam_envelope_failed" ? "实际裁线与可见主体之间的缝边超出 200–230 px；不能修改规格值或缩放图案来绕过检查。" : "实际刀线或已锁定图案未通过独立主体几何检查。", "error", layer.id);
          if (effectiveDpi < document.spec.dpi - 1e-7) issue("insufficient_image_resolution", `当前素材按实际主体放置尺寸为 ${Number(effectiveDpi.toFixed(3))} PPI，低于 ${document.spec.dpi} PPI；DPI 标签与透明留白不能补足主体像素。`, "error", layer.id);
        } else if (effectiveDpi + 1 < document.spec.dpi) issue("insufficient_image_resolution", `当前图层素材按放置尺寸约 ${Math.round(effectiveDpi)} PPI，低于目标 ${document.spec.dpi} PPI；修改 DPI 标签不会增加细节。`, "error", layer.id);
      } catch { issue("asset_unavailable", "图片不可读、超限或不是受支持的单帧位图。", "error", layer.id); }
    } else {
      try {
        let font = fonts.get(layer.fontId);
        if (!font) {
          const { bytes } = await resolvers.resolveFont(layer.fontId);
          if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("font_size");
          totalFontBytes += bytes.length;
          if (totalFontBytes > 40 * 1024 * 1024) throw new Error("font_size");
          font = parseProductionFont(bytes);
          fonts.set(layer.fontId, font);
        }
        if (/\r|\n/.test(layer.text)) issue("multiline_not_supported", "当前文字层为单行，请拆分多行文字。", "error", layer.id);
        if (Array.from(layer.text).some((character) => !font.charToGlyphIndex(character) && !/\s/.test(character))) issue("unsupported_glyph", "固定字体缺少部分字符，请上传完整支持这些字符的字体。", "error", layer.id);
        const metrics = textMetrics(font, layer);
        if (metrics.advances.some((advance) => advance <= 0)) issue("invalid_letter_spacing", "字距使字符发生倒序或重叠，请调整。", "error", layer.id);
        if (layer.arc && layoutArcGlyphs(metrics.advances, layer.arc).overflow) issue("arc_text_overflow", "文字长度超过当前圆弧，请调整字号、字距或弧长。", "error", layer.id);
      } catch { issue("font_unavailable", "固定字体文件不可用或无法解析；不会自动替换字体。", "error", layer.id); }
    }
  }
  return { document, options, assets, fonts, preflight: applyArtworkAudit({ productionReady: !issues.some((entry) => entry.severity !== "warning"), widthPx: layout.widthPx, heightPx: layout.heightPx, issues }, resolvers.artworkAudit) };
}

export async function renderProductionDocument(rawDocument: ProductionEditorDocument, rawOptions: ProductionEditorExportOptions, resolvers: ProductionEditorResolvers) {
  const prepared = await prepare(rawDocument, rawOptions, resolvers);
  const { document, options, preflight, assets, fonts } = prepared;
  const fatalPreviewCodes = new Set(["asset_unavailable", "font_unavailable", "unsupported_glyph", "jpeg_transparency", "contour_self_intersection", "contour_union_failed", "barcode_union_invalid", "contour_outside_body", "contour_too_small", "barcode_outside_body", "barcode_not_connected", "barcode_not_at_bottom", "pixel_limit", "opening_outside_cover"]);
  if (options.purpose === "production" ? !preflight.productionReady : preflight.issues.some((issue) => fatalPreviewCodes.has(issue.code))) throw new ProductionEditorRenderError(preflight);
  const layout = getProductionLayout(document);
  const scale = options.purpose === "preview" && !options.previewFullResolution ? Math.min(1, 1600 / Math.max(layout.widthPx, layout.heightPx)) : 1;
  const widthPx = Math.max(1, Math.round(layout.widthPx * scale)), heightPx = Math.max(1, Math.round(layout.heightPx * scale));
  const layers = document.layers.filter((layer) => layer.visible);
  const normalizedAssets = new Map<string, string>();
  let inlineImageBytes = 0;
  const rejectInlineLimit = () => { throw new ProductionEditorRenderError({ ...preflight, productionReady: false, issues: [...preflight.issues, { code: "render_asset_limit", severity: "error", message: "图稿的图片数据超过单次渲染上限，请拆分生产稿或减少重复图片层。" }] }); };
  for (const [key, asset] of assets) {
    // Input metadata/profiles/orientation are normalized; no source URLs reach the SVG parser.
    const bytes = await sharp(asset.bytes, { limitInputPixels: MAX_PRODUCTION_PIXELS }).rotate().toColourspace("srgb").png().toBuffer();
    const copies = layers.filter((layer) => layer.kind === "image" && `${layer.assetId}:${layer.assetVersion}` === key).length * (document.productType === "shaped_pillow" && document.spec.sideMode === "double" ? 2 : 1);
    inlineImageBytes += Math.ceil(bytes.byteLength / 3) * 4 * copies;
    if (inlineImageBytes > MAX_INLINE_IMAGE_BYTES) rejectInlineLimit();
    normalizedAssets.set(key, `data:image/png;base64,${bytes.toString("base64")}`);
  }
  const body = renderProductionProductBody(document, { layout, layers, normalizedAssets, fonts, renderLayer });
  const background = options.background === "white" ? `<rect width="100%" height="100%" fill="white"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${layout.widthMm} ${layout.heightMm}">${background}${body}</svg>`;
  const svgBytes = Buffer.from(svg);
  if (svgBytes.byteLength > MAX_INLINE_IMAGE_BYTES + 4 * 1024 * 1024) rejectInlineLimit();
  // Only this bounded, internally constructed SVG needs a larger XML attribute limit
  // for photographic PNG data. Customer inputs remain raster-only with decoder limits.
  let pipeline = sharp(svgBytes, { limitInputPixels: MAX_PRODUCTION_PIXELS, unlimited: true }).toColourspace("srgb").withIccProfile("srgb").withMetadata({ density: document.spec.dpi * scale });
  if (options.background === "white") pipeline = pipeline.flatten({ background: "#ffffff" });
  if (options.format === "jpeg") pipeline = pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: 100, chromaSubsampling: "4:4:4" });
  else if (options.format === "tiff") pipeline = pipeline.tiff({ compression: "lzw" });
  else pipeline = pipeline.png();
  const bytes = await pipeline.toBuffer();
  if (document.productType === "shaped_pillow" && document.spec.factoryStandardId === SHAPED_PILLOW_FACTORY_STANDARD.id && options.format === "jpeg") {
    const output = await sharp(bytes).metadata();
    if (output.format !== "jpeg" || output.width !== widthPx || output.height !== heightPx || Math.abs((output.density ?? 0) - document.spec.dpi * scale) > 1 || output.space !== "srgb" || output.channels !== 3 || output.hasAlpha || !output.icc?.length) {
      throw new Error("production_factory_output_invalid");
    }
  }
  return { bytes, mediaType: options.format === "jpeg" ? "image/jpeg" : options.format === "tiff" ? "image/tiff" : "image/png", widthPx, heightPx, dpi: document.spec.dpi * scale, preflight };
}

function renderLayer(layer: ProductionEditorImageLayer | ProductionEditorTextLayer, assets: Map<string, string>, fonts: Map<string, opentype.Font>) {
  if (layer.kind === "image") {
    const source = assets.get(`${layer.assetId}:${layer.assetVersion}`);
    if (!source) return "";
    return `<g opacity="${layer.opacity}" transform="translate(${layer.xMm} ${layer.yMm}) rotate(${layer.rotationDeg})"><image href="${source}" width="${layer.widthMm}" height="${layer.heightMm}" preserveAspectRatio="none" transform="translate(${layer.flipX ? layer.widthMm : 0} ${layer.flipY ? layer.heightMm : 0}) scale(${layer.flipX ? -1 : 1} ${layer.flipY ? -1 : 1})"/></g>`;
  }
  const font = fonts.get(layer.fontId);
  if (!font) return "";
  const paths = buildProductionTextPaths(font, layer).map((glyph) => `<path d="${glyph.path}" transform="translate(${glyph.xMm} ${glyph.yMm}) rotate(${glyph.rotationDeg})"/>`).join("");
  return `<g fill="${layer.color}" opacity="${layer.opacity}" transform="translate(${layer.xMm} ${layer.yMm}) rotate(${layer.rotationDeg})">${paths}</g>`;
}
function isRaster(bytes: Buffer) {
  return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) || bytes.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) || bytes.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42])) || (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP");
}
