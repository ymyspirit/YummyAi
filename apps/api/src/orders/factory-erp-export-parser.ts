import { posix } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";
import {
  FACTORY_ERP_HEADERS,
  FACTORY_ERP_MAX_BYTES,
  FactoryErpOptionsSchema,
} from "@yummyai/contracts/order/factory-erp-import";
import type {
  FactoryErpDiagnostic,
  FactoryErpExportRow,
  FactoryErpOptions,
  FactoryErpParsed,
} from "@yummyai/contracts/order/factory-erp-import";
import { FactoryErpRawStatusSchema } from "@yummyai/contracts/order/production-delivery";

const MAX_ROWS = 5000;
const MAX_COLUMNS = 64;
const MAX_CELL_CHARACTERS = 4000;
const MAX_ZIP_ENTRIES = 256;
const MAX_EXPANDED_BYTES = 40 * 1024 * 1024;
const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 250;
const MAX_XML_NODES = 500_000;
const MAX_XML_DEPTH = 32;

/** Public failures never contain a cell, filename, relationship target, or XML. */
export class FactoryErpExportParseError extends Error {
  readonly diagnostic: FactoryErpDiagnostic;

  constructor(readonly code: string, readonly rowNumber: number | null = null) {
    super(code);
    this.name = "FactoryErpExportParseError";
    this.diagnostic = { code, rowNumber };
  }
}

function fail(code: string, rowNumber: number | null = null): never {
  throw new FactoryErpExportParseError(code, rowNumber);
}

interface SourceRow {
  rowNumber: number;
  cells: string[];
  numericColumns?: Set<number>;
  numberFormatReviewColumns?: Set<number>;
}

interface ZipEntry {
  name: string;
  directory: boolean;
  compressedSize: number;
  expandedSize: number;
  crc: number;
  start: number;
  end: number;
}

interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string;
}

function utf8(bytes: Uint8Array, code: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return fail(code);
  }
}

function checkedText(value: string, rowNumber: number | null = null): string {
  if (value.length > MAX_CELL_CHARACTERS) fail("factory_erp_cell_limit", rowNumber);
  if (Array.from(value).some(char => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0))))
    fail("factory_erp_cell_invalid", rowNumber);
  return value;
}

function positiveCount(value: string, rowNumber: number): number {
  if (!/^\d{1,6}$/.test(value)) fail("factory_erp_quantity_invalid", rowNumber);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 100_000)
    fail("factory_erp_quantity_invalid", rowNumber);
  return number;
}

function localTime(value: string, rowNumber: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) fail("factory_erp_date_invalid", rowNumber);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const [year, month, day, hour, minute, second] =
    [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
      hour > 23 || minute > 59 || second > 59)
    fail("factory_erp_date_invalid", rowNumber);
  // These are factory-local strings. No timezone, instant, or actual event is inferred.
  return value;
}

