import type {
  TemplateCanvas,
  TemplateSourceInspectionSlot,
  TemplateSourceInspectionWarning,
} from "@yummyai/contracts";
import { TEMPLATE_SOURCE_PARSER } from "@yummyai/contracts";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const MAX_PSD_LAYERS = 5_000;
const MAX_OUTPUT_SLOTS = 500;

export const TEMPLATE_SOURCE_PARSER_KEY = TEMPLATE_SOURCE_PARSER.key;
export const TEMPLATE_SOURCE_PARSER_VERSION = TEMPLATE_SOURCE_PARSER.version;

export interface ParsedPersonalizationTemplateSource {
  canvas: TemplateCanvas;
  slots: TemplateSourceInspectionSlot[];
  warnings: TemplateSourceInspectionWarning[];
}

export class TemplateSourceParseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TemplateSourceParseError";
  }
}

export function inspectPersonalizationTemplateSource(
  bytes: Uint8Array,
  source: "png" | "psd",
): ParsedPersonalizationTemplateSource {
  if (source === "png") return inspectPng(bytes);
  return inspectPsd(bytes);
}

function inspectPng(bytes: Uint8Array): ParsedPersonalizationTemplateSource {
  if (bytes.byteLength < 33 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    throw new TemplateSourceParseError("PNG_SIGNATURE_INVALID", "The selected asset is not a valid PNG file");
  }
  const reader = new BinaryReader(bytes);
  reader.skip(8);
  const ihdrLength = reader.u32();
  if (ihdrLength !== 13 || reader.ascii(4) !== "IHDR") {
    throw new TemplateSourceParseError("PNG_IHDR_INVALID", "The PNG header is missing or invalid");
  }
  const width = reader.u32();
  const height = reader.u32();
  reader.u8();
  const colorType = reader.u8();
  reader.skip(7);
  assertCanvasDimensions(width, height);

  let dpi: number | undefined;
  while (reader.remaining >= 12) {
    const length = reader.u32();
    const type = reader.ascii(4);
    if (length > reader.remaining - 4) throw new TemplateSourceParseError("PNG_CHUNK_INVALID", "A PNG chunk exceeds the file boundary");
    if (type === "pHYs" && length === 9) {
      const xPixelsPerMeter = reader.u32();
      reader.u32();
      const unit = reader.u8();
      if (unit === 1 && xPixelsPerMeter > 0) dpi = clampDpi(Math.round(xPixelsPerMeter * 0.0254));
    } else {
      reader.skip(length);
    }
    reader.skip(4);
    if (type === "IEND") break;
  }
  const warnings: TemplateSourceInspectionWarning[] = [{
    code: "PNG_LAYER_SEMANTICS_UNAVAILABLE",
    message: "PNG does not contain editable layer groups. A full-canvas customer image slot was proposed and must be reviewed.",
  }];
  if (!dpi) warnings.push({ code: "DPI_DEFAULTED", message: "No physical resolution was found; the inspection uses 300 DPI." });
  const colorMode: TemplateCanvas["colorMode"] = colorType === 0 || colorType === 4 ? "grayscale" : "rgb";
  return {
    canvas: { width, height, dpi: dpi ?? 300, colorMode, background: colorType === 4 || colorType === 6 ? "transparent" : undefined },
    slots: [{
      stableKey: "customer.image",
      name: "顾客图片",
      kind: "image",
      geometry: { x: 0, y: 0, width, height, rotationDegrees: 0 },
      fillMode: "cover",
      validationSnapshot: { parserProposal: true, required: true, sourceFormat: "png" },
      replaceable: true,
      sourceLayerPath: ["PNG canvas"],
      confidencePermille: 500,
    }],
    warnings,
  };
}

type PsdLayer = {
  index: number;
  name: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
  flags: number;
  sectionType?: number;
  isText: boolean;
};

type GroupRange = { name: string; start: number; end: number };

