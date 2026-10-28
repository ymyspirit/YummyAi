import { z } from "zod";

export const fulfillmentAttentionSources = ["logistics", "production", "delivery"] as const;
export const FulfillmentAttentionSourceSchema = z.enum(fulfillmentAttentionSources);
export type FulfillmentAttentionSource = z.infer<typeof FulfillmentAttentionSourceSchema>;
export const fulfillmentAttentionLabels: Record<FulfillmentAttentionSource, string> = {
  logistics: "物流下单", production: "生产异常", delivery: "工厂进度",
};

export const FulfillmentAttentionQuerySchema = z.object({
  source: z.enum(["all", ...fulfillmentAttentionSources]).default("all"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
}).strict();
export type FulfillmentAttentionQuery = z.infer<typeof FulfillmentAttentionQuerySchema>;
export const FulfillmentAttentionItemSchema = z.object({
  id: z.string(), source: FulfillmentAttentionSourceSchema, entityId: z.uuidv7(),
  orderId: z.uuidv7(), status: z.string(), title: z.string(), reason: z.string(),
  priority: z.enum(["blocked", "overdue", "pending"]), nextAction: z.string(),
  href: z.string().startsWith("/"), updatedAt: z.iso.datetime(), dueAt: z.iso.datetime().nullable(),
}).strict();
export type FulfillmentAttentionItem = z.infer<typeof FulfillmentAttentionItemSchema>;
export const FulfillmentAttentionViewSchema = z.object({
  generatedAt: z.iso.datetime(), source: FulfillmentAttentionQuerySchema.shape.source,
  page: z.int().positive(), pageSize: z.literal(12), total: z.int().nonnegative(), hasMore: z.boolean(),
  sources: z.array(z.object({ source: FulfillmentAttentionSourceSchema, available: z.boolean(), count: z.int().nonnegative().nullable() }).strict()),
  items: z.array(FulfillmentAttentionItemSchema),
}).strict();
export type FulfillmentAttentionView = z.infer<typeof FulfillmentAttentionViewSchema>;
