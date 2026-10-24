import { z } from "zod";
import { CustomizationSchema } from "@yummyai/contracts/catalog/product";

export const ArtworkModeSchema = z.enum(["fixed", "personalized_text", "customer_image", "mixed"]);
export const ArtworkMaterialRoleSchema = z.enum([
  "master",
  "source",
  "background",
  "decoration",
  "font",
  "reference",
]);
export const ArtworkMaterialInputSchema = z
  .object({
    assetId: z.uuidv7(),
    role: ArtworkMaterialRoleSchema,
    usage: z.string().trim().min(1).max(160),
  })
  .strict();
export const ArtworkMaterialSchema = ArtworkMaterialInputSchema.extend({
  assetVersion: z.int().positive(),
  checksumSha256: z.string().length(64),
  fileName: z.string(),
  mediaType: z.string(),
}).strict();
export const ArtworkPlacementSchema = z
  .object({
    fieldKey: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
    surface: z.enum(["front", "back"]).optional(),
    xPercent: z.number().min(0).max(100),
    yPercent: z.number().min(0).max(100),
    widthPercent: z.number().positive().max(100),
    heightPercent: z.number().positive().max(100),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#111111"),
  })
  .strict()
  .refine(
    (v) => v.xPercent + v.widthPercent <= 100 && v.yPercent + v.heightPercent <= 100,
    "定制区域须位于版面内",
  );
export const ArtworkLayoutSchema = z
  .array(ArtworkPlacementSchema)
  .max(30)
  .refine(
    (v) => new Set(v.map((p) => p.fieldKey)).size === v.length,
    "每个定制字段只能绑定一个区域",
  );
export const CreativeRequirementsSchema = z
  .object({
    mode: ArtworkModeSchema,
    audience: z.string().trim().max(500).default(""),
    occasion: z.string().trim().max(500).default(""),
    style: z.string().trim().max(1000).default(""),
    fixedElements: z.string().trim().max(2000).default(""),
    imageInstructions: z.string().trim().max(2000).default(""),
    researchItemIds: z.array(z.uuidv7()).max(30).default([]),
    specificationVersionIds: z.array(z.uuidv7()).max(50).default([]),
    customization: CustomizationSchema.default({ version: 1, fields: [] }),
    layout: ArtworkLayoutSchema.default([]),
    acceptance: z.string().trim().max(3000).default(""),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.mode === "fixed" && (v.customization.fields.length || v.layout.length))
      ctx.addIssue({
        code: "custom",
        message: "固定印花不包含买家定制字段",
        path: ["customization"],
      });
    for (const p of v.layout)
      if (!v.customization.fields.some((f) => f.key === p.fieldKey))
        ctx.addIssue({ code: "custom", message: "排版区域必须关联已有定制字段", path: ["layout"] });
    if (
      new Set(v.researchItemIds).size !== v.researchItemIds.length ||
      new Set(v.specificationVersionIds).size !== v.specificationVersionIds.length
    )
      ctx.addIssue({ code: "custom", message: "研究来源和规格不可重复" });
  });
export type ArtworkMaterial = z.infer<typeof ArtworkMaterialSchema>;
export type ArtworkLayout = z.infer<typeof ArtworkLayoutSchema>;
export type CreativeRequirements = z.infer<typeof CreativeRequirementsSchema>;

export function creativeRequirementsText(r: CreativeRequirements): string {
  return [
    `定制方式：${{ fixed: "固定印花", personalized_text: "文字定制", customer_image: "图片定制", mixed: "图文定制" }[r.mode]}`,
    r.audience && `目标人群：${r.audience}`,
    r.occasion && `场景：${r.occasion}`,
    r.style && `风格与配色：${r.style}`,
    r.fixedElements && `固定元素：${r.fixedElements}`,
    r.imageInstructions && `图片处理要求：${r.imageInstructions}`,
    ...r.customization.fields.map(
      (f) =>
        `定制字段 ${f.key}（${f.label}）：${f.type}，${f.required ? "必填" : "可选"}。${f.helpText ?? ""}${(f.type === "short_text" || f.type === "long_text") && f.validation?.maxLength ? `最多 ${f.validation.maxLength} 字符。` : ""}`,
    ),
    ...r.layout.map(
      (p) =>
        `预留区域 ${p.fieldKey}：左 ${p.xPercent}%，上 ${p.yPercent}%，宽 ${p.widthPercent}%，高 ${p.heightPercent}%。`,
    ),
    r.acceptance && `验收要求：${r.acceptance}`,
    r.mode !== "fixed" &&
      "本项目交付可复用母版。定制区域供订单替换，不把示例名字或照片永久合并进母版。",
  ]
    .filter(Boolean)
    .join("\n");
}
