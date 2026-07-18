import { z } from "zod";

import { EntityIdSchema } from "../common/ids.js";

export const ProductStatusSchema = z.enum([
  "researching",
  "pending_approval",
  "approved",
  "developing",
  "listing",
  "ready",
  "archived",
]);

export const MoneySchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export const ConditionalVisibilitySchema = z.object({
  fieldKey: z.string().min(1).max(80),
  operator: z.enum(["equals", "not_equals", "contains", "not_empty"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
});

const ProductionMappingSchema = z.object({
  targetSystem: z.string().min(1).max(80),
  path: z.string().min(1).max(200),
}).optional();

const FieldCoreSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
  label: z.string().min(1).max(120),
  helpText: z.string().max(500).optional(),
  required: z.boolean().default(false),
  visibleWhen: ConditionalVisibilitySchema.optional(),
  productionMapping: ProductionMappingSchema,
});

const TextValidationSchema = z.object({
  minLength: z.int().nonnegative().optional(),
  maxLength: z.int().positive().max(10_000).optional(),
  pattern: z.string().max(300).optional(),
}).refine((value) => value.minLength === undefined || value.maxLength === undefined || value.minLength <= value.maxLength, {
  message: "minLength cannot exceed maxLength",
});

const ChoiceOptionSchema = z.object({
  value: z.string().min(1).max(120),
  label: z.string().min(1).max(120),
});

export const CustomizationFieldSchema = z.discriminatedUnion("type", [
  FieldCoreSchema.extend({ type: z.literal("short_text"), validation: TextValidationSchema.optional() }),
  FieldCoreSchema.extend({ type: z.literal("long_text"), validation: TextValidationSchema.optional() }),
  FieldCoreSchema.extend({
    type: z.literal("image"),
    validation: z.object({
      allowedMediaTypes: z.array(z.enum(["image/png", "image/jpeg", "image/webp"])).min(1),
      maxFiles: z.int().positive().max(20).default(1),
      maxBytes: z.int().positive().max(100_000_000),
    }),
  }),
  FieldCoreSchema.extend({ type: z.literal("date"), minDate: z.iso.date().optional(), maxDate: z.iso.date().optional() }),
  FieldCoreSchema.extend({ type: z.literal("color"), palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(1).max(100) }),
  FieldCoreSchema.extend({ type: z.literal("single_choice"), options: z.array(ChoiceOptionSchema).min(1).max(100) }),
  FieldCoreSchema.extend({
    type: z.literal("multiple_choice"),
    options: z.array(ChoiceOptionSchema).min(1).max(100),
    minSelections: z.int().nonnegative().default(0),
    maxSelections: z.int().positive().optional(),
  }),
]);

export const CustomizationSchema = z.object({
  version: z.int().positive(),
  fields: z.array(CustomizationFieldSchema).max(100),
}).superRefine((value, context) => {
  const keys = new Set<string>();
  for (const [index, field] of value.fields.entries()) {
    if (keys.has(field.key)) context.addIssue({ code: "custom", path: ["fields", index, "key"], message: "Field keys must be unique" });
    keys.add(field.key);
  }
  for (const [index, field] of value.fields.entries()) {
    if (field.visibleWhen && (!keys.has(field.visibleWhen.fieldKey) || field.visibleWhen.fieldKey === field.key)) {
      context.addIssue({ code: "custom", path: ["fields", index, "visibleWhen", "fieldKey"], message: "Visibility conditions must reference another field in this schema" });
    }
  }
});

export const ProductPlanInputSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4_000).optional(),
  sourceReportIds: z.array(EntityIdSchema).max(50).default([]),
  targetCost: MoneySchema.optional(),
  customization: CustomizationSchema.default({ version: 1, fields: [] }),
});

export const CreateSpuInputSchema = z.object({
  code: z.string().trim().min(1).max(80).transform((value) => value.toUpperCase()),
  name: z.string().min(1).max(200),
});

export const CreateSkuInputSchema = z.object({
  spuId: EntityIdSchema,
  code: z.string().trim().min(1).max(100).transform((value) => value.toUpperCase()),
  attributes: z.record(z.string(), z.string()).default({}),
  unitCost: MoneySchema.optional(),
});

export const SupplierCandidateInputSchema = z.object({
  productPlanId: EntityIdSchema,
  name: z.string().min(1).max(200),
  priority: z.int().min(1).max(5),
  quotedCost: MoneySchema.optional(),
  minimumOrderQuantity: z.int().positive().optional(),
  leadTimeDays: z.int().nonnegative().optional(),
  notes: z.string().max(2_000).optional(),
});

export type ProductStatus = z.infer<typeof ProductStatusSchema>;
export type Money = z.infer<typeof MoneySchema>;
export type CustomizationField = z.infer<typeof CustomizationFieldSchema>;
export type CustomizationDefinition = z.infer<typeof CustomizationSchema>;
export type ProductPlanInput = z.infer<typeof ProductPlanInputSchema>;
export type CreateSpuInput = z.infer<typeof CreateSpuInputSchema>;
export type CreateSkuInput = z.infer<typeof CreateSkuInputSchema>;
export type SupplierCandidateInput = z.infer<typeof SupplierCandidateInputSchema>;
