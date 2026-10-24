import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import {
  ApplyFactoryErpImportSchema,
  FACTORY_ERP_HEADERS,
  FACTORY_ERP_MAX_BYTES,
  FactoryErpCandidatesQuerySchema,
  FactoryErpDiagnosticSchema,
  FactoryErpOptionsSchema,
  FactoryErpPageQuerySchema,
  FactoryErpParsedSchema,
  FactoryErpStatusViewSchema,
  UploadFactoryErpImportSchema,
  type ApplyFactoryErpImport,
  type FactoryErpExportRow,
  type FactoryErpItemSelection,
  type FactoryErpParsed,
  type FactoryErpStatusView,
  type UploadFactoryErpImport,
} from "./factory-erp-import.js";

const fileChecksum = "a".repeat(64), previewChecksum = "b".repeat(64);
function row(rowNumber = 2): FactoryErpExportRow {
  const rawCells = [
    "0009007199254740993123", "Synthetic source", "SYNTHETIC-ORDER", "00000123456789012345", "", "",
    "2", "4", "Synthetic carrier", "Synthetic service", "已审核", "2026-10-21 08:09:10", "2026-10-21 09:10:11",
  ];
  return {
    rowNumber, rawCells, externalId: rawCells[0]!, sourceLabel: rawCells[1]!, orderReference: rawCells[2]!,
    trackingReference: rawCells[3]!, sizeText: "", customizationText: "", itemKinds: 2, itemQuantity: 4,
    carrier: rawCells[8]!, carrierService: rawCells[9]!, rawStatus: "已审核", createdAtLocal: rawCells[11]!, updatedAtLocal: rawCells[12]!,
  };
}
function parsed(): FactoryErpParsed {
  return { format: "csv", sheetName: null, headers: [...FACTORY_ERP_HEADERS], rows: [row()], diagnostics: [], coverage: "current_page_or_unspecified" };
}
function selection(): FactoryErpItemSelection {
  return { deliveryItemId: createEntityId(), productionOrderId: createEntityId(), productionVersionId: createEntityId(), fileChecksum, manufacturingChecksum: "c".repeat(64) };
}
function upload(): UploadFactoryErpImport {
  const bytes = Buffer.from(`${FACTORY_ERP_HEADERS.join(",")}\r\n${row().rawCells.join(",")}`, "utf8");
  return { factoryId: createEntityId(), fileName: "synthetic-current-page.csv", contentBase64: bytes.toString("base64"),
    checksumSha256: createHash("sha256").update(bytes).digest("hex"), options: { csvEncoding: "utf-8", delimiter: "," }, idempotencyKey: randomUUID() };
}
function apply(): ApplyFactoryErpImport {
  return { fileChecksum, previewChecksum, idempotencyKey: randomUUID(), confirmed: true,
    rows: [{ rowNumber: 2, items: [selection(), selection()], wholeGroupConfirmed: true }] };
}

