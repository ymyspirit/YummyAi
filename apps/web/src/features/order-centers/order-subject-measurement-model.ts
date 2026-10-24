import type { OrderWorkDetail } from "@yummyai/contracts/order/workspace";
import type { ProductionEditorDetailView } from "@yummyai/contracts/pod/production-editor-api";
import type { ProductionEditorImageLayer } from "@yummyai/contracts/pod/production-editor";
import { measurePillowSubject, type PillowSubjectMeasurement, type PillowSubjectRaster } from "@yummyai/production-editor/pillow-subject";
import { orderProductionRequirements } from "../production-editor/order-production-requirements";

/** Compare against this task's captured buyer options, never today's report or the artwork's own declaration. */
export function customerSubjectSize(detail: OrderWorkDetail, editor: ProductionEditorDetailView) {
  const work = editor.project.workSource;
  const revision = detail.versions.find(item => item.revision === detail.line.revision);
  if (work && (work.workItemId !== detail.line.id || work.revisionId !== revision?.id))
    return { inches: null, note: "制作需求版本不一致，不能用当前顾客尺寸核对此稿。" };
  const source = detail.sourceReport === undefined ? !detail.line.sourceChanged ? detail.report : null : detail.sourceReport;
  if (!source) return { inches: null, note: "本次制作的顾客原始尺寸暂不可用，请核对订单资料。" };
  const requirements = orderProductionRequirements({ surfaces: source.surfaces.map(surface => ({
    ...surface, fields: surface.fields.filter(field => /\bsize\b|尺寸|规格/i.test(field.label)),
  })) });
  if (requirements.warnings.length || !requirements.sizeInches)
    return { inches: null, note: "顾客尺寸缺失、冲突或无法唯一识别，请核对原始尺寸选项。" };
  return { inches: requirements.sizeInches, note: detail.line.sourceChanged ? "依据本次制作固定的顾客选项；平台资料已有更新，请另核对变化。" : "依据本次制作采用的顾客原始尺寸选项。" };
}

/** A source bounding box is only an actual print measurement when no subsequent clipping/composition changes it. */
export function subjectMeasurementCandidate(editor: ProductionEditorDetailView) {
  const document = editor.version.document;
  if (document.productType !== "shaped_pillow") return { reason: "此测量用于异形抱枕。" } as const;
  if (editor.version.id !== editor.project.currentVersionId) return { reason: "当前显示的是历史稿，请先打开最新版本再测量。" } as const;
  if (document.spec.artworkClipMode !== "none") return { reason: "此稿仍按白边裁切图案，素材边界不等于最终印刷边界；请在编辑器核对裁切后测量。" } as const;
  const visible = document.layers.filter(layer => layer.visible && layer.opacity > 0);
  if (visible.length !== 1 || visible[0]?.kind !== "image") return { reason: "需要一张完整的透明主体图层；当前为空或含多个图层，请在编辑器核对完整主体。" } as const;
  const layer = visible[0];
  if (layer.opacity !== 1 || Math.abs(layer.rotationDeg % 360) > 1e-8)
    return { reason: "此图层带旋转或透明度效果，请在编辑器核对实际印刷边界。" } as const;
  const asset = editor.images.find(image => image.id === layer.assetId && image.version === layer.assetVersion);
  if (!asset) return { reason: "当前版本使用的主体素材不可用。" } as const;
  if (!asset.actualAlpha) return { reason: "素材没有透明背景，无法自动区分主体与白底；请使用透明抠图测量。" } as const;
  if (asset.width * asset.height > 48_000_000) return { reason: "素材过大，请在编辑器核验；审核页不会缩小素材后冒充原像素测量。" } as const;
  return { layer, asset } as const;
}

export function measureTransparentSubject(raster: PillowSubjectRaster) {
  const measurement = measurePillowSubject(raster);
  const alpha = raster.rgba ?? raster.alpha;
  const stride = raster.rgba ? 4 : 1;
  let transparent = false;
  for (let i = stride - 1; i < alpha.length; i += stride) if (alpha[i]! < measurement.alphaThreshold) { transparent = true; break; }
  if (!transparent) throw new Error("素材没有透明背景，无法单独识别主体。");
  return measurement;
}

export function placedSubjectMeasurement(measurement: PillowSubjectMeasurement, layer: ProductionEditorImageLayer) {
  const scaleX = layer.widthMm / measurement.sourceWidthPx, scaleY = layer.heightMm / measurement.sourceHeightPx;
  const widthMm = measurement.bounds.width * scaleX, heightMm = measurement.bounds.height * scaleY;
  const longestMm = Math.max(widthMm, heightMm);
  return { measurement, widthMm, heightMm, longestMm, longestInches: longestMm / 25.4,
    outputWidthPx: widthMm * 150 / 25.4, outputHeightPx: heightMm * 150 / 25.4,
    effectivePpi: Math.min(25.4 / scaleX, 25.4 / scaleY),
    proportional: Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY) < 1e-6 };
}

export function compareSubjectSize(measured: ReturnType<typeof placedSubjectMeasurement>, inches: number | null) {
  if (inches === null || !measured.proportional) return "unconfirmed";
  // Display-only comparison at the final 150-DPI pixel grid. Never writes approval or weakens preflight.
  return Math.round(measured.longestInches * 150) === Math.round(inches * 150) ? "match" : "mismatch";
}
