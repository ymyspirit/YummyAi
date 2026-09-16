import { z } from "zod";
import { CreativeRequirementsSchema } from "@yummyai/contracts/catalog/artwork";

export const ResearchStudyStatusSchema = z.enum(["unreviewed", "analyzed", "parked"]);
export const ResearchStudyContentSchema = z
  .object({
    audience: CreativeRequirementsSchema.shape.audience,
    occasion: CreativeRequirementsSchema.shape.occasion,
    style: CreativeRequirementsSchema.shape.style,
    fixedElements: CreativeRequirementsSchema.shape.fixedElements,
    imageInstructions: CreativeRequirementsSchema.shape.imageInstructions,
    acceptance: CreativeRequirementsSchema.shape.acceptance,
  })
  .extend({
    status: ResearchStudyStatusSchema.default("unreviewed"),
    theme: z.string().trim().max(160).default(""),
    buyingReasons: z.string().trim().max(2000).default(""),
    differentiation: z.string().trim().max(2000).default(""),
    customizationNotes: z.string().trim().max(2000).default(""),
    annotations: z
      .array(
        z
          .object({
            mediaIndex: z.int().nonnegative(),
            note: z.string().trim().min(1).max(1000),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.annotations.map((note) => note.mediaIndex)).size === value.annotations.length,
    "同一图片或视频只保留一条批注",
  );

export const SaveResearchStudyInputSchema = z
  .object({
    requestId: z.uuid(),
    snapshotId: z.uuidv7(),
    expectedVersion: z.int().nonnegative(),
    content: ResearchStudyContentSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.content.status !== "analyzed" ||
      Boolean(value.content.theme && value.content.differentiation),
    "完成研究前请填写设计主题与差异化方向",
  );

export const ResearchSourceSelectionSchema = z
  .object({
    researchItemId: z.uuidv7(),
    snapshotId: z.uuidv7().optional(),
    studyRevisionId: z.uuidv7().nullable().optional(),
  })
  .strict();
export const ResolveResearchSourcesInputSchema = z
  .object({
    sources: z.array(ResearchSourceSelectionSchema).max(30),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.sources.map((source) => source.researchItemId)).size === value.sources.length,
    "研究来源不可重复",
  );

export const ResearchSourceReferenceSchema = z
  .object({
    domain: z.literal("research"),
    researchItemId: z.uuidv7(),
    snapshotId: z.uuidv7(),
    studyRevisionId: z.uuidv7().nullable(),
    studyVersion: z.int().nonnegative(),
    title: z.string(),
    sourceUrl: z.string().url(),
    platform: z.enum(["amazon", "etsy"]),
    capturedAt: z.string(),
    thumbnailUrl: z.string().url().nullable(),
    mediaCount: z.int().nonnegative(),
    content: ResearchStudyContentSchema.nullable(),
  })
  .strict();

export type ResearchStudyContent = z.infer<typeof ResearchStudyContentSchema>;
export type ResearchSourceReference = z.infer<typeof ResearchSourceReferenceSchema>;
export type ResearchSourceSelection = z.infer<typeof ResearchSourceSelectionSchema>;
export type ResearchStudyRevision = {
  id: string;
  researchItemId: string;
  snapshotId: string;
  version: number;
  content: ResearchStudyContent;
  createdAt: string;
};
export type ResearchStudyWorkspace = {
  revision: ResearchStudyRevision | null;
  latestSnapshotId: string | null;
  projects: Array<{ id: string; name: string }>;
};

export function researchSourceInstructions(sources: ResearchSourceReference[]): string {
  return sources
    .map((source, index) => {
      const content = source.content;
      return [
        `研究来源 ${index + 1}：${source.title}（采集 ${source.capturedAt}；研究 V${source.studyVersion}）`,
        `来源：${source.sourceUrl}`,
        ...(content
          ? [
              content.theme && `设计主题：${content.theme}`,
              content.audience && `目标人群：${content.audience}`,
              content.occasion && `使用场景：${content.occasion}`,
              content.buyingReasons && `购买动机：${content.buyingReasons}`,
              content.style && `风格与配色观察：${content.style}`,
              content.fixedElements && `图案与元素观察：${content.fixedElements}`,
              content.differentiation && `原创差异化方向：${content.differentiation}`,
              content.customizationNotes && `定制方式：${content.customizationNotes}`,
              content.imageInstructions && `图片处理要求：${content.imageInstructions}`,
              content.acceptance && `验收要求：${content.acceptance}`,
              ...content.annotations.map(
                (note) => `媒体 ${note.mediaIndex + 1} 批注：${note.note}`,
              ),
            ]
          : ["研究结论尚未填写，请由运营确认设计方向。"]),
        "以上为研究依据。最终印花使用原创或授权素材，产品尺寸与工艺以已确认的 SPU 规格为准。",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}