function materializeRows(source: SourceRow[]): Pick<FactoryErpParsed, "headers" | "rows" | "diagnostics"> {
  const header = source[0];
  if (!header || header.rowNumber !== 1 || header.cells.length !== FACTORY_ERP_HEADERS.length ||
      new Set(header.cells).size !== FACTORY_ERP_HEADERS.length ||
      !FACTORY_ERP_HEADERS.every(name => header.cells.includes(name)))
    fail("factory_erp_headers_invalid", header?.rowNumber ?? null);
  if (source.length < 2) fail("factory_erp_rows_missing");
  if (source.length > MAX_ROWS + 1) fail("factory_erp_row_limit");

  const positions = FACTORY_ERP_HEADERS.map(name => header.cells.indexOf(name));
  const diagnostics: FactoryErpDiagnostic[] = [];
  const rows: FactoryErpExportRow[] = [];
  const externalIds = new Map<string, number>(), markedDuplicates = new Set<number>();
  for (const entry of source.slice(1)) {
    if (entry.rowNumber < 2 || entry.rowNumber > MAX_ROWS + 1)
      fail("factory_erp_row_limit", entry.rowNumber);
    if (entry.cells.length > FACTORY_ERP_HEADERS.length)
      fail("factory_erp_column_count_invalid", entry.rowNumber);
    const rawCells = Array.from({ length: FACTORY_ERP_HEADERS.length }, (_, i) =>
      checkedText(entry.cells[i] ?? "", entry.rowNumber));
    const get = (index: number) => rawCells[positions[index]];
    // XLSX numeric identifiers have already passed Excel's precision boundary.
    // Never expand exponent notation or invent digits lost by the spreadsheet.
    for (const index of [0, 2, 3]) {
      if (entry.numericColumns?.has(positions[index]) && get(index) !== "" &&
          (!/^\d{1,15}$/.test(get(index)) || !Number.isSafeInteger(Number(get(index)))))
        fail("factory_erp_identifier_precision_invalid", entry.rowNumber);
    }
    if ([0, 2, 3].some(index => entry.numberFormatReviewColumns?.has(positions[index])))
      fail("factory_erp_identity_number_format_requires_review", entry.rowNumber);
    const externalId = get(0);
    if (!externalId.trim() || !get(10)) fail("factory_erp_row_identity_missing", entry.rowNumber);
    if ([0, 1, 2, 3, 8, 9].some(index => get(index) !== get(index).trim()))
      diagnostics.push({ code: "identity_whitespace_requires_review", rowNumber: entry.rowNumber });
    const originalRow = externalIds.get(externalId);
    if (originalRow !== undefined) {
      if (!markedDuplicates.has(originalRow)) {
        diagnostics.push({ code: "duplicate_external_id", rowNumber: originalRow });
        markedDuplicates.add(originalRow);
      }
      diagnostics.push({ code: "duplicate_external_id", rowNumber: entry.rowNumber });
    } else externalIds.set(externalId, entry.rowNumber);
    if (!FactoryErpRawStatusSchema.safeParse(get(10)).success)
      diagnostics.push({ code: "unknown_status", rowNumber: entry.rowNumber });
    rows.push({
      rowNumber: entry.rowNumber,
      rawCells,
      externalId,
      sourceLabel: get(1),
      orderReference: get(2),
      trackingReference: get(3),
      sizeText: get(4),
      customizationText: get(5),
      itemKinds: positiveCount(get(6), entry.rowNumber),
      itemQuantity: positiveCount(get(7), entry.rowNumber),
      carrier: get(8),
      carrierService: get(9),
      rawStatus: get(10),
      createdAtLocal: localTime(get(11), entry.rowNumber),
      updatedAtLocal: localTime(get(12), entry.rowNumber),
    });
  }
  if (diagnostics.length > 10_000) fail("factory_erp_diagnostic_limit");
  return { headers: [...header.cells], rows, diagnostics };
}

function csvRows(text: string, delimiter: "," | "\t" | ";"): SourceRow[] {
  if (text.includes("\0")) fail("factory_erp_csv_invalid");
  const rows: SourceRow[] = [];
  let cells: string[] = [], cell = "", quoted = false, closed = false;
  let recordNumber = 1;
  const finishCell = () => {
    cells.push(checkedText(cell, recordNumber));
    if (cells.length > MAX_COLUMNS) fail("factory_erp_column_limit", recordNumber);
    cell = "";
    closed = false;
  };
  const finishRow = () => {
    finishCell();
    if (cells.some(value => value !== "")) rows.push({ rowNumber: recordNumber, cells });
    if (rows.length > MAX_ROWS + 1) fail("factory_erp_row_limit", recordNumber);
    cells = [];
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index++; }
        else { quoted = false; closed = true; }
      } else {
        cell += char;
        if (char === "\r") {
          if (text[index + 1] === "\n") { cell += "\n"; index++; }
        }
      }
    } else if (char === delimiter) finishCell();
    else if (char === "\r" || char === "\n") {
      finishRow();
      if (char === "\r" && text[index + 1] === "\n") index++;
      recordNumber++;
    } else if (closed) fail("factory_erp_csv_invalid", recordNumber);
    else if (char === '"') {
      if (cell !== "") fail("factory_erp_csv_invalid", recordNumber);
      quoted = true;
    } else cell += char;
    if (cell.length > MAX_CELL_CHARACTERS) fail("factory_erp_cell_limit", recordNumber);
  }
  if (quoted) fail("factory_erp_csv_invalid", recordNumber);
  if (cell !== "" || cells.length || closed) finishRow();
  return rows;
}

function csvDelimiter(text: string): "," | "\t" | ";" {
  const counts = new Map<"," | "\t" | ";", number>([[",", 0], ["\t", 0], [";", 0]]);
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index++;
      else quoted = !quoted;
    } else if (!quoted && (char === "\n" || char === "\r")) break;
    else if (!quoted && (char === "," || char === "\t" || char === ";"))
      counts.set(char, counts.get(char)! + 1);
  }
  const candidates = [...counts].filter(([, count]) => count === FACTORY_ERP_HEADERS.length - 1);
  if (candidates.length !== 1) fail("factory_erp_headers_invalid", 1);
  return candidates[0][0];
}

function zipExtra(body: Buffer, offset: number, length: number): void {
  const end = offset + length;
  while (offset < end) {
    if (offset + 4 > end) fail("factory_erp_zip_invalid");
    const id = body.readUInt16LE(offset), size = body.readUInt16LE(offset + 2);
    if (offset + 4 + size > end) fail("factory_erp_zip_invalid");
    // A Unicode-path override must not change the central directory identity.
    if (id === 0x0001 || id === 0x7075) fail("factory_erp_zip_unsupported");
    offset += 4 + size;
  }
}

