import { describe, expect, it } from "vitest";
import type { ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";
import { createDefaultProductionDocument } from "./products.js";
import { auditPillowGeometry, measureCutNeck } from "./pillow-artwork-audit.js";
function polygon(points: number[][]) {
  const doc = createDefaultProductionDocument("shaped_pillow") as ShapedPillowDocument;
  doc.contour = points.map(([xMm, yMm]) => ({xMm: xMm!, yMm: yMm!, smooth: false}));
  return doc;
}
describe("cut-contour neck measurements", () => {
  it.each([40, 50, 60, 100])("measures a %s mm rectangle in either winding", width => {
    const doc = polygon([[0, 0], [width, 0], [width, 200], [0, 200]]);
    expect(measureCutNeck(doc)?.widthMm).toBeCloseTo(width, 1);
    doc.contour.reverse();
    expect(measureCutNeck(doc)?.widthMm).toBeCloseTo(width, 1);
  });
  it("finds a narrow waist rather than the overall bounding box", () => {
    const doc = polygon([[0,0],[200,0],[200,80],[120,80],[120,220],[200,220],[200,300],[0,300],[0,220],[80,220],[80,80],[0,80]]);
    const neck = measureCutNeck(doc)!;
    expect(neck.widthMm).toBeCloseTo(40, 1);
    expect(neck.from[1]).toBeGreaterThan(80);
    expect(neck.to[1]).toBeLessThan(220);
  });
  it("is invariant under rotation and translation", () => {
    const angle = .7, doc = polygon([[0,0],[70,0],[70,200],[0,200]].map(([x,y]) => [x! * Math.cos(angle) - y! * Math.sin(angle) + 50, x! * Math.sin(angle) + y! * Math.cos(angle) + 20]));
    expect(measureCutNeck(doc)?.widthMm).toBeCloseTo(70, 1);
  });
  it("does not claim a measurement for a degenerate path", () => {
    expect(measureCutNeck(polygon([[0,0],[100,0],[200,0]]))).toBeNull();
  });
  it("keeps missing customer size and side options unconfirmed", () => {
    const checks = auditPillowGeometry(createDefaultProductionDocument("shaped_pillow") as ShapedPillowDocument, null, null);
    expect(checks.find(c => c.code === "physicalSize")?.status).toBe("needs_review");
    expect(checks.find(c => c.code === "backText")?.status).toBe("needs_review");
    expect(checks.find(c => c.code === "whiteBorderRule")?.status).toBe("needs_review");
  });
});
