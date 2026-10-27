import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";

const SourceKey = z.string().min(1).max(500);
const Checksum = z.string().regex(/^[a-f0-9]{64}$/);
export const OrderRequirementRoleSchema = z.enum([
  "text", "font", "color", "image", "crop", "side", "size", "notes", "enhancement", "option", "unknown",
]);
export const OrderRequirementSourceSchema = z.object({
  sourceFieldKey: SourceKey, surfaceKey: SourceKey, groupKey: SourceKey,
  origin: z.enum(["amazon_raw", "operator", "legacy_unresolved"]),
  jsonPointer: z.string().max(4000), role: OrderRequirementRoleSchema,
  fontJsonPointer: z.string().max(4000).optional(), colorJsonPointer: z.string().max(4000).optional(),
  label: z.string().max(500), value: z.string().max(20000),
  requestedFont: z.string().max(500).nullable(),
  colorLabel: z.string().max(500).nullable(), colorHex: z.string().regex(/^#[a-fA-F0-9]{6}$/).nullable(),
  targetTextKey: SourceKey.nullable(),
}).strict();
export const OrderRequirementBasisSchema = z.object({
  orderLineId: Id, revision: z.int().nonnegative(), projectionVersion: z.int().nonnegative(),
  sourceVersionId: Id.nullable(), draftChecksum: Checksum,
  artworkVersionId: Id.nullable(), specificationVersionId: Id.nullable(),
  printProfileVersionId: Id.nullable(), templateVersionId: Id.nullable(),
}).strict();
export const OrderRequirementInterpretationSchema = z.object({
  version: z.literal("order-requirements-v1"), basis: OrderRequirementBasisSchema,
  instructions: z.string().max(10000),
  sources: z.array(OrderRequirementSourceSchema).max(500),
  texts: z.array(z.object({
    sourceFieldKey: SourceKey, groupKey: SourceKey, originalText: z.string().max(20000),
    needsPrinting: z.boolean(),
    font: z.object({ requested: z.string().max(500).nullable(), sourceFieldKey: SourceKey.nullable() }).strict(),
    color: z.object({ label: z.string().max(500).nullable(), hex: z.string().regex(/^#[a-fA-F0-9]{6}$/).nullable(), sourceFieldKey: SourceKey.nullable() }).strict(),
  }).strict()).max(500),
  notes: z.array(z.object({ sourceFieldKey: SourceKey, original: z.string().max(20000) }).strict()).max(500),
  options: z.array(z.object({ sourceFieldKey: SourceKey, role: OrderRequirementRoleSchema, label: z.string().max(500), value: z.string().max(20000) }).strict()).max(500),
  coverage: z.array(z.object({
    sourceFieldKey: SourceKey, status: z.enum(["matched", "retained", "empty", "needs_review"]),
    targetFieldKey: z.string().max(100).nullable(), reason: z.string().max(2000),
  }).strict()).max(500),
  unresolved: z.array(z.object({ code: z.string().min(1).max(100), sourceFieldKeys: z.array(SourceKey).max(500), message: z.string().min(1).max(2000) }).strict()).max(100),
}).strict().superRefine((value, context) => {
  const keys = new Set(value.sources.map(source => source.sourceFieldKey));
  if (keys.size !== value.sources.length || value.coverage.length !== keys.size ||
    new Set(value.coverage.map(row => row.sourceFieldKey)).size !== keys.size ||
    value.coverage.some(row => !keys.has(row.sourceFieldKey)))
    context.addIssue({ code: "custom", path: ["coverage"], message: "每个原始定制字段必须且只能有一条处理说明" });
  for (const rows of [value.texts, value.notes, value.options]) {
    if (new Set(rows.map(row => row.sourceFieldKey)).size !== rows.length)
      context.addIssue({ code: "custom", message: "同一原始要求不能重复生成制作内容" });
  }
  for (const note of value.notes) {
    const source = value.sources.find(row => row.sourceFieldKey === note.sourceFieldKey);
    if (!source || source.role !== "notes" || note.original !== source.value)
      context.addIssue({ code: "custom", path: ["notes"], message: "顾客备注必须保留对应来源的完整原文" });
  }
  for (const option of value.options) {
    const source = value.sources.find(row => row.sourceFieldKey === option.sourceFieldKey);
    if (!source || ["text", "font", "color", "image", "notes"].includes(source.role) ||
      option.role !== source.role || option.label !== source.label || option.value !== source.value)
      context.addIssue({ code: "custom", path: ["options"], message: "定制选项必须与原始字段保持一致" });
  }
  if (value.unresolved.some(issue => issue.sourceFieldKeys.some(key => !keys.has(key))))
    context.addIssue({ code: "custom", path: ["unresolved"], message: "待核对内容必须引用本次原始要求" });
  for (const text of value.texts) {
    const source = value.sources.find(row => row.sourceFieldKey === text.sourceFieldKey);
    if (!source || source.role !== "text" || source.groupKey !== text.groupKey ||
      text.originalText !== source.value || text.needsPrinting !== !!text.originalText.trim())
      context.addIssue({ code: "custom", path: ["texts"], message: "印字要求必须对应本组实际文字，空文字不生成文字层" });
    for (const [style, role] of [[text.font, "font"], [text.color, "color"]] as const) {
      if (!style.sourceFieldKey) {
        if (role === "font" ? "requested" in style && style.requested !== null
          : "hex" in style && (style.hex !== null || style.label !== null))
          context.addIssue({ code: "custom", path: ["texts"], message: "文字样式必须有本组原始依据，不能补造字色" });
        continue;
      }
      const ref = value.sources.find(row => row.sourceFieldKey === style.sourceFieldKey);
      const ownInlineStyle = ref?.role === "text" && ref.sourceFieldKey === text.sourceFieldKey;
      if (!ref || (ref.role !== role && !ownInlineStyle) || ref.groupKey !== text.groupKey ||
        (ref.targetTextKey !== text.sourceFieldKey && !ownInlineStyle))
        context.addIssue({ code: "custom", path: ["texts"], message: "字体或颜色不能跨文字组应用" });
      if (ref && (role === "font" ? "requested" in style && style.requested !== ref.requestedFont
        : "hex" in style && (style.hex !== ref.colorHex || style.label !== ref.colorLabel)))
        context.addIssue({ code: "custom", path: ["texts"], message: "文字样式必须与引用的实际字体、色值一致" });
    }
  }
});
export type OrderRequirementRole = z.infer<typeof OrderRequirementRoleSchema>;
export type OrderRequirementSource = z.infer<typeof OrderRequirementSourceSchema>;
export type OrderRequirementBasis = z.infer<typeof OrderRequirementBasisSchema>;
export type OrderRequirementInterpretation = z.infer<typeof OrderRequirementInterpretationSchema>;

/** Stable browser/server input identity. SHA256 is applied to the UTF-8 result. */
export function orderRequirementDraftInput(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(Object.entries(item).filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonical(entry)]));
    return item;
  };
  return JSON.stringify(canonical(value));
}
