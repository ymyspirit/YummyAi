import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import type { AmazonReportLineView } from "@yummyai/contracts/order/report";
import { archiveLimit, planReportArchives } from "./amazon-report-archive-plan";

const row: AmazonReportLineView = { id: createEntityId(), orderId: createEntityId(), orderLineId: createEntityId(), externalOrderId: "111-0000000-0000001", externalLineId: "123456789012345", skuCode: "changed-sku", title: "Pillow", quantity: 1, currency: null, itemTotalMinor: null, state: "failed", versionNumber: 0, reviewed: false, lastErrorCode: "download_failed", updatedAt: new Date().toISOString(), hasPreview: false };
const file = { name: `${row.externalOrderId}_${row.externalLineId}.zip`, size: 100 };
describe("existing Amazon archive intake plan", () => {
  it("matches the full order/item pair within the selected workspace independently of SKU", () => {
    expect(planReportArchives([file], [row])[0]).toEqual({ file, line: row, issue: null });
    expect(planReportArchives([file], [{ ...row, externalOrderId: "111-0000000-0000002" }])[0]!.line).toBeNull();
    expect(planReportArchives([file], [row, { ...row, id: createEntityId() }])[0]!.issue).toContain("不唯一");
  });
  it("does not silently choose duplicate files or unsafe/oversized filenames", () => {
    expect(planReportArchives([file, file], [row]).every(item => item.issue?.includes("同名"))).toBe(true);
    for (const changed of [{ name: `../${file.name}` }, { name: "report.zip" }, { size: 0 }, { size: archiveLimit + 1 }]) expect(planReportArchives([{ ...file, ...changed }], [row])[0]!.issue).toBeTruthy();
  });
  it("preserves parsed, reviewed, processing and expired content on repeated intake", () => {
    for (const state of ["ready", "partial", "processing", "expired"] as const) expect(planReportArchives([file], [{ ...row, state }])[0]!.issue).toBeTruthy();
    expect(planReportArchives([file], [{ ...row, reviewed: true }])[0]!.issue).toBeTruthy();
  });
});
