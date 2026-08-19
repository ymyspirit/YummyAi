import { z } from "zod";

const EntityIdSchema = z.uuidv7();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const VersionNumberSchema = z.int().positive();
const JsonSnapshotSchema = z.record(z.string(), z.unknown());

export const TEMPLATE_SOURCE_PARSER = {
  key: "yummyai-template-source",
  version: "1.0.0",
} as const;

export const PersonalizationTemplateStatusSchema = z.enum(["draft", "pending_review", "approved", "rejected", "archived"]);
export const PersonalizationTemplateSourceSchema = z.enum(["blank", "png", "psd", "popular_template"]);
export const TemplateSourceInspectionStatusSchema = z.enum(["queued", "running", "completed", "failed"]);
export const TemplateSlotKindSchema = z.enum(["image", "text", "decoration", "background"]);
export const TemplateSlotGeometrySchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
  rotationDegrees: z.number().finite().min(-360).max(360).default(0),
});
export const TemplateCanvasSchema = z.object({
  width: z.int().positive().max(100_000),
  height: z.int().positive().max(100_000),
  dpi: z.int().min(36).max(2_400),
  colorMode: z.enum(["rgb", "cmyk", "grayscale"]),
  background: z.string().trim().min(1).max(120).optional(),
});

export const CreateTemplateSlotInputSchema = z.object({
  stableKey: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/),
  name: z.string().trim().min(1).max(200),
  kind: TemplateSlotKindSchema,
  psdGroup: TemplateSlotKindSchema.optional(),
  geometry: TemplateSlotGeometrySchema,
  fillMode: z.enum(["contain", "cover", "stretch", "tile", "none"]),
  validationSnapshot: JsonSnapshotSchema,
  replaceable: z.boolean(),
  reuseLabel: z.string().trim().min(1).max(120).optional(),
});

const PersonalizationTemplateVersionInputBaseSchema = z.object({
  templateId: EntityIdSchema.optional(),
  name: z.string().trim().min(1).max(200),
  source: PersonalizationTemplateSourceSchema,
  sourceAssetId: EntityIdSchema.optional(),
  sourceAssetVersion: VersionNumberSchema.optional(),
  sourceInspectionId: EntityIdSchema.optional(),
  sourceTemplateVersionId: EntityIdSchema.optional(),
  canvas: TemplateCanvasSchema,
  previewAssetId: EntityIdSchema.optional(),
  slots: z.array(CreateTemplateSlotInputSchema).max(500),
});

export const CreatePersonalizationTemplateVersionInputSchema = PersonalizationTemplateVersionInputBaseSchema.superRefine((value, context) => {
  if ((value.source === "png" || value.source === "psd") && (!value.sourceAssetId || !value.sourceAssetVersion || !value.sourceInspectionId)) {
    context.addIssue({ code: "custom", path: ["sourceAssetId"], message: "Imported templates require a pinned source asset version" });
  }
  if (!(value.source === "png" || value.source === "psd") && value.sourceInspectionId) {
    context.addIssue({ code: "custom", path: ["sourceInspectionId"], message: "Only PNG or PSD templates can reference a source inspection" });
  }
  if (value.source === "popular_template" && !value.sourceTemplateVersionId) {
    context.addIssue({ code: "custom", path: ["sourceTemplateVersionId"], message: "Copied templates require a pinned source template version" });
  }
  if (value.source !== "popular_template" && value.sourceTemplateVersionId) {
    context.addIssue({ code: "custom", path: ["sourceTemplateVersionId"], message: "Only copied templates can reference a source template version" });
  }
  const keys = new Set<string>();
  value.slots.forEach((slot, index) => {
    if (keys.has(slot.stableKey)) context.addIssue({ code: "custom", path: ["slots", index, "stableKey"], message: "Slot stable keys must be unique" });
    keys.add(slot.stableKey);
    if (value.source === "psd" && slot.psdGroup !== slot.kind) {
      context.addIssue({ code: "custom", path: ["slots", index, "psdGroup"], message: "PSD slots must be classified into the matching image, text, decoration, or background group" });
    }
  });
});

export const ClonePersonalizationTemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
}).strict();

export const CreateTemplateSourceInspectionInputSchema = z.object({
  sourceAssetId: EntityIdSchema,
  sourceAssetVersion: VersionNumberSchema,
  idempotencyKey: EntityIdSchema,
}).strict();

export const TemplateSourceInspectionWarningSchema = z.object({
  code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,79}$/),
  message: z.string().trim().min(1).max(500),
  layerPath: z.array(z.string().trim().min(1).max(200)).max(32).optional(),
}).strict();

export const TemplateSourceInspectionSlotSchema = CreateTemplateSlotInputSchema.extend({
  sourceLayerPath: z.array(z.string().trim().min(1).max(200)).min(1).max(32),
  confidencePermille: z.int().min(0).max(1_000),
}).strict();

