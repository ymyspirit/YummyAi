import { z } from "zod";

const Mm = z.number().finite().min(-10_000).max(10_000);
const SizeMm = z.number().finite().positive().max(5_000);
const Key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
const Color = z.string().regex(/^#[a-fA-F0-9]{6}$/);

export const ProductionEditorPointSchema = z.object({ xMm: Mm, yMm: Mm, smooth: z.boolean() }).strict();
const LayerBase = z.object({ id: Key, name: z.string().max(160), xMm: Mm, yMm: Mm, rotationDeg: z.number().finite().min(-360).max(360), opacity: z.number().min(0).max(1), visible: z.boolean(), locked: z.boolean().default(false) }).strict();
export const ProductionEditorImageLayerSchema = LayerBase.extend({
  /** x/y is the image's local top-left rotation anchor; dimensions are unrotated. */
  kind: z.literal("image"), assetId: z.uuidv7(), assetVersion: z.int().positive(),
  widthMm: SizeMm, heightMm: SizeMm, flipX: z.boolean(), flipY: z.boolean(),
}).strict();
export const ProductionEditorTextLayerSchema = LayerBase.extend({
  kind: z.literal("text"), text: z.string().min(1).max(500), fontId: Key,
  fontSizeMm: z.number().positive().max(500), letterSpacingMm: z.number().min(-10).max(100), color: Color,
  /** Flat text uses x/y as left baseline; arc text uses x/y as circle centre. */
  arc: z.object({ radiusMm: SizeMm, startAngleDeg: z.number().min(-360).max(360), endAngleDeg: z.number().min(-360).max(360) }).strict().nullable(),
}).strict();
export const ProductionEditorLayerSchema = z.discriminatedUnion("kind", [ProductionEditorImageLayerSchema, ProductionEditorTextLayerSchema]);
export const ProductionEditorConfirmationsSchema = z.object({
  physicalSize: z.boolean(), whiteBorderRule: z.boolean(), narrowParts: z.boolean(), barcodeTab: z.boolean(), backText: z.boolean(), visualReview: z.boolean(),
}).strict();
const BaseDocument = z.object({
  schemaVersion: z.literal(1), name: z.string().trim().min(1).max(160),
  layers: z.array(ProductionEditorLayerSchema).max(100),
  confirmations: ProductionEditorConfirmationsSchema,
}).strict();
export const ShapedPillowDocumentSchema = BaseDocument.extend({
  productType: z.literal("shaped_pillow"),
  spec: z.object({
    /** Physical bounding box of ONE cut-contour body, excluding barcode tab. */
    widthMm: SizeMm, heightMm: SizeMm, dpi: z.literal(150), sideMode: z.enum(["single", "double"]),
    declaredLongestMm: SizeMm.nullable(), sizeBasis: z.enum(["unconfirmed", "artwork", "cut_contour", "finished"]),
    whiteBorderMm: z.number().min(0).max(200), cutLineMm: z.number().positive().max(10),
    minimumNeckMm: z.number().positive().max(500), minimumNeckBasis: z.enum(["unconfirmed", "cut_contour", "finished"]),
    panelGapMm: z.number().min(0).max(500),
    barcodeTab: z.object({ widthMm: SizeMm.nullable(), heightMm: SizeMm.nullable(), centerXMm: Mm }).strict(),
  }).strict(),
  /** Closed body contour BEFORE barcode tab. Final cut boundary, not photo alpha tracing. */
  contour: z.array(ProductionEditorPointSchema).min(3).max(200),
}).strict();
export const TireCoverDocumentSchema = BaseDocument.extend({
  productType: z.literal("tire_cover"),
  spec: z.object({
    diameterMm: SizeMm, dpi: z.int().min(72).max(600), safeInsetMm: z.number().min(0).max(500),
    opening: z.object({ xMm: Mm, yMm: Mm, diameterMm: SizeMm }).strict().nullable(),
  }).strict(),
  contour: z.array(ProductionEditorPointSchema).length(0),
}).strict();
export const ProductionEditorDocumentSchema = z.discriminatedUnion("productType", [ShapedPillowDocumentSchema, TireCoverDocumentSchema]).superRefine((document, ctx) => {
  const ids = new Set<string>();
  for (const [index, layer] of document.layers.entries()) {
    if (ids.has(layer.id)) ctx.addIssue({ code: "custom", path: ["layers", index, "id"], message: "Layer IDs must be unique" });
    ids.add(layer.id);
    if (layer.kind === "text" && layer.arc && layer.arc.endAngleDeg <= layer.arc.startAngleDeg) ctx.addIssue({ code: "custom", path: ["layers", index, "arc"], message: "Arc end must be greater than start" });
  }
});
export const ProductionEditorExportOptionsSchema = z.object({ format: z.enum(["png", "jpeg", "tiff"]), background: z.enum(["transparent", "white"]), purpose: z.enum(["preview", "production"]) }).strict();
export const ProductionEditorPreflightIssueSchema = z.object({ code: Key, severity: z.enum(["error", "warning", "manual"]), message: z.string().min(1).max(500), layerId: Key.optional() }).strict();
export const ProductionEditorPreflightSchema = z.object({ productionReady: z.boolean(), widthPx: z.int().positive(), heightPx: z.int().positive(), issues: z.array(ProductionEditorPreflightIssueSchema) }).strict();

export type ProductionEditorDocument = z.infer<typeof ProductionEditorDocumentSchema>;
export type ShapedPillowDocument = z.infer<typeof ShapedPillowDocumentSchema>;
export type TireCoverDocument = z.infer<typeof TireCoverDocumentSchema>;
export type ProductionEditorLayer = z.infer<typeof ProductionEditorLayerSchema>;
export type ProductionEditorImageLayer = z.infer<typeof ProductionEditorImageLayerSchema>;
export type ProductionEditorTextLayer = z.infer<typeof ProductionEditorTextLayerSchema>;
export type ProductionEditorPoint = z.infer<typeof ProductionEditorPointSchema>;
export type ProductionEditorExportOptions = z.infer<typeof ProductionEditorExportOptionsSchema>;
export type ProductionEditorPreflight = z.infer<typeof ProductionEditorPreflightSchema>;
export type ProductionEditorPreflightIssue = z.infer<typeof ProductionEditorPreflightIssueSchema>;
