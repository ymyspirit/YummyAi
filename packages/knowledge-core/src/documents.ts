import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import type { KnowledgeFields } from "@yummyai/contracts/knowledge";

export const knowledgeChecksum = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export const knowledgeDay = (at = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(at);
const MAX_TEXT = 200_000;
export async function parseKnowledgeDocument(
  bytes: Uint8Array,
  name: string,
): Promise<{ text: string; mediaType: string; diagnostics: string[] }> {
  if (!bytes.length || bytes.length > 5 * 1024 * 1024)
    throw new Error("资料必须介于 1 字节和 5 MB 之间");
  const suffix = name.toLowerCase().split(".").pop();
  let text = "",
    mediaType = "text/plain";
  if (["md", "txt", "csv"].includes(suffix ?? "")) {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    mediaType = suffix === "csv" ? "text/csv" : suffix === "md" ? "text/markdown" : "text/plain";
  } else if (suffix === "docx") {
    mediaType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    checkDocxArchive(bytes);
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const document = zip.file("word/document.xml");
    if (!document) throw new Error("Word 文件缺少正文，或不是 DOCX 格式");
    const xml = await document.async("string");
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("不接受包含外部实体的 Word 文件");
    const data = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      processEntities: true,
    }).parse(xml) as unknown;
    const paragraphs: string[] = [];
    function content(value: unknown): string {
      if (Array.isArray(value)) return value.map(content).join("");
      if (!value || typeof value !== "object") return "";
      const obj = value as Record<string, unknown>;
      return Object.entries(obj)
        .map(([key, child]) =>
          key === "#text"
            ? String(child)
            : key === "w:tab"
              ? "\t"
              : key === "w:br"
                ? "\n"
                : content(child),
        )
        .join("");
    }
    function walk(value: unknown) {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "w:p") paragraphs.push(content(child));
        else walk(child);
      }
    }
    walk(data);
    text = paragraphs.join("\n\n");
  } else if (suffix === "pdf") {
    mediaType = "application/pdf";
    if (!Buffer.from(bytes.subarray(0, 8)).toString().startsWith("%PDF-"))
      throw new Error("PDF 文件标识无效");
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const fontDirectory =
      join(
        dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")),
        "standard_fonts",
      ).replaceAll("\\", "/") + "/";
    const task = getDocument({
      data: Uint8Array.from(bytes),
      standardFontDataUrl: fontDirectory,
      useWorkerFetch: false,
      disableFontFace: true,
      isOffscreenCanvasSupported: false,
    });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 80) throw new Error("PDF 最多 80 页，请拆分资料");
      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber),
          data = await page.getTextContent();
        const body = data.items
          .map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : ""))
          .join("")
          .trim();
        pages.push(`## 第 ${pageNumber} 页\n\n${body}`);
        if (pages.join("\n").length > MAX_TEXT)
          throw new Error("解析正文超过 20 万字符，请拆分资料");
        page.cleanup();
      }
      if (!pages.some((p) => p.replace(/^## 第 \d+ 页\s*/, "").trim()))
        throw new Error("PDF 未找到可提取文字；扫描件需要先进行 OCR，本次没有生成知识卡");
      text = pages.join("\n\n");
    } finally {
      await task.destroy();
    }
  } else throw new Error("支持 UTF-8 TXT、Markdown、CSV、文字 PDF 和 DOCX；旧版 DOC 请先转换");
  if (!text.trim()) throw new Error("资料没有可提取正文");
  if (text.length > MAX_TEXT) throw new Error("解析正文超过 20 万字符，请拆分资料");
  return {
    text: text.replace(/\r\n?/g, "\n").trim(),
    mediaType,
    diagnostics: ["按原文段落生成候选卡，未经语义判断；需人工整理、确认与审核。"],
  };
}
function checkDocxArchive(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--)
    if (b.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0 || b.readUInt16LE(end + 4) || b.readUInt16LE(end + 6))
    throw new Error("Word ZIP 容器无效");
  const entries = b.readUInt16LE(end + 10),
    size = b.readUInt32LE(end + 12),
    start = b.readUInt32LE(end + 16);
  if (entries > 1000 || start + size > end) throw new Error("Word ZIP 容器超过限制");
  let offset = start,
    inflated = 0;
  for (let i = 0; i < entries; i++) {
    if (
      offset + 46 > end ||
      b.readUInt32LE(offset) !== 0x02014b50 ||
      b.readUInt16LE(offset + 8) & 1
    )
      throw new Error("不接受加密或损坏的 Word 容器");
    const compressed = b.readUInt32LE(offset + 20),
      plain = b.readUInt32LE(offset + 24);
    inflated += plain;
    if (plain > 4_000_000 || inflated > 16_000_000 || plain > Math.max(1, compressed) * 200)
      throw new Error("Word 解压大小超过限制");
    offset +=
      46 + b.readUInt16LE(offset + 28) + b.readUInt16LE(offset + 30) + b.readUInt16LE(offset + 32);
  }
}
export function redactKnowledgeText(text: string): { text: string; findings: string[] } {
  const findings = new Set<string>();
  let value = text;
  const rules: Array<[RegExp, string]> = [
    [
      /(?:authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret|cookie|凭证|令牌|密码)["']?\s*[=:：]\s*[^\n,;]+/gi,
      "凭证或访问密钥",
    ],
    [
      /\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      "访问密钥或 JWT",
    ],
    [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "邮箱"],
    [
      /(?:customer[-_ ]?name|recipient|buyer[-_ ]?name|shipping[-_ ]?address|billing[-_ ]?address|phone|姓名|收件人|地址|电话|手机号)\s*[=:：]\s*[^\n;]+/gi,
      "顾客身份、地址或联系方式",
    ],
    [/(?<![\w.])\+?\d[\d ()-]{8,}\d(?![\w.])/g, "可能的电话号码或个人编号"],
  ];
  for (const [pattern, label] of rules)
    value = value.replace(pattern, (match: string) => {
      if (
        label === "可能的电话号码或个人编号" &&
        (/^\d{4}-\d{2}-\d{2}$/.test(match.trim()) || match.replace(/\D/g, "").length < 10)
      )
        return match;
      findings.add(label);
      return `[已脱敏：${label}]`;
    });
  // Report CSV is processed by column, including quoted and multiline cells.
  if (value.includes(",") && value.includes("\n")) {
    const rows = readCsv(value);
    const blocked =
      rows[0]
        ?.map((header, index) =>
          /customer|buyer|recipient|address|phone|email|api[-_ ]?key|authorization|credential|signature|token|cookie|password|secret|姓名|地址|电话|邮箱|凭证/i.test(
            header,
          )
            ? index
            : -1,
        )
        .filter((i) => i >= 0) ?? [];
    if (blocked.length) {
      findings.add("报告中的身份或凭证列");
      value = rows
        .map((row, i) =>
          row.map((cell, n) => csvCell(i && blocked.includes(n) ? "[已脱敏]" : cell)).join(","),
        )
        .join("\n");
    }
  }
  return { text: value, findings: [...findings] };
}
function readCsv(value: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === '"') {
      if (quoted && value[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (c === "," || c === "\n")) {
      row.push(cell);
      cell = "";
      if (c === "\n") {
        rows.push(row);
        row = [];
      }
    } else cell += c;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}
const csvCell = (s: string) => (/[,\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
export function knowledgeCandidatesFromText(text: string, fields: KnowledgeFields) {
  const result: Array<{ fields: KnowledgeFields; locator: string; excerpt: string }> = [];
  const lines = text.split("\n");
  let start = 0,
    body = "",
    heading = fields.title;
  function flush(end: number) {
    if (!body.trim()) return;
    result.push({
      fields: {
        ...fields,
        title: heading.slice(0, 180),
        body: body.trim(),
        summary: body.trim().slice(0, 240),
      },
      locator: `第 ${start + 1}–${end + 1} 行`,
      excerpt: body.trim().slice(0, 1000),
    });
    body = "";
  }
  for (const [i, line] of lines.entries()) {
    const h = /^#{1,6}\s+(.+)/.exec(line);
    if (h || body.length + line.length > 20_000) {
      flush(i - 1);
      start = i;
      if (h) heading = h[1]!;
    }
    if (line.length > 20_000) {
      flush(i - 1);
      for (let p = 0; p < line.length; p += 20_000) {
        start = i;
        body = line.slice(p, p + 20_000);
        flush(i);
      }
    } else body += `${line}\n`;
  }
  flush(lines.length - 1);
  if (result.length > 50) throw new Error("候选卡超过 50 张，请拆分资料后重试");
  return result;
}