export const PersonalizationTemplateSourceInspectionSchema = z.object({
  id: EntityIdSchema,
  sourceAssetId: EntityIdSchema,
  sourceAssetVersion: VersionNumberSchema,
  checksumSha256: Sha256Schema,
  source: z.enum(["png", "psd"]),
  status: TemplateSourceInspectionStatusSchema,
  parserKey: z.string().trim().min(1).max(120),
  parserVersion: z.string().trim().min(1).max(120),
  canvas: TemplateCanvasSchema.optional(),
  slots: z.array(TemplateSourceInspectionSlotSchema).max(500),
  warnings: z.array(TemplateSourceInspectionWarningSchema).max(500),
  errorCode: z.string().trim().min(1).max(120).optional(),
  errorMessage: z.string().trim().min(1).max(500).optional(),
  requestedBy: EntityIdSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
}).strict().superRefine((value, context) => {
  if (value.status === "completed" && !value.canvas) {
    context.addIssue({ code: "custom", path: ["canvas"], message: "Completed source inspections require a canvas snapshot" });
  }
  if (value.status === "failed" && (!value.errorCode || !value.errorMessage)) {
    context.addIssue({ code: "custom", path: ["errorCode"], message: "Failed source inspections require an error" });
  }
});

export const PersonalizationTemplateSourceInspectionListSchema = z.object({
  items: z.array(PersonalizationTemplateSourceInspectionSchema).max(500),
}).strict();

export const ConfirmTemplateSourceInspectionSlotInputSchema = z.object({
  stableKey: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/),
  name: z.string().trim().min(1).max(200),
  kind: TemplateSlotKindSchema,
  fillMode: z.enum(["contain", "cover", "stretch", "tile", "none"]),
  replaceable: z.boolean(),
  reuseLabel: z.string().trim().min(1).max(120).optional(),
}).strict();

export const ConfirmTemplateSourceInspectionInputSchema = z.object({
  templateId: EntityIdSchema.optional(),
  name: z.string().trim().min(1).max(200),
  acknowledgeWarnings: z.boolean(),
  slots: z.array(ConfirmTemplateSourceInspectionSlotInputSchema).min(1).max(500),
}).strict().superRefine((value, context) => {
  const keys = new Set<string>();
  value.slots.forEach((slot, index) => {
    if (keys.has(slot.stableKey)) {
      context.addIssue({ code: "custom", path: ["slots", index, "stableKey"], message: "Confirmed slot keys must be unique" });
    }
    keys.add(slot.stableKey);
  });
});

export const TemplateSlotSchema = CreateTemplateSlotInputSchema.extend({
  id: EntityIdSchema,
  templateVersionId: EntityIdSchema,
});

export const PersonalizationTemplateVersionSchema = PersonalizationTemplateVersionInputBaseSchema.omit({ slots: true }).extend({
  id: EntityIdSchema,
  templateId: EntityIdSchema,
  versionNumber: VersionNumberSchema,
  status: PersonalizationTemplateStatusSchema,
  slots: z.array(TemplateSlotSchema),
  createdBy: EntityIdSchema.optional(),
  createdAt: z.iso.datetime(),
});

export const PersonalizationTemplateVersionListSchema = z.object({
  items: z.array(PersonalizationTemplateVersionSchema).max(500),
}).strict();

export const PodPersonalizationOptionsViewSchema = z.object({
  skus: z.array(z.object({
    id: EntityIdSchema,
    code: z.string().min(1),
    spuCode: z.string().min(1),
    productName: z.string().min(1),
  }).strict()).max(500),
  sourceAssets: z.array(z.object({
    id: EntityIdSchema,
    version: VersionNumberSchema,
    fileName: z.string().min(1),
    mediaType: z.string().min(1),
  }).strict()).max(500),
}).strict();

export const TemplateMappingSnapshotSchema = z.object({
  slotFieldMap: z.record(
    z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/),
    z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
  ),
  fitOverrides: z.record(
    z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/),
    z.enum(["contain", "cover", "stretch", "tile", "none"]),
  ).optional(),
}).strict();

export const CreateSkuTemplateBindingInputSchema = z.object({
  skuId: EntityIdSchema,
  templateVersionId: EntityIdSchema,
  sizeLabel: z.string().trim().min(1).max(120),
  mappingSnapshot: TemplateMappingSnapshotSchema,
  effectiveFrom: z.iso.datetime(),
  effectiveTo: z.iso.datetime().optional(),
});

export const SkuTemplateBindingSchema = CreateSkuTemplateBindingInputSchema.extend({
  id: EntityIdSchema,
  status: z.enum(["active", "inactive"]),
  createdBy: EntityIdSchema.optional(),
  createdAt: z.iso.datetime(),
});

export const PodReviewDecisionInputSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(1).max(2_000).optional(),
}).superRefine((value, context) => {
  if (value.decision === "reject" && !value.reason) {
    context.addIssue({ code: "custom", path: ["reason"], message: "A rejection reason is required" });
  }
});

