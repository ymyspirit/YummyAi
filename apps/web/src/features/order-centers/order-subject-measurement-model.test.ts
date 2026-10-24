import { describe, expect, it } from "vitest";
import type { OrderWorkDetail } from "@yummyai/contracts/order/workspace";
import type { ProductionEditorDetailView } from "@yummyai/contracts/pod/production-editor-api";
import { createProductionDocument, newProductionImage } from "../production-editor/production-editor-model";
import { compareSubjectSize, customerSubjectSize, measureTransparentSubject, placedSubjectMeasurement, subjectMeasurementCandidate } from "./order-subject-measurement-model";

function source() {
  const document = createProductionDocument("shaped_pillow");
  if (document.productType !== "shaped_pillow") throw new Error("fixture");
  document.spec.artworkClipMode = "none";
  const layer = newProductionImage(document, { id: "asset", version: 1, name: "Synthetic subject", width: 100, height: 100 });
  layer.widthMm = layer.heightMm = 508;
  document.layers = [layer];
  const editor = { project: { id: "project", currentVersionId: "version", workSource: { workItemId: "order", revisionId: "revision" } },
    version: { id: "version", document }, images: [{ id: "asset", version: 1, actualAlpha: true, width: 100, height: 100 }] } as unknown as ProductionEditorDetailView;
  const detail = { line: { id: "order", revision: 1, sourceChanged: false }, versions: [{ id: "revision", revision: 1 }],
    sourceReport: { surfaces: [{ key: "front", label: "Front", previewFileKey: null, buyerFileKeys: [], fields: [{ key: "size", kind: "choice", label: "Size", value: "12 inch" }] }] }, report: null } as unknown as OrderWorkDetail;
  return { document, layer, editor, detail };
}

describe("read-only subject size comparison", () => {
  it("excludes transparent padding and faint residue, includes both boundary pixels, and uses actual placement", () => {
    const { layer, document } = source();
    const alpha = new Uint8Array(100 * 100);
    for (let y = 30; y <= 69; y++) for (let x = 20; x <= 79; x++) alpha[y * 100 + x] = 255;
    alpha[0] = 31; alpha[30 * 100 + 20] = 32;
    const before = structuredClone(document);
    const measurement = measureTransparentSubject({ width: 100, height: 100, alpha });
    expect(measurement.bounds).toEqual({ x: 20, y: 30, width: 60, height: 40 });
    const measured = placedSubjectMeasurement(measurement, layer);
    expect(measured.longestMm).toBeCloseTo(304.8);
    expect(measured.outputWidthPx).toBeCloseTo(1800);
    expect(measured.outputHeightPx).toBeCloseTo(1200);
    expect(measured.effectivePpi).toBeCloseTo(5);
    expect(compareSubjectSize(measured, 12)).toBe("match");
    expect(compareSubjectSize(measured, 14)).toBe("mismatch");
    expect(compareSubjectSize(measured, null)).toBe("unconfirmed");
    expect(document).toEqual(before);
    layer.widthMm *= .8;
    expect(compareSubjectSize(placedSubjectMeasurement(measurement, layer), 12)).toBe("unconfirmed");
    layer.heightMm *= .8;
    expect(compareSubjectSize(placedSubjectMeasurement(measurement, layer), 12)).toBe("mismatch");
  });
  it("does not identify an opaque sheet or fully transparent file as a subject", () => {
    expect(() => measureTransparentSubject({ width: 2, height: 2, alpha: new Uint8Array([255, 255, 255, 255]) })).toThrow("没有透明背景");
    expect(() => measureTransparentSubject({ width: 2, height: 2, rgba: new Uint8Array(16) })).toThrow("pillow_subject_not_visible");
  });
  it("uses captured buyer dimensions even when the newest import or declared artwork size differs", () => {
    const { detail, editor, document } = source();
    detail.line.sourceChanged = true;
    detail.report = structuredClone(detail.sourceReport!);
    detail.report.surfaces[0]!.fields[0]!.value = "24 inch";
    document.spec.declaredLongestMm = 609.6;
    expect(customerSubjectSize(detail, editor).inches).toBe(12);
    expect(customerSubjectSize(detail, editor).note).toContain("平台资料已有更新");
    detail.sourceReport = null;
    expect(customerSubjectSize(detail, editor).inches).toBeNull();
    detail.sourceReport = undefined;
    expect(customerSubjectSize(detail, editor).inches).toBeNull();
  });
  it("leaves conflicting or unrecognized buyer sizes unresolved", () => {
    const { detail, editor } = source();
    const fields = detail.sourceReport!.surfaces[0]!.fields;
    fields.push({ key: "other-size", kind: "choice", label: "Size", value: "14 inch" });
    expect(customerSubjectSize(detail, editor).inches).toBeNull();
    fields[1]!.value = "Extra large";
    expect(customerSubjectSize(detail, editor).inches).toBeNull();
  });
  it("rejects a stale order revision and a historical artwork version", () => {
    const { detail, editor } = source();
    editor.project.workSource!.revisionId = "older";
    expect(customerSubjectSize(detail, editor).note).toContain("版本不一致");
    editor.project.currentVersionId = "newer";
    expect(subjectMeasurementCandidate(editor).reason).toContain("历史稿");
  });
  it("does not present cropped, composited, rotated or missing source material as a measurable final subject", () => {
    const { editor, document, layer } = source();
    expect(subjectMeasurementCandidate(editor).asset?.id).toBe("asset");
    document.spec.artworkClipMode = "white_border";
    expect(subjectMeasurementCandidate(editor).reason).toContain("裁切");
    document.spec.artworkClipMode = "none";
    document.layers.push({ ...layer, id: "second" });
    expect(subjectMeasurementCandidate(editor).reason).toContain("多个图层");
    document.layers.pop(); layer.rotationDeg = 45;
    expect(subjectMeasurementCandidate(editor).reason).toContain("旋转");
    layer.rotationDeg = 0; layer.opacity = .5;
    expect(subjectMeasurementCandidate(editor).reason).toContain("透明度");
    layer.opacity = 1; editor.images[0]!.actualAlpha = false;
    expect(subjectMeasurementCandidate(editor).reason).toContain("没有透明背景");
    editor.images = [];
    expect(subjectMeasurementCandidate(editor).reason).toContain("不可用");
  });
});