function inspectPsd(bytes: Uint8Array): ParsedPersonalizationTemplateSource {
  const reader = new BinaryReader(bytes);
  if (reader.ascii(4) !== "8BPS") throw new TemplateSourceParseError("PSD_SIGNATURE_INVALID", "The selected asset is not a Photoshop document");
  const version = reader.u16();
  if (version !== 1) throw new TemplateSourceParseError("PSD_VERSION_UNSUPPORTED", "Only PSD files are supported; PSB files must be converted before import");
  reader.skip(6);
  reader.u16();
  const height = reader.u32();
  const width = reader.u32();
  reader.u16();
  const rawColorMode = reader.u16();
  assertCanvasDimensions(width, height);
  skipLength32Section(reader, "PSD_COLOR_MODE_DATA_INVALID");
  const resourceLength = reader.u32();
  const resourceStart = reader.position;
  reader.skip(resourceLength);
  const dpi = inspectPsdResolution(bytes.subarray(resourceStart, resourceStart + resourceLength));
  const layerMaskLength = reader.u32();
  const layerMaskEnd = reader.position + layerMaskLength;
  if (layerMaskEnd > bytes.byteLength) throw new TemplateSourceParseError("PSD_LAYER_SECTION_INVALID", "The PSD layer section exceeds the file boundary");
  const warnings: TemplateSourceInspectionWarning[] = [];
  if (!dpi) warnings.push({ code: "DPI_DEFAULTED", message: "No Photoshop resolution resource was found; the inspection uses 300 DPI." });
  const colorMode = psdColorMode(rawColorMode, warnings);
  if (layerMaskLength === 0) {
    warnings.push({ code: "PSD_NO_LAYERS", message: "The PSD contains no layer records. A full-canvas customer image slot was proposed." });
    return {
      canvas: { width, height, dpi: dpi ?? 300, colorMode },
      slots: [fallbackPsdSlot(width, height)],
      warnings,
    };
  }

  const layerInfoLength = reader.u32();
  const layerInfoEnd = reader.position + layerInfoLength;
  if (layerInfoEnd > layerMaskEnd || layerInfoLength < 2) {
    throw new TemplateSourceParseError("PSD_LAYER_INFO_INVALID", "The PSD layer information is missing or invalid");
  }
  const layerCount = Math.abs(reader.i16());
  if (layerCount > MAX_PSD_LAYERS) throw new TemplateSourceParseError("PSD_LAYER_LIMIT_EXCEEDED", `PSD layer count exceeds ${MAX_PSD_LAYERS}`);
  const layers: PsdLayer[] = [];
  for (let index = 0; index < layerCount; index += 1) layers.push(readPsdLayer(reader, index, layerInfoEnd));
  reader.seek(layerMaskEnd);

  const ranges = selectGroupRanges(layers);
  const slots: TemplateSourceInspectionSlot[] = [];
  const stableKeys = new Map<string, number>();
  for (const layer of layers) {
    if (layer.sectionType !== undefined) continue;
    const widthPx = layer.right - layer.left;
    const heightPx = layer.bottom - layer.top;
    const path = ranges.filter((range) => layer.index >= range.start && layer.index <= range.end)
      .sort((left, right) => (right.end - right.start) - (left.end - left.start))
      .map((range) => range.name)
      .slice(-31);
    const classification = classifyLayer(layer, path);
    if (widthPx <= 0 || heightPx <= 0) {
      warnings.push({ code: "PSD_LAYER_EMPTY", message: `Layer “${layer.name}” has no drawable bounds and was skipped.`, layerPath: [...path, layer.name] });
      continue;
    }
    const sourceLayerPath = [...path, layer.name].slice(-32);
    const baseKey = stableKey(sourceLayerPath);
    const occurrence = (stableKeys.get(baseKey) ?? 0) + 1;
    stableKeys.set(baseKey, occurrence);
    const stableKeyValue = occurrence === 1 ? baseKey : `${baseKey}.${occurrence}`.slice(0, 120);
    if (!classification.explicit) {
      warnings.push({ code: "PSD_LAYER_CLASSIFICATION_INFERRED", message: `Layer “${layer.name}” was classified as ${classification.kind}; verify it before confirmation.`, layerPath: sourceLayerPath });
    }
    slots.push({
      stableKey: stableKeyValue,
      name: layer.name.slice(0, 200) || `Layer ${layer.index + 1}`,
      kind: classification.kind,
      psdGroup: classification.kind,
      geometry: { x: layer.left, y: layer.top, width: widthPx, height: heightPx, rotationDegrees: 0 },
      fillMode: classification.kind === "image" || classification.kind === "background" ? "cover" : "none",
      validationSnapshot: {
        parserProposal: true,
        sourceFormat: "psd",
        sourceLayerIndex: layer.index,
        sourceLayerName: layer.name,
        visible: (layer.flags & 0x02) === 0,
        textLayer: layer.isText,
        classification: classification.explicit ? "group_or_name" : "inferred",
      },
      replaceable: classification.kind === "image" || classification.kind === "text",
      sourceLayerPath,
      confidencePermille: classification.confidencePermille,
    });
    if (slots.length === MAX_OUTPUT_SLOTS) {
      warnings.push({ code: "PSD_SLOT_LIMIT_REACHED", message: `Only the first ${MAX_OUTPUT_SLOTS} drawable layers were proposed as slots.` });
      break;
    }
  }
  if (!slots.length) {
    slots.push(fallbackPsdSlot(width, height));
    warnings.push({ code: "PSD_NO_DRAWABLE_SLOTS", message: "No drawable PSD layer could be proposed. A full-canvas customer image slot was added for review." });
  }
  const duplicateNames = new Set(slots.filter((slot, index) => slots.some(
    (candidate, candidateIndex) => candidateIndex !== index && candidate.kind === slot.kind && candidate.name === slot.name,
  )).map((slot) => `${slot.kind}:${slot.name}`));
  for (const slot of slots) {
    if (duplicateNames.has(`${slot.kind}:${slot.name}`)) slot.reuseLabel = `same-name:${slot.name}`.slice(0, 120);
  }
  return { canvas: { width, height, dpi: dpi ?? 300, colorMode }, slots, warnings: warnings.slice(0, 500) };
}

