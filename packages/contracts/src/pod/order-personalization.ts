import { z } from "zod";

const EntityIdSchema = z.uuidv7();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const OrderPersonalizationBatchStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "partially_succeeded",
  "failed",
]);

export const OrderPersonalizationBatchItemStatusSchema = z.enum([
  "queued",
  "running",
  "prepared",
  "failed",
]);

export const CreateOrderPersonalizationBatchItemInputSchema = z.object({
  orderId: EntityIdSchema,
  orderLineId: EntityIdSchema,
  customizationVersionId: EntityIdSchema,
  bindingId: EntityIdSchema,
}).strict();

export const CreateOrderPersonalizationBatchInputSchema = z.object({
  idempotencyKey: EntityIdSchema,
  items: z.array(CreateOrderPersonalizationBatchItemInputSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  const orderLines = new Set<string>();
  value.items.forEach((item, index) => {
    if (orderLines.has(item.orderLineId)) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "orderLineId"],
        message: "A personalization batch can contain an order line only once",
      });
    }
    orderLines.add(item.orderLineId);
  });
});

export const OrderPersonalizationBatchItemSchema = CreateOrderPersonalizationBatchItemInputSchema.extend({
  id: EntityIdSchema,
  ordinal: z.int().min(0).max(99),
  templateVersionId: EntityIdSchema.optional(),
  status: OrderPersonalizationBatchItemStatusSchema,
  resolvedSlotCount: z.int().min(0).max(500),
  resolutionChecksum: Sha256Schema.optional(),
  errorCode: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,79}$/).optional(),
  errorMessage: z.string().trim().min(1).max(500).optional(),
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
}).strict().superRefine((value, context) => {
  if (value.status === "prepared" && (!value.templateVersionId || !value.resolutionChecksum || !value.completedAt)) {
    context.addIssue({ code: "custom", path: ["status"], message: "Prepared items require a pinned template and resolution checksum" });
  }
  if (value.status === "failed" && (!value.errorCode || !value.errorMessage || !value.completedAt)) {
    context.addIssue({ code: "custom", path: ["status"], message: "Failed items require a stable diagnostic" });
  }
});

export const OrderPersonalizationBatchSchema = z.object({
  id: EntityIdSchema,
  idempotencyKey: EntityIdSchema,
  status: OrderPersonalizationBatchStatusSchema,
  itemCount: z.int().min(1).max(100),
  preparedCount: z.int().min(0).max(100),
  failedCount: z.int().min(0).max(100),
  errorCode: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,79}$/).optional(),
  errorMessage: z.string().trim().min(1).max(500).optional(),
  requestedBy: EntityIdSchema.optional(),
  items: z.array(OrderPersonalizationBatchItemSchema).max(100),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime(),
}).strict().superRefine((value, context) => {
  if (value.items.length !== value.itemCount) {
    context.addIssue({ code: "custom", path: ["items"], message: "Batch item count does not match its immutable request" });
  }
  if (value.preparedCount + value.failedCount > value.itemCount) {
    context.addIssue({ code: "custom", path: ["preparedCount"], message: "Batch counters exceed the immutable item count" });
  }
  if (["completed", "partially_succeeded", "failed"].includes(value.status) && !value.completedAt) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Terminal batches require a completion time" });
  }
});

export const OrderPersonalizationBatchListSchema = z.object({
  items: z.array(OrderPersonalizationBatchSchema).max(200),
}).strict();

export const OrderPersonalizationCandidateBlockerSchema = z.enum([
  "order_cancelled",
  "customization_requirement_missing",
  "customization_version_missing",
  "customization_not_ready",
  "catalog_sku_missing",
  "template_binding_missing",
  "template_binding_inactive",
  "template_not_approved",
  "binding_not_effective_at_order",
]);

