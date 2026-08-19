import { z } from "zod";

const EntityIdSchema = z.uuidv7();

export const POD_BATCH_ITEM_LIMIT = 50;
export const POD_DESIGN_CANDIDATE_LIMIT = 4;
export const POD_DESIGN_REFERENCE_LIMIT = 10;
export const POD_PRINT_SPEC_LIMIT = 8;
export const POD_MOCKUP_SLOT_LIMIT = 16;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const VersionSchema = z.int().positive();
const IsoDateSchema = z.iso.datetime();

export const PodBatchStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_review",
  "partially_succeeded",
  "completed",
  "failed",
  "cancelled",
]);

export const CanvasWrapModeSchema = z.enum(["none", "mirror", "extend", "solid"]);
export const CanvasPhysicalSizeSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9_.-]{0,79}$/),
  label: z.string().trim().min(1).max(120),
  widthMm: z.number().positive().max(10_000),
  heightMm: z.number().positive().max(10_000),
}).strict();

const CanvasPrintSpecInputSchema = z.object({
  specId: EntityIdSchema.optional(),
  name: z.string().trim().min(1).max(160),
  aspectWidth: z.int().positive().max(100),
  aspectHeight: z.int().positive().max(100),
  targetDpi: z.int().min(72).max(2_400),
  bleedMm: z.number().min(0).max(500),
  safeZoneMm: z.number().min(0).max(500),
  wrapMode: CanvasWrapModeSchema,
  physicalSizes: z.array(CanvasPhysicalSizeSchema).min(1).max(50),
}).strict().superRefine((value, context) => {
  const keys = new Set<string>();
  value.physicalSizes.forEach((size, index) => {
    if (keys.has(size.key)) {
      context.addIssue({ code: "custom", path: ["physicalSizes", index, "key"], message: "Physical size keys must be unique" });
    }
    keys.add(size.key);
    const declared = value.aspectWidth / value.aspectHeight;
    const actual = size.widthMm / size.heightMm;
    if (Math.abs(actual - declared) / declared > 0.02) {
      context.addIssue({ code: "custom", path: ["physicalSizes", index], message: "Physical size must remain within two percent of the declared aspect ratio" });
    }
  });
});

export const CreateCanvasPrintSpecVersionInputSchema = CanvasPrintSpecInputSchema;
export const CanvasPrintSpecStatusSchema = z.enum(["draft", "approved", "rejected", "archived"]);
export const CanvasPrintSpecVersionSchema = CanvasPrintSpecInputSchema.safeExtend({
  id: EntityIdSchema,
  specId: EntityIdSchema,
  versionNumber: VersionSchema,
  status: CanvasPrintSpecStatusSchema,
  rejectionReason: z.string().trim().min(1).max(2_000).optional(),
  createdBy: EntityIdSchema.optional(),
  reviewedBy: EntityIdSchema.optional(),
  reviewedAt: IsoDateSchema.optional(),
  createdAt: IsoDateSchema,
}).strict();

export const ReviewVersionInputSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  rejectionReason: z.string().trim().min(1).max(2_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "reject" && !value.rejectionReason) {
    context.addIssue({ code: "custom", path: ["rejectionReason"], message: "Rejection requires a reason" });
  }
  if (value.decision === "approve" && value.rejectionReason) {
    context.addIssue({ code: "custom", path: ["rejectionReason"], message: "Approval cannot include a rejection reason" });
  }
});

export const CreateCreativeDesignBatchItemInputSchema = z.object({
  rowKey: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/),
  name: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(8_000),
  negativePrompt: z.string().trim().min(1).max(4_000).optional(),
  referenceAssetIds: z.array(EntityIdSchema).max(POD_DESIGN_REFERENCE_LIMIT).default([]),
  candidateCount: z.int().min(1).max(POD_DESIGN_CANDIDATE_LIMIT),
  printSpecVersionIds: z.array(EntityIdSchema).min(1).max(POD_PRINT_SPEC_LIMIT),
  focalPoint: z.object({ xPermille: z.int().min(0).max(1_000), yPermille: z.int().min(0).max(1_000) }).strict().default({ xPermille: 500, yPermille: 500 }),
}).strict().superRefine((value, context) => {
  if (new Set(value.referenceAssetIds).size !== value.referenceAssetIds.length) {
    context.addIssue({ code: "custom", path: ["referenceAssetIds"], message: "Reference assets must be unique" });
  }
  if (new Set(value.printSpecVersionIds).size !== value.printSpecVersionIds.length) {
    context.addIssue({ code: "custom", path: ["printSpecVersionIds"], message: "Print specification versions must be unique" });
  }
});

export const CreateCreativeDesignBatchInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  recipeVersionId: EntityIdSchema.optional(),
  items: z.array(CreateCreativeDesignBatchItemInputSchema).min(1).max(POD_BATCH_ITEM_LIMIT),
}).strict().superRefine((value, context) => {
  const rows = new Set<string>();
  value.items.forEach((item, index) => {
    if (rows.has(item.rowKey)) context.addIssue({ code: "custom", path: ["items", index, "rowKey"], message: "Batch row keys must be unique" });
    rows.add(item.rowKey);
  });
});

export const CreativeDesignCandidateStatusSchema = z.enum(["queued", "running", "generated", "selected", "failed", "cancelled"]);
export const CreativeDesignCandidateSchema = z.object({
  id: EntityIdSchema,
  itemId: EntityIdSchema,
  ordinal: z.int().min(0).max(POD_DESIGN_CANDIDATE_LIMIT - 1),
  status: CreativeDesignCandidateStatusSchema,
  assetId: EntityIdSchema.optional(),
  assetVersion: VersionSchema.optional(),
  checksumSha256: Sha256Schema.optional(),
  modelKey: z.string().trim().min(1).max(160).optional(),
  modelVersion: z.string().trim().min(1).max(160).optional(),
  promptTemplateVersion: z.string().trim().min(1).max(160),
  parameterSnapshot: z.record(z.string(), z.unknown()),
  inputChecksum: Sha256Schema,
  seed: z.string().trim().min(1).max(160).optional(),
  costUsd: z.number().nonnegative().optional(),
  qualitySnapshot: z.record(z.string(), z.unknown()).optional(),
  errorCode: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,79}$/).optional(),
  errorMessage: z.string().trim().min(1).max(500).optional(),
  createdAt: IsoDateSchema,
}).strict();