function readPsdLayer(reader: BinaryReader, index: number, layerInfoEnd: number): PsdLayer {
  const top = reader.i32();
  const left = reader.i32();
  const bottom = reader.i32();
  const right = reader.i32();
  const channelCount = reader.u16();
  if (channelCount > 64) throw new TemplateSourceParseError("PSD_CHANNEL_LIMIT_EXCEEDED", "A PSD layer contains too many channels");
  reader.skip(channelCount * 6);
  if (reader.ascii(4) !== "8BIM") throw new TemplateSourceParseError("PSD_BLEND_SIGNATURE_INVALID", "A PSD layer has an invalid blend signature");
  reader.skip(4);
  reader.u8();
  reader.u8();
  const flags = reader.u8();
  reader.u8();
  const extraLength = reader.u32();
  const extraStart = reader.position;
  const extraEnd = extraStart + extraLength;
  if (extraEnd > layerInfoEnd) throw new TemplateSourceParseError("PSD_LAYER_EXTRA_INVALID", "A PSD layer extra-data block exceeds its section");
  skipLength32Section(reader, "PSD_LAYER_MASK_INVALID", extraEnd);
  skipLength32Section(reader, "PSD_BLEND_RANGE_INVALID", extraEnd);
  const pascalStart = reader.position;
  const nameLength = reader.u8();
  let name = reader.latin1(nameLength);
  reader.seek(Math.min(extraEnd, pascalStart + padded(1 + nameLength, 4)));
  let sectionType: number | undefined;
  let isText = false;
  while (reader.position + 12 <= extraEnd) {
    const signature = reader.ascii(4);
    const key = reader.ascii(4);
    const length = reader.u32();
    const dataStart = reader.position;
    const dataEnd = dataStart + length;
    if ((signature !== "8BIM" && signature !== "8B64") || dataEnd > extraEnd) break;
    if (key === "luni" && length >= 4) {
      const characters = reader.u32();
      if (characters <= 10_000 && reader.position + characters * 2 <= dataEnd) name = reader.utf16be(characters);
    } else if ((key === "lsct" || key === "lsdk") && length >= 4) {
      sectionType = reader.u32();
    } else if (key === "TySh") {
      isText = true;
    }
    reader.seek(dataEnd + (length % 2));
  }
  reader.seek(extraEnd);
  return { index, name: cleanLayerName(name, index), top, left, bottom, right, flags, sectionType, isText };
}

