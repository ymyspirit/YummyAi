import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import {
  FACTORY_ERP_HEADERS,
  FACTORY_ERP_MAX_BYTES,
  FactoryErpParsedSchema,
  type FactoryErpOptions,
} from "@yummyai/contracts/order/factory-erp-import";
import { FactoryErpExportParseError, parseFactoryErpExport } from "./factory-erp-export-parser.js";

// These are entirely synthetic rows. No user export or real order/tracking number is copied.
const syntheticRow = (): string[] => [
  "0009007199254740993123", "Synthetic & owned source", "SYNTHETIC-ORDER", "000000123456789012345", "", "",
  "2", "4", "Synthetic carrier", "Synthetic service", "已审核", "2026-10-21 08:09:10", "2026-10-21 09:10:11",
];
type Cell = ({ type: "inline" | "shared" | "number"; value: string } | { type: "formula"; value: string; cached: string }) & { styleIndex?: number };
type Sheet = { name: string; rows: Cell[][] };
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const strings = (values: readonly string[], type: "inline" | "shared" = "inline"): Cell[] => values.map(value => ({ type, value }));
const sheet = (name = "Synthetic export", rows: string[][] = [syntheticRow()]): Sheet => ({ name, rows: [strings(FACTORY_ERP_HEADERS, "shared"), ...rows.map(values => strings(values))] });

