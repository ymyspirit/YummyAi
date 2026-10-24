import { z } from "zod";

export const PodProcessorMediaTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp", "image/tiff", "image/svg+xml", "video/mp4", "application/zip", "application/postscript", "text/plain"]);

export const PodProcessorResultV1Schema = z.object({
  outputs: z.array(z.object({
    dataBase64: z.string().min(1),
    mediaType: PodProcessorMediaTypeSchema,
    role: z.enum(["effect", "production"]),
    fileName: z.string().min(1).max(180),
    metadata: z.object({
      width: z.number().positive().finite().optional(),
      height: z.number().positive().finite().optional(),
      unit: z.enum(["px", "mm", "in"]).optional(),
      dpi: z.number().positive().finite().max(2_400).optional(),
      colorMode: z.enum(["rgb", "cmyk", "grayscale", "spot"]).optional(),
      transparent: z.boolean().optional(),
      durationSeconds: z.number().positive().max(60).optional(),
      fps: z.union([z.literal(24), z.literal(25), z.literal(30)]).optional(),
      videoCodec: z.literal("h264").optional(),
      audioCodec: z.enum(["none", "aac"]).optional(),
      aiInference: z.enum(["none", "partial", "full"]),
      inferenceRegions: z.array(z.object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().positive().finite(),
        height: z.number().positive().finite(),
      }).strict()).max(1_000).optional(),
    }).strict().superRefine((metadata, context) => {
      if (metadata.aiInference === "partial" && !metadata.inferenceRegions?.length) {
        context.addIssue({ code: "custom", path: ["inferenceRegions"], message: "Partial AI inference requires machine-readable regions" });
      }
      if ([metadata.width, metadata.height, metadata.unit].filter((value) => value !== undefined).length % 3 !== 0) {
        context.addIssue({ code: "custom", path: ["width"], message: "Output dimensions require width, height, and unit together" });
      }
    }),
  }).strict().superRefine((output, context) => {
    const packaged = output.mediaType === "text/plain" || output.mediaType === "application/zip";
    if (!packaged && !output.metadata.width) {
      context.addIssue({ code: "custom", path: ["metadata", "width"], message: "Visual outputs require dimensions" });
    }
    if (!packaged && output.metadata.colorMode === undefined) {
      context.addIssue({ code: "custom", path: ["metadata", "colorMode"], message: "Visual outputs require a color mode" });
    }
    if (!packaged && output.metadata.transparent === undefined) {
      context.addIssue({ code: "custom", path: ["metadata", "transparent"], message: "Visual outputs require transparency metadata" });
    }
  })).min(1).max(100),
  modelKey: z.string().min(1).max(160),
  modelVersion: z.string().min(1).max(160),
  seed: z.string().min(1).max(160).optional(),
  costUsd: z.number().nonnegative().finite().optional(),
  qualityCheckSnapshot: z.record(z.string(), z.unknown()),
  partial: z.boolean().default(false),
}).strict();

export type PodProcessorResultV1 = z.infer<typeof PodProcessorResultV1Schema>;