export const OrderPersonalizationCandidateSchema = z.object({
  orderId: EntityIdSchema,
  externalOrderId: z.string().trim().min(1).max(240),
  platform: z.enum(["amazon", "etsy"]),
  placedAt: z.iso.datetime(),
  orderLineId: EntityIdSchema,
  externalLineId: z.string().trim().min(1).max(240),
  lineTitle: z.string().trim().min(1).max(500),
  quantity: z.int().positive().max(100_000),
  skuId: EntityIdSchema.optional(),
  skuCode: z.string().trim().min(1).max(240).optional(),
  customizationVersionId: EntityIdSchema.optional(),
  customizationVersionNumber: z.int().positive().optional(),
  completeness: z.int().min(0).max(100).optional(),
  requirementStatus: z.enum([
    "incomplete",
    "ready",
    "awaiting_design",
    "awaiting_customer",
    "approved",
    "rejected",
    "quarantined",
  ]).optional(),
  bindingId: EntityIdSchema.optional(),
  templateVersionId: EntityIdSchema.optional(),
  templateName: z.string().trim().min(1).max(200).optional(),
  sizeLabel: z.string().trim().min(1).max(120).optional(),
  eligible: z.boolean(),
  blockers: z.array(OrderPersonalizationCandidateBlockerSchema).max(12),
}).strict().superRefine((value, context) => {
  if (value.eligible && (
    value.blockers.length
    || !value.skuId
    || !value.customizationVersionId
    || !value.bindingId
    || !value.templateVersionId
  )) {
    context.addIssue({
      code: "custom",
      path: ["eligible"],
      message: "Eligible candidates require a complete, unblocked identifier set",
    });
  }
  if (!value.eligible && !value.blockers.length) {
    context.addIssue({
      code: "custom",
      path: ["blockers"],
      message: "Ineligible candidates require at least one stable blocker",
    });
  }
});

export const OrderPersonalizationOptionsViewSchema = z.object({
  items: z.array(OrderPersonalizationCandidateSchema).max(500),
}).strict();

export const OrderPersonalizationResolutionSlotSchema = z.discriminatedUnion("kind", [
  z.object({
    slotId: EntityIdSchema,
    stableKey: z.string().trim().min(1).max(120),
    kind: z.literal("text"),
    value: z.string().max(20_000),
  }).strict(),
  z.object({
    slotId: EntityIdSchema,
    stableKey: z.string().trim().min(1).max(120),
    kind: z.enum(["image", "decoration", "background"]),
    assetId: EntityIdSchema,
    assetVersion: z.int().positive(),
    checksumSha256: Sha256Schema,
    mediaType: z.string().trim().min(1).max(200),
  }).strict(),
]);

export const OrderPersonalizationResolutionSnapshotSchema = z.object({
  version: z.literal(2),
  orderId: EntityIdSchema,
  orderLineId: EntityIdSchema,
  customizationVersionId: EntityIdSchema,
  templateVersionId: EntityIdSchema,
  slots: z.array(OrderPersonalizationResolutionSlotSchema).min(1).max(500),
}).strict();

export const OrderPersonalizationRenderToolSchema = z.enum([
  "image_composite",
  "group_photo",
  "pet_outfit",
  "fulfillment_composite",
  "vector_fulfillment",
]);

export const OrderPersonalizationRenderTaskStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_review",
  "partially_succeeded",
  "failed",
]);

export const OrderPersonalizationRenderParameterSnapshotSchema = z.object({
  outputFormat: z.enum(["png", "jpeg", "webp", "tiff", "svg"]),
  fitMode: z.enum(["template", "contain", "cover", "stretch"]).default("template"),
  autoComposition: z.enum(["off", "balanced", "subject_focus"]).default("off"),
  allowAiEnhancement: z.boolean().default(false),
  identityMode: z.enum(["standard", "strict"]).default("standard"),
  customerAssetUsage: z.enum(["mapped", "all"]).default("mapped"),
  referenceIdentityTransfer: z.enum(["not_applicable", "forbid"]).default("not_applicable"),
  dpi: z.int().min(36).max(2_400).optional(),
  colorMode: z.enum(["rgb", "cmyk", "grayscale", "spot"]).optional(),
  transparent: z.boolean().optional(),
  vectorTemplateProfile: z.string().trim().min(1).max(500).optional(),
  vectorWidth: z.number().positive().max(100_000).optional(),
  vectorHeight: z.number().positive().max(100_000).optional(),
  vectorUnit: z.enum(["mm", "in"]).optional(),
  vectorLayoutMode: z.enum(["template", "automatic"]).optional(),
  textToPath: z.boolean().optional(),
  hollowMode: z.boolean().optional(),
  bridgeWidthMm: z.number().min(0.1).max(100).optional(),
  minimumLineWidthMm: z.number().min(0.01).max(100).optional(),
  pathRepair: z.enum(["off", "safe"]).optional(),
}).strict();