/** A complete, independently assembled OOXML workbook, rather than a mocked parser tree. */
async function workbook(sheets: Sheet[] = [sheet()], extras: Record<string, string | Uint8Array> = {}, compression: "STORE" | "DEFLATE" = "STORE"): Promise<Buffer> {
  const zip = new JSZip(), sharedStrings: string[] = [];
  const put = (name: string, body: string | Uint8Array) => zip.file(name, body, { createFolders: false });
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main", relationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const stylesType = Object.hasOwn(extras, "xl/styles.xml") ? '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' : "";
  const stylesRelation = Object.hasOwn(extras, "xl/styles.xml") ? `<Relationship Id="styles" Type="${relationships}/styles" Target="styles.xml"/>` : "";
  const cellXml = (cell: Cell, rowIndex: number, columnIndex: number): string => {
    const ref = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`, style = cell.styleIndex === undefined ? "" : ` s="${cell.styleIndex}"`;
    if (cell.type === "number") return `<c r="${ref}"${style} t="n"><v>${xml(cell.value)}</v></c>`;
    if (cell.type === "formula") return `<c r="${ref}"${style}><f>${xml(cell.value)}</f><v>${xml(cell.cached)}</v></c>`;
    if (cell.type === "shared") {
      const index = sharedStrings.push(cell.value) - 1;
      return `<c r="${ref}"${style} t="s"><v>${index}</v></c>`;
    }
    return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(cell.value)}</t></is></c>`;
  };
  sheets.forEach((value, index) => put(`xl/worksheets/sheet${index + 1}.xml`,
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${ns}"><sheetData>${value.rows.map((cells, rowIndex) =>
      `<row r="${rowIndex + 1}">${cells.map((cell, columnIndex) => cellXml(cell, rowIndex, columnIndex)).join("")}</row>`).join("")}</sheetData></worksheet>`));
  put("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>${stylesType}${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`);
  put("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relationships}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  put("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${ns}" xmlns:r="${relationships}"><sheets>${sheets.map((value, index) => `<sheet name="${xml(value.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`);
  put("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="${relationships}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="shared" Type="${relationships}/sharedStrings" Target="sharedStrings.xml"/>${stylesRelation}</Relationships>`);
  put("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${ns}" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sharedStrings.map(value => `<si><t xml:space="preserve">${xml(value)}</t></si>`).join("")}</sst>`);
  for (const [name, body] of Object.entries(extras)) put(name, body);
  return zip.generateAsync({ type: "nodebuffer", compression });
}

function csv(rows: string[][] = [syntheticRow()], delimiter: "," | "\t" | ";" = ",", headers: readonly string[] = FACTORY_ERP_HEADERS): string {
  const quote = (value: string) => value.includes(delimiter) || /[\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return [headers, ...rows].map(values => values.map(quote).join(delimiter)).join("\r\n");
}

/** Encode only this fixture's characters using the platform's standard GB18030 table. */
function gb18030Fixture(text: string): Buffer {
  const wanted = new Set([...text].filter(value => value.codePointAt(0)! > 127)), encoded = new Map<string, Buffer>();
  const decoder = new TextDecoder("gb18030", { fatal: true });
  for (let lead = 0x81; lead <= 0xfe && wanted.size; lead++) {
    for (let trail = 0x40; trail <= 0xfe && wanted.size; trail++) {
      if (trail === 0x7f) continue;
      const bytes = Buffer.from([lead, trail]);
      try {
        const value = decoder.decode(bytes);
        if (wanted.delete(value)) encoded.set(value, bytes);
      } catch { /* An invalid byte pair is not part of the standard fixture alphabet. */ }
    }
  }
  if (wanted.size) throw new Error("Synthetic GB18030 fixture contains an unsupported fixture character");
  return Buffer.concat([...text].map(value => {
    if (value.codePointAt(0)! <= 127) return Buffer.from(value, "ascii");
    const bytes = encoded.get(value);
    if (!bytes) throw new Error("Synthetic GB18030 fixture character missing");
    return bytes;
  }));
}

async function rejectsFile(fileName: string, bytes: Uint8Array, options: FactoryErpOptions = {}): Promise<void> {
  try { await parseFactoryErpExport(fileName, bytes, options); }
  catch (error) {
    expect(error).toBeInstanceOf(FactoryErpExportParseError);
    if (!(error instanceof FactoryErpExportParseError)) throw error;
    expect(error.code).toMatch(/^factory_erp_[a-z0-9_]+$/);
    expect(error.message).toBe(error.code);
    expect(Object.keys(error.diagnostic).sort()).toEqual(["code", "rowNumber"]);
    expect(error.diagnostic).toEqual({ code: error.code, rowNumber: error.rowNumber });
    return;
  }
  throw new Error("Expected the whole synthetic export to be rejected");
}

describe("bounded factory ERP export parser", () => {
  it("reads real OOXML shared, inline and numeric cells without rounding identifier strings or converting local times", async () => {
    const first = syntheticRow(); first[0] = "812345";
    const second = syntheticRow(); second[0] = "0009007199254740993999"; second[10] = "已出库";
    const cells = strings(first, "shared");
    for (const column of [0, 6, 7]) cells[column] = { type: "number", value: first[column]! };
    const bytes = await workbook([{ name: "Synthetic export", rows: [strings(FACTORY_ERP_HEADERS, "shared"), cells, strings(second)] }]);
    const value = FactoryErpParsedSchema.parse(await parseFactoryErpExport("synthetic-export.xlsx", bytes));
    expect(value).toMatchObject({ format: "xlsx", sheetName: "Synthetic export", headers: [...FACTORY_ERP_HEADERS], diagnostics: [], coverage: "current_page_or_unspecified" });
    expect(value.rows.map(row => row.rawCells)).toEqual([first, second]);
    expect(value.rows[0]).toMatchObject({ rowNumber: 2, externalId: "812345", itemKinds: 2, itemQuantity: 4, sizeText: "", customizationText: "" });
    expect(value.rows[1]).toMatchObject({ rowNumber: 3, externalId: second[0], trackingReference: second[3], rawStatus: "已出库",
      createdAtLocal: "2026-10-21 08:09:10", updatedAtLocal: "2026-10-21 09:10:11" });
  });

  it("requires an explicit choice among visible worksheets and reads only the chosen data sheet", async () => {
    const first = syntheticRow(), second = syntheticRow(); second[0] = "SYNTHETIC-SECOND-SHEET"; second[10] = "已作废";
    const bytes = await workbook([sheet("Synthetic first", [first]), sheet("Synthetic second", [second])]);
    await rejectsFile("synthetic-sheets.xlsx", bytes);
    const value = await parseFactoryErpExport("synthetic-sheets.xlsx", bytes, { sheetName: "Synthetic second" });
    expect(value.sheetName).toBe("Synthetic second");
    expect(value.rows).toHaveLength(1);
    expect(value.rows[0]!.rawCells).toEqual(second);
    expect(value.rows[0]!.rawStatus).toBe("已作废");
    await rejectsFile("synthetic-sheets.xlsx", bytes, { sheetName: "Synthetic missing" });
  });

  it("preserves UTF8 BOM, quoted delimiters, escaped quotes and embedded newlines under each declared CSV delimiter", async () => {
    const raw = syntheticRow(); raw[5] = 'Synthetic, custom\ttext; "quoted"\nsecond line <literal>';
    const next = syntheticRow(); next[0] = "SYNTHETIC-AFTER-QUOTED-RECORD";
    for (const delimiter of [",", "\t", ";"] as const) {
      const bytes = Buffer.from(`\uFEFF${csv([raw, next], delimiter)}\r\n`, "utf8");
      const value = await parseFactoryErpExport("synthetic-quoted.csv", bytes, { csvEncoding: "utf-8", delimiter });
      expect(FactoryErpParsedSchema.parse(value).rows).toHaveLength(2);
      expect(value).toMatchObject({ format: "csv", sheetName: null, diagnostics: [] });
      expect(value.rows.map(row => row.rawCells)).toEqual([raw, next]);
      expect(value.rows.map(row => row.rowNumber)).toEqual([2, 3]);
      expect(value.rows[0]!.customizationText).toBe(raw[5]);
    }
  });

  it("decodes explicitly selected GB18030 and rejects bad UTF8 or format-specific options rather than silently guessing", async () => {
    const text = csv(), bytes = gb18030Fixture(text);
    expect(new TextDecoder("gb18030", { fatal: true }).decode(bytes)).toBe(text);
    const value = await parseFactoryErpExport("synthetic-gb18030.csv", bytes, { csvEncoding: "gb18030", delimiter: "," });
    expect(value.headers).toEqual([...FACTORY_ERP_HEADERS]);
    expect(value.rows[0]!.rawCells).toEqual(syntheticRow());
    await rejectsFile("synthetic-gb18030.csv", bytes, { csvEncoding: "utf-8" });
    await rejectsFile("synthetic-invalid.csv", Buffer.concat([Buffer.from(csv()), Buffer.from([0xc3, 0x28])]), { csvEncoding: "utf-8" });
    await rejectsFile("synthetic-sheet.csv", Buffer.from(csv()), { sheetName: "Synthetic export" });
    await rejectsFile("synthetic-options.xlsx", await workbook(), { delimiter: "," });
  });

  it("retains every unknown-status and duplicate-ID row with only bounded code and source row-number diagnostics", async () => {
    const first = syntheticRow(), duplicate = syntheticRow(), unknown = syntheticRow();
    duplicate[10] = "已出库"; unknown[0] = "SYNTHETIC-UNRESOLVED"; unknown[10] = "SYNTHETIC_UNKNOWN_STATUS";
    const value = await parseFactoryErpExport("synthetic-diagnostics.csv", Buffer.from(csv([first, duplicate, unknown])));
    expect(value.rows.map(row => row.rawCells)).toEqual([first, duplicate, unknown]);
    expect(value.rows.map(row => row.rowNumber)).toEqual([2, 3, 4]);
    expect(value.diagnostics).toEqual(expect.arrayContaining([
      { code: "duplicate_external_id", rowNumber: 2 }, { code: "duplicate_external_id", rowNumber: 3 }, { code: "unknown_status", rowNumber: 4 },
    ]));
    expect(value.diagnostics).toHaveLength(3);
    for (const diagnostic of value.diagnostics) expect(Object.keys(diagnostic).sort()).toEqual(["code", "rowNumber"]);
    expect(JSON.stringify(value.diagnostics)).not.toContain("SYNTHETIC_UNKNOWN_STATUS");
  });

  it("maps reordered confirmed headers and rejects missing, repeated or extra headers and malformed CSV structure", async () => {
    const raw = syntheticRow(), headers = [...FACTORY_ERP_HEADERS].reverse(), reordered = [...raw].reverse();
    const value = await parseFactoryErpExport("synthetic-reordered.csv", Buffer.from(csv([reordered], ",", headers)));
    expect(value.headers).toEqual(headers);
    expect(value.rows[0]).toMatchObject({ externalId: raw[0], trackingReference: raw[3], rawStatus: raw[10], itemKinds: 2, itemQuantity: 4 });
    expect(value.rows[0]!.rawCells).toEqual(reordered);
    const duplicate = [...FACTORY_ERP_HEADERS]; duplicate[1] = "编号";
    for (const text of [
      csv([raw], ",", FACTORY_ERP_HEADERS.slice(0, 12)), csv([raw], ",", duplicate),
      csv([raw], ",", [...FACTORY_ERP_HEADERS, "Synthetic extra column"]), csv([[...raw, "Synthetic extra value"]]),
      `${FACTORY_ERP_HEADERS.join(",")}\r\n"Synthetic unterminated`,
    ]) await rejectsFile("synthetic-headers.csv", Buffer.from(text));
  });

  it("keeps text identifiers exact but refuses unsafe numeric spreadsheet IDs, fractional counts and impossible unzoned dates", async () => {
    const raw = syntheticRow(), valid = await parseFactoryErpExport("synthetic-precision.csv", Buffer.from(csv([raw])));
    expect(valid.rows[0]!.externalId).toBe("0009007199254740993123");
    expect(valid.rows[0]!.trackingReference).toBe("000000123456789012345");
    const leap = syntheticRow(); leap[11] = "2024-02-29 23:59:59";
    expect((await parseFactoryErpExport("synthetic-leap.csv", Buffer.from(csv([leap])))).rows[0]!.createdAtLocal).toBe(leap[11]);
    for (const invalid of ["0", "-1", "1.5", "1e3", "100001", "9007199254740993"]) {
      const values = syntheticRow(); values[7] = invalid;
      await rejectsFile("synthetic-quantity.csv", Buffer.from(csv([values])));
    }
    for (const invalid of ["2026-02-30 08:09:10", "0000-01-01 00:00:00", "2026-10-21T08:09:10Z"]) {
      const values = syntheticRow(); values[11] = invalid;
      await rejectsFile("synthetic-local-time.csv", Buffer.from(csv([values])));
    }
    for (const value of ["9007199254740993", "1.234567890123456e17"]) {
      const values = strings(syntheticRow()); values[0] = { type: "number", value };
      await rejectsFile("synthetic-numeric-id.xlsx", await workbook([{ name: "Synthetic export", rows: [strings(FACTORY_ERP_HEADERS), values] }]));
    }
  });

  it("identity fidelity: keeps whitespace-distinct raw IDs separate and accepts numeric IDs only with General formatting", async () => {
    const padded = syntheticRow(), plain = syntheticRow();
    padded[0] = " SYNTHETIC-IDENTITY "; plain[0] = "SYNTHETIC-IDENTITY";
    for (const column of [1, 2, 3, 8, 9]) padded[column] = ` ${padded[column]} `;
    const value = await parseFactoryErpExport("synthetic-identity.csv", Buffer.from(csv([padded, plain])));
    expect(value.rows.map(row => row.rawCells)).toEqual([padded, plain]);
    expect(value.rows.map(row => row.externalId)).toEqual([" SYNTHETIC-IDENTITY ", "SYNTHETIC-IDENTITY"]);
    expect(value.rows[0]).toMatchObject({ sourceLabel: padded[1], orderReference: padded[2], trackingReference: padded[3], carrier: padded[8], carrierService: padded[9] });
    expect(value.diagnostics).toContainEqual({ code: "identity_whitespace_requires_review", rowNumber: 2 });
    expect(value.diagnostics.some(row => row.code === "duplicate_external_id")).toBe(false);
    const styles = '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="000000000000000000000"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="11" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    const styled = async (styleIndex: number, sourceStyles = styles) => {
      const values = strings(syntheticRow()); values[0] = { type: "number", value: "812345", styleIndex };
      return workbook([{ name: "Synthetic export", rows: [strings(FACTORY_ERP_HEADERS), values] }], { "xl/styles.xml": sourceStyles });
    };
    const general = await parseFactoryErpExport("synthetic-general-id.xlsx", await styled(0));
    expect(general.rows[0]!.externalId).toBe("812345");
    expect(general.rows[0]!.rawCells[0]).toBe("812345");
    const unusedLocalized56 = styles.replace('<numFmts count="1">', '<numFmts count="2"><numFmt numFmtId="56" formatCode="yyyy年m月d日"/>');
    expect((await parseFactoryErpExport("synthetic-unused-localized-format.xlsx", await styled(0, unusedLocalized56))).rows[0]!.externalId).toBe("812345");
    const overriddenGeneral = styles.replace('<numFmts count="1">', '<numFmts count="2"><numFmt numFmtId="0" formatCode="000000"/>');
    await rejectsFile("synthetic-overridden-general-id.xlsx", await styled(0, overriddenGeneral));
    await rejectsFile("synthetic-zero-filled-id.xlsx", await styled(1));
    await rejectsFile("synthetic-scientific-id.xlsx", await styled(2));
  });

  it("returns all 5000 source rows without truncation and refuses a 5001st row, oversized file or oversized cell", async () => {
    const rows = Array.from({ length: 5000 }, (_, index) => { const values = syntheticRow(); values[0] = `SYNTHETIC-${String(index).padStart(5, "0")}`; return values; });
    const bytes = Buffer.from(csv(rows)), value = await parseFactoryErpExport("synthetic-5000.csv", bytes);
    expect(bytes.byteLength).toBeLessThan(FACTORY_ERP_MAX_BYTES);
    expect(FactoryErpParsedSchema.parse(value).rows).toHaveLength(5000);
    expect(value.rows[0]!.rawCells).toEqual(rows[0]);
    expect(value.rows[4999]).toMatchObject({ rowNumber: 5001, externalId: "SYNTHETIC-04999" });
    expect(value.diagnostics).toEqual([]);
    const overflow = syntheticRow(); overflow[0] = "SYNTHETIC-05000";
    await rejectsFile("synthetic-5001.csv", Buffer.from(csv([...rows, overflow])));
    await rejectsFile("synthetic-too-large.csv", Buffer.alloc(FACTORY_ERP_MAX_BYTES + 1, 65));
    const long = syntheticRow(); long[5] = "S".repeat(4001);
    await rejectsFile("synthetic-large-cell.csv", Buffer.from(csv([long])));
  });

  it("rejects broken, disguised, path-conflicting and expansion-heavy ZIP files as whole-file failures", async () => {
    const valid = await workbook();
    expect((await parseFactoryErpExport("synthetic-control.xlsx", valid)).rows).toHaveLength(1);
    const corrupt = Buffer.from(valid), central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    if (central < 0) throw new Error("Synthetic OOXML central directory missing");
    corrupt[central + 16] = corrupt[central + 16]! ^ 0x01;
    for (const bytes of [
      Buffer.from("PK-SYNTHETIC-NOT-A-ZIP"), valid.subarray(0, valid.length - 8), corrupt,
      await workbook(undefined, { "../synthetic-private.xml": "<Synthetic/>" }),
      await workbook(undefined, { "xl/worksheets/SHEET1.xml": "<Synthetic/>" }),
      await workbook(undefined, { "xl/synthetic-expanded.xml": `<Synthetic>${"A".repeat(2 * 1024 * 1024)}</Synthetic>` }, "DEFLATE"),
    ]) await rejectsFile("synthetic-unsafe.xlsx", bytes);
    await rejectsFile("synthetic-disguised.xlsx", Buffer.from(csv()));
    await rejectsFile("synthetic-not-csv.csv", valid);
  });

  it("effective MIME: accepts an unused macro binary default but rejects an actual binary part inheriting it", async () => {
    const build = async (includeBinary: boolean) => {
      const zip = await JSZip.loadAsync(await workbook());
      const types = zip.file("[Content_Types].xml");
      if (!types) throw new Error("Synthetic OOXML content types missing");
      zip.file("[Content_Types].xml", (await types.async("string")).replace("</Types>",
        '<Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/></Types>'), { createFolders: false });
      if (includeBinary) zip.file("xl/synthetic-binary.bin", Buffer.from("SYNTHETIC_BINARY_PART"), { createFolders: false });
      return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
    };
    const value = await parseFactoryErpExport("synthetic-unused-default.xlsx", await build(false));
    expect(FactoryErpParsedSchema.parse(value)).toMatchObject({ format: "xlsx", sheetName: "Synthetic export", diagnostics: [] });
    expect(value.rows).toHaveLength(1);
    expect(value.rows[0]!.rawCells).toEqual(syntheticRow());
    await rejectsFile("synthetic-active-binary.xlsx", await build(true));
  });

  it("rejects cached formulas, external relationships, entity declarations and macro parts without fetching or exposing private cell values", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Synthetic parser must not fetch external data"); });
    try {
      const values = strings(syntheticRow()); values[7] = { type: "formula", value: 'WEBSERVICE("https://example.invalid/SYNTHETIC_PRIVATE_FORMULA")', cached: "4" };
      const parts = [
        await workbook([{ name: "Synthetic export", rows: [strings(FACTORY_ERP_HEADERS), values] }]),
        await workbook(undefined, { "xl/worksheets/_rels/sheet1.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/SYNTHETIC_PRIVATE_LINK" TargetMode="External"/></Relationships>' }),
        await workbook(undefined, { "xl/sharedStrings.xml": '<?xml version="1.0"?><!DOCTYPE sst [<!ENTITY private SYSTEM "https://example.invalid/SYNTHETIC_PRIVATE_ENTITY">]><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>&private;</t></si></sst>' }),
        await workbook(undefined, { "xl/vbaProject.bin": Buffer.from("SYNTHETIC_PRIVATE_MACRO") }),
      ];
      for (const bytes of parts) await rejectsFile("synthetic-active-content.xlsx", bytes);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
});
