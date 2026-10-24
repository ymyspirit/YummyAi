import type { ArtworkAuditCheck } from "@yummyai/contracts/ai/artwork-audit";
import { SHAPED_PILLOW_FACTORY_STANDARD, type ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";
import type { OrderProductionRequirements } from "@yummyai/contracts/order/production-requirements";
import { buildPillowContour, getProductionLayout, sampleClosedContour } from "./geometry.js";
import { measurePillowSubject, type PillowSubjectRaster } from "./pillow-subject.js";
import { verifyPillowAutomationGeometry } from "./pillow-automation-geometry.js";

const n = (v: number) => Number(v.toFixed(2));
const titles = { physicalSize: "尺寸与订单", visualReview: "图案与顾客要求", narrowParts: "最窄处不少于 5 厘米", whiteBorderRule: "白边与黑裁线", barcodeTab: "条码框", backText: "背片与文字方向" } as const;
type Point = [number, number];
/** Normal chords between opposing cut edges, with a conservative 2 mm sampling guard.
 * Body contour excludes the separately checked barcode tab. Sharp/degenerate shapes
 * without an opposing edge remain unconfirmed. No guessed finished-product width. */
export function measureCutNeck(document: ShapedPillowDocument) {
  const raw = sampleClosedContour(document.contour), points: Point[] = [raw[0]!];
  let remaining = 1;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]!, b = raw[(i + 1) % raw.length]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let distance = 0;
    while (length - distance >= remaining) {
      distance += remaining;
      points.push([a[0] + (b[0] - a[0]) * distance / length, a[1] + (b[1] - a[1]) * distance / length]);
      remaining = 1;
    }
    remaining -= length - distance;
  }
  if (points.length > 6000 || points.length < 8) return null;
  const area = points.reduce((sum, a, i) => { const b = points[(i + 1) % points.length]!; return sum + a[0] * b[1] - b[0] * a[1]; }, 0);
  if (Math.abs(area) < 1) return null;
  const sign = area > 0 ? 1 : -1;
  let best: { widthMm: number; from: Point; to: Point } | null = null;
  const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!, prev = points[(i + points.length - 2) % points.length]!, next = points[(i + 2) % points.length]!;
    const dx = next[0] - prev[0], dy = next[1] - prev[1], length = Math.hypot(dx, dy);
    if (length < .01) continue;
    const normal: Point = [-dy / length * sign, dx / length * sign];
    let nearest = Infinity, hit: Point | null = null, opposing = false;
    for (let j = 0; j < points.length; j++) {
      if (j === i || (j + 1) % points.length === i) continue;
      const a = points[j]!, b = points[(j + 1) % points.length]!, edge: Point = [b[0] - a[0], b[1] - a[1]];
      const den = cross(normal, edge), edgeLength = Math.hypot(...edge);
      if (Math.abs(den) < 1e-8 || edgeLength < .01) continue;
      const offset: Point = [a[0] - p[0], a[1] - p[1]], t = cross(offset, edge) / den, u = cross(offset, normal) / den;
      if (t <= .01 || t >= nearest || u < 0 || u > 1) continue;
      nearest = t; hit = [p[0] + normal[0] * t, p[1] + normal[1] * t];
      opposing = normal[0] * (-edge[1] * sign / edgeLength) + normal[1] * (edge[0] * sign / edgeLength) < -.5;
    }
    if (hit && opposing && (!best || nearest < best.widthMm)) best = { widthMm: nearest, from: p, to: hit };
  }
  return best;
}

