import { z } from "zod";

const Unit = z.number().finite().min(0).max(1);
export const CutoutPointSchema = z.object({ x: Unit, y: Unit }).strict();
export const CutoutBoxSchema = z.object({ x: Unit, y: Unit, width: Unit.positive(), height: Unit.positive() }).strict().refine((box) => box.x + box.width <= 1.000001 && box.y + box.height <= 1.000001, "Selection must stay inside the image");
const MaskPng = z.string().min(16).max(2_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const CutoutOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clean-alpha"), threshold: z.number().finite().min(0.01).max(0.4) }).strict(),
  z.object({ kind: z.literal("polygon"), mode: z.enum(["keep", "erase", "restore"]), points: z.array(CutoutPointSchema).min(3).max(400) }).strict(),
  z.object({ kind: z.literal("brush"), mode: z.enum(["erase", "restore"]), radius: z.number().finite().min(0.0001).max(0.2), softness: Unit, points: z.array(CutoutPointSchema).min(1).max(2000) }).strict(),
]);
/** Coordinates refer to the EXIF-oriented original, independent of canvas placement. */
export const ProductionCutoutRecipeSchema = z.object({
  schemaVersion: z.literal(1), maskPngBase64: MaskPng.nullable(),
  operations: z.array(CutoutOperationSchema).max(160),
}).strict().superRefine((recipe, ctx) => {
  if (recipe.operations.reduce((sum, operation) => sum + ("points" in operation ? operation.points.length : 0), 0) > 16_000) ctx.addIssue({ code: "custom", message: "Too many editing points" });
});
export const SegmentProductionImageInputSchema = z.object({
  expectedVersionId: z.uuidv7(), box: CutoutBoxSchema,
  points: z.array(CutoutPointSchema.extend({ keep: z.boolean() }).strict()).max(40),
}).strict();
export const SegmentProductionImageResultSchema = z.object({ maskPngBase64: MaskPng, engine: z.literal("sam2.1"), width: z.int().positive().max(2048), height: z.int().positive().max(2048) }).strict();
export const ApplyProductionCutoutInputSchema = z.object({ expectedVersionId: z.uuidv7(), name: z.string().trim().min(1).max(160), recipe: ProductionCutoutRecipeSchema }).strict();
/** Brush marks identify uncertain hair; they never paint foreground pixels. */
export const CutoutRefineStrokeSchema = z.object({ radius: z.number().finite().min(0.0001).max(0.2), points: z.array(CutoutPointSchema).min(1).max(2000) }).strict();
export const RefineProductionImageInputSchema = z.object({
  expectedVersionId: z.uuidv7(), recipe: ProductionCutoutRecipeSchema,
  radius: z.number().finite().min(0.001).max(0.05),
  strokes: z.array(CutoutRefineStrokeSchema).max(80),
}).strict().superRefine((input, ctx) => {
  if (input.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0) > 8000) ctx.addIssue({ code: "custom", message: "Too many refinement points" });
});
export const RefineProductionImageResultSchema = SegmentProductionImageResultSchema.extend({ engine: z.literal("vitmatte-small") });
export type CutoutRefineStroke = z.infer<typeof CutoutRefineStrokeSchema>;
export type RefineProductionImageInput = z.infer<typeof RefineProductionImageInputSchema>;
export type CutoutPoint = z.infer<typeof CutoutPointSchema>;
export type CutoutBox = z.infer<typeof CutoutBoxSchema>;
export type CutoutOperation = z.infer<typeof CutoutOperationSchema>;
export type ProductionCutoutRecipe = z.infer<typeof ProductionCutoutRecipeSchema>;
export type SegmentProductionImageInput = z.infer<typeof SegmentProductionImageInputSchema>;