function zipName(bytes: Uint8Array): string {
  if (bytes.some(byte => byte > 0x7f)) fail("factory_erp_zip_path_invalid");
  const name = Buffer.from(bytes).toString("ascii");
  if (name.length > 240 || !/^[\x21-\x7e]+$/.test(name) || /[\\:%?#]/.test(name) ||
      name.startsWith("/") || name.split("/").some((part, i, all) =>
        part === "." || part === ".." || part === "" && i !== all.length - 1))
    fail("factory_erp_zip_path_invalid");
  return name;
}

/** Inspect the public ZIP records before JSZip allocates any inflated content. */
function preflightZip(body: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let offset = body.length - 22; offset >= Math.max(0, body.length - 65_557); offset--) {
    if (body.readUInt32LE(offset) === 0x06054b50 &&
        offset + 22 + body.readUInt16LE(offset + 20) === body.length) { eocd = offset; break; }
  }
  if (eocd < 0) fail("factory_erp_zip_invalid");
  const entries = body.readUInt16LE(eocd + 10), centralSize = body.readUInt32LE(eocd + 12),
    centralOffset = body.readUInt32LE(eocd + 16);
  if (body.readUInt16LE(eocd + 4) !== 0 || body.readUInt16LE(eocd + 6) !== 0 ||
      body.readUInt16LE(eocd + 8) !== entries || entries === 0xffff ||
      centralSize === 0xffffffff || centralOffset === 0xffffffff ||
      eocd >= 20 && body.readUInt32LE(eocd - 20) === 0x07064b50)
    fail("factory_erp_zip_unsupported");
  if (!entries || entries > MAX_ZIP_ENTRIES || centralOffset + centralSize !== eocd)
    fail("factory_erp_zip_limit");
  const result: ZipEntry[] = [], names = new Set<string>();
  let offset = centralOffset, expanded = 0;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > eocd || body.readUInt32LE(offset) !== 0x02014b50)
      fail("factory_erp_zip_invalid");
    const flags = body.readUInt16LE(offset + 8), method = body.readUInt16LE(offset + 10),
      crc = body.readUInt32LE(offset + 16), compressedSize = body.readUInt32LE(offset + 20),
      expandedSize = body.readUInt32LE(offset + 24), nameLength = body.readUInt16LE(offset + 28),
      extraLength = body.readUInt16LE(offset + 30), commentLength = body.readUInt16LE(offset + 32),
      start = body.readUInt32LE(offset + 42), attributes = body.readUInt32LE(offset + 38);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > eocd || !nameLength) fail("factory_erp_zip_invalid");
    if (flags & ~0x080e || ![0, 8].includes(method) || body.readUInt16LE(offset + 34) !== 0 ||
        [compressedSize, expandedSize, start].includes(0xffffffff) ||
        (attributes >>> 16 & 0xf000) === 0xa000)
      fail("factory_erp_zip_unsupported");
    const nameBytes = body.subarray(offset + 46, offset + 46 + nameLength), name = zipName(nameBytes);
    if (names.has(name.toLowerCase())) fail("factory_erp_zip_duplicate_entry");
    names.add(name.toLowerCase());
    zipExtra(body, offset + 46 + nameLength, extraLength);
    const directory = name.endsWith("/");
    expanded += expandedSize;
    if (compressedSize > body.length || expandedSize > MAX_EXPANDED_BYTES ||
        expanded > MAX_EXPANDED_BYTES || expandedSize > Math.max(1, compressedSize) * MAX_COMPRESSION_RATIO ||
        /\.(?:xml|rels)$/i.test(name) && expandedSize > MAX_XML_BYTES)
      fail("factory_erp_zip_limit");
    if (directory && (expandedSize !== 0 || compressedSize !== 0) || method === 0 && compressedSize !== expandedSize)
      fail("factory_erp_zip_invalid");
    if (start + 30 > centralOffset || body.readUInt32LE(start) !== 0x04034b50 ||
        body.readUInt16LE(start + 6) !== flags || body.readUInt16LE(start + 8) !== method)
      fail("factory_erp_zip_invalid");
    const localNameLength = body.readUInt16LE(start + 26), localExtraLength = body.readUInt16LE(start + 28),
      dataStart = start + 30 + localNameLength + localExtraLength;
    if (dataStart > centralOffset || localNameLength !== nameLength ||
        !body.subarray(start + 30, start + 30 + localNameLength).equals(nameBytes))
      fail("factory_erp_zip_invalid");
    zipExtra(body, start + 30 + localNameLength, localExtraLength);
    const localValues = [body.readUInt32LE(start + 14), body.readUInt32LE(start + 18), body.readUInt32LE(start + 22)],
      centralValues = [crc, compressedSize, expandedSize];
    if (localValues.some((value, i) => value !== centralValues[i] && (!(flags & 8) || value !== 0)))
      fail("factory_erp_zip_invalid");
    let end = dataStart + compressedSize;
    if (end > centralOffset) fail("factory_erp_zip_invalid");
    if (flags & 8) {
      if (end + 4 <= centralOffset && body.readUInt32LE(end) === 0x08074b50) end += 4;
      if (end + 12 > centralOffset || centralValues.some((value, i) => body.readUInt32LE(end + i * 4) !== value))
        fail("factory_erp_zip_invalid");
      end += 12;
    }
    if (/(?:^|\/)(?:vbaproject\.bin|vbadata\.xml)(?:$|\/)|^xl\/(?:externallinks|macrosheets|dialogsheets|activex|embeddings)\//i.test(name))
      fail("factory_erp_xlsx_active_content");
    result.push({ name, directory, compressedSize, expandedSize, crc, start, end });
    offset = next;
  }
  if (offset !== eocd) fail("factory_erp_zip_invalid");
  let previousEnd = 0;
  for (const entry of [...result].sort((a, b) => a.start - b.start)) {
    if (entry.start !== previousEnd) fail("factory_erp_zip_invalid");
    previousEnd = entry.end;
  }
  if (previousEnd !== centralOffset) fail("factory_erp_zip_invalid");
  return result;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});

