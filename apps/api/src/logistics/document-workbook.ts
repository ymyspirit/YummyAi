import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import type { DocumentAdapter, DocumentRow } from "@yummyai/contracts/logistics/documents";

export const documentTemplates = {
  printeque_shipping: { file:"printeque-shipping.xlsx", sheet:"Sheet1", headerRow:2, label:"Printeque快递打单" },
  printeque_factory: { file:"printeque-factory.xlsx", sheet:"orders", headerRow:1, label:"Printeque生产导单" },
  yunexpress: { file:"yunexpress-standard.xlsx", sheet:"标准模板", headerRow:1, label:"云途标准面单导入" },
} as const;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function documentTemplateChecksum(adapter: DocumentAdapter) {
  return sha(await readFile(new URL(`./templates/${documentTemplates[adapter].file}`,import.meta.url)));
}
/** Only bundled, sanitized templates are opened. Caller-supplied paths and macros are never read. */
export async function createDocumentWorkbook(adapter: DocumentAdapter, rows: DocumentRow[], createdAt: Date): Promise<Buffer> {
  if (!rows.length || rows.length > 10000) throw Error("导出行数须为 1 至 10000");
  const template = documentTemplates[adapter], book = new ExcelJS.Workbook();
  await book.xlsx.load(Uint8Array.from(await readFile(new URL(`./templates/${template.file}`,import.meta.url))).buffer);
  const sheet = book.getWorksheet(template.sheet);
  if (!sheet) throw Error("内置模板工作表缺失");
  const columns: string[] = [];
  sheet.getRow(template.headerRow).eachCell({includeEmpty:true},(cell,column) => { columns[column-1] = cell.text.trim(); });
  if (!columns.length || new Set(columns.filter(Boolean)).size !== columns.filter(Boolean).length) throw Error("模板表头无效或重复");
  for (const record of rows) for (const key of Object.keys(record)) {
    if (!columns.includes(key)) throw Error(`模板缺少字段 ${key}`);
  }
  const start = template.headerRow + 1;
  const styles = columns.map((_,index) => structuredClone(sheet.getRow(start).getCell(index+1).style));
  const height = sheet.getRow(start).height;
  if (sheet.rowCount >= start) sheet.spliceRows(start,sheet.rowCount-start+1);
  rows.forEach((record,index) => {
    const row = sheet.getRow(start+index); if (height) row.height=height;
    columns.forEach((header,column) => {
      const cell = row.getCell(column+1), value = record[header] ?? null;
      if (typeof value === "number" && !Number.isFinite(value)) throw Error("导出数值无效");
      cell.style = structuredClone(styles[column] ?? {});
      // A string is a literal XLSX string, including = + - @ and leading zeros.
      cell.value = value; cell.numFmt = typeof value === "number" ? "General" : "@";
    });
  });
  if (sheet.autoFilter) sheet.autoFilter={from:{row:template.headerRow,column:1},to:{row:start+rows.length-1,column:columns.length}};
  book.creator="YummyAI";book.lastModifiedBy="YummyAI";book.created=createdAt;book.modified=createdAt;
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  if (bytes.byteLength > 10*1024*1024) throw Error("导出文件超过 10 MiB 请缩小批次");
  return bytes;
}