export function auditPillowGeometry(document: ShapedPillowDocument, requirements: OrderProductionRequirements | null, raster: PillowSubjectRaster | null): ArtworkAuditCheck[] {
  const checks = (Object.keys(titles) as Array<keyof typeof titles>).map(code => ({ code, title: titles[code], status: "needs_review" as const,
    method: code === "visualReview" || code === "backText" ? "vision" as const : "measurement" as const,
    detail: "尚未完成核对。", action: "请检查当前资料后重新核对。", evidence: [] as string[], marks: [] as ArtworkAuditCheck["marks"] })) as ArtworkAuditCheck[];
  const set = (code: keyof typeof titles, data: Partial<ArtworkAuditCheck>) => Object.assign(checks.find(c => c.code === code)!, data);
  const spec = document.spec, standard = spec.factoryStandardId === SHAPED_PILLOW_FACTORY_STANDARD.id;
  const layers = document.layers.filter(l => l.visible && l.opacity > 0), layer = layers.length === 1 && layers[0]?.kind === "image" ? layers[0] : null;
  const size = requirements?.sizeInches && !requirements.warnings.length ? requirements.sizeInches : null;
  const geometryIssues = buildPillowContour(document).issues;
  const measurement = raster ? safeSubject(raster) : null;
  if (standard && spec.sizeBasis === "artwork" && spec.artworkClipMode === "none" && raster && measurement && layer && layer.opacity === 1 && layer.rotationDeg % 360 === 0) {
    const x = layer.widthMm / raster.width, y = layer.heightMm / raster.height;
    const longest = Math.max(measurement.bounds.width * x, measurement.bounds.height * y);
    const proportional = Math.abs(x - y) / Math.max(x, y) < 1e-6;
    const hasTransparency = raster.rgba ? raster.rgba.some((v, i) => i % 4 === 3 && v < 32) : raster.alpha?.some(v => v < 32);
    if (size && hasTransparency) set("physicalSize", { status: proportional && Math.round(longest / 25.4 * 150) === Math.round(size * 150) ? "passed" : "failed",
      detail: `顾客下单 ${size} 英寸；图案实测 ${n(longest / 25.4)} 英寸（${n(longest / 10)} 厘米）。`,
      action: !proportional ? "图案被拉伸，请恢复原比例。" : Math.round(longest / 25.4 * 150) === Math.round(size * 150) ? "" : "按顾客下单尺寸调整图案后重新核对。",
      evidence: [`主体 ${measurement.bounds.width} × ${measurement.bounds.height} px；透明边界 Alpha ≥ 32；按实际放置尺寸换算，150 DPI 像素取整。`] });
    if (size && hasTransparency) {
      try {
        const result = verifyPillowAutomationGeometry(document, raster, { artworkLayerId: layer.id, longestSideInches: size, roundingPx: 30 });
        const ruleMatch = Math.abs(spec.whiteBorderMm * 150 / 25.4 - 200) < .01 && Math.abs(spec.cutLineMm * 150 / 25.4 - 6) < .01;
        set("whiteBorderRule", { status: result.technicalPassed && ruleMatch ? "passed" : "failed", detail: result.technicalPassed && ruleMatch ? "白边宽度、黑裁线和图案完整性符合本单工厂标准。" : "白边、黑裁线或图案与裁线的位置关系不符合标准。",
          action: result.technicalPassed && ruleMatch ? "" : "保持图案不变，修正独立裁线后重新核对。",
          evidence: [`基础白边 200 px，局部圆滑最多加宽 30 px；黑线 6 px。`, `实测白边最小 ${result.minimumSeamPx === null ? "未测得" : n(result.minimumSeamPx)} px，最大 ${result.maximumSeamPx === null ? "未测得" : n(result.maximumSeamPx)} px。`, ...result.issues] });
      } catch { set("whiteBorderRule", { detail: "当前图案或裁线不支持完整测量。", action: "检查裁线闭合、图层和订单尺寸后重新核对。" }); }
    }
  } else set("physicalSize", { detail: "当前稿件无法按完整透明主体测量。", action: "核对工艺版本、透明素材及裁切或旋转设置。" });
  if (!size) set("physicalSize", { status: "needs_review", detail: "本次制作的顾客尺寸缺失或存在冲突。", action: "先核对本单原始尺寸选项。" });
  if (standard) {
    const w = (spec.barcodeTab.widthMm ?? 0) * 150 / 25.4, h = (spec.barcodeTab.heightMm ?? 0) * 150 / 25.4;
    const valid = Math.abs(w - 600) < .01 && Math.abs(h - 200) < .01 && !geometryIssues.length;
    set("barcodeTab", { status: valid ? "passed" : "failed", detail: valid ? "条码框尺寸正确，已连接图案底部。" : "条码框的尺寸或底部连接需要修改。", action: valid ? "" : "将条码框设为 600 × 200 像素并连接主体最下方。", evidence: [`实测 ${n(w)} × ${n(h)} px（150 DPI）；已检查轮廓与矩形合并后的底部连接。`, ...geometryIssues] });
    const neck = !geometryIssues.length ? measureCutNeck(document) : null;
    if (neck) {
      const layout = getProductionLayout(document), minX = Math.min(neck.from[0], neck.to[0]), minY = Math.min(neck.from[1], neck.to[1]);
      const x = Math.max(0, (minX + layout.marginMm - 2) / layout.widthMm), y = Math.max(0, (minY + layout.marginMm - 2) / layout.heightMm);
      const threshold = Math.max(50, spec.minimumNeckMm);
      const status = neck.widthMm >= threshold + 2 ? "passed" : neck.widthMm < threshold - 2 ? "failed" : "needs_review";
      set("narrowParts", { status, detail: `裁线之间最窄处约 ${n(neck.widthMm / 10)} 厘米，要求不少于 ${threshold / 10} 厘米。`, action: status === "passed" ? "" : status === "failed" ? "加宽标出的细窄部位，保持图案不变，再重新核对。" : "测量接近最低宽度边界，请复核标出的部位。",
        evidence: ["用户于 2026-09-20 确认：测量生产稿两侧裁线间距，不使用缝制后成品宽度；底部条码框单独检查。", "沿相向裁线法线测量，采样步距不超过 1 mm；距 50 mm 阈值 2 mm 内保留复核，不降低工厂标准。"],
        marks: [{ sourceId: "production-preview", label: `最窄处约 ${n(neck.widthMm / 10)} 厘米`, x, y, width: Math.min(1 - x, (Math.abs(neck.from[0] - neck.to[0]) + 4) / layout.widthMm), height: Math.min(1 - y, (Math.abs(neck.from[1] - neck.to[1]) + 4) / layout.heightMm) }] });
    } else set("narrowParts", { detail: "未能可靠测出两侧裁线的最窄距离。", action: "请检查轮廓，不能仅凭 AI 看图认定宽度达标。" });
  }
  if (requirements?.sideMode && requirements.sideMode !== spec.sideMode) set("backText", { status: "failed", method: "measurement", detail: "稿件的单双面设置与顾客选择不一致。", action: "按顾客要求调整单双面后重新核对。", evidence: [`顾客 ${requirements.sideMode}；稿件 ${spec.sideMode}。`] });
  else if (!requirements?.sideMode) set("backText", { detail: "未取得本次制作的单双面要求。", action: "请核对顾客原始印刷面数选项。", method: "factory" });
  return checks;
}
function safeSubject(raster: PillowSubjectRaster) {
  try { return measurePillowSubject(raster); } catch { return null; }
}