export const VectorFulfillmentOutputCheckSchema = z.object({
  fileName: z.string().trim().min(1).max(180),
  usedInputStableKeys: z.array(z.string().trim().min(1).max(120)).min(1).max(500),
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
  unit: z.enum(["mm", "in"]),
  viewBox: z.string().trim().regex(/^\s*-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s*$/),
  pathCount: z.number().int().positive().max(1_000_000),
  minimumLineWidthMm: z.number().positive().max(100),
  minimumBridgeWidthMm: z.number().positive().max(100).optional(),
}).strict();

export const VectorFulfillmentQualityCheckSnapshotSchema = z.object({
  passed: z.literal(true),
  exportReady: z.literal(true),
  templateProfileMatched: z.literal(true),
  canvasMatched: z.literal(true),
  textConvertedToPaths: z.literal(true),
  authorizedFontsOnly: z.literal(true),
  pathsClosed: z.literal(true),
  selfIntersectionsDetected: z.literal(false),
  duplicatePathsDetected: z.literal(false),
  isolatedNodesDetected: z.literal(false),
  holeDirectionsValid: z.literal(true),
  minimumLineWidthPassed: z.literal(true),
  minimumBridgeWidthPassed: z.literal(true),
  outOfBoundsDetected: z.literal(false),
  rasterImagesEmbedded: z.literal(false),
  repairs: z.array(z.enum(["close_path", "remove_duplicate", "reverse_hole", "add_bridge", "remove_isolated_node"])).max(1_000),
  outputChecks: z.array(VectorFulfillmentOutputCheckSchema).min(1).max(100),
  processorDeploymentId: z.string().trim().min(1).max(160).optional(),
}).strict();

export const CreateOrderPersonalizationRenderTaskInputSchema = z.object({
  idempotencyKey: EntityIdSchema,
  batchItemId: EntityIdSchema,
  toolKey: OrderPersonalizationRenderToolSchema,
  parameterSnapshot: OrderPersonalizationRenderParameterSnapshotSchema,
}).strict().superRefine((value, context) => {
  const format = value.parameterSnapshot.outputFormat;
  const creative = value.toolKey === "group_photo" || value.toolKey === "pet_outfit";
  if (!["fulfillment_composite", "vector_fulfillment"].includes(value.toolKey) && !["png", "jpeg", "webp"].includes(format)) {
    context.addIssue({ code: "custom", path: ["parameterSnapshot", "outputFormat"], message: "Preview composition supports PNG, JPEG, or WebP" });
  }
  if (value.toolKey === "fulfillment_composite" && !["png", "tiff"].includes(format)) {
    context.addIssue({ code: "custom", path: ["parameterSnapshot", "outputFormat"], message: "Fulfillment composition supports PNG or TIFF" });
  }
  if (creative && (
    !value.parameterSnapshot.allowAiEnhancement
    || value.parameterSnapshot.autoComposition === "off"
    || value.parameterSnapshot.identityMode !== "strict"
    || value.parameterSnapshot.customerAssetUsage !== "all"
  )) {
    context.addIssue({ code: "custom", path: ["parameterSnapshot"], message: "Creative order tools require explicit AI consent, automatic composition, strict identity preservation, and all mapped customer images" });
  }
  if (value.toolKey === "pet_outfit" && value.parameterSnapshot.referenceIdentityTransfer !== "forbid") {
    context.addIssue({ code: "custom", path: ["parameterSnapshot", "referenceIdentityTransfer"], message: "Pet outfit rendering must forbid reference identity transfer" });
  }
  if (value.toolKey !== "pet_outfit" && value.parameterSnapshot.referenceIdentityTransfer !== "not_applicable") {
    context.addIssue({ code: "custom", path: ["parameterSnapshot", "referenceIdentityTransfer"], message: "Reference identity transfer policy only applies to pet outfit rendering" });
  }
  validateVectorFulfillmentParameters(value.toolKey, value.parameterSnapshot, context);
});

