import { createHash } from "node:crypto";
import {
  OrderRequirementInterpretationSchema, OrderRequirementSourceSchema,
  type OrderRequirementBasis, type OrderRequirementRole, type OrderRequirementSource,
} from "@yummyai/contracts/order/requirement-interpretation";
import type { OrderIntakeCheck, OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import type { AmazonCustomDocument } from "./amazon-custom-archive.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
function text(value: unknown, depth = 0): string {
  if (depth > 8) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const item = record(value);
  return item ? text(item["#text"] ?? item.label ?? item.name ?? item.value ?? item.displayValue ?? item.optionValue ?? item.fontFamily ?? item.fontName ?? item.family ?? item.colorName ?? item.hex, depth + 1) : "";
}
const pointer = (base: string, key: string | number) => base + "/" + String(key).replaceAll("~", "~0").replaceAll("/", "~1");
const identity = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
function role(label: string, kind: "text" | "choice" | "image" | "unknown"): OrderRequirementRole {
  const name = identity(label);
  if (kind === "image") return "image";
  if (["font", "fontfamily", "字体"].includes(name)) return "font";
  if (["fontcolor", "textcolor", "字体颜色", "文字颜色"].includes(name)) return "color";
  if (["ordernotesforseller", "sellernotes", "customernotes", "顾客特殊要求", "给卖家留言", "制作说明"].includes(name)) return "notes";
  if (kind === "choice") {
    if (/^(?:size|尺寸|规格)/u.test(name)) return "size";
    if (["pillowshape", "cropscope", "裁切范围"].includes(name)) return "crop";
    if (["style", "printsides", "printingsides", "印刷面数"].includes(name)) return "side";
    if (/enhancement|enhance|高清|美化/u.test(name)) return "enhancement";
    return "option";
  }
  return kind === "text" ? "text" : "unknown";
}
/** An operator's explicit canonical target has business meaning even when entered in a textarea. */
function operatorRole(field: OrderWorkDraft["fields"][number]): OrderRequirementRole {
  switch (field.key) {
    case "buyer_photo": return "image";
    case "crop_scope": return "crop";
    case "print_sides": return "side";
    case "customer_notes": return "notes";
    default: return role(field.label, field.kind);
  }
}
/** Only an explicitly supplied code is a color. CustomColor is a label. */
function colorHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.trim();
  if (/^#[a-fA-F0-9]{6}$/.test(hex)) return hex;
  if (/^#[a-fA-F0-9]{3}$/.test(hex)) return "#" + [...hex.slice(1)].map(part => part + part).join("");
  return null;
}
function explicitColor(value: unknown) {
  const item = record(value);
  return { label: text(value) || null, hex: colorHex(item?.value ?? item?.hex ?? item?.hexCode ?? value) };
}
function children(value: unknown, path: string): Array<{ node: unknown; path: string }> {
  if (Array.isArray(value)) return value.map((node, index) => ({ node, path: pointer(path, index) }));
  const item = record(value);
  if (!item) return [];
  if (item.type || item.inputValue !== undefined) return [{ node: item, path }];
  return Object.entries(item).flatMap(([key, entry]) => Array.isArray(entry)
    ? entry.map((node, index) => ({ node, path: pointer(pointer(path, key), index) }))
    : [{ node: entry, path: pointer(path, key) }]);
}

/** Read immutable raw structure; never infer style ownership from flattened adjacency. */
export function extractAmazonRequirementSources(document: AmazonCustomDocument): OrderRequirementSource[] {
  const sources: OrderRequirementSource[] = [], textGroups = new Set<string>();
  const groupStyles = new Map<string, { font?: unknown; color?: unknown; fontPath: string; colorPath: string }>();
  let root = record(document.raw), rootPath = "", surfaceIndex = -1, count = 0;
  for (let depth = 0; root && depth < 8 && !root.orderId && !root.OrderId && !root.orderID; depth++) {
    const keys = Object.keys(root).filter(key => !key.startsWith("?"));
    if (keys.length !== 1 || !record(root[keys[0]!])) break;
    rootPath = pointer(rootPath, keys[0]!); root = record(root[keys[0]!]);
  }
  type Surface = { index: number; next: number };
  const surface = (): Surface => ({ index: ++surfaceIndex, next: 0 });
  function emit(target: Surface, node: RecordValue, path: string, kind: "text" | "choice" | "image" | "unknown",
    groupKey: string | null, forced?: OrderRequirementRole, inline?: { font?: unknown; color?: unknown }) {
    const originalSurface = document.surfaces[target.index], original = originalSurface?.fields[target.next++];
    if (!original) return;
    const sourceRole = forced ?? role(original.label, kind);
    const scoped = groupKey ? groupStyles.get(groupKey) : undefined;
    const fontSelection = sourceRole === "text" ? inline?.font ?? node.fontSelection ?? scoped?.font : node.fontSelection ?? (sourceRole === "font" ? node.optionSelection : undefined);
    const colorSelection = sourceRole === "text" ? inline?.color ?? node.colorSelection ?? scoped?.color : node.colorSelection ?? (sourceRole === "color" ? node.optionSelection : undefined);
    const ownFont = sourceRole === "font" || sourceRole === "text" ? text(record(fontSelection)?.family ?? fontSelection) : "";
    const ownColor = sourceRole === "color" || sourceRole === "text" ? explicitColor(colorSelection) : { label: null, hex: null };
    sources.push(OrderRequirementSourceSchema.parse({
      sourceFieldKey: original.key, surfaceKey: originalSurface!.key,
      groupKey: groupKey ?? `${originalSurface!.key}:field:${original.key}`, origin: "amazon_raw", jsonPointer: path,
      role: sourceRole, label: original.label, value: original.value,
      requestedFont: ownFont || null, colorLabel: ownColor.label, colorHex: ownColor.hex,
      ...(fontSelection !== undefined && ["font", "text"].includes(sourceRole) ? {
        fontJsonPointer: inline?.font !== undefined ? pointer(path, node.fontFamily !== undefined ? "fontFamily" : "font")
          : node.fontSelection !== undefined ? pointer(path, "fontSelection") : sourceRole === "font" ? pointer(path, "optionSelection") : scoped!.fontPath,
      } : {}),
      ...(colorSelection !== undefined && ["color", "text"].includes(sourceRole) ? {
        colorJsonPointer: inline?.color !== undefined ? pointer(path, "color")
          : node.colorSelection !== undefined ? pointer(path, "colorSelection") : sourceRole === "color" ? pointer(path, "optionSelection") : scoped!.colorPath,
      } : {}),
      targetTextKey: sourceRole === "text" ? original.key : null,
    }));
  }
  function walk(value: unknown, path: string, target: Surface | null, groupKey: string | null, depth: number): void {
    if (++count > 10000 || depth > 64) throw new Error("定制需求来源超过可解析范围");
    const node = record(value); if (!node) return;
    const type = text(node.type);
    if (type === "PageContainerCustomization") { target = surface(); groupKey = null; }
    const hasFont = type === "FontCustomization" && node.fontSelection !== undefined;
    const hasColor = type === "ColorCustomization" && node.colorSelection !== undefined;
    const hasField = node.inputValue !== undefined || node.optionSelection !== undefined || node.image !== undefined || hasFont || hasColor;
    if (!target && (hasField || node.snapshot)) target = surface();
    if (type === "TextContainerCustomization") {
      groupKey = `text:${createHash("sha256").update(path).digest("hex").slice(0, 32)}`;
      textGroups.add(groupKey);
      groupStyles.set(groupKey, { font: node.fontSelection, color: node.colorSelection,
        fontPath: pointer(path, "fontSelection"), colorPath: pointer(path, "colorSelection") });
    }
    if (target) {
      if (hasFont || hasColor) emit(target, node, path, "choice", groupKey, hasFont ? "font" : "color");
      if (node.optionSelection !== undefined) emit(target, node, path, "choice", groupKey);
      if (node.inputValue !== undefined) emit(target, node, path, "text", groupKey);
      if (node.image) emit(target, node, path, "image", groupKey, "image");
      if (!hasField && /Customization$/.test(type) && !/ContainerCustomization$/.test(type) && !node.children)
        emit(target, node, path, type === "ImageCustomization" ? "image" : "unknown", groupKey);
    }
    for (const child of children(node.children, pointer(path, "children"))) walk(child.node, child.path, target, groupKey, depth + 1);
  }
  const tree = record(root?.customizationData);
  if (tree && (tree.type || tree.children)) walk(tree, pointer(rootPath, "customizationData"), null, null, 0);
  else if (root) {
    const v3 = record(root["version3.0"]), versioned = record(v3?.customizationInfo);
    const legacy = versioned ?? record(root.customizationInfo);
    const legacyPath = versioned ? pointer(pointer(rootPath, "version3.0"), "customizationInfo") : pointer(rootPath, "customizationInfo");
    for (const item of children(legacy?.surfaces, pointer(legacyPath, "surfaces"))) {
      const node = record(item.node); if (!node) continue;
      const target = surface();
      for (const area of children(node.areas, pointer(item.path, "areas"))) {
        const entry = record(area.node); if (!entry) continue;
        const group = `legacy-area:${createHash("sha256").update(area.path).digest("hex").slice(0, 32)}`;
        if (entry.image || entry.imageName) emit(target, entry, area.path, "image", group, "image");
        if (entry.text !== undefined || entry.inputValue !== undefined)
          emit(target, entry, area.path, "text", group, undefined, { font: entry.fontFamily ?? entry.font, color: entry.color });
        if (entry.optionSelection !== undefined) emit(target, entry, area.path, "choice", group);
      }
    }
  }
  const existing = new Set(sources.map(source => source.sourceFieldKey));
  for (const item of document.surfaces) for (const field of item.fields) if (!existing.has(field.key)) sources.push({
    sourceFieldKey: field.key, surfaceKey: item.key, groupKey: `unresolved:${field.key}`, origin: "legacy_unresolved", jsonPointer: "",
    role: role(field.label, field.kind), label: field.label, value: field.value,
    requestedFont: null, colorLabel: null, colorHex: null, targetTextKey: null,
  });
  for (const group of textGroups) {
    const rows = sources.filter(source => source.groupKey === group), texts = rows.filter(source => source.role === "text");
    if (texts.length !== 1) continue;
    for (const styleRole of ["font", "color"] as const) {
      const styles = rows.filter(source => source.role === styleRole);
      for (const style of styles) style.targetTextKey = texts[0]!.sourceFieldKey;
    }
  }
  return sources;
}

export function interpretOrderRequirements(input: {
  basis: OrderRequirementBasis; sources: readonly OrderRequirementSource[]; draft: OrderWorkDraft; fields?: OrderIntakeCheck["fields"];
}) {
  const sources = structuredClone([...input.sources]), draft = structuredClone(input.draft);
  const active = new Map(draft.fields.map(field => [field.sourceKey ?? field.key, field]));
  for (const field of draft.fields) {
    const key = field.sourceKey ?? field.key;
    if (!sources.some(source => source.sourceFieldKey === key)) sources.push({
      sourceFieldKey: key, surfaceKey: "operator", groupKey: `operator:${key}`, origin: "operator", jsonPointer: "",
      role: operatorRole(field), label: field.label, value: field.value,
      requestedFont: null, colorLabel: null, colorHex: null, targetTextKey: null,
    });
  }
  for (const source of sources) {
    const field = active.get(source.sourceFieldKey); if (!field) continue;
    if (field.value !== source.value) {
      source.origin = "operator"; source.value = field.value;
      if (source.role === "font") source.requestedFont = field.value || null;
      if (source.role === "color") { source.colorLabel = field.value || null; source.colorHex = colorHex(field.value); }
    }
    if (source.role === "text" && field.styleOverride) {
      source.origin = "operator";
      if (field.styleOverride.font !== undefined) source.requestedFont = field.styleOverride.font;
      if (field.styleOverride.colorHex !== undefined) { source.colorHex = field.styleOverride.colorHex; source.colorLabel = field.styleOverride.colorHex; }
    }
  }
  const unresolved: Array<{ code: string; sourceFieldKeys: string[]; message: string }> = [];
  const texts = sources.filter(source => source.role === "text" && active.has(source.sourceFieldKey)).map(source => {
    const singleText = sources.filter(row => row.role === "text" && row.groupKey === source.groupKey).length === 1;
    const fonts = sources.filter(row => row.role === "font" && row.groupKey === source.groupKey &&
      (row.targetTextKey === source.sourceFieldKey || singleText));
    const colors = sources.filter(row => row.role === "color" && row.groupKey === source.groupKey &&
      (row.targetTextKey === source.sourceFieldKey || singleText));
    const font = source.requestedFont !== null ? source : fonts.find(row => row.targetTextKey === source.sourceFieldKey) ?? null;
    const color = source.colorLabel !== null || source.colorHex !== null ? source : colors.find(row => row.targetTextKey === source.sourceFieldKey) ?? null;
    const needsPrinting = !!source.value.trim();
    const override = active.get(source.sourceFieldKey)?.styleOverride;
    if (needsPrinting && override?.font === undefined && new Set([source.requestedFont, ...fonts.map(row => row.requestedFont)]
      .filter((name): name is string => name !== null).map(name => name.normalize("NFKC").trim().toLowerCase())).size > 1)
      unresolved.push({ code: "font_group_conflict", sourceFieldKeys: [source.sourceFieldKey, ...fonts.map(row => row.sourceFieldKey)], message: "本组原始字体要求互相冲突，请核对并明确采用本组真实字体" });
    if (needsPrinting && override?.colorHex === undefined && new Set([source.colorHex, ...colors.map(row => row.colorHex)]
      .filter((hex): hex is string => hex !== null).map(hex => hex.toLowerCase())).size > 1)
      unresolved.push({ code: "color_group_conflict", sourceFieldKeys: [source.sourceFieldKey, ...colors.map(row => row.sourceFieldKey)], message: "本组原始颜色提供了不同色值，请核对并明确采用本组真实色值" });
    if (needsPrinting && color && !color.colorHex) unresolved.push({ code: "color_value_missing", sourceFieldKeys: [source.sourceFieldKey, color.sourceFieldKey], message: "颜色选项没有提供真实色值，需要模型或运营结合原始预览核对，不能默认黑色" });
    return { sourceFieldKey: source.sourceFieldKey, groupKey: source.groupKey, originalText: source.value, needsPrinting,
      font: { requested: font?.requestedFont ?? null, sourceFieldKey: font?.sourceFieldKey ?? null },
      color: { label: color?.colorLabel ?? null, hex: color?.colorHex ?? null, sourceFieldKey: color?.sourceFieldKey ?? null } };
  });
  for (const source of sources) {
    if (source.origin === "legacy_unresolved" && ["text", "font", "color"].includes(source.role))
      unresolved.push({ code: "legacy_group_missing", sourceFieldKeys: [source.sourceFieldKey], message: "旧资料缺少可核对的文字分组来源，保留原文并核对原始定制资料，不按相邻位置猜测样式" });
    if (source.role === "text" && source.value.trim() && !active.has(source.sourceFieldKey))
      unresolved.push({ code: "source_text_not_selected", sourceFieldKeys: [source.sourceFieldKey], message: "原始非空文案未纳入当前制作草稿，请核对是否应保留印字" });
  }
  const targets = new Map<string, string>();
  for (const field of input.fields ?? []) for (const key of field.sourceKeys) {
    const current = draft.fields.find(row => row.key === key);
    targets.set(current?.sourceKey ?? key, field.key);
  }
  const interpretation = OrderRequirementInterpretationSchema.parse({
    version: "order-requirements-v1", basis: input.basis, instructions: draft.instructions, sources, texts,
    notes: sources.filter(source => source.role === "notes" && active.has(source.sourceFieldKey) && source.value.trim()).map(source => ({ sourceFieldKey: source.sourceFieldKey, original: source.value })),
    options: sources.filter(source => !["text", "font", "color", "image", "notes"].includes(source.role)).map(source => ({ sourceFieldKey: source.sourceFieldKey, role: source.role, label: source.label, value: source.value })),
    coverage: sources.map(source => ({ sourceFieldKey: source.sourceFieldKey,
      status: unresolved.some(issue => issue.sourceFieldKeys.includes(source.sourceFieldKey)) ? "needs_review" : !source.value.trim() ? "empty" : targets.has(source.sourceFieldKey) ? "matched" : "retained",
      targetFieldKey: targets.get(source.sourceFieldKey) ?? null,
      reason: targets.has(source.sourceFieldKey) ? "已匹配制作字段" : ["font", "color"].includes(source.role) ? "原始文字样式选项已保留，不作为独立印字内容" : "原始要求已保留并交给无人设计，无需逐条选择模板字段" })),
    unresolved,
  });
  for (const field of draft.fields) {
    const key = field.sourceKey ?? field.key, source = sources.find(row => row.sourceFieldKey === key);
    if (!source) continue;
    field.sourceKey = source.sourceFieldKey;
    delete field.font; delete field.color;
    const printable = interpretation.texts.find(row => row.sourceFieldKey === key && row.needsPrinting);
    if (printable?.font.requested) field.font = printable.font.requested;
    if (printable?.color.hex) field.color = printable.color.hex;
  }
  return { interpretation, normalizedDraft: draft };
}