export const CreativeDesignVersionStatusSchema = z.enum(["adapting", "pending_review", "approved", "rejected"]);
export const CreativeDesignAssetRoleSchema = z.enum(["master", "aspect_variant"]);
export const CreativeDesignVersionAssetSchema = z.object({
  id: EntityIdSchema,
  assetId: EntityIdSchema,
  assetVersion: VersionSchema,
  role: CreativeDesignAssetRoleSchema,
  printSpecVersionId: EntityIdSchema.optional(),
  adaptationMode: z.enum(["original", "crop", "ai_outpaint"]),
  generatedRegions: z.array(z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).strict()).max(100).default([]),
  qualitySnapshot: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const CreativeDesignVersionSchema = z.object({
  id: EntityIdSchema,
  familyId: EntityIdSchema,
  versionNumber: VersionSchema,
  sourceCandidateId: EntityIdSchema,
  name: z.string().trim().min(1).max(160),
  status: CreativeDesignVersionStatusSchema,
  rejectionReason: z.string().trim().min(1).max(2_000).optional(),
  assets: z.array(CreativeDesignVersionAssetSchema).min(1).max(POD_PRINT_SPEC_LIMIT + 1),
  reviewedBy: EntityIdSchema.optional(),
  reviewedAt: IsoDateSchema.optional(),
  createdAt: IsoDateSchema,
}).strict();

export const CreativeDesignBatchItemSchema = CreateCreativeDesignBatchItemInputSchema.safeExtend({
  id: EntityIdSchema,
  status: PodBatchStatusSchema,
  candidates: z.array(CreativeDesignCandidateSchema).max(POD_DESIGN_CANDIDATE_LIMIT),
  creativeVersions: z.array(CreativeDesignVersionSchema).max(POD_DESIGN_CANDIDATE_LIMIT),
  errorCode: z.string().trim().min(1).max(80).optional(),
  errorMessage: z.string().trim().min(1).max(500).optional(),
}).strict();

export const CreativeDesignBatchSchema = z.object({
  id: EntityIdSchema,
  name: z.string().trim().min(1).max(160),
  recipeVersionId: EntityIdSchema.optional(),
  status: PodBatchStatusSchema,
  itemCount: z.int().min(1).max(POD_BATCH_ITEM_LIMIT),
  generatedCount: z.int().min(0).max(POD_BATCH_ITEM_LIMIT * POD_DESIGN_CANDIDATE_LIMIT),
  approvedCount: z.int().min(0).max(POD_BATCH_ITEM_LIMIT * POD_DESIGN_CANDIDATE_LIMIT),
  failedCount: z.int().min(0).max(POD_BATCH_ITEM_LIMIT),
  requestChecksum: Sha256Schema,
  createdBy: EntityIdSchema.optional(),
  createdAt: IsoDateSchema,
  completedAt: IsoDateSchema.optional(),
  items: z.array(CreativeDesignBatchItemSchema).max(POD_BATCH_ITEM_LIMIT).optional(),
}).strict();

export const CreateCreativeDesignSkuBindingsInputSchema = z.object({
  bindings: z.array(z.object({ skuId: EntityIdSchema, printSpecVersionId: EntityIdSchema }).strict()).min(1).max(POD_BATCH_ITEM_LIMIT),
}).strict().superRefine((value, context) => {
  const pairs = value.bindings.map((binding) => `${binding.skuId}:${binding.printSpecVersionId}`);
  if (new Set(pairs).size !== pairs.length) context.addIssue({ code: "custom", path: ["bindings"], message: "SKU and print specification binding pairs must be unique" });
});

export const CreativeDesignSkuBindingSchema = z.object({
  id: EntityIdSchema,
  creativeDesignVersionId: EntityIdSchema,
  skuId: EntityIdSchema,
  printSpecVersionId: EntityIdSchema,
  designTaskId: EntityIdSchema,
  designVersionId: EntityIdSchema,
  createdBy: EntityIdSchema.optional(),
  createdAt: IsoDateSchema,
}).strict();

export const MockupTemplateInspectionStatusSchema = z.enum(["queued", "running", "completed", "failed"]);
export const CreateMockupTemplateInspectionInputSchema = z.object({
  sourceAssetId: EntityIdSchema,
  sourceAssetVersion: VersionSchema,
  checksumSha256: Sha256Schema,
  slotKey: z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
}).strict();

export const MockupTemplateCompilationSchema = z.object({
  canvasWidth: z.int().positive().max(100_000),
  canvasHeight: z.int().positive().max(100_000),
  slotKey: z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
  transform: z.array(z.number().finite()).length(8),
  backgroundAssetId: EntityIdSchema,
  foregroundAssetId: EntityIdSchema,
  maskAssetId: EntityIdSchema.optional(),
  previewAssetId: EntityIdSchema,
  manifestAssetId: EntityIdSchema,
  checksumSha256: Sha256Schema,
  ssimPermille: z.int().min(990).max(1_000),
  compilerVersion: z.string().trim().min(1).max(160),
}).strict();

export const MockupTemplateInspectionSchema = CreateMockupTemplateInspectionInputSchema.extend({
  id: EntityIdSchema,
  status: MockupTemplateInspectionStatusSchema,
  compilation: MockupTemplateCompilationSchema.optional(),
  warnings: z.array(z.object({ code: z.string().trim().min(1).max(80), message: z.string().trim().min(1).max(500) }).strict()).max(100).default([]),
  errorCode: z.string().trim().min(1).max(80).optional(),
  errorMessage: z.string().trim().min(1).max(500).optional(),
  createdAt: IsoDateSchema,
  completedAt: IsoDateSchema.optional(),
}).strict();

export const MockupTemplatePackStatusSchema = z.enum(["draft", "approved", "rejected", "archived"]);
export const MockupTemplateSlotInputSchema = z.object({
  slotKey: z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
  label: z.string().trim().min(1).max(120),
  ordinal: z.int().min(0).max(POD_MOCKUP_SLOT_LIMIT - 1),
  required: z.boolean(),
  inspectionId: EntityIdSchema,
  acceptedPrintSpecVersionIds: z.array(EntityIdSchema).min(1).max(POD_PRINT_SPEC_LIMIT),
}).strict();

export const CreateMockupTemplatePackVersionInputSchema = z.object({
  packId: EntityIdSchema.optional(),
  name: z.string().trim().min(1).max(160),
  platform: z.enum(["amazon", "etsy"]),
  locale: z.string().trim().regex(/^[a-z]{2}-[A-Z]{2}$/),
  productCategory: z.literal("canvas_art"),
  slots: z.array(MockupTemplateSlotInputSchema).min(1).max(POD_MOCKUP_SLOT_LIMIT),
}).strict().superRefine((value, context) => {
  const keys = value.slots.map((slot) => slot.slotKey);
  const ordinals = value.slots.map((slot) => slot.ordinal);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", path: ["slots"], message: "Mockup slot keys must be unique" });
  if (new Set(ordinals).size !== ordinals.length) context.addIssue({ code: "custom", path: ["slots"], message: "Mockup slot ordinals must be unique" });
});

export const MockupTemplatePackVersionSchema = CreateMockupTemplatePackVersionInputSchema.safeExtend({
  id: EntityIdSchema,
  packId: EntityIdSchema,
  versionNumber: VersionSchema,
  status: MockupTemplatePackStatusSchema,
  rejectionReason: z.string().trim().min(1).max(2_000).optional(),
  createdBy: EntityIdSchema.optional(),
  reviewedBy: EntityIdSchema.optional(),
  reviewedAt: IsoDateSchema.optional(),
  createdAt: IsoDateSchema,
}).strict();

export const CreateMockupBatchInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  templatePackVersionId: EntityIdSchema,
  platform: z.enum(["amazon", "etsy"]),
  locale: z.string().trim().regex(/^[a-z]{2}-[A-Z]{2}$/),
  items: z.array(z.object({ designVersionId: EntityIdSchema, skuId: EntityIdSchema }).strict()).min(1).max(POD_BATCH_ITEM_LIMIT),
}).strict().superRefine((value, context) => {
  const pairs = value.items.map((item) => `${item.designVersionId}:${item.skuId}`);
  if (new Set(pairs).size !== pairs.length) context.addIssue({ code: "custom", path: ["items"], message: "Mockup batch design and SKU pairs must be unique" });
});