export const OrderPersonalizationRenderTaskSchema = z.object({
  id: EntityIdSchema,
  idempotencyKey: EntityIdSchema,
  batchItemId: EntityIdSchema,
  designTaskId: EntityIdSchema,
  toolKey: OrderPersonalizationRenderToolSchema,
  status: OrderPersonalizationRenderTaskStatusSchema,
  parameterSnapshot: OrderPersonalizationRenderParameterSnapshotSchema,
  progressPercent: z.int().min(0).max(100),
  attemptCount: z.int().min(0).max(20),
  maxAttempts: z.int().min(1).max(20),
  resultVersionId: EntityIdSchema.optional(),
  modelKey: z.string().trim().min(1).max(160).optional(),
  modelVersion: z.string().trim().min(1).max(160).optional(),
  seed: z.string().trim().min(1).max(160).optional(),
  qualityCheckSnapshot: z.record(z.string(), z.unknown()).optional(),
  errorCode: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,79}$/).optional(),
  errorMessage: z.string().trim().min(1).max(500).optional(),
  requestedBy: EntityIdSchema.optional(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime(),
}).strict().superRefine((value, context) => {
  const format = value.parameterSnapshot.outputFormat;
  const creative = value.toolKey === "group_photo" || value.toolKey === "pet_outfit";
  if (!["fulfillment_composite", "vector_fulfillment"].includes(value.toolKey) && !["png", "jpeg", "webp"].includes(format)) {
    context.addIssue({ code: "custom", path: ["parameterSnapshot", "outputFormat"], message: "Preview composition supports PNG, JPEG, or WebP" });
  }
  if (value.toolKey === "fulfillment_composite" && !["png", "tiff"].includes(format)) {
    context.addIssue({ code: "custom", path: ["parameterSnapshot", "outputFormat"], message: "Fulfillment composition supports PNG or TIFF" });
  }
  if (creative && (
    !value.parameterSnapshot.allowAiEnhancement
    || value.parameterSnapshot.autoComposition === "off"
    || value.parameterSnapshot.identityMode !== "strict"
    || value.parameterSnapshot.customerAssetUsage !== "all"
  )) {
    context.addIssue({ code: "custom", path: ["parameterSnapshot"], message: "Creative order tools require explicit AI consent, automatic composition, strict identity preservation, and all mapped customer images" });
  }
  if (value.toolKey === "pet_outfit" && value.parameterSnapshot.referenceIdentityTransfer !== "forbid") {
    context.addIssue({ code: "custom", path: ["parameterSnapshot", "referenceIdentityTransfer"], message: "Pet outfit rendering must forbid reference identity transfer" });
  }
  if (value.toolKey !== "pet_outfit" && value.parameterSnapshot.referenceIdentityTransfer !== "not_applicable") {
    context.addIssue({ code: "custom", path: ["parameterSnapshot", "referenceIdentityTransfer"], message: "Reference identity transfer policy only applies to pet outfit rendering" });
  }
  validateVectorFulfillmentParameters(value.toolKey, value.parameterSnapshot, context);
  if (["awaiting_review", "partially_succeeded"].includes(value.status) && (!value.resultVersionId || !value.completedAt)) {
    context.addIssue({ code: "custom", path: ["resultVersionId"], message: "Completed render tasks require a reviewable design version" });
  }
  if (value.status === "failed" && (!value.errorCode || !value.errorMessage || !value.completedAt)) {
    context.addIssue({ code: "custom", path: ["errorCode"], message: "Failed render tasks require a stable diagnostic" });
  }
});

export const OrderPersonalizationRenderTaskListSchema = z.object({
  items: z.array(OrderPersonalizationRenderTaskSchema).max(200),
}).strict();