function selectGroupRanges(layers: PsdLayer[]): GroupRange[] {
  const forward = groupRanges(layers, false);
  const reverse = groupRanges(layers, true);
  return scoreRanges(layers, reverse) > scoreRanges(layers, forward) ? reverse : forward;
}

function groupRanges(layers: PsdLayer[], reverseOrder: boolean): GroupRange[] {
  const stack: Array<{ index: number; name?: string }> = [];
  const ranges: GroupRange[] = [];
  for (const layer of layers) {
    if (!reverseOrder && (layer.sectionType === 1 || layer.sectionType === 2)) {
      stack.push({ index: layer.index, name: layer.name });
    } else if (!reverseOrder && layer.sectionType === 3) {
      const start = stack.pop();
      if (start?.name) ranges.push({ name: start.name, start: start.index + 1, end: layer.index - 1 });
    } else if (reverseOrder && layer.sectionType === 3) {
      stack.push({ index: layer.index });
    } else if (reverseOrder && (layer.sectionType === 1 || layer.sectionType === 2)) {
      const start = stack.pop();
      if (start) ranges.push({ name: layer.name, start: start.index + 1, end: layer.index - 1 });
    }
  }
  return ranges.filter((range) => range.start <= range.end);
}

function scoreRanges(layers: PsdLayer[], ranges: GroupRange[]) {
  return layers.filter((layer) => layer.sectionType === undefined && ranges.some(
    (range) => layer.index >= range.start && layer.index <= range.end && classifyName(range.name),
  )).length;
}

function classifyLayer(layer: PsdLayer, path: string[]) {
  for (const name of [...path].reverse()) {
    const kind = classifyName(name);
    if (kind) return { kind, explicit: true, confidencePermille: 950 } as const;
  }
  const ownKind = classifyName(layer.name);
  if (ownKind) return { kind: ownKind, explicit: true, confidencePermille: 850 } as const;
  if (layer.isText) return { kind: "text" as const, explicit: true, confidencePermille: 900 };
  return { kind: "decoration" as const, explicit: false, confidencePermille: 350 };
}

function classifyName(value: string): "image" | "text" | "decoration" | "background" | undefined {
  const normalized = value.normalize("NFKC").toLowerCase().replaceAll(/[\s_.[\](){}-]+/g, "");
  if (/^(image|images|photo|photos|picture|pictures|customerimage|图片区|图片|照片|图像|素材)$/.test(normalized)) return "image";
  if (/^(text|texts|type|typography|name|customertext|文字区|文字|文本|姓名)$/.test(normalized)) return "text";
  if (/^(decoration|decorations|decor|ornament|ornaments|element|elements|mask|masks|装饰区|装饰|元素|点缀|蒙版|遮罩)$/.test(normalized)) return "decoration";
  if (/^(background|backgrounds|bg|backdrop|背景区|背景|底图)$/.test(normalized)) return "background";
  return undefined;
}

function inspectPsdResolution(bytes: Uint8Array): number | undefined {
  const reader = new BinaryReader(bytes);
  while (reader.remaining >= 12) {
    if (reader.ascii(4) !== "8BIM") return undefined;
    const resourceId = reader.u16();
    const nameStart = reader.position;
    const nameLength = reader.u8();
    reader.skip(nameLength);
    reader.seek(nameStart + padded(1 + nameLength, 2));
    const length = reader.u32();
    if (length > reader.remaining) return undefined;
    if (resourceId === 1005 && length >= 4) {
      const fixed = reader.u32();
      return clampDpi(Math.round(fixed / 65_536));
    }
    reader.skip(length + (length % 2));
  }
  return undefined;
}

