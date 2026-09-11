import { inflateRawSync } from "node:zlib";

import { XMLParser, XMLValidator } from "fast-xml-parser";
import sharp from "sharp";

export const AMAZON_CUSTOM_PARSER_REVISION = 2;

export type AmazonCustomField = {
  key: string; label: string; kind: "text" | "choice" | "image" | "unknown"; value: string; font?: string; color?: string;
};
export type AmazonCustomDocument = {
  schemaVersion: string;
  surfaces: Array<{ key: string; label: string; fields: AmazonCustomField[]; previewFileKey: string | null; buyerFileKeys: string[] }>;
  warnings: string[];
  raw: unknown;
};
export type AmazonCustomFile = {
  key: string; name: string; mediaType: string; body: Uint8Array; role: "preview" | "buyer_image" | "source";
  originalFileKey?: string; width?: number; height?: number;
};

const MIB = 1024 * 1024;
const ARCHIVE_LIMIT = 20 * MIB;
const ENTRY_LIMIT = 20 * MIB;
const TOTAL_LIMIT = 80 * MIB;
const TEXT_LIMIT = 5 * MIB;
const decoder = new TextDecoder("utf-8", { fatal: true });
type Entry = { name: string; body: Buffer };
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}
function text(value: unknown, depth = 0): string {
  if (depth > 8) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const object = record(value);
  return object ? text(object["#text"] ?? object.label ?? object.name ?? object.value ?? object.displayValue ?? object.optionValue ?? object.fontFamily ?? object.fontName ?? object.family ?? object.colorName ?? object.hex, depth + 1) : "";
}
function reject(reason: string): never { throw new Error(`定制 ZIP：${reason}`); }
function decode(bytes: Uint8Array): string {
  try { return decoder.decode(bytes); } catch { return reject("文件编码无效，需使用 UTF-8"); }
}

function checkPath(name: string): void {
  const parts = name.split("/");
  if (!name || name.length > 1_000 || [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || /[\\:]/.test(name) || name.startsWith("/") || parts.some((part, index) => part === "." || part === ".." || part === "" && index !== parts.length - 1)) reject("包含不安全的文件路径");
  if (name.split("/").some((part) => part.endsWith(".") || part.endsWith(" "))) reject("包含不明确的文件路径");
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let result = value;
  for (let bit = 0; bit < 8; bit++) result = result & 1 ? 0xedb88320 ^ (result >>> 1) : result >>> 1;
  return result >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function checkExtra(extra: Buffer): void {
  for (let offset = 0; offset < extra.length;) {
    if (offset + 4 > extra.length) reject("文件扩展头损坏");
    const id = extra.readUInt16LE(offset), length = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + length > extra.length) reject("文件扩展头损坏");
    if (id === 0x0001) reject("暂不支持 ZIP64 文件");
    // Unicode path aliases can change a library's filename interpretation. Require one canonical filename.
    if (id === 0x7075) {
      if (length < 5) reject("Unicode 路径扩展头损坏");
      checkPath(decode(extra.subarray(offset + 5, offset + length)));
    }
    offset += length;
  }
}

function decodeXmlValues(value: unknown): void {
  const pending: unknown[] = [value];
  let nodes = 0;
  while (pending.length) {
    if (++nodes > 30_000) reject("XML 节点数量超过限制");
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, item] of Object.entries(current)) {
      if (typeof item === "string") {
        const decoded = item.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (entity) => {
          const predefined: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
          if (predefined[entity]) return predefined[entity];
          const code = entity.startsWith("&#x") ? Number.parseInt(entity.slice(3, -1), 16) : Number.parseInt(entity.slice(2, -1), 10);
          return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : entity;
        });
        (current as Record<string, unknown>)[key] = decoded;
      } else if (item && typeof item === "object") pending.push(item);
    }
  }
}