export type OrderPersonalizationBatchStatus = z.infer<typeof OrderPersonalizationBatchStatusSchema>;
export type OrderPersonalizationBatchItemStatus = z.infer<typeof OrderPersonalizationBatchItemStatusSchema>;
export type CreateOrderPersonalizationBatchItemInput = z.infer<typeof CreateOrderPersonalizationBatchItemInputSchema>;
export type CreateOrderPersonalizationBatchInput = z.infer<typeof CreateOrderPersonalizationBatchInputSchema>;
export type OrderPersonalizationBatchItem = z.infer<typeof OrderPersonalizationBatchItemSchema>;
export type OrderPersonalizationBatch = z.infer<typeof OrderPersonalizationBatchSchema>;
export type OrderPersonalizationBatchList = z.infer<typeof OrderPersonalizationBatchListSchema>;
export type OrderPersonalizationCandidateBlocker = z.infer<typeof OrderPersonalizationCandidateBlockerSchema>;
export type OrderPersonalizationCandidate = z.infer<typeof OrderPersonalizationCandidateSchema>;
export type OrderPersonalizationOptionsView = z.infer<typeof OrderPersonalizationOptionsViewSchema>;
export type OrderPersonalizationResolutionSlot = z.infer<typeof OrderPersonalizationResolutionSlotSchema>;
export type OrderPersonalizationResolutionSnapshot = z.infer<typeof OrderPersonalizationResolutionSnapshotSchema>;
export type OrderPersonalizationRenderTool = z.infer<typeof OrderPersonalizationRenderToolSchema>;
export type OrderPersonalizationRenderTaskStatus = z.infer<typeof OrderPersonalizationRenderTaskStatusSchema>;
export type OrderPersonalizationRenderParameterSnapshot = z.infer<typeof OrderPersonalizationRenderParameterSnapshotSchema>;
export type CreateOrderPersonalizationRenderTaskInput = z.infer<typeof CreateOrderPersonalizationRenderTaskInputSchema>;
export type OrderPersonalizationRenderTask = z.infer<typeof OrderPersonalizationRenderTaskSchema>;
export type OrderPersonalizationRenderTaskList = z.infer<typeof OrderPersonalizationRenderTaskListSchema>;
export type VectorFulfillmentQualityCheckSnapshot = z.infer<typeof VectorFulfillmentQualityCheckSnapshotSchema>;

function validateVectorFulfillmentParameters(
  toolKey: z.infer<typeof OrderPersonalizationRenderToolSchema>,
  parameters: z.infer<typeof OrderPersonalizationRenderParameterSnapshotSchema>,
  context: z.RefinementCtx,
) {
  const vectorFields = [
    parameters.vectorTemplateProfile,
    parameters.vectorWidth,
    parameters.vectorHeight,
    parameters.vectorUnit,
    parameters.vectorLayoutMode,
    parameters.textToPath,
    parameters.hollowMode,
    parameters.bridgeWidthMm,
    parameters.minimumLineWidthMm,
    parameters.pathRepair,
  ];
  if (toolKey !== "vector_fulfillment") {
    if (vectorFields.some((value) => value !== undefined)) {
      context.addIssue({ code: "custom", path: ["parameterSnapshot"], message: "Vector production parameters only apply to vector fulfillment" });
    }
    return;
  }
  if (
    parameters.outputFormat !== "svg"
    || parameters.fitMode !== "template"
    || parameters.autoComposition !== "off"
    || parameters.allowAiEnhancement
    || parameters.identityMode !== "standard"
    || parameters.customerAssetUsage !== "mapped"
    || parameters.referenceIdentityTransfer !== "not_applicable"
    || parameters.transparent !== true
    || !["cmyk", "spot"].includes(parameters.colorMode ?? "")
    || !parameters.vectorTemplateProfile
    || parameters.vectorWidth === undefined
    || parameters.vectorHeight === undefined
    || !parameters.vectorUnit
    || !parameters.vectorLayoutMode
    || parameters.textToPath !== true
    || parameters.hollowMode === undefined
    || parameters.bridgeWidthMm === undefined
    || parameters.minimumLineWidthMm === undefined
    || !parameters.pathRepair
    || parameters.dpi !== undefined
  ) {
    context.addIssue({ code: "custom", path: ["parameterSnapshot"], message: "Vector fulfillment requires a complete non-generative SVG production plan" });
  }
}