describe("factory ERP immutable import contracts", () => {
  it("preserves opaque external and tracking identifiers, empty production details and unzoned source times", () => {
    const input = parsed(), value = FactoryErpParsedSchema.parse(input);
    expect(value).toEqual(input);
    expect(value.rows[0]).toMatchObject({ externalId: "0009007199254740993123", trackingReference: "00000123456789012345",
      sizeText: "", customizationText: "", createdAtLocal: "2026-10-21 08:09:10", updatedAtLocal: "2026-10-21 09:10:11", itemKinds: 2, itemQuantity: 4 });
    expect(value.coverage).toBe("current_page_or_unspecified");
    expect(FactoryErpParsedSchema.safeParse({ ...input, coverage: "all_factory_records" }).success).toBe(false);
  });

  it("accepts bounded original-byte uploads and rejects path, format, checksum, base64 and authority injection", () => {
    const input = upload();
    expect(UploadFactoryErpImportSchema.parse(input)).toEqual(input);
    const maxBytes = Buffer.alloc(FACTORY_ERP_MAX_BYTES, 65);
    expect(UploadFactoryErpImportSchema.safeParse({ ...input, contentBase64: maxBytes.toString("base64"),
      checksumSha256: createHash("sha256").update(maxBytes).digest("hex") }).success).toBe(true);
    for (const invalid of [
      { ...input, fileName: "../synthetic.csv" }, { ...input, fileName: "C:\\synthetic.xlsx" },
      { ...input, fileName: "synthetic.xlsm" }, { ...input, fileName: "synthetic.csv\u0000" },
      { ...input, checksumSha256: "A".repeat(64) }, { ...input, contentBase64: "data:text/csv;base64,QUFB" },
      { ...input, contentBase64: "QU FB" }, { ...input, contentBase64: Buffer.alloc(FACTORY_ERP_MAX_BYTES + 3, 65).toString("base64") },
      { ...input, tenantId: createEntityId() }, { ...input, createdBy: createEntityId() },
    ]) expect(UploadFactoryErpImportSchema.safeParse(invalid).success).toBe(false);
  });

  it("keeps encoding, delimiter and sheet choices explicit and refuses unsupported parser options", () => {
    expect(FactoryErpOptionsSchema.parse({})).toEqual({});
    expect(FactoryErpOptionsSchema.parse({ sheetName: "Synthetic selected sheet", csvEncoding: "gb18030", delimiter: "\t" }))
      .toEqual({ sheetName: "Synthetic selected sheet", csvEncoding: "gb18030", delimiter: "\t" });
    for (const invalid of [{ sheetName: "" }, { csvEncoding: "auto" }, { csvEncoding: "latin1" }, { delimiter: "|" }, { executeFormulas: true }, { timeZone: "UTC" }])
      expect(FactoryErpOptionsSchema.safeParse(invalid).success).toBe(false);
  });

  it("binds a confirmed multi-item head to each original production version and both exact file pins", () => {
    const input = apply(), value = ApplyFactoryErpImportSchema.parse(input);
    expect(value).toEqual(input);
    expect(value.rows[0]!.items).toHaveLength(2);
    for (const item of value.rows[0]!.items) {
      expect(item.productionVersionId).toBeTruthy();
      expect(item.fileChecksum).toBe(fileChecksum);
      expect(item.manufacturingChecksum).toBe("c".repeat(64));
    }
  });

  it("rejects repeated row heads and delivery items within or across external heads", () => {
    const input = apply(), first = input.rows[0]!, second = { rowNumber: 3, items: [selection()], wholeGroupConfirmed: true as const };
    expect(ApplyFactoryErpImportSchema.safeParse({ ...input, rows: [first, second] }).success).toBe(true);
    for (const rows of [
      [first, { ...second, rowNumber: first.rowNumber }],
      [{ ...first, items: [first.items[0]!, first.items[0]!] }],
      [first, { ...second, items: [first.items[0]!] }],
    ]) expect(ApplyFactoryErpImportSchema.safeParse({ ...input, rows }).success).toBe(false);
  });

  it("requires both explicit confirmations and exact preview pins without accepting status or quantity instructions", () => {
    const input = apply(), first = input.rows[0]!;
    for (const invalid of [
      { ...input, confirmed: false }, { ...input, rows: [{ ...first, wholeGroupConfirmed: false }] },
      { ...input, fileChecksum: "" }, { ...input, previewChecksum: "" }, { ...input, rows: [] },
      { ...input, rows: [{ ...first, items: [{ ...first.items[0]!, manufacturingChecksum: null }] }] },
      { ...input, rows: [{ ...first, items: [{ ...first.items[0]!, productionVersionId: null }] }] },
      { ...input, rows: [{ ...first, status: "shipped" }] }, { ...input, rows: [{ ...first, shippedQuantity: 4 }] },
      { ...input, tenantId: createEntityId() },
    ]) expect(ApplyFactoryErpImportSchema.safeParse(invalid).success).toBe(false);
  });

  it("bounds page inputs and separates factory-scoped candidate queries from imported source-row pages", () => {
    const factoryId = createEntityId();
    expect(FactoryErpPageQuerySchema.parse({})).toEqual({ offset: 0, limit: 25 });
    expect(FactoryErpPageQuerySchema.parse({ offset: "5000", limit: "100" })).toEqual({ offset: 5000, limit: 100 });
    expect(FactoryErpCandidatesQuerySchema.parse({ factoryId, q: "SYNTHETIC-ORDER", limit: "100" }))
      .toEqual({ factoryId, q: "SYNTHETIC-ORDER", limit: 100 });
    for (const input of [{ offset: -1 }, { offset: 5001 }, { limit: 0 }, { limit: 101 }, { cursor: "invented" }, { factoryId }])
      expect(FactoryErpPageQuerySchema.safeParse(input).success).toBe(false);
    expect(FactoryErpCandidatesQuerySchema.safeParse({ q: "SYNTHETIC-ORDER" }).success).toBe(false);
    expect(FactoryErpCandidatesQuerySchema.safeParse({ factoryId, tenantId: createEntityId() }).success).toBe(false);
  });

  it("keeps all 5000 bounded rows and refuses overflow or malformed raw column and quantity evidence", () => {
    const input = parsed(), rows = Array.from({ length: 5000 }, (_, index) => {
      const value = row(index + 2); value.externalId = `SYNTHETIC-${index}`; value.rawCells[0] = value.externalId; return value;
    });
    expect(FactoryErpParsedSchema.parse({ ...input, rows }).rows).toHaveLength(5000);
    expect(FactoryErpParsedSchema.safeParse({ ...input, rows: [...rows, row(5002)] }).success).toBe(false);
    for (const invalid of [
      { ...row(), rawCells: row().rawCells.slice(0, 12) }, { ...row(), rawCells: [...row().rawCells, "unexpected"] },
      { ...row(), itemKinds: 0 }, { ...row(), itemQuantity: 0 }, { ...row(), itemQuantity: 1.5 },
      { ...row(), itemQuantity: 100001 }, { ...row(), rowNumber: 1 },
    ]) expect(FactoryErpParsedSchema.safeParse({ ...input, rows: [invalid] }).success).toBe(false);
  });

  it("exposes diagnostic codes and row numbers without reflecting source cells or file contents", () => {
    expect(FactoryErpDiagnosticSchema.parse({ code: "unknown_status", rowNumber: 2 })).toEqual({ code: "unknown_status", rowNumber: 2 });
    expect(FactoryErpDiagnosticSchema.parse({ code: "duplicate_external_id", rowNumber: 3 })).toEqual({ code: "duplicate_external_id", rowNumber: 3 });
    for (const invalid of [
      { code: "unknown_status", rowNumber: 2, rawValue: "Synthetic private source" },
      { code: "unknown_status", rowNumber: 2, message: "Synthetic private cell content" },
      { code: "UNKNOWN_STATUS", rowNumber: 2 }, { code: "unknown_status", rowNumber: 0 },
    ]) expect(FactoryErpDiagnosticSchema.safeParse(invalid).success).toBe(false);
  });

  it("records external shipment status without fabricating an internal shipped quantity", () => {
    const input: FactoryErpStatusView = { bindingId: createEntityId(), externalId: row().externalId, status: "shipped", exception: null,
      observationId: createEntityId(), importId: createEntityId(), rawStatus: "已出库", updatedAtLocal: row().updatedAtLocal,
      recordedAt: "2026-10-21T09:10:11.123Z", trackingReference: row().trackingReference, carrier: "Synthetic carrier", carrierService: "Synthetic service", shippedQuantity: null };
    expect(FactoryErpStatusViewSchema.parse(input)).toEqual(input);
    expect(FactoryErpStatusViewSchema.safeParse({ ...input, shippedQuantity: 4 }).success).toBe(false);
    expect(FactoryErpStatusViewSchema.safeParse({ ...input, status: "cancelled" }).success).toBe(false);
    expect(FactoryErpStatusViewSchema.safeParse({ ...input, startedAt: input.recordedAt }).success).toBe(false);
  });
});