/** Inspect raw ZIP headers before extraction. zlib's output cap applies while inflating, not after allocation. */
function extractArchive(input: Uint8Array): Entry[] {
  if (!input.length || input.length > ARCHIVE_LIMIT) reject("文件为空或超过 20 MiB 限制");
  const bytes = Buffer.from(input);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) reject("不是完整的 ZIP 文件");
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count) reject("不支持分卷 ZIP 文件");
  if (count === 0xffff || start === 0xffffffff || size === 0xffffffff) reject("暂不支持 ZIP64 文件");
  if (!count || count > 200) reject("文件数量必须在 1 至 200 之间");
  if (start + size !== end) reject("ZIP 目录损坏或存在额外数据");
  const entries: Entry[] = [], names = new Set<string>();
  const spans: Array<[number, number]> = [];
  let cursor = start, total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) reject("ZIP 目录损坏");
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20), plainSize = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28), extraSize = bytes.readUInt16LE(cursor + 30), commentSize = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42), next = cursor + 46 + nameSize + extraSize + commentSize;
    if (next > end || bytes.readUInt16LE(cursor + 34)) reject("ZIP 文件头损坏");
    if (flags & 0x2041) reject("不支持加密 ZIP 文件");
    if (method !== 0 && method !== 8) reject("暂不支持此 ZIP 压缩方式");
    if (plainSize > ENTRY_LIMIT || compressedSize > ARCHIVE_LIMIT) reject("单个文件超过 20 MiB 限制");
    total += plainSize;
    if (total > TOTAL_LIMIT) reject("解压后的文件总大小超过 80 MiB 限制");
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameSize), name = decode(nameBytes);
    checkPath(name);
    const canonicalName = name.normalize("NFC").toLowerCase();
    if (names.has(canonicalName)) reject("包含重名或大小写不明确的文件");
    names.add(canonicalName);
    checkExtra(bytes.subarray(cursor + 46 + nameSize, cursor + 46 + nameSize + extraSize));
    const unixType = (bytes.readUInt32LE(cursor + 38) >>> 16) & 0xf000;
    if (unixType && unixType !== 0x8000 && unixType !== 0x4000) reject("不支持链接或特殊文件");
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) reject("ZIP 本地文件头损坏");
    const localNameSize = bytes.readUInt16LE(local + 26), localExtraSize = bytes.readUInt16LE(local + 28), dataStart = local + 30 + localNameSize + localExtraSize;
    if (dataStart + compressedSize > start || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || !bytes.subarray(local + 30, local + 30 + localNameSize).equals(nameBytes)) reject("ZIP 文件头与目录不一致");
    checkExtra(bytes.subarray(local + 30 + localNameSize, dataStart));
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== expectedCrc || bytes.readUInt32LE(local + 18) !== compressedSize || bytes.readUInt32LE(local + 22) !== plainSize)) reject("ZIP 文件大小与目录不一致");
    spans.push([local, dataStart + compressedSize]);
    let body: Buffer;
    try {
      const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
      body = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.min(plainSize + 1, ENTRY_LIMIT + 1) });
    } catch { reject("文件解压失败或解压大小超限"); }
    if (body.length !== plainSize || crc32(body) !== expectedCrc) reject("文件长度或校验值不匹配");
    if (/\.(?:zip|zipx|7z|rar|tar|gz)$/i.test(name) || body.length >= 4 && [0x04034b50, 0x06054b50, 0x08074b50].includes(body.readUInt32LE(0))) reject("不支持嵌套压缩文件");
    if (!name.endsWith("/")) entries.push({ name, body });
    else if (body.length) reject("ZIP 目录项包含文件内容");
    cursor = next;
  }
  if (cursor !== end) reject("ZIP 目录记录数不一致");
  spans.sort((left, right) => left[0] - right[0]);
  if (spans.some((span, index) => index > 0 && span[0] < spans[index - 1][1])) reject("ZIP 包含重叠文件");
  return entries;
}