function fallbackPsdSlot(width: number, height: number): TemplateSourceInspectionSlot {
  return {
    stableKey: "customer.image",
    name: "顾客图片",
    kind: "image",
    psdGroup: "image",
    geometry: { x: 0, y: 0, width, height, rotationDegrees: 0 },
    fillMode: "cover",
    validationSnapshot: { parserProposal: true, required: true, sourceFormat: "psd", fallback: true },
    replaceable: true,
    sourceLayerPath: ["PSD canvas"],
    confidencePermille: 250,
  };
}

function psdColorMode(value: number, warnings: TemplateSourceInspectionWarning[]): TemplateCanvas["colorMode"] {
  if (value === 1) return "grayscale";
  if (value === 3) return "rgb";
  if (value === 4) return "cmyk";
  warnings.push({ code: "PSD_COLOR_MODE_MAPPED", message: `Photoshop color mode ${value} is represented as RGB for template configuration.` });
  return "rgb";
}

function assertCanvasDimensions(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 100_000 || height > 100_000) {
    throw new TemplateSourceParseError("CANVAS_DIMENSIONS_INVALID", "Template canvas dimensions must be between 1 and 100000 pixels");
  }
}

function skipLength32Section(reader: BinaryReader, code: string, outerEnd = reader.length) {
  const length = reader.u32();
  if (reader.position + length > outerEnd) throw new TemplateSourceParseError(code, "A length-delimited source section exceeds its parent boundary");
  reader.skip(length);
}

function stableKey(path: string[]) {
  const value = path.join(".").normalize("NFKC").toLowerCase()
    .replaceAll(/[^a-z0-9_.-]+/g, ".")
    .replaceAll(/\.{2,}/g, ".")
    .replaceAll(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 120);
  return value || "layer";
}

function cleanLayerName(value: string, index: number) {
  const cleaned = Array.from(value).filter((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  }).join("").trim();
  return (cleaned || `Layer ${index + 1}`).slice(0, 200);
}

function clampDpi(value: number) {
  return Math.min(2_400, Math.max(36, value));
}

function padded(value: number, alignment: number) {
  return Math.ceil(value / alignment) * alignment;
}

class BinaryReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get length() { return this.bytes.byteLength; }
  get position() { return this.offset; }
  get remaining() { return this.bytes.byteLength - this.offset; }

  seek(position: number) {
    if (!Number.isInteger(position) || position < 0 || position > this.bytes.byteLength) this.boundary();
    this.offset = position;
  }

  skip(length: number) { this.seek(this.offset + length); }

  u8() { this.ensure(1); return this.bytes[this.offset++]!; }
  u16() { this.ensure(2); const value = this.view().getUint16(this.offset, false); this.offset += 2; return value; }
  i16() { this.ensure(2); const value = this.view().getInt16(this.offset, false); this.offset += 2; return value; }
  u32() { this.ensure(4); const value = this.view().getUint32(this.offset, false); this.offset += 4; return value; }
  i32() { this.ensure(4); const value = this.view().getInt32(this.offset, false); this.offset += 4; return value; }

  ascii(length: number) {
    this.ensure(length);
    let value = "";
    for (let index = 0; index < length; index += 1) value += String.fromCharCode(this.bytes[this.offset + index]!);
    this.offset += length;
    return value;
  }

  latin1(length: number) { return this.ascii(length); }

  utf16be(characters: number) {
    this.ensure(characters * 2);
    let value = "";
    for (let index = 0; index < characters; index += 1) value += String.fromCharCode(this.u16());
    return value;
  }

  private ensure(length: number) {
    if (!Number.isInteger(length) || length < 0 || this.offset + length > this.bytes.byteLength) this.boundary();
  }

  private view() { return new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength); }

  private boundary(): never {
    throw new TemplateSourceParseError("SOURCE_BOUNDARY_INVALID", "The template source ended before a declared section boundary");
  }
}