export const MockupOutputStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "approved", "rejected"]);
export const MockupBatchOutputSchema = z.object({
  id: EntityIdSchema,
  itemId: EntityIdSchema,
  slotKey: z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
  attempt: z.int().min(0).max(20),
  status: MockupOutputStatusSchema,
  assetId: EntityIdSchema.optional(),
  assetVersion: VersionSchema.optional(),
  checksumSha256: Sha256Schema.optional(),
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
  qualitySnapshot: z.record(z.string(), z.unknown()).optional(),
  errorCode: z.string().trim().min(1).max(80).optional(),
  errorMessage: z.string().trim().min(1).max(500).optional(),
  createdAt: IsoDateSchema,
}).strict();

export const MockupBatchItemSchema = z.object({
  id: EntityIdSchema,
  designVersionId: EntityIdSchema,
  skuId: EntityIdSchema,
  status: PodBatchStatusSchema,
  outputs: z.array(MockupBatchOutputSchema).max(POD_MOCKUP_SLOT_LIMIT),
  reviewedBy: EntityIdSchema.optional(),
  reviewedAt: IsoDateSchema.optional(),
  rejectionReason: z.string().trim().min(1).max(2_000).optional(),
}).strict();

export const MockupBatchSchema = z.object({
  id: EntityIdSchema,
  name: z.string().trim().min(1).max(160),
  templatePackVersionId: EntityIdSchema,
  platform: z.enum(["amazon", "etsy"]),
  locale: z.string().trim().regex(/^[a-z]{2}-[A-Z]{2}$/),
  status: PodBatchStatusSchema,
  itemCount: z.int().min(1).max(POD_BATCH_ITEM_LIMIT),
  completedCount: z.int().min(0).max(POD_BATCH_ITEM_LIMIT),
  failedCount: z.int().min(0).max(POD_BATCH_ITEM_LIMIT),
  requestChecksum: Sha256Schema,
  createdBy: EntityIdSchema.optional(),
  createdAt: IsoDateSchema,
  completedAt: IsoDateSchema.optional(),
  items: z.array(MockupBatchItemSchema).max(POD_BATCH_ITEM_LIMIT).optional(),
}).strict();