function parseSource(entries: Entry[]): { raw: unknown; root: RecordValue; sourceName: string; schemaVersion: string } {
  const json = entries.filter((entry) => /\.json$/i.test(entry.name));
  const xml = entries.filter((entry) => /\.xml$/i.test(entry.name));
  if (json.length > 1 || !json.length && xml.length > 1) reject("包含多个定制数据文件，无法确定订单内容");
  const source = json[0] ?? xml[0];
  if (!source) reject("未找到 JSON 或 XML 定制数据");
  if (source.body.length > TEXT_LIMIT) reject("定制数据文件超过 5 MiB 限制");
  const content = decode(source.body);
  let raw: unknown;
  if (json.length) {
    try { raw = JSON.parse(content.replace(/^\uFEFF/, "")); } catch { reject("JSON 定制数据损坏"); }
  } else {
    if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(content)) reject("XML 包含不允许的文档类型或实体声明");
    if (XMLValidator.validate(content) !== true) reject("XML 定制数据损坏");
    try { raw = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", removeNSPrefix: true, processEntities: false, parseTagValue: false, parseAttributeValue: false, trimValues: false }).parse(content); }
    catch { reject("XML 定制数据损坏"); }
    decodeXmlValues(raw);
  }
  let root = record(raw);
  for (let depth = 0; root && depth < 8 && !root.orderId && !root.OrderId && !root.orderID; depth++) {
    const keys = Object.keys(root).filter((key) => !key.startsWith("?"));
    if (keys.length !== 1 || !record(root[keys[0]])) break;
    root = record(root[keys[0]]);
  }
  if (!root) reject("定制数据根节点无效");
  return { raw, root, sourceName: source.name, schemaVersion: json.length ? "amazon-custom-json" : "amazon-custom-xml" };
}

function sourceMediaType(name: string): string {
  if (/\.json$/i.test(name)) return "application/json";
  if (/\.xml$/i.test(name)) return "application/xml";
  if (/\.svg$/i.test(name)) return "image/svg+xml";
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.webp$/i.test(name)) return "image/webp";
  return "application/octet-stream";
}

