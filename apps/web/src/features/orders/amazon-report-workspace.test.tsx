import { createEntityId, type AmazonReportBatchView, type AmazonReportDetailView } from "@yummyai/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AmazonReportDetail, AmazonReportWorkspace, batchSummary, decodeAmazonReport, runReportQueue } from "./amazon-report-workspace";

describe("Amazon report workspace", () => {
  it("explains manual import needs a shop record but does not require platform authorization", () => {
    const html = renderToStaticMarkup(<AmazonReportWorkspace accounts={[]} initialWorkspace={{ batches: [], lines: [] }} />);
    expect(html).toContain("先建立店铺档案");
    expect(html).toContain("手动导入无需平台授权");
    expect(html).toContain('href="/stores"');
  });

  it("does not misrepresent an unavailable shop service as a legitimately empty account list", () => {
    const html = renderToStaticMarkup(<AmazonReportWorkspace accounts={[]} initialWorkspace={{ batches: [], lines: [] }} initialError="订单服务暂时不可用，请稍后刷新页面。" />);
    expect(html).toContain("暂时无法读取店铺");
    expect(html).not.toContain("先建立店铺档案");
    expect(html).toContain('role="alert"');
  });

  it("preserves missing preview, raw customer text and buyer-source distinction", () => {
    const detail = detailFixture();
    const html = renderToStaticMarkup(<AmazonReportDetail detail={detail} />);
    expect(html).toContain("暂无可用的亚马逊预览");
    expect(html).toContain("买家上传原图");
    expect(html).toContain("A &amp; B\n第二行");
    expect(html).toContain("未识别类型");
    expect(html).toContain("缺少预览文件");
    expect(html).not.toContain("放大亚马逊定制预览");
    expect(html).not.toMatch(/(?:src|href)="https?:\/\/|customizedUrl|encrypted/);
  });

  it("uses authenticated media paths and never interprets customer input as HTML", () => {
    const detail = detailFixture();
    detail.surfaces[0]!.previewFileKey = "preview-1";
    detail.surfaces[0]!.fields[0]!.value = '<script>alert("buyer")</script>';
    detail.files.push({ key: "preview-1", name: "preview.jpg", mediaType: "image/jpeg", role: "preview", byteSize: 60 });
    const html = renderToStaticMarkup(<AmazonReportDetail detail={detail} />);
    expect(html).toContain(`/api/orders/reports/lines/${detail.line.id}/files/preview-1`);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('referrerPolicy="no-referrer"');
  });

  it("explains that a failed attachment must be retried before review", () => {
    const detail = detailFixture();
    detail.line.state = "failed";
    const html = renderToStaticMarkup(<AmazonReportDetail detail={detail} />);
    expect(html).toContain("最新附件未能完成解析");
    expect(html).toContain("重试或补传 ZIP 后再核对");
  });

  it("downloads the untouched source while labelling the reduced display image and original dimensions", () => {
    const detail = detailFixture();
    detail.files[0] = { ...detail.files[0]!, originalFileKey: "source-1", width: 4800, height: 6400 };
    const html = renderToStaticMarkup(<AmazonReportDetail detail={detail} />);
    expect(html).toContain("4800 × 6400 px（原图）");
    expect(html).toContain(`/files/source-1?versionId=${detail.versionId}`);
    expect(html).toContain("下载原图");
    expect(html).toContain(`/files/buyer-1?versionId=${detail.versionId}`);
  });

  it("shows new and duplicate order counts separately", () => {
    const batch: AmazonReportBatchView = { id: createEntityId(), accountId: createEntityId(), marketplaceId: "ATVPDKIKX0DER", fileName: "orders.txt", rowCount: 3, orderCount: 2, newOrderCount: 0, duplicateOrderCount: 2, failedOrderCount: 0, status: "completed", createdAt: "2026-09-08T00:00:00.000Z" };
    expect(batchSummary(batch)).toBe("2 个订单 / 3 条商品 · 新增 0 · 重复 2 · 异常 0");
  });

  it("preserves UTF-8 BOM text and requires explicit fallback for invalid UTF-8", () => {
    const bytes = new TextEncoder().encode("\uFEFForder-id\tname\n001\t名字");
    expect(decodeAmazonReport(bytes.buffer, "utf-8")).toBe("order-id\tname\n001\t名字");
    expect(() => decodeAmazonReport(Uint8Array.from([0xc4, 0xe3, 0xba, 0xc3]).buffer, "utf-8")).toThrow("GB18030");
    expect(decodeAmazonReport(Uint8Array.from([0xc4, 0xe3, 0xba, 0xc3]).buffer, "gb18030")).toBe("你好");
    expect(() => decodeAmazonReport(new ArrayBuffer(5 * 1024 * 1024 + 1), "utf-8")).toThrow("5 MB");
  });

  it("isolates a failed ZIP and bounds simultaneous parsing to two rows", async () => {
    let inFlight = 0;
    let peak = 0;
    const visited: number[] = [];
    await runReportQueue([1, 2, 3, 4, 5], async (item) => {
      visited.push(item); inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      if (item === 2) throw new Error("attachment unavailable");
    });
    expect(visited).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("stops dequeuing when the user changes account or batch", async () => {
    let active = true;
    const visited: number[] = [];
    await runReportQueue([1, 2, 3], async (item) => { visited.push(item); active = false; }, () => active);
    expect(visited).toEqual([1]);
  });
});

function detailFixture(): AmazonReportDetailView {
  return {
    line: { id: createEntityId(), orderId: createEntityId(), orderLineId: createEntityId(), externalOrderId: "TEST-ORDER-01", externalLineId: "TEST-LINE-01", skuCode: "TEST-PHOTO", title: "Photo pillow", quantity: 1, currency: "USD", itemTotalMinor: 2499, state: "partial", versionNumber: 1, reviewed: false, lastErrorCode: null, updatedAt: "2026-09-08T00:00:00.000Z", hasPreview: false },
    surfaces: [{ key: "front", label: "正面", fields: [{ key: "message", label: "文字", kind: "text", value: "A & B\n第二行" }, { key: "unknown", label: "选项", kind: "unknown", value: "需要核对" }], previewFileKey: null, buyerFileKeys: ["buyer-1"] }],
    files: [{ key: "buyer-1", name: "original.jpg", mediaType: "image/jpeg", role: "buyer_image", byteSize: 100 }], warnings: ["缺少预览文件"], versionId: createEntityId(),
  };
}
