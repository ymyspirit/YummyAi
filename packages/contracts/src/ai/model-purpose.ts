import { z } from "zod";

export const ModelPurposeSchema = z.enum([
  "creative", "order_review", "artwork_preflight", "template_config", "sku_package",
  "business_review", "procurement_review", "after_sales_review", "knowledge_answer", "agent_chat",
]);
export type ModelPurpose = z.infer<typeof ModelPurposeSchema>;

/** Personal suggestions for new tasks; immutable execution snapshots take precedence. */
export const ModelPurposeDefaultsSchema = z.object({
  creative: z.uuidv7().nullable().optional(),
  order_review: z.uuidv7().nullable().optional(),
  artwork_preflight: z.uuidv7().nullable().optional(),
  template_config: z.uuidv7().nullable().optional(),
  sku_package: z.uuidv7().nullable().optional(),
  business_review: z.uuidv7().nullable().optional(),
  procurement_review: z.uuidv7().nullable().optional(),
  after_sales_review: z.uuidv7().nullable().optional(),
  knowledge_answer: z.uuidv7().nullable().optional(),
  agent_chat: z.uuidv7().nullable().optional(),
}).strict();
export type ModelPurposeDefaults = z.infer<typeof ModelPurposeDefaultsSchema>;

/** Keep an operator's current choice; otherwise apply their purpose preference. */
export function preferredModelId(
  models: ReadonlyArray<{ id: string; defaultFor?: readonly ModelPurpose[] }>,
  purpose: ModelPurpose,
  selected = "",
) {
  if (models.some(model => model.id === selected)) return selected;
  return models.find(model => model.defaultFor?.includes(purpose))?.id ?? models[0]?.id ?? "";
}