async function boundedEntry(file: JSZip.JSZipObject, entry: ZipEntry): Promise<Buffer> {
  // JSZip's public Node stream uses readable-stream and is not necessarily an
  // async iterable. Its event API still permits a strict bound before buffering.
  const stream = file.nodeStream("nodebuffer") as NodeJS.ReadableStream & { destroy(): void };
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0, crc = 0xffffffff, settled = false;
    const stop = (code: string) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      stream.pause();
      stream.destroy();
      reject(new FactoryErpExportParseError(code));
    };
    stream.on("data", (part: unknown) => {
      if (settled) return;
      if (!Buffer.isBuffer(part)) { stop("factory_erp_zip_invalid"); return; }
      length += part.length;
      if (length > entry.expandedSize || length > MAX_EXPANDED_BYTES) {
        stop("factory_erp_zip_limit"); return;
      }
      for (const byte of part) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
      chunks.push(part);
    });
    stream.on("error", () => stop("factory_erp_zip_invalid"));
    stream.on("end", () => {
      if (settled) return;
      if (length !== entry.expandedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) {
        stop("factory_erp_zip_invalid"); return;
      }
      settled = true;
      resolve(Buffer.concat(chunks, length));
    });
  });
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("factory_erp_xml_invalid");
  return value as Record<string, unknown>;
}

function xmlCharacters(value: string): string {
  return value.replace(/&([^;]*);|&/g, (reference, entity: string | undefined) => {
    const standard: Record<string, string> = { amp: "&", lt: "<", gt: ">", apos: "'", quot: '"' };
    if (entity && Object.hasOwn(standard, entity)) return standard[entity];
    if (!entity || !/^#(?:[0-9]{1,8}|x[0-9a-fA-F]{1,6})$/.test(entity))
      return fail("factory_erp_xml_invalid");
    const code = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!(code === 9 || code === 10 || code === 13 || code >= 32 && code <= 0xd7ff ||
        code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff))
      return fail("factory_erp_xml_invalid");
    return String.fromCodePoint(code);
  });
}

function localName(name: string): string { return name.slice(name.lastIndexOf(":") + 1); }

