import { z } from "zod";

export const CapturePlatformSchema = z.enum(["amazon", "etsy"]);
export const CaptureDomainSchema = z.enum(["research", "authorized"]);
export const CaptureStatusSchema = z.enum(["complete", "partial", "failed"]);

export const CaptureDiagnosticSchema = z.object({
  field: z.string().min(1),
  code: z.enum(["missing", "invalid", "selector_error"]),
  message: z.string().min(1),
  severity: z.enum(["warning", "error"]),
});

export const CaptureMediaSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["image", "video"]),
  sourceUrl: z.url(),
  alt: z.string().optional(),
  included: z.boolean().default(true),
});

export const CaptureVariantSchema = z.object({
  label: z.string().min(1),
  options: z.array(
    z.object({
      label: z.string().min(1),
      externalId: z.string().optional(),
    }),
  ),
});

export const CaptureContentBlockSchema = z.object({
  kind: z.enum(["description", "aplus", "personalization", "review"]),
  text: z.string().min(1),
  sourceSelector: z.string().min(1),
});

export const CapturePriceSchema = z.object({
  raw: z.string().min(1),
  amount: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
});

export const CaptureDraftSchema = z.object({
  platform: CapturePlatformSchema,
  parserVersion: z.string().min(1),
  extensionVersion: z.string().min(1),
  marketplace: z.string().min(1),
  sourceUrl: z.url(),
  externalId: z.string().min(1).nullable(),
  title: z.string().min(1).nullable(),
  domain: CaptureDomainSchema.default("research"),
  price: CapturePriceSchema.nullable(),
  rating: z.number().min(0).max(5).nullable(),
  reviewCount: z.number().int().nonnegative().nullable(),
  bullets: z.array(z.string().min(1)),
  media: z.array(CaptureMediaSchema),
  variants: z.array(CaptureVariantSchema),
  contentBlocks: z.array(CaptureContentBlockSchema),
  missingFields: z.array(z.string().min(1)),
  diagnostics: z.array(CaptureDiagnosticSchema),
  captureStatus: CaptureStatusSchema,
  capturedAt: z.iso.datetime(),
});

export type CaptureDraft = z.infer<typeof CaptureDraftSchema>;
export type AmazonCaptureDraft = CaptureDraft & { platform: "amazon" };
export type EtsyCaptureDraft = CaptureDraft & { platform: "etsy" };
export type CaptureDomain = z.infer<typeof CaptureDomainSchema>;
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>;
