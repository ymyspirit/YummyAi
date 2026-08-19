import type { OrderPersonalizationCandidate } from "@yummyai/contracts/pod/order-personalization";

const maxBytes = 256 * 1024;
const maxRows = 100;
type ImportColumn = "externalOrderId" | "externalLineId" | "sizeLabel";

const allowedHeaders: ReadonlyMap<string, ImportColumn> = new Map([
  ["external_order_id", "externalOrderId"],
  ["order_id", "externalOrderId"],
  ["订单号", "externalOrderId"],
  ["external_line_id", "externalLineId"],
  ["line_id", "externalLineId"],
  ["订单行号", "externalLineId"],
  ["size_label", "sizeLabel"],
  ["size", "sizeLabel"],
  ["尺寸", "sizeLabel"],
] as const);

export type OrderPersonalizationTableImportDiagnosticCode =
  | "candidate_blocked"
  | "candidate_not_found"
  | "duplicate_order_line"
  | "invalid_row"
  | "size_required";

export type OrderPersonalizationTableImportDiagnostic = {
  code: OrderPersonalizationTableImportDiagnosticCode;
  row: number;
};

export type OrderPersonalizationTableImportResult = {
  diagnostics: OrderPersonalizationTableImportDiagnostic[];
  matchedValues: string[];
  rowCount: number;
  fileError?: string;
};

export function candidateSelectionValue(candidate: OrderPersonalizationCandidate) {
  if (!candidate.eligible || !candidate.customizationVersionId || !candidate.bindingId) return undefined;
  return [candidate.orderId, candidate.orderLineId, candidate.customizationVersionId, candidate.bindingId].join(":");
}

export function parseOrderPersonalizationCandidateCsv(
  source: string,
  candidates: OrderPersonalizationCandidate[],
): OrderPersonalizationTableImportResult {
  if (new TextEncoder().encode(source).byteLength > maxBytes) return fileFailure("CSV 文件不能超过 256 KB。");
  let table: string[][];
  try {
    table = parseCsv(source.replace(/^\uFEFF/, ""));
  } catch {
    return fileFailure("CSV 引号或换行格式无效。");
  }
  const nonEmpty = table.filter((row) => row.some((cell) => cell.trim()));
  if (nonEmpty.length < 2) return fileFailure("CSV 必须包含表头和至少一行数据。");
  const [header, ...rows] = nonEmpty;
  if (rows.length > maxRows) return fileFailure("一次最多导入 100 行。");

  const columns = new Map<ImportColumn, number>();
  for (const [index, cell] of header!.entries()) {
    const canonical = allowedHeaders.get(cell.trim().toLowerCase());
    if (!canonical) return fileFailure("CSV 只能包含订单号、订单行号和尺寸列。");
    if (columns.has(canonical)) return fileFailure("CSV 表头包含重复列。");
    columns.set(canonical, index);
  }
  if (!columns.has("externalOrderId") || !columns.has("externalLineId")) {
    return fileFailure("CSV 缺少 external_order_id 或 external_line_id 列。");
  }

  const diagnostics: OrderPersonalizationTableImportDiagnostic[] = [];
  const matchedValues: string[] = [];
  const selectedOrderLines = new Set<string>();
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    if (row.length > header.length) {
      diagnostics.push({ code: "invalid_row", row: rowNumber });
      return;
    }
    const externalOrderId = cell(row, columns.get("externalOrderId")!);
    const externalLineId = cell(row, columns.get("externalLineId")!);
    const sizeLabel = columns.has("sizeLabel") ? cell(row, columns.get("sizeLabel")!) : "";
    if (!validCell(externalOrderId, 240) || !validCell(externalLineId, 240) || !validCell(sizeLabel, 120, true)) {
      diagnostics.push({ code: "invalid_row", row: rowNumber });
      return;
    }

    const identifierMatches = candidates.filter((candidate) => (
      candidate.externalOrderId === externalOrderId
      && candidate.externalLineId === externalLineId
      && (!sizeLabel || candidate.sizeLabel === sizeLabel)
    ));
    if (!identifierMatches.length) {
      diagnostics.push({ code: "candidate_not_found", row: rowNumber });
      return;
    }
    const eligible = identifierMatches.filter((candidate) => candidate.eligible);
    if (!eligible.length) {
      diagnostics.push({ code: "candidate_blocked", row: rowNumber });
      return;
    }
    if (eligible.length > 1) {
      diagnostics.push({ code: "size_required", row: rowNumber });
      return;
    }
    const candidate = eligible[0]!;
    const value = candidateSelectionValue(candidate);
    if (!value) {
      diagnostics.push({ code: "candidate_blocked", row: rowNumber });
      return;
    }
    if (selectedOrderLines.has(candidate.orderLineId)) {
      diagnostics.push({ code: "duplicate_order_line", row: rowNumber });
      return;
    }
    selectedOrderLines.add(candidate.orderLineId);
    matchedValues.push(value);
  });
  return { diagnostics, matchedValues, rowCount: rows.length };
}

function fileFailure(fileError: string): OrderPersonalizationTableImportResult {
  return { diagnostics: [], matchedValues: [], rowCount: 0, fileError };
}

function cell(row: string[], index: number) {
  return (row[index] ?? "").trim();
}

function validCell(value: string, length: number, optional = false) {
  if (!value) return optional;
  return value.length <= length && ![...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function parseCsv(source: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        closedQuote = true;
      } else {
        field += character;
      }
      continue;
    }
    if (closedQuote && character !== "," && character !== "\n" && character !== "\r") {
      throw new Error("Unexpected character after quote");
    }
    if (character === '"') {
      if (field) throw new Error("Unexpected quote");
      quoted = true;
      closedQuote = false;
    } else if (character === ",") {
      row.push(field);
      field = "";
      closedQuote = false;
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      closedQuote = false;
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("Unclosed quote");
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