function parseXml(bytes: Buffer, budget: { nodes: number; tags: number }): XmlElement {
  const xml = utf8(bytes, "factory_erp_xml_invalid");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) ||
      /<\?xml\b[^?]*encoding\s*=\s*["'](?!utf-?8["'])/i.test(xml))
    fail("factory_erp_xml_unsupported");
  for (let offset = xml.indexOf("<"); offset !== -1; offset = xml.indexOf("<", offset + 1)) {
    if (++budget.tags > MAX_XML_NODES * 2) fail("factory_erp_xml_limit");
  }
  try {
    if (XMLValidator.validate(xml, { allowBooleanAttributes: false }) !== true)
      fail("factory_erp_xml_invalid");
    const parsed: unknown = new XMLParser({
      preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "",
      parseTagValue: false, parseAttributeValue: false, trimValues: false,
      processEntities: false, ignoreDeclaration: true, ignorePiTags: true,
      cdataPropName: "#cdata", maxNestedTags: MAX_XML_DEPTH,
    }).parse(xml);
    const elements = (value: unknown, depth: number): { children: XmlElement[]; text: string } => {
      if (!Array.isArray(value) || depth > MAX_XML_DEPTH) fail("factory_erp_xml_limit");
      const children: XmlElement[] = [], texts: string[] = [];
      for (const entry of value) {
        if (++budget.nodes > MAX_XML_NODES) fail("factory_erp_xml_limit");
        const record = object(entry), names = Object.keys(record).filter(key => key !== ":@");
        if (names.length !== 1) fail("factory_erp_xml_invalid");
        const name = names[0];
        if (name === "#text") {
          if (typeof record[name] !== "string") fail("factory_erp_xml_invalid");
          texts.push(xmlCharacters(record[name]));
        } else if (name === "#cdata") {
          if (!Array.isArray(record[name])) fail("factory_erp_xml_invalid");
          for (const child of record[name]) {
            const text = object(child)["#text"];
            if (typeof text !== "string") fail("factory_erp_xml_invalid");
            texts.push(text);
          }
        } else {
          if (localName(name) === "f") fail("factory_erp_xlsx_formula");
          const attributes: Record<string, string> = Object.create(null);
          if (record[":@"] !== undefined) {
            for (const [key, attribute] of Object.entries(object(record[":@"]))) {
              if (typeof attribute !== "string") fail("factory_erp_xml_invalid");
              attributes[key] = xmlCharacters(attribute);
            }
          }
          const content = elements(record[name], depth + 1);
          children.push({ name: localName(name), attributes, ...content });
        }
      }
      return { children, text: texts.join("") };
    };
    const root = elements(parsed, 0);
    if (root.children.length !== 1 || root.text.trim() !== "") fail("factory_erp_xml_invalid");
    return root.children[0];
  } catch (error) {
    if (error instanceof FactoryErpExportParseError) throw error;
    return fail("factory_erp_xml_invalid");
  }
}

function children(node: XmlElement, name: string): XmlElement[] {
  return node.children.filter(child => child.name === name);
}

function one(node: XmlElement, name: string, required = true): XmlElement | undefined {
  const found = children(node, name);
  if (found.length > 1 || required && found.length !== 1) fail("factory_erp_xlsx_invalid");
  return found[0];
}

function attribute(node: XmlElement, name: string, required = true): string {
  const entries = Object.entries(node.attributes).filter(([key]) => localName(key) === name);
  if (entries.length > 1 || required && entries.length !== 1) fail("factory_erp_xlsx_invalid");
  return entries[0]?.[1] ?? "";
}

