import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";
import { createDocumentWorkbook, documentTemplates } from "./document-workbook.js";

describe("supplier workbook templates", () => {
  it("bundles no sample order rows in any of the three templates", async () => {
    for (const template of Object.values(documentTemplates)) {
      const book=new ExcelJS.Workbook();
      await book.xlsx.load(Uint8Array.from(await readFile(new URL(`./templates/${template.file}`,import.meta.url))).buffer);
      const sheet=book.getWorksheet(template.sheet)!;
      for (let row=template.headerRow+1;row<=sheet.rowCount;row++)
        expect(sheet.getRow(row).actualCellCount).toBe(0);
    }
  });
  it("preserves literal strings and leading zeros while numbers use General", async () => {
    const bytes=await createDocumentWorkbook("printeque_shipping",[{"订单号":"111-0000000-0000000","目的国家":"US",
      "收件人姓名":"=Synthetic literal","收件人邮编":"00123","收件人电话":"0012345","商品SKU":"@literal-sku",
      "长":12,"宽":5,"高":5,"申报单价":8,"包裹重量":0.31,"数量":1}],new Date("2026-11-04T00:00:00Z"));
    const book=new ExcelJS.Workbook();await book.xlsx.load(Uint8Array.from(bytes).buffer);
    const sheet=book.getWorksheet("Sheet1")!;
    const headers=new Map<string,number>();sheet.getRow(2).eachCell((cell,index)=>headers.set(cell.text,index));
    for (const name of ["长","宽","高","申报单价","包裹重量","数量"]) {
      const cell=sheet.getRow(3).getCell(headers.get(name)!);expect(typeof cell.value).toBe("number");expect(cell.numFmt??"General").toBe("General");
    }
    for (const [name,value] of [["收件人姓名","=Synthetic literal"],["收件人邮编","00123"],["商品SKU","@literal-sku"]]) {
      const cell=sheet.getRow(3).getCell(headers.get(name!)!);expect(cell.value).toBe(value);expect(cell.formula).toBeUndefined();
    }
    expect(sheet.actualRowCount).toBe(3);
  });
  it("exports only the first YunExpress declaration group and keeps requested fields blank", async () => {
    const bytes=await createDocumentWorkbook("yunexpress",[{"客户订单号":"111-0000000-0000000","产品代码":"THPHR",
      "申报品名1":"Custom pillow","申报数量1":2,"申报FOB价1":8,"申报单重1":0.141}],new Date("2026-11-04T00:00:00Z"));
    const book=new ExcelJS.Workbook();await book.xlsx.load(Uint8Array.from(bytes).buffer);
    const sheet=book.getWorksheet("标准模板")!;
    sheet.getRow(1).eachCell((cell,column)=>{
      if (["SKU1","配货信息1","规格1","申报品名2","申报数量2","申报FOB价2","申报单重2","配货信息2","规格2"].includes(cell.text))
        expect(sheet.getRow(2).getCell(column).value).toBeNull();
    });
    expect(sheet.actualRowCount).toBe(2);
  });
});
