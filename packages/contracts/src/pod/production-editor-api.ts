import { z } from "zod";
import { ProductionEditorDocumentSchema, ProductionEditorExportOptionsSchema, ProductionEditorPreflightSchema } from "@yummyai/contracts/pod/production-editor";
import { ProductionCutoutRecipeSchema } from "@yummyai/contracts/pod/production-cutout";

export const ProductionEditorSourceSchema = z.object({ reportLineId: z.uuidv7(), reportVersionId: z.uuidv7() }).strict();
export const CreateProductionEditorProjectInputSchema = z.object({ name: z.string().trim().min(1).max(160), document: ProductionEditorDocumentSchema, source: ProductionEditorSourceSchema.nullable().optional() }).strict();
export const SaveProductionEditorVersionInputSchema = z.object({ expectedVersionId: z.uuidv7(), document: ProductionEditorDocumentSchema }).strict();
export const ReviewProductionEditorVersionInputSchema = z.object({ expectedVersionId: z.uuidv7() }).strict();
export const CreateProductionEditorRenderInputSchema = ProductionEditorExportOptionsSchema.extend({ expectedVersionId: z.uuidv7() }).strict();
export const ProductionEditorProjectViewSchema = z.object({ id: z.uuidv7(), name: z.string(), productType: z.enum(["shaped_pillow", "tire_cover"]), currentVersionId: z.uuidv7(), versionNumber: z.int().positive(), source: ProductionEditorSourceSchema.nullable(), expiresAt: z.iso.datetime().nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }).strict();
export const ProductionEditorImageViewSchema = z.object({ id: z.uuidv7(), version: z.literal(1), name: z.string(), mediaType: z.string(), width: z.int().positive(), height: z.int().positive(), hasAlpha: z.boolean(), actualAlpha: z.boolean(), checksumSha256: z.string(), byteSize: z.int().positive(), previewPath: z.string(), originalPath: z.string() }).strict();
export const ProductionEditorFontViewSchema = z.object({ id: z.string(), name: z.string(), builtin: z.boolean(), originalPath: z.string() }).strict();
export const ProductionEditorRenderFileSchema = z.object({ key: z.string(), name: z.string(), mediaType: z.string(), byteSize: z.int().positive() }).strict();
export const ProductionEditorRenderViewSchema = z.object({ id: z.uuidv7(), versionId: z.uuidv7(), purpose: z.enum(["preview", "production"]), status: z.enum(["queued", "processing", "completed", "failed"]), errorCode: z.string().nullable(), createdAt: z.iso.datetime(), files: z.array(ProductionEditorRenderFileSchema), preflight: ProductionEditorPreflightSchema.nullable() }).strict();
export const ProductionEditorVersionMetaSchema = z.object({ id: z.uuidv7(), versionNumber: z.int().positive(), createdAt: z.iso.datetime(), reviewed: z.boolean() }).strict();
export const ProductionEditorDetailViewSchema = z.object({ project: ProductionEditorProjectViewSchema, version: ProductionEditorVersionMetaSchema.extend({ document: ProductionEditorDocumentSchema }), versions: z.array(ProductionEditorVersionMetaSchema), images: z.array(ProductionEditorImageViewSchema), fonts: z.array(ProductionEditorFontViewSchema), renders: z.array(ProductionEditorRenderViewSchema) }).strict();
export const ProductionEditorWorkspaceViewSchema = z.object({ projects: z.array(ProductionEditorProjectViewSchema) }).strict();
export const ProductionCutoutEditorViewSchema = z.object({ source: ProductionEditorImageViewSchema, recipe: ProductionCutoutRecipeSchema, automaticAvailable: z.boolean(), refinementAvailable: z.boolean().default(false) }).strict();

export type CreateProductionEditorProjectInput = z.infer<typeof CreateProductionEditorProjectInputSchema>;
export type SaveProductionEditorVersionInput = z.infer<typeof SaveProductionEditorVersionInputSchema>;
export type CreateProductionEditorRenderInput = z.infer<typeof CreateProductionEditorRenderInputSchema>;
export type ProductionEditorProjectView = z.infer<typeof ProductionEditorProjectViewSchema>;
export type ProductionEditorImageView = z.infer<typeof ProductionEditorImageViewSchema>;
export type ProductionEditorFontView = z.infer<typeof ProductionEditorFontViewSchema>;
export type ProductionEditorRenderView = z.infer<typeof ProductionEditorRenderViewSchema>;
export type ProductionEditorDetailView = z.infer<typeof ProductionEditorDetailViewSchema>;
export type ProductionEditorWorkspaceView = z.infer<typeof ProductionEditorWorkspaceViewSchema>;