export async function parseAmazonCustomArchive(bytes: Uint8Array, expected: { externalOrderId: string; externalLineId: string }): Promise<{ document: AmazonCustomDocument; files: AmazonCustomFile[] }> {
  const entries = extractArchive(bytes);
  const { raw, root, sourceName, schemaVersion } = parseSource(entries);
  const orderId = text(root.orderId ?? root.OrderId ?? root.orderID), lineId = text(root.orderItemId ?? root.OrderItemId ?? root.orderItemID);
  if (!orderId || !lineId) reject("缺少可核对的订单号或订单行编号");
  if (orderId !== expected.externalOrderId || lineId !== expected.externalLineId) reject("订单号或订单行编号与当前订单不匹配");
  const warnings = new Set<string>();
  const document: AmazonCustomDocument = { schemaVersion, surfaces: [], warnings: [], raw };
  const files: AmazonCustomFile[] = entries.map((entry, index) => ({ key: `source-${index + 1}`, name: entry.name, mediaType: sourceMediaType(entry.name), body: entry.body, role: "source" }));
  type Surface = AmazonCustomDocument["surfaces"][number];
  const refs: Array<{ surface: Surface; name: string; role: "preview" | "buyer_image" }> = [];
  const surface = (label: string): Surface => {
    if (document.surfaces.length >= 50) reject("定制面数量超过 50 个限制");
    const result: Surface = { key: `surface-${document.surfaces.length + 1}`, label: label.slice(0, 240) || `定制面 ${document.surfaces.length + 1}`, fields: [], previewFileKey: null, buyerFileKeys: [] };
    document.surfaces.push(result); return result;
  };
  let nodeCount = 0, fieldCount = 0;
  const addField = (target: Surface, field: Omit<AmazonCustomField, "key">) => {
    if (++fieldCount > 500) reject("定制字段数量超过 500 个限制");
    if (field.value.length > 20_000) reject("定制文字过长");
    target.fields.push({ key: `${target.key}-field-${target.fields.length + 1}`, ...field, label: field.label.slice(0, 240) });
  };
  const pushRef = (target: Surface, value: unknown, role: "preview" | "buyer_image") => {
    const object = record(value);
    const name = text(object?.imageName ?? object?.fileName ?? value);
    if (name) refs.push({ surface: target, name, role });
  };
  const children = (value: unknown): unknown[] => {
    if (Array.isArray(value)) return value;
    const object = record(value);
    if (!object) return [];
    if (object.type || object.inputValue !== undefined) return [object];
    return Object.values(object).flatMap((item) => Array.isArray(item) ? item : [item]);
  };
  const walk = (value: unknown, target: Surface | null, inherited: { font?: string; color?: string; label?: string }, depth: number): void => {
    if (++nodeCount > 10_000 || depth > 64) reject("定制数据层级或节点数量超过限制");
    const node = record(value);
    if (!node) return;
    const type = text(node.type), label = text(node.label ?? node.name) || inherited.label || "定制内容";
    if (type === "PageContainerCustomization") target = surface(label);
    const childNodes = children(node.children);
    const childSelections = childNodes.flatMap((child) => record(child) ? [record(child)!] : []);
    // Amazon can put font and color choices beside the text node, inside the same text container.
    const fontSelection = node.fontSelection ?? childSelections.find((child) => child.type === "FontCustomization")?.fontSelection;
    const colorSelection = node.colorSelection ?? childSelections.find((child) => child.type === "ColorCustomization")?.colorSelection;
    const font = text(record(fontSelection)?.family ?? fontSelection) || inherited.font;
    const color = text(record(colorSelection)?.value ?? colorSelection) || inherited.color;
    const appearance = { ...(font ? { font: font.slice(0, 500) } : {}), ...(color ? { color: color.slice(0, 500) } : {}) };
    const isFontChoice = type === "FontCustomization" && node.fontSelection !== undefined;
    const isColorChoice = type === "ColorCustomization" && node.colorSelection !== undefined;
    const hasField = node.inputValue !== undefined || node.optionSelection !== undefined || node.image !== undefined || isFontChoice || isColorChoice;
    if (!target && (hasField || node.snapshot)) target = surface("定制面 1");
    if (target) {
      if (node.snapshot) pushRef(target, node.snapshot, "preview");
      if (isFontChoice || isColorChoice) {
        const selection = isFontChoice ? node.fontSelection : node.colorSelection;
        const value = isFontChoice ? text(record(selection)?.family ?? selection) : text(selection);
        if (value) addField(target, { label, kind: "choice", value, ...appearance });
        else {
          addField(target, { label, kind: "unknown", value: isFontChoice ? "字体名称未提供，请核对原始数据" : "颜色名称或值未提供，请核对原始数据", ...appearance });
          warnings.add("部分字体或颜色选择缺少可展示的值，请核对原始数据");
        }
      }
      if (node.optionSelection !== undefined) {
        const selection = record(node.optionSelection);
        const value = text(selection?.label ?? selection?.name ?? selection?.value ?? node.optionSelection);
        if (!value && selection) warnings.add("部分选择项结构暂不支持解析，请核对原始数据");
        addField(target, { label, kind: "choice", value, ...appearance });
      }
      if (node.inputValue !== undefined) addField(target, { label, kind: "text", value: text(node.inputValue), ...appearance });
      if (node.image) {
        const image = record(node.image);
        pushRef(target, node.image, "buyer_image");
        addField(target, { label, kind: "image", value: text(image?.buyerFilename ?? image?.imageName ?? node.image), ...appearance });
      }
      if (!hasField && /Customization$/.test(type) && !/ContainerCustomization$/.test(type) && !node.children) {
        if (type === "ImageCustomization") {
          addField(target, { label, kind: "image", value: "未提供图片", ...appearance });
          warnings.add("该图片字段未提供上传文件，请核对是否需要图片");
        } else {
          const unknown = text(node.value ?? node.displayValue);
          addField(target, { label, kind: "unknown", value: unknown || "此定制字段暂不支持自动解析", ...appearance });
          warnings.add("部分定制字段暂不支持解析，请核对原始数据");
        }
      }
    }
    for (const child of childNodes) walk(child, target, { ...appearance, label }, depth + 1);
  };
  const tree = record(root.customizationData);
  if (tree && (tree.type || tree.children)) {
    walk(tree, null, {}, 0);
    document.schemaVersion += ":tree";
  } else {
    const legacy = record(record(root["version3.0"])?.customizationInfo) ?? record(root.customizationInfo);
    const legacySurfaces = legacy?.surfaces;
    for (const value of Array.isArray(legacySurfaces) ? legacySurfaces : children(legacySurfaces)) {
      const node = record(value);
      if (!node) continue;
      const target = surface(text(node.label ?? node.name) || "定制面");
      pushRef(target, node.snapshot ?? node.previewImage ?? node.preview, "preview");
      const areas = node.areas;
      for (const area of Array.isArray(areas) ? areas : children(areas)) {
        const item = record(area);
        if (!item) continue;
        const label = text(item.label ?? item.name) || "定制内容";
        if (item.image || item.imageName) {
          pushRef(target, item.image ?? item.imageName, "buyer_image");
          addField(target, { label, kind: "image", value: text(record(item.image)?.buyerFilename ?? record(item.image)?.imageName ?? item.imageName) });
        }
        if (item.text !== undefined || item.inputValue !== undefined) addField(target, { label, kind: "text", value: text(item.text ?? item.inputValue), ...(text(item.fontFamily ?? item.font) ? { font: text(item.fontFamily ?? item.font) } : {}), ...(text(item.color) ? { color: text(item.color) } : {}) });
        if (item.optionSelection !== undefined) addField(target, { label, kind: "choice", value: text(item.optionSelection) });
      }
    }
    document.schemaVersion += ":legacy";
    if (!document.surfaces.length) warnings.add("暂不支持此定制结构，请核对原始 JSON 或 XML");
  }

  const generated = new Map<string, string>();
  let renderedBytes = 0;
  for (const reference of refs) {
    const normalized = reference.name.replace(/^\.\//, "");
    if (/^[a-z][a-z0-9+.-]*:/i.test(normalized) || normalized.startsWith("//")) { warnings.add("定制内容引用外部资源，未自动下载"); continue; }
    const sourceDirectory = sourceName.includes("/") ? sourceName.slice(0, sourceName.lastIndexOf("/") + 1) : "";
    let entry = entries.find((candidate) => candidate.name === normalized) ?? entries.find((candidate) => candidate.name === sourceDirectory + normalized);
    if (!entry) {
      const basename = normalized.split("/").at(-1);
      const matches = entries.filter((candidate) => candidate.name.split("/").at(-1) === basename);
      if (matches.length === 1) entry = matches[0];
      else if (matches.length > 1) { warnings.add("图片引用对应多个文件，无法确定正确图片"); continue; }
    }
    if (!entry) { warnings.add(reference.role === "preview" ? "缺少定制预览图片" : "缺少买家上传图片"); continue; }
    if (/\.svg$/i.test(entry.name)) { warnings.add("SVG 仅保留为原始文件，未作为安全预览展示"); continue; }
    let key = generated.get(entry.name);
    if (!key) {
      try {
        const pipeline = sharp(entry.body, { limitInputPixels: 40_000_000, failOn: "warning", pages: 1 });
        const metadata = await pipeline.metadata();
        if (!metadata.format || !["jpeg", "png", "webp", "gif", "tiff", "heif", "avif"].includes(metadata.format)) { warnings.add("图片格式暂不支持安全预览"); continue; }
        const body = await pipeline.rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).png().toBuffer();
        if (body.length > ENTRY_LIMIT) { warnings.add("安全预览图片超过大小限制"); continue; }
        if (renderedBytes + body.length > TOTAL_LIMIT) { warnings.add("安全预览总大小超过 80 MiB 限制，部分图片仅保留原件"); continue; }
        renderedBytes += body.length;
        key = `display-${generated.size + 1}`;
        files.push({ key, name: `${key}.png`, mediaType: "image/png", body, role: reference.role,
          originalFileKey: `source-${entries.indexOf(entry) + 1}`,
          ...(metadata.width ? { width: metadata.width } : {}), ...(metadata.height ? { height: metadata.height } : {}),
        });
        generated.set(entry.name, key);
      } catch { warnings.add("图片损坏、尺寸超限或无法生成安全预览"); continue; }
    }
    if (reference.role === "preview") {
      if (!reference.surface.previewFileKey) reference.surface.previewFileKey = key;
      else if (reference.surface.previewFileKey !== key) warnings.add("同一定制面包含多个预览，已展示首个预览并保留原始文件");
    } else if (!reference.surface.buyerFileKeys.includes(key)) reference.surface.buyerFileKeys.push(key);
  }
  for (const target of document.surfaces) if (!target.previewFileKey) warnings.add("部分定制面没有可展示的亚马逊预览");
  if (!document.surfaces.some((target) => target.fields.length)) warnings.add("未解析到可展示的定制字段，请核对原始数据");
  document.warnings = [...warnings];
  return { document, files };
}
