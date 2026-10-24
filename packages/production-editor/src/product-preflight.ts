import { SHAPED_PILLOW_FACTORY_STANDARD, type ProductionEditorDocument, type ProductionEditorPreflightIssue } from "@yummyai/contracts/pod/production-editor";
import { buildPillowContour, sampleClosedContour } from "./geometry.js";

/** Product V1 rules; preserve issue order and legacy omitted-field semantics. */
export function preflightProductionProduct(document: ProductionEditorDocument): ProductionEditorPreflightIssue[] {
  const issues: ProductionEditorPreflightIssue[] = [];
  const issue = (code: string, message: string, severity: ProductionEditorPreflightIssue["severity"] = "error") => issues.push({ code, message, severity });
  if (document.productType === "shaped_pillow") {
    const spec = document.spec;
    if (spec.factoryStandardId === SHAPED_PILLOW_FACTORY_STANDARD.id) {
      const rule = SHAPED_PILLOW_FACTORY_STANDARD;
      const matches = (value: number | null | undefined, px: number) => value !== null && value !== undefined && Math.abs(value * spec.dpi / 25.4 - px) < 0.01;
      if (!matches(spec.barcodeTab.widthMm, rule.barcodeWidthPx) || !matches(spec.barcodeTab.heightMm, rule.barcodeHeightPx)) issue("factory_barcode_dimensions", "工厂要求底部空白条码框为 600 × 200 px（150 DPI）。");
      if (!matches(spec.panelGapMm, rule.panelGapPx) || !matches(spec.sheetMarginMm, rule.sheetMarginPx)) issue("factory_sheet_spacing", "工厂要求正反片净距 100 px、整图四周各留 50 px，均从裁线外缘计算。");
      if (!matches(spec.whiteBorderMm, rule.whiteBorderPx)) issue("factory_white_border", "工厂基础缝边为 200 px；局部圆滑余量由独立轮廓处理。");
      if (spec.artworkClipMode !== "none") issue("factory_artwork_clipping", "工厂稿需保留独立图案，不可使用缝边遮罩裁掉图案。");
      if (spec.sizeBasis !== "artwork") issue("factory_size_basis", "工厂教程以主体最长边确定英寸尺寸，缝边、裁线和条码框另加。");
    }
    for (const code of buildPillowContour(document).issues) issue(code, code === "barcode_not_at_bottom" ? "空白条码框必须连接主体最下方，请移到底部，不能放在侧边或较高的位置。" : "轮廓或条码区域几何无效，请检查节点、边界和底部连接。");
    if (spec.sizeBasis === "unconfirmed" || !spec.declaredLongestMm) issue("size_basis_unconfirmed", "需填写声明尺寸并确认主体、裁片或成品尺寸基准。", "manual");
    const bodyPoints = sampleClosedContour(document.contour);
    const bodyXs = bodyPoints.map(([x]) => x), bodyYs = bodyPoints.map(([, y]) => y);
    const actualBodyLongest = Math.max(Math.max(...bodyXs) - Math.min(...bodyXs), Math.max(...bodyYs) - Math.min(...bodyYs));
    if (spec.sizeBasis === "cut_contour" && spec.declaredLongestMm && Math.abs(actualBodyLongest - spec.declaredLongestMm) > 0.5) issue("cut_size_mismatch", `声明的裁片最长边与真实轮廓包围尺寸 ${Number(actualBodyLongest.toFixed(2))} mm 不一致（不含条码框）。`);
    if (spec.sizeBasis === "finished" || spec.sizeBasis === "artwork") issue("manual_size_basis", "成品或主体图尺寸基准由人工核对；服务端只验证实际文件几何，不能推断缝制后的成品尺寸。", "warning");
    if (spec.minimumNeckMm < 50) issue("minimum_neck_below_factory_rule", "当前抱枕工艺要求细窄部位至少 50 mm，不能降低阈值。");
    if (Math.abs(spec.cutLineMm - 6 * 25.4 / 150) > 0.001) issue("cut_line_mismatch", "当前抱枕工艺要求 150 PPI 下 6 px 黑线，即 1.016 mm。");
    if (spec.minimumNeckBasis === "unconfirmed" || !document.confirmations.narrowParts) issue("narrow_parts_unconfirmed", `细窄部位需核对不少于 ${spec.minimumNeckMm / 10} 厘米；可在订单审核页运行自动核对，或按本单固定口径人工核验。`, "manual");
    if (!document.confirmations.whiteBorderRule) issue("white_border_unconfirmed", "需确认当前尺寸适用的缝边白边规则。", "manual");
    if (!spec.barcodeTab.widthMm || !spec.barcodeTab.heightMm) issue("barcode_dimensions_missing", "请填写工厂要求的底部条码矩形宽高。");
    if (!document.confirmations.barcodeTab) issue("barcode_rule_unconfirmed", "请人工确认条码矩形的尺寸与底部位置。", "manual");
    if (spec.sideMode === "double" && !document.confirmations.backText) issue("back_text_unconfirmed", "请确认背片文字正读；照片内已压平的文字不能自动识别或纠正。", "manual");
    if (spec.whiteBorderMm * 2 >= Math.min(spec.widthMm, spec.heightMm)) issue("white_border_too_large", "白边宽度覆盖了整个主体可印区域。");
    issue("manual_factory_preflight", "白边适用规则、成品尺寸、细窄部位和缝制结果依据人工确认；自动检查不能代替工厂工艺确认。", "warning");
  } else if (document.productType === "tire_cover") {
    const { diameterMm, opening, safeInsetMm } = document.spec;
    if (safeInsetMm * 2 >= diameterMm) issue("safe_inset_too_large", "安全区内缩量必须小于半径。");
    if (opening && Math.hypot(opening.xMm - diameterMm / 2, opening.yMm - diameterMm / 2) + opening.diameterMm / 2 >= diameterMm / 2) issue("opening_outside_cover", "开孔必须完整位于圆形罩面内。");
    if (opening) issue("opening_manual_review", "开孔尺寸与位置需在服务端预览及工厂规格中核对。", "warning");
  } else if (document.productType === "rectangular_print") {
    const { widthMm, heightMm, safeInsetMm } = document.spec;
    if (safeInsetMm * 2 >= Math.min(widthMm, heightMm)) issue("safe_inset_too_large", "安全区内缩量必须小于打印区域短边的一半。");
  }
  return issues;
}