function partTarget(source: string, target: string): string {
  if (!target || /[\\:%?#]/.test(target) || Array.from(target).some(char => char.charCodeAt(0) <= 32))
    fail("factory_erp_xlsx_relationship_invalid");
  const path = target.startsWith("/") ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(posix.dirname(source), target));
  if (path.startsWith("../") || path === ".." || path.startsWith("/"))
    fail("factory_erp_xlsx_relationship_invalid");
  zipName(Buffer.from(path));
  return path;
}

function relationships(root: XmlElement, source: string): Map<string, { type: string; target: string }> {
  if (root.name !== "Relationships") fail("factory_erp_xlsx_relationship_invalid");
  const result = new Map<string, { type: string; target: string }>();
  for (const child of root.children) {
    if (child.name !== "Relationship" || attribute(child, "TargetMode", false) !== "" &&
        attribute(child, "TargetMode", false) !== "Internal")
      fail("factory_erp_xlsx_external_relationship");
    const id = attribute(child, "Id"), type = attribute(child, "Type");
    if (result.has(id)) fail("factory_erp_xlsx_relationship_invalid");
    if (/\/(?:externalLink|vbaProject|oleObject|attachedTemplate)$/i.test(type))
      fail("factory_erp_xlsx_active_content");
    result.set(id, { type, target: partTarget(source, attribute(child, "Target")) });
  }
  return result;
}

function excelString(value: string): string {
  return value.replace(/_x([0-9a-fA-F]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function richText(node: XmlElement): string {
  const direct = children(node, "t"), runs = children(node, "r");
  if (direct.length > 1 || direct.length && runs.length ||
      node.children.some(child => !["t", "r", "rPh", "phoneticPr"].includes(child.name)) ||
      direct.some(child => child.children.length !== 0) ||
      runs.some(run => run.children.some(child => !["rPr", "t"].includes(child.name)) ||
        children(run, "t").some(child => child.children.length !== 0)))
    fail("factory_erp_xlsx_invalid");
  const value = direct.length ? direct[0].text : runs.map(run => one(run, "t")!.text).join("");
  return checkedText(excelString(value));
}

function cellReference(value: string): { row: number; column: number } {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value);
  if (!match) fail("factory_erp_xlsx_dimension_invalid");
  let column = 0;
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column > MAX_COLUMNS || row > MAX_ROWS + 1) fail("factory_erp_xlsx_dimension_invalid");
  return { row, column };
}

/** Only decide whether a numeric identity is safe to use as stored. This is not
 * a display formatter and never restores a guessed zero prefix or rounded ID. */
function safeNumberFormats(styles?: XmlElement): boolean[] {
  if (!styles) return [true];
  if (styles.name !== "styleSheet") fail("factory_erp_xlsx_style_invalid");
  const formats = new Map<number, string>(), custom = one(styles, "numFmts", false);
  if ((custom?.children.length ?? 0) > 1024) fail("factory_erp_xlsx_style_invalid");
  for (const format of custom?.children ?? []) {
    if (format.name !== "numFmt") fail("factory_erp_xlsx_style_invalid");
    const text = attribute(format, "numFmtId");
    if (!/^\d{1,6}$/.test(text) || formats.has(Number(text)))
      fail("factory_erp_xlsx_style_invalid");
    formats.set(Number(text), checkedText(attribute(format, "formatCode")));
  }
  const safe = (xf: XmlElement) => {
    const value = attribute(xf, "numFmtId", false) || "0";
    if (!/^\d{1,6}$/.test(value)) fail("factory_erp_xlsx_style_invalid");
    const id = Number(value);
    const format = formats.get(id);
    if (format !== undefined) return format === "General" || format === "0";
    if (id < 164) return id === 0 || id === 1;
    return fail("factory_erp_xlsx_style_invalid");
  };
  const base = one(styles, "cellStyleXfs", false)?.children ?? [];
  const cells = one(styles, "cellXfs", false)?.children ?? [];
  if (base.length > 1024 || cells.length > 1024 || [...base, ...cells].some(xf => xf.name !== "xf"))
    fail("factory_erp_xlsx_style_invalid");
  const baseSafety = base.map(safe);
  if (!cells.length) return [true];
  return cells.map(xf => {
    const ownSafe = safe(xf), baseId = attribute(xf, "xfId", false), apply = attribute(xf, "applyNumberFormat", false);
    if (apply && !["0", "1", "false", "true"].includes(apply)) fail("factory_erp_xlsx_style_invalid");
    if (!baseId) return ownSafe;
    if (!/^\d{1,6}$/.test(baseId) || Number(baseId) >= baseSafety.length)
      fail("factory_erp_xlsx_style_invalid");
    if (apply === "1" || apply === "true") return ownSafe;
    if (apply === "0" || apply === "false") return baseSafety[Number(baseId)];
    return ownSafe && baseSafety[Number(baseId)];
  });
}

function worksheetRows(sheet: XmlElement, sharedStrings: string[], numberFormats: boolean[]): SourceRow[] {
  if (sheet.name !== "worksheet") fail("factory_erp_xlsx_invalid");
  if (one(sheet, "mergeCells", false)) fail("factory_erp_xlsx_merged_cells");
  const dimension = one(sheet, "dimension", false);
  if (dimension) {
    const range = attribute(dimension, "ref").split(":");
    if (range.length > 2) fail("factory_erp_xlsx_dimension_invalid");
    const start = cellReference(range[0]), end = cellReference(range[1] ?? range[0]);
    if (start.row > end.row || start.column > end.column) fail("factory_erp_xlsx_dimension_invalid");
  }
  const data = one(sheet, "sheetData")!, result: SourceRow[] = [];
  let previousRow = 0;
  for (const row of data.children) {
    if (row.name !== "row") fail("factory_erp_xlsx_invalid");
    const rowText = attribute(row, "r");
    if (!/^[1-9]\d{0,6}$/.test(rowText)) fail("factory_erp_xlsx_dimension_invalid");
    const rowNumber = Number(rowText);
    if (rowNumber <= previousRow || rowNumber > MAX_ROWS + 1) fail("factory_erp_xlsx_dimension_invalid");
    previousRow = rowNumber;
    const cells: string[] = [], numericColumns = new Set<number>(), numberFormatReviewColumns = new Set<number>();
    let previousColumn = 0;
    for (const cell of row.children) {
      if (cell.name !== "c") fail("factory_erp_xlsx_invalid");
      const reference = cellReference(attribute(cell, "r"));
      if (reference.row !== rowNumber || reference.column <= previousColumn)
        fail("factory_erp_xlsx_dimension_invalid");
      previousColumn = reference.column;
      const type = attribute(cell, "t", false), stored = one(cell, "v", false), inline = one(cell, "is", false);
      if (stored?.children.length) fail("factory_erp_xlsx_invalid");
      const style = attribute(cell, "s", false) || "0";
      if (!/^\d{1,6}$/.test(style) || Number(style) >= numberFormats.length)
        fail("factory_erp_xlsx_style_invalid");
      let value = "";
      if (type === "inlineStr") {
        if (!inline || stored) fail("factory_erp_xlsx_invalid");
        value = richText(inline);
      } else if (inline) fail("factory_erp_xlsx_invalid");
      else if (type === "s") {
        if (!stored || !/^\d{1,6}$/.test(stored.text) || Number(stored.text) >= sharedStrings.length)
          fail("factory_erp_xlsx_shared_string_invalid");
        value = sharedStrings[Number(stored.text)];
      } else if (type === "str") value = excelString(stored?.text ?? "");
      else if (type === "" || type === "n") {
        value = stored?.text ?? "";
        numericColumns.add(reference.column - 1);
        if (value !== "" && !numberFormats[Number(style)]) numberFormatReviewColumns.add(reference.column - 1);
      } else fail("factory_erp_xlsx_cell_type_invalid", rowNumber);
      if (reference.column > FACTORY_ERP_HEADERS.length && value !== "")
        fail("factory_erp_column_count_invalid", rowNumber);
      if (reference.column <= FACTORY_ERP_HEADERS.length) {
        while (cells.length < reference.column - 1) cells.push("");
        cells[reference.column - 1] = checkedText(value, rowNumber);
      }
    }
    if (cells.some(value => value !== "")) {
      while (cells.length < FACTORY_ERP_HEADERS.length) cells.push("");
      result.push({ rowNumber, cells, numericColumns, numberFormatReviewColumns });
    }
  }
  return result;
}

async function xlsxRows(body: Buffer, sheetName?: string): Promise<{ sheetName: string; rows: SourceRow[] }> {
  const entries = preflightZip(body);
  let zip: JSZip;
  try {
    // JSZip also applies this callback to comments, including empty comments.
    // Paths themselves were checked above and are compared again after loading.
    zip = await JSZip.loadAsync(body, { createFolders: false, decodeFileName: bytes => utf8(Uint8Array.from(bytes as ArrayLike<number>), "factory_erp_zip_invalid") });
  } catch (error) {
    if (error instanceof FactoryErpExportParseError) throw error;
    return fail("factory_erp_zip_invalid");
  }
  if (Object.keys(zip.files).length !== entries.length) fail("factory_erp_zip_invalid");
  const xml = new Map<string, XmlElement>(), budget = { nodes: 0, tags: 0 };
  for (const entry of entries) {
    const file = zip.files[entry.name];
    if (!file || file.name !== entry.name || file.dir !== entry.directory ||
        file.unsafeOriginalName !== undefined && file.unsafeOriginalName !== entry.name)
      fail("factory_erp_zip_invalid");
    if (entry.directory) continue;
    const bytes = await boundedEntry(file, entry);
    if (/\.(?:xml|rels)$/i.test(entry.name)) {
      const root = parseXml(bytes, budget);
      if (entry.name.endsWith(".rels")) {
        const source = entry.name === "_rels/.rels" ? "" : entry.name.replace(/(^|\/)_rels\/([^/]+)\.rels$/, "$1$2");
        relationships(root, source);
      }
      xml.set(entry.name, root);
    }
  }
  const get = (name: string): XmlElement => xml.get(name) ?? fail("factory_erp_xlsx_part_missing");
  const types = get("[Content_Types].xml");
  if (types.name !== "Types") fail("factory_erp_xlsx_invalid");
  const defaults = new Map<string, string>(), overrides = new Map<string, string>(), overrideNames = new Set<string>();
  const actualParts = new Set(entries.filter(entry => !entry.directory).map(entry => entry.name));
  for (const child of types.children) {
    const contentType = attribute(child, "ContentType");
    if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(contentType))
      fail("factory_erp_xlsx_content_types_invalid");
    if (child.name === "Default") {
      const extension = attribute(child, "Extension");
      if (!/^[A-Za-z0-9]+$/.test(extension) || defaults.has(extension.toLowerCase()))
        fail("factory_erp_xlsx_content_types_invalid");
      defaults.set(extension.toLowerCase(), contentType);
    } else if (child.name === "Override") {
      const raw = attribute(child, "PartName");
      if (!raw.startsWith("/")) fail("factory_erp_xlsx_content_types_invalid");
      const path = partTarget("", raw);
      if (raw !== `/${path}` || overrideNames.has(path.toLowerCase()) ||
          !actualParts.has(path) || path === "[Content_Types].xml")
        fail("factory_erp_xlsx_content_types_invalid");
      overrides.set(path, contentType);
      overrideNames.add(path.toLowerCase());
    } else fail("factory_erp_xlsx_content_types_invalid");
  }
  // Templates may advertise an unused binary/macro Default. Only the effective
  // content type of a real part can make this package contain active content.
  for (const name of actualParts) {
    if (name === "[Content_Types].xml") continue;
    const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    const effectiveType = overrides.get(name) ?? defaults.get(extension);
    if (!effectiveType) fail("factory_erp_xlsx_content_types_invalid");
    if (/macroEnabled|vbaProject|externalLink|oleObject|activeX/i.test(effectiveType))
      fail("factory_erp_xlsx_active_content");
    if (name === "xl/workbook.xml" && effectiveType !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml")
      fail("factory_erp_xlsx_content_types_invalid");
  }
  const roots = relationships(get("_rels/.rels"), "");
  const office = [...roots.values()].filter(relation => relation.type.endsWith("/officeDocument"));
  if (office.length !== 1 || office[0].target !== "xl/workbook.xml") fail("factory_erp_xlsx_invalid");
  const workbook = get("xl/workbook.xml");
  if (workbook.name !== "workbook") fail("factory_erp_xlsx_invalid");
  const relations = relationships(get("xl/_rels/workbook.xml.rels"), "xl/workbook.xml");
  const sheets = one(workbook, "sheets")!.children;
  if (!sheets.length || sheets.length > 32 || sheets.some(sheet => sheet.name !== "sheet"))
    fail("factory_erp_xlsx_sheet_invalid");
  const names = sheets.map(sheet => attribute(sheet, "name"));
  if (names.some(name => !name || name.length > 100) || new Set(names).size !== names.length)
    fail("factory_erp_xlsx_sheet_invalid");
  const candidates = sheetName === undefined ? sheets.filter(sheet => !attribute(sheet, "state", false) || attribute(sheet, "state", false) === "visible") : sheets.filter(sheet => attribute(sheet, "name") === sheetName);
  if (candidates.length !== 1) fail(sheetName === undefined ? "factory_erp_sheet_selection_required" : "factory_erp_sheet_not_found");
  const selected = candidates[0], relation = relations.get(attribute(selected, "id"));
  if (!relation || !relation.type.endsWith("/worksheet")) fail("factory_erp_xlsx_sheet_invalid");
  const stringsRelations = [...relations.values()].filter(candidate => candidate.type.endsWith("/sharedStrings"));
  if (stringsRelations.length > 1) fail("factory_erp_xlsx_shared_string_invalid");
  const sharedStrings: string[] = [];
  if (stringsRelations.length) {
    const strings = get(stringsRelations[0].target);
    if (strings.name !== "sst" || strings.children.length > 100_000)
      fail("factory_erp_xlsx_shared_string_invalid");
    for (const child of strings.children) {
      if (child.name !== "si") fail("factory_erp_xlsx_shared_string_invalid");
      sharedStrings.push(richText(child));
    }
  }
  const styleRelations = [...relations.values()].filter(candidate => candidate.type.endsWith("/styles"));
  if (styleRelations.length > 1) fail("factory_erp_xlsx_style_invalid");
  const styles = styleRelations.length ? get(styleRelations[0].target) : xml.get("xl/styles.xml");
  return { sheetName: attribute(selected, "name"), rows: worksheetRows(get(relation.target), sharedStrings, safeNumberFormats(styles)) };
}

export async function parseFactoryErpExport(
  fileName: string,
  body: Uint8Array,
  rawOptions: FactoryErpOptions = {},
): Promise<FactoryErpParsed> {
  if (!body.byteLength || body.byteLength > FACTORY_ERP_MAX_BYTES) fail("factory_erp_file_limit");
  if (fileName.length > 200 || Array.from(fileName).some(char => char.charCodeAt(0) < 32) ||
      !/^[^\\/]+\.(?:xlsx|csv)$/i.test(fileName)) fail("factory_erp_file_type_invalid");
  const validated = FactoryErpOptionsSchema.safeParse(rawOptions);
  if (!validated.success) fail("factory_erp_options_invalid");
  const options = validated.data, bytes = Buffer.from(body);
  if (/\.xlsx$/i.test(fileName)) {
    if (options.csvEncoding !== undefined || options.delimiter !== undefined) fail("factory_erp_options_invalid");
    const worksheet = await xlsxRows(bytes, options.sheetName);
    return { format: "xlsx", sheetName: worksheet.sheetName, ...materializeRows(worksheet.rows), coverage: "current_page_or_unspecified" };
  }
  if (options.sheetName !== undefined) fail("factory_erp_options_invalid");
  let text: string;
  try {
    text = new TextDecoder(options.csvEncoding ?? "utf-8", { fatal: true, ignoreBOM: true })
      .decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return fail("factory_erp_encoding_invalid");
  }
  return { format: "csv", sheetName: null, ...materializeRows(csvRows(text, options.delimiter ?? csvDelimiter(text))), coverage: "current_page_or_unspecified" };
}
