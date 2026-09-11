import { ProductionEditorDocumentSchema, ProductionEditorExportOptionsSchema, type ProductionEditorDocument, type ProductionEditorExportOptions, type ProductionEditorImageLayer, type ProductionEditorPreflight, type ProductionEditorPreflightIssue, type ProductionEditorTextLayer } from "@yummyai/contracts/pod/production-editor";
import type opentype from "opentype.js";
import sharp from "sharp";

import { buildPillowContour, getProductionLayout, layoutArcGlyphs, MAX_PRODUCTION_PIXELS, polygonPath, sampleClosedContour } from "./geometry.js";
import { buildProductionTextPaths, mirrorProductionTextLayer, parseProductionFont, productionTextMetrics as textMetrics } from "./text.js";

export interface ProductionEditorResolvers {
  resolveAsset(assetId: string, assetVersion: number): Promise<{ bytes: Uint8Array }>;
  resolveFont(fontId: string): Promise<{ bytes: Uint8Array }>;
}
interface LoadedAsset { bytes: Buffer; width: number; height: number }
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
  const options = ProductionEditorExportOptionsSchema.parse(rawOptions);
  const layout = getProductionLayout(document);
  const issues: ProductionEditorPreflightIssue[] = [];
  const issue = (code: string, message: string, severity: ProductionEditorPreflightIssue["severity"] = "error", layerId?: string) => issues.push({ code, message, severity, ...(layerId ? { layerId } : {}) });
  if (layout.widthPx * layout.heightPx > MAX_PRODUCTION_PIXELS) issue("pixel_limit", "生产文件超过 1 亿像素上限，请调整规格。");
  if (options.format === "jpeg" && options.background === "transparent") issue("jpeg_transparency", "JPEG 不支持透明背景，请选 PNG/TIFF 或明确白底。");
  if (!document.layers.some((layer) => layer.visible)) issue("empty_artwork", "没有可见图层。");
  if (!document.confirmations.physicalSize) issue("physical_size_unconfirmed", "请核对并确认工厂要求的实际毫米尺寸与测量基准。", "manual");
  if (!document.confirmations.visualReview) issue("visual_review_required", "请核对服务端生产预览，包括文字、裁剪和正背片。", "manual");
  if (document.productType === "shaped_pillow") {
    const spec = document.spec;
    for (const code of buildPillowContour(document).issues) issue(code, code === "barcode_not_at_bottom" ? "空白条码框必须连接主体最下方，请移到底部，不能放在侧边或较高的位置。" : "轮廓或条码区域几何无效，请检查节点、边界和底部连接。");
    if (spec.sizeBasis === "unconfirmed" || !spec.declaredLongestMm) issue("size_basis_unconfirmed", "需填写声明尺寸并确认主体、裁片或成品尺寸基准。", "manual");
    const bodyPoints = sampleClosedContour(document.contour);
    const bodyXs = bodyPoints.map(([x]) => x), bodyYs = bodyPoints.map(([, y]) => y);
    const actualBodyLongest = Math.max(Math.max(...bodyXs) - Math.min(...bodyXs), Math.max(...bodyYs) - Math.min(...bodyYs));
    if (spec.sizeBasis === "cut_contour" && spec.declaredLongestMm && Math.abs(actualBodyLongest - spec.declaredLongestMm) > 0.5) issue("cut_size_mismatch", `声明的裁片最长边与真实轮廓包围尺寸 ${Number(actualBodyLongest.toFixed(2))} mm 不一致（不含条码框）。`);
    if (spec.sizeBasis === "finished" || spec.sizeBasis === "artwork") issue("manual_size_basis", "成品或主体图尺寸基准由人工核对；服务端只验证实际文件几何，不能推断缝制后的成品尺寸。", "warning");
    if (spec.minimumNeckMm < 50) issue("minimum_neck_below_factory_rule", "当前抱枕工艺要求细窄部位至少 50 mm，不能降低阈值。");
    if (Math.abs(spec.cutLineMm - 6 * 25.4 / 150) > 0.001) issue("cut_line_mismatch", "当前抱枕工艺要求 150 PPI 下 6 px 黑线，即 1.016 mm。");
    if (spec.minimumNeckBasis === "unconfirmed" || !document.confirmations.narrowParts) issue("narrow_parts_unconfirmed", `需人工按工厂测量基准核对细窄部位不少于 ${spec.minimumNeckMm} mm；系统未自动验证缝制后宽度。`, "manual");
    if (!document.confirmations.whiteBorderRule) issue("white_border_unconfirmed", "需确认当前尺寸适用的缝边白边规则。", "manual");
    if (!spec.barcodeTab.widthMm || !spec.barcodeTab.heightMm) issue("barcode_dimensions_missing", "请填写工厂要求的底部条码矩形宽高。");
    if (!document.confirmations.barcodeTab) issue("barcode_rule_unconfirmed", "请人工确认条码矩形的尺寸与底部位置。", "manual");
    if (spec.sideMode === "double" && !document.confirmations.backText) issue("back_text_unconfirmed", "请确认背片文字正读；照片内已压平的文字不能自动识别或纠正。", "manual");
    if (spec.whiteBorderMm * 2 >= Math.min(spec.widthMm, spec.heightMm)) issue("white_border_too_large", "白边宽度覆盖了整个主体可印区域。");
    issue("manual_factory_preflight", "白边适用规则、成品尺寸、细窄部位和缝制结果依据人工确认；自动检查不能代替工厂工艺确认。", "warning");
  } else {
    const { diameterMm, opening, safeInsetMm } = document.spec;
    if (safeInsetMm * 2 >= diameterMm) issue("safe_inset_too_large", "安全区内缩量必须小于半径。");
    if (opening && Math.hypot(opening.xMm - diameterMm / 2, opening.yMm - diameterMm / 2) + opening.diameterMm / 2 >= diameterMm / 2) issue("opening_outside_cover", "开孔必须完整位于圆形罩面内。");
    if (opening) issue("opening_manual_review", "开孔尺寸与位置需在服务端预览及工厂规格中核对。", "warning");
  }
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
          asset = { bytes, width: rotated ? metadata.height : metadata.width, height: rotated ? metadata.width : metadata.height };
          assets.set(key, asset);
        }
        const effectiveDpi = Math.min(asset.width / (layer.widthMm / 25.4), asset.height / (layer.heightMm / 25.4));
        if (effectiveDpi + 1 < document.spec.dpi) issue("insufficient_image_resolution", `原图按当前放置尺寸约 ${Math.round(effectiveDpi)} PPI，低于目标 ${document.spec.dpi} PPI；修改 DPI 标签不会增加细节。`, "error", layer.id);
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
  return { document, options, assets, fonts, preflight: { productionReady: !issues.some((entry) => entry.severity !== "warning"), widthPx: layout.widthPx, heightPx: layout.heightPx, issues } };
}