export const ReviewMockupBatchInputSchema = z.object({
  decisions: z.array(z.object({
    itemId: EntityIdSchema,
    decision: z.enum(["approve", "reject"]),
    rejectionReason: z.string().trim().min(1).max(2_000).optional(),
  }).strict()).min(1).max(POD_BATCH_ITEM_LIMIT),
}).strict().superRefine((value, context) => {
  const ids = value.decisions.map((decision) => decision.itemId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["decisions"], message: "Mockup review item IDs must be unique" });
  value.decisions.forEach((decision, index) => {
    if (decision.decision === "reject" && !decision.rejectionReason) context.addIssue({ code: "custom", path: ["decisions", index, "rejectionReason"], message: "Rejection requires a reason" });
  });
});

export const CreateMockupListingBindingsInputSchema = z.object({
  bindings: z.array(z.object({
    itemId: EntityIdSchema,
    listingVersionId: EntityIdSchema,
    slots: z.array(z.object({ outputId: EntityIdSchema, slotKey: z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,79}$/) }).strict()).min(1).max(POD_MOCKUP_SLOT_LIMIT),
  }).strict()).min(1).max(POD_BATCH_ITEM_LIMIT),
}).strict();

export type PodBatchStatus = z.infer<typeof PodBatchStatusSchema>;
export type CanvasWrapMode = z.infer<typeof CanvasWrapModeSchema>;
export type CanvasPhysicalSize = z.infer<typeof CanvasPhysicalSizeSchema>;
export type CanvasPrintSpecStatus = z.infer<typeof CanvasPrintSpecStatusSchema>;
export type CreativeDesignCandidateStatus = z.infer<typeof CreativeDesignCandidateStatusSchema>;
export type CreativeDesignVersionStatus = z.infer<typeof CreativeDesignVersionStatusSchema>;
export type MockupTemplateInspectionStatus = z.infer<typeof MockupTemplateInspectionStatusSchema>;
export type MockupTemplateCompilation = z.infer<typeof MockupTemplateCompilationSchema>;
export type MockupTemplatePackStatus = z.infer<typeof MockupTemplatePackStatusSchema>;
export type MockupOutputStatus = z.infer<typeof MockupOutputStatusSchema>;
export type CreateCanvasPrintSpecVersionInput = z.infer<typeof CreateCanvasPrintSpecVersionInputSchema>;
export type CanvasPrintSpecVersion = z.infer<typeof CanvasPrintSpecVersionSchema>;
export type ReviewVersionInput = z.infer<typeof ReviewVersionInputSchema>;
export type CreateCreativeDesignBatchInput = z.infer<typeof CreateCreativeDesignBatchInputSchema>;
export type CreativeDesignBatch = z.infer<typeof CreativeDesignBatchSchema>;
export type CreativeDesignBatchItem = z.infer<typeof CreativeDesignBatchItemSchema>;
export type CreativeDesignCandidate = z.infer<typeof CreativeDesignCandidateSchema>;
export type CreativeDesignVersion = z.infer<typeof CreativeDesignVersionSchema>;
export type CreativeDesignVersionAsset = z.infer<typeof CreativeDesignVersionAssetSchema>;
export type CreateCreativeDesignSkuBindingsInput = z.infer<typeof CreateCreativeDesignSkuBindingsInputSchema>;
export type CreativeDesignSkuBinding = z.infer<typeof CreativeDesignSkuBindingSchema>;
export type CreateMockupTemplateInspectionInput = z.infer<typeof CreateMockupTemplateInspectionInputSchema>;
export type MockupTemplateInspection = z.infer<typeof MockupTemplateInspectionSchema>;
export type CreateMockupTemplatePackVersionInput = z.infer<typeof CreateMockupTemplatePackVersionInputSchema>;
export type MockupTemplatePackVersion = z.infer<typeof MockupTemplatePackVersionSchema>;
export type CreateMockupBatchInput = z.infer<typeof CreateMockupBatchInputSchema>;
export type MockupBatch = z.infer<typeof MockupBatchSchema>;
export type MockupBatchItem = z.infer<typeof MockupBatchItemSchema>;
export type MockupBatchOutput = z.infer<typeof MockupBatchOutputSchema>;
export type ReviewMockupBatchInput = z.infer<typeof ReviewMockupBatchInputSchema>;
export type CreateMockupListingBindingsInput = z.infer<typeof CreateMockupListingBindingsInputSchema>;
