import { describe, expect, it } from "vitest";

import {
  AmazonReportDetailViewSchema,
  AmazonReportImportInputSchema,
  AmazonReportLineViewSchema,
  AmazonReportRetryInputSchema,
  AmazonReportReviewInputSchema,
} from "./report.js";

const id = "019c4567-89ab-7def-8123-456789abcdef";
const line = {
  id, orderId: id, orderLineId: id, externalOrderId: "114-0000000-0000000", externalLineId: "1234567890",
  skuCode: "PHOTO-PILLOW", title: "Custom photo pillow", quantity: 3, currency: "USD", itemTotalMinor: 1000,
  state: "ready", versionNumber: 1, reviewed: false, lastErrorCode: null, updatedAt: "2026-09-08T00:00:00.000Z", hasPreview: true,
};

describe("Amazon report contracts", () => {
  it("accepts original report whitespace and prevents caller-selected tenant context", () => {
    const input = { accountId: id, marketplaceId: "ATVPDKIKX0DER", fileName: "orders.txt", content: "order-id\tcustomized-url\r\n" };
    expect(AmazonReportImportInputSchema.parse(input).content).toBe(input.content);
    expect(AmazonReportImportInputSchema.safeParse({ ...input, tenantId: id }).success).toBe(false);
    expect(AmazonReportImportInputSchema.safeParse({ ...input, content: "x".repeat(5 * 1024 * 1024 + 1) }).success).toBe(false);
    expect(AmazonReportImportInputSchema.safeParse({ ...input, accountId: "019c4567-89ab-4def-8123-456789abcdef" }).success).toBe(false);
  });

  it("preserves exact line total independently of a non-divisible unit price", () => {
    const parsed = AmazonReportLineViewSchema.parse(line);
    expect(parsed.itemTotalMinor).toBe(1000);
    expect(parsed.quantity).toBe(3);
    expect(AmazonReportLineViewSchema.safeParse({ ...line, itemTotalMinor: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });

  it("exposes authorized media descriptors without embedded image or source content", () => {
    const detail = {
      line,
      surfaces: [{ key: "front", label: "Front", fields: [{ key: "name", label: "Your name", kind: "text", value: "  Ada  " }], previewFileKey: "preview", buyerFileKeys: ["original"] }],
      files: [{ key: "preview", name: "preview.jpg", mediaType: "image/jpeg", role: "preview", byteSize: 100, originalFileKey: "source-1", width: 6000, height: 4000 }],
      warnings: [], versionId: id,
    };
    expect(AmazonReportDetailViewSchema.parse(detail).surfaces[0]?.fields[0]?.value).toBe("  Ada  ");
    expect(AmazonReportDetailViewSchema.parse(detail).files[0]?.originalFileKey).toBe("source-1");
    expect(AmazonReportDetailViewSchema.parse({ ...detail, files: Array.from({ length: 400 }, (_, index) => ({ ...detail.files[0], key: `file-${index}` })) }).files).toHaveLength(400);
    expect(AmazonReportDetailViewSchema.safeParse({ ...detail, archiveBase64: "secret" }).success).toBe(false);
    expect(AmazonReportDetailViewSchema.safeParse({ ...detail, files: [{ ...detail.files[0], base64: "secret" }] }).success).toBe(false);
  });

  it("requires a concrete version for review while allowing first-time retry", () => {
    expect(AmazonReportRetryInputSchema.parse({ expectedVersionId: null }).expectedVersionId).toBeNull();
    expect(AmazonReportReviewInputSchema.safeParse({ expectedVersionId: null }).success).toBe(false);
    expect(AmazonReportReviewInputSchema.parse({ expectedVersionId: id }).expectedVersionId).toBe(id);
  });
});