export async function renderProductionDocument(rawDocument: ProductionEditorDocument, rawOptions: ProductionEditorExportOptions, resolvers: ProductionEditorResolvers) {
  const prepared = await prepare(rawDocument, rawOptions, resolvers);
  const { document, options, preflight, assets, fonts } = prepared;
  const fatalPreviewCodes = new Set(["asset_unavailable", "font_unavailable", "unsupported_glyph", "jpeg_transparency", "contour_self_intersection", "contour_union_failed", "barcode_union_invalid", "contour_outside_body", "contour_too_small", "barcode_outside_body", "barcode_not_connected", "barcode_not_at_bottom", "pixel_limit", "opening_outside_cover"]);
  if (options.purpose === "production" ? !preflight.productionReady : preflight.issues.some((issue) => fatalPreviewCodes.has(issue.code))) throw new ProductionEditorRenderError(preflight);
  const layout = getProductionLayout(document);
  const scale = options.purpose === "preview" ? Math.min(1, 1600 / Math.max(layout.widthPx, layout.heightPx)) : 1;
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
  let body: string;
  if (document.productType === "tire_cover") {
    const radius = document.spec.diameterMm / 2, opening = document.spec.opening;
    const hole = opening ? `<circle cx="${opening.xMm}" cy="${opening.yMm}" r="${opening.diameterMm / 2}" fill="black"/>` : "";
    body = `<defs><mask id="cover" maskUnits="userSpaceOnUse" x="0" y="0" width="${layout.widthMm}" height="${layout.heightMm}"><rect width="100%" height="100%" fill="black"/><circle cx="${radius}" cy="${radius}" r="${radius}" fill="white"/>${hole}</mask></defs><g mask="url(#cover)">${layers.map((layer) => renderLayer(layer, normalizedAssets, fonts)).join("")}</g>`;
  } else {
    const outline = buildPillowContour(document).path;
    const rawBody = polygonPath(sampleClosedContour(document.contour));
    const spec = document.spec;
    const maskPath = `<path d="${rawBody}" fill="white" stroke="black" stroke-width="${spec.whiteBorderMm * 2}" stroke-linejoin="round"/>`;
    const mask = `<defs><mask id="print" maskUnits="userSpaceOnUse" x="0" y="0" width="${spec.widthMm}" height="${spec.heightMm}"><rect width="100%" height="100%" fill="black"/>${maskPath}</mask><mask id="printBack" maskUnits="userSpaceOnUse" x="0" y="0" width="${spec.widthMm}" height="${spec.heightMm}"><rect width="100%" height="100%" fill="black"/><g transform="translate(${spec.widthMm} 0) scale(-1 1)">${maskPath}</g></mask></defs>`;
    const front = `<path d="${outline}" fill="white"/><g mask="url(#print)">${layers.map((layer) => renderLayer(layer, normalizedAssets, fonts)).join("")}</g><path d="${outline}" fill="none" stroke="black" stroke-width="${spec.cutLineMm}"/>`;
    const backLayers = layers.map((layer) => layer.kind === "image" ? `<g transform="translate(${spec.widthMm} 0) scale(-1 1)">${renderLayer(layer, normalizedAssets, fonts)}</g>` : renderLayer(mirrorProductionTextLayer(layer, fonts.get(layer.fontId)!, spec.widthMm), normalizedAssets, fonts)).join("");
    const backArt = spec.sideMode === "double" ? `<g mask="url(#printBack)">${backLayers}</g>` : "";
    const back = `<g transform="translate(${spec.widthMm} 0) scale(-1 1)"><path d="${outline}" fill="white"/></g>${backArt}<g transform="translate(${spec.widthMm} 0) scale(-1 1)"><path d="${outline}" fill="none" stroke="black" stroke-width="${spec.cutLineMm}"/></g>`;
    body = `${mask}<g transform="translate(${layout.marginMm} ${layout.marginMm})">${front}</g><g transform="translate(${layout.backOffsetMm + layout.marginMm} ${layout.marginMm})">${back}</g>`;
  }
  const background = options.background === "white" ? `<rect width="100%" height="100%" fill="white"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${layout.widthMm} ${layout.heightMm}">${background}${body}</svg>`;
  const svgBytes = Buffer.from(svg);
  if (svgBytes.byteLength > MAX_INLINE_IMAGE_BYTES + 4 * 1024 * 1024) rejectInlineLimit();
  // Only this bounded, internally constructed SVG needs a larger XML attribute limit
  // for photographic PNG data. Customer inputs remain raster-only with decoder limits.
  let pipeline = sharp(svgBytes, { limitInputPixels: MAX_PRODUCTION_PIXELS, unlimited: true }).toColourspace("srgb").withIccProfile("srgb").withMetadata({ density: document.spec.dpi * scale });
  if (options.format === "jpeg") pipeline = pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: 100, chromaSubsampling: "4:4:4" });
  else if (options.format === "tiff") pipeline = pipeline.tiff({ compression: "lzw" });
  else pipeline = pipeline.png();
  return { bytes: await pipeline.toBuffer(), mediaType: options.format === "jpeg" ? "image/jpeg" : options.format === "tiff" ? "image/tiff" : "image/png", widthPx, heightPx, dpi: document.spec.dpi * scale, preflight };
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
