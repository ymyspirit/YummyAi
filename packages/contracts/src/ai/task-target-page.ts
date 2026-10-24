import { z } from "zod";
import { AssistKindSchema, type AssistKind } from "@yummyai/contracts/ai/assist";

/** Additive contract. The original task-targets and benchmark v1 ABI is frozen. */
export const ASSIST_TARGET_PAGE_VERSION = "assist-target-page-v1" as const;
export const AssistTargetPageQuerySchema = z.object({
  kind: AssistKindSchema,
  q: z.string().trim().max(200).default(""),
  pageSize: z.coerce.number().int().min(1).max(100).default(40),
  cursor: z.string().min(1).max(12_000).optional(),
}).strict();
export const AssistTargetPageItemSchema = z.object({
  id: z.string().min(1).max(80), label: z.string().min(1).max(4000),
  detail: z.string().max(4000), href: z.string().min(1).max(300),
}).strict();
export function assistTargetPageHref(kind: AssistKind, id: string): string {
  switch (kind) {
    case "order_review": return "/orders?line=" + id;
    case "artwork_preflight": return "/order-artwork?line=" + id;
    case "creative": return "/content-projects?project=" + id;
    case "sku_package": return "/listings/" + id;
    case "template_config": return "/pod-workbench?module=personalization";
    case "business_review": return "/finance";
    case "procurement_review": return "/procurement";
    case "after_sales_review": return "/after-sales";
    case "knowledge_answer": return "/knowledge";
  }
}
export const AssistTargetPageViewSchema = z.object({
  version: z.literal(ASSIST_TARGET_PAGE_VERSION), effect: z.literal("read"), kind: AssistKindSchema,
  contextAuthority: z.string().min(1).max(65_536), checkedAt: z.iso.datetime(),
  collectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  total: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER), readCount: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  consistency: z.literal("unchanged_collection"), complete: z.boolean(), nextCursor: z.string().min(1).max(12_000).nullable(),
  query: AssistTargetPageQuerySchema, items: z.array(AssistTargetPageItemSchema).max(100),
}).strict().superRefine((value, context) => {
  if (value.kind !== value.query.kind || value.items.length > value.query.pageSize || value.readCount < value.items.length || value.readCount > value.total ||
    value.complete !== (value.nextCursor === null) || (value.complete ? value.readCount !== value.total : value.readCount >= value.total || !value.items.length) ||
    (!value.query.cursor && value.readCount !== value.items.length) ||
    new Set(value.items.map(item => item.id)).size !== value.items.length)
    context.addIssue({ code: "custom", message: "Target page completeness or query identity is invalid" });
  for (const item of value.items) {
    const ids = item.id.split(":");
    if ((value.kind === "procurement_review" ? ids.length !== 2 : ids.length !== 1) || ids.some(id => !z.uuid().safeParse(id).success) ||
      item.href !== assistTargetPageHref(value.kind, item.id)) context.addIssue({ code: "custom", message: "Target reference is invalid" });
  }
  if (value.kind === "knowledge_answer" && (value.total !== 0 || value.items.length !== 0)) context.addIssue({ code: "custom", message: "Knowledge questions do not select a business object" });
});
export type AssistTargetPageQuery = z.infer<typeof AssistTargetPageQuerySchema>;
export type AssistTargetPageSelection = Omit<AssistTargetPageQuery, "cursor">;
export type AssistTargetPageItem = z.infer<typeof AssistTargetPageItemSchema>;
export type AssistTargetPageView = z.infer<typeof AssistTargetPageViewSchema>;
export type AssistTargetOwnerPosition = { after: string; collectionFingerprint: string } | null;
export type AssistTargetOwnerPage = { items: AssistTargetPageItem[]; total: number; checkedAt: string; collectionFingerprint: string; hasMore: boolean; lastKey: string | null };
