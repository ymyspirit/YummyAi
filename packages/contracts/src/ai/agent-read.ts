import { z } from "zod";
import { HarnessExecutionContractSchema, HarnessToolDescriptorSchema } from "@yummyai/contracts/harness";
import { OrderExceptionCategorySchema } from "@yummyai/contracts/order/order";
import { InventoryUnitSchema } from "@yummyai/contracts/inventory";
import { stockQuantityValue } from "@yummyai/contracts/inventory/quantity";

export const AGENT_READ_VERSION = "erp-agent-read-v1" as const;
export const AgentReadToolKeySchema = z.enum(["orders.exceptions.page", "inventory.balances.page"]);
const Id = z.uuidv7(), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Page = { pageSize: z.int().min(1).max(100).default(25), cursor: z.string().min(1).max(12_000).nullable().default(null) };
export const AgentExceptionPageInputSchema = z.object({ ...Page, status: z.enum(["all", "open", "resolved"]).default("open"), orderId: Id.optional() }).strict();
export const AgentBalancePageInputSchema = z.object({ ...Page, stockItemId: Id.optional(), locationId: Id.optional() }).strict();
const Envelope = { version: z.literal(AGENT_READ_VERSION), executionContract: HarnessExecutionContractSchema };
export const AgentReadCallSchema = z.discriminatedUnion("tool", [
  z.object({ ...Envelope, tool: z.literal("orders.exceptions.page"), input: AgentExceptionPageInputSchema }).strict(),
  z.object({ ...Envelope, tool: z.literal("inventory.balances.page"), input: AgentBalancePageInputSchema }).strict(),
]);
// Wire values preserve the inventory owner's exact representation. No transform:
// HarnessRegistry must be able to pin this schema as JSON Schema.
const Quantity = z.union([z.int().safe(), z.string().max(41).regex(/^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,9})?$/)]).superRefine((value, context) => {
  try { stockQuantityValue(value); } catch { context.addIssue({ code: "custom", message: "Invalid exact inventory quantity" }); }
});
export const AgentExceptionItemSchema = z.object({
  id: Id, orderId: Id, category: OrderExceptionCategorySchema, status: z.enum(["open", "resolved"]),
  eventMissing: z.boolean(), eventId: Id.nullable(), sequence: z.int().nonnegative(), orderSequence: z.int().nonnegative(),
  openedAt: z.iso.datetime(), resolvedAt: z.iso.datetime().nullable(), sourceChecksum: Hash,
}).strict();
export const AgentBalanceItemSchema = z.object({
  id: Id, dimensionKey: z.string().min(1).max(200), stockItemId: Id, locationId: Id, lotId: Id.nullable(), unit: InventoryUnitSchema,
  physicalQuantity: Quantity, reservedQuantity: Quantity, availableQuantity: Quantity, inTransitQuantity: Quantity,
  providerQuantity: Quantity, virtualQuantity: Quantity, projectionVersion: z.int().positive(), updatedAt: z.iso.datetime(),
}).strict();
const Result = {
  version: z.literal(AGENT_READ_VERSION), effect: z.literal("read"), contextAuthority: z.string().min(1).max(65_536),
  checkedAt: z.iso.datetime(), collectionFingerprint: Hash, total: z.int().nonnegative(), readCount: z.int().nonnegative(),
  consistency: z.literal("unchanged_collection"), complete: z.boolean(), nextCursor: z.string().min(1).max(12_000).nullable(),
};
export const AgentExceptionPageViewSchema = z.object({ ...Result, tool: z.literal("orders.exceptions.page"),
  query: AgentExceptionPageInputSchema, items: z.array(AgentExceptionItemSchema).max(100) }).strict();
export const AgentBalancePageViewSchema = z.object({ ...Result, tool: z.literal("inventory.balances.page"),
  query: AgentBalancePageInputSchema, items: z.array(AgentBalanceItemSchema).max(100) }).strict();
export const AgentReadPageViewSchema = z.discriminatedUnion("tool", [AgentExceptionPageViewSchema, AgentBalancePageViewSchema]);
export const AgentReadWorkspaceSchema = z.object({
  version: z.literal(AGENT_READ_VERSION), contextAuthority: z.string().min(1).max(65_536), executionContract: HarnessExecutionContractSchema,
  mcpState: z.literal("not_connected"), tools: z.array(z.object({ key: AgentReadToolKeySchema,
    available: z.boolean(), minimumScope: z.literal("tenant"), descriptor: HarnessToolDescriptorSchema }).strict()).length(2),
}).strict();
export type AgentReadToolKey = z.infer<typeof AgentReadToolKeySchema>;
export type AgentExceptionPageInput = z.infer<typeof AgentExceptionPageInputSchema>;
export type AgentBalancePageInput = z.infer<typeof AgentBalancePageInputSchema>;
export type AgentExceptionItem = z.infer<typeof AgentExceptionItemSchema>;
export type AgentBalanceItem = z.infer<typeof AgentBalanceItemSchema>;
export type AgentReadCall = z.infer<typeof AgentReadCallSchema>;
export type AgentReadPageView = z.infer<typeof AgentReadPageViewSchema>;
export type AgentReadWorkspace = z.infer<typeof AgentReadWorkspaceSchema>;

/** Owner-only query ABI. Encrypted transport cursors are opened by the gateway. */
export type AgentReadOwnerPosition = { after: string; collectionFingerprint: string } | null;
export type AgentReadOwnerPage<T> = { items: T[]; total: number; checkedAt: string; collectionFingerprint: string; hasMore: boolean; lastKey: string | null };