export const ProductionColorModeSchema = z.enum(["rgb", "cmyk", "grayscale", "spot"]);
export const ProductionFileSnapshotSchema = z.object({
  assetId: EntityIdSchema,
  assetVersion: VersionNumberSchema,
  checksumSha256: Sha256Schema,
  fileName: z.string().trim().min(1).max(500),
  mediaType: z.enum(["image/png", "image/tiff", "image/svg+xml", "application/postscript"]),
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
  unit: z.enum(["px", "mm", "in"]),
  dpi: z.int().min(36).max(2_400).optional(),
  colorMode: ProductionColorModeSchema,
});

const ProductionManifestInputBaseSchema = z.object({
  orderLineId: EntityIdSchema.optional(),
  designVersionId: EntityIdSchema.optional(),
  templateVersionId: EntityIdSchema.optional(),
  inputSnapshot: z.array(z.object({
    assetId: EntityIdSchema,
    assetVersion: VersionNumberSchema,
    checksumSha256: Sha256Schema,
  })).min(1).max(500),
  files: z.array(ProductionFileSnapshotSchema).min(1).max(500),
  qualityCheckSnapshot: JsonSnapshotSchema,
});

function validateProductionManifest(value: z.infer<typeof ProductionManifestInputBaseSchema>, context: z.RefinementCtx) {
  if (!value.orderLineId && !value.designVersionId) {
    context.addIssue({ code: "custom", path: ["orderLineId"], message: "A production manifest requires an order line or design version source" });
  }
}

export const CreateProductionManifestInputSchema = ProductionManifestInputBaseSchema.superRefine(validateProductionManifest);

export const ProductionManifestSchema = ProductionManifestInputBaseSchema.extend({
  id: EntityIdSchema,
  status: z.enum(["pending_review", "approved", "rejected"]),
  reviewedBy: EntityIdSchema.optional(),
  reviewedAt: z.iso.datetime().optional(),
  rejectionReason: z.string().max(2_000).optional(),
  createdBy: EntityIdSchema.optional(),
  createdAt: z.iso.datetime(),
}).superRefine(validateProductionManifest);

export const ProductionManifestListSchema = z.object({
  items: z.array(ProductionManifestSchema).max(500),
}).strict();

export type CreatePersonalizationTemplateVersionInput = z.infer<typeof CreatePersonalizationTemplateVersionInputSchema>;
export type ClonePersonalizationTemplateInput = z.infer<typeof ClonePersonalizationTemplateInputSchema>;
export type CreateTemplateSourceInspectionInput = z.infer<typeof CreateTemplateSourceInspectionInputSchema>;
export type TemplateSourceInspectionStatus = z.infer<typeof TemplateSourceInspectionStatusSchema>;
export type TemplateSourceInspectionWarning = z.infer<typeof TemplateSourceInspectionWarningSchema>;
export type TemplateSourceInspectionSlot = z.infer<typeof TemplateSourceInspectionSlotSchema>;
export type PersonalizationTemplateSourceInspection = z.infer<typeof PersonalizationTemplateSourceInspectionSchema>;
export type PersonalizationTemplateSourceInspectionList = z.infer<typeof PersonalizationTemplateSourceInspectionListSchema>;
export type ConfirmTemplateSourceInspectionInput = z.infer<typeof ConfirmTemplateSourceInspectionInputSchema>;
export type PersonalizationTemplateVersion = z.infer<typeof PersonalizationTemplateVersionSchema>;
export type PersonalizationTemplateVersionList = z.infer<typeof PersonalizationTemplateVersionListSchema>;
export type PodPersonalizationOptionsView = z.infer<typeof PodPersonalizationOptionsViewSchema>;
export type TemplateCanvas = z.infer<typeof TemplateCanvasSchema>;
export type TemplateSlotGeometry = z.infer<typeof TemplateSlotGeometrySchema>;
export type CreateTemplateSlotInput = z.infer<typeof CreateTemplateSlotInputSchema>;
export type TemplateSlot = z.infer<typeof TemplateSlotSchema>;
export type CreateSkuTemplateBindingInput = z.infer<typeof CreateSkuTemplateBindingInputSchema>;
export type SkuTemplateBinding = z.infer<typeof SkuTemplateBindingSchema>;
export type TemplateMappingSnapshot = z.infer<typeof TemplateMappingSnapshotSchema>;
export type PodReviewDecisionInput = z.infer<typeof PodReviewDecisionInputSchema>;
export type ProductionFileSnapshot = z.infer<typeof ProductionFileSnapshotSchema>;
export type CreateProductionManifestInput = z.infer<typeof CreateProductionManifestInputSchema>;
export type ProductionManifest = z.infer<typeof ProductionManifestSchema>;
export type ProductionManifestList = z.infer<typeof ProductionManifestListSchema>;
