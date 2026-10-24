import { z } from "zod";
import { StudioKeySchema, StudioNamespaceSchema, StudioScopeSchema } from "@yummyai/contracts/pod/studio-address";

export { STUDIO_IMAGE_DRAFT_KEY, STUDIO_VIDEO_DRAFT_KEY } from "@yummyai/contracts/pod/studio-address";
export const STUDIO_DOCUMENT_TRANSFER_VERSION = 1;
export const STUDIO_TRANSFER_INTENT_PREFIX = "yummyai.studio.transfer.v1:";
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const StudioTransferRequestFields = {
  scope: StudioScopeSchema, targetScope: z.uuidv7(), requestId: z.uuid(), manifestHash: Hash,
};
export const StudioTransferRequestSchema = z.object(StudioTransferRequestFields).strict();
export type StudioTransferRequest = z.infer<typeof StudioTransferRequestSchema>;
export const StudioTransferCountsSchema = z.object({
  canvases: z.int().nonnegative(), prompts: z.int().nonnegative(), assets: z.int().nonnegative(),
  imageDrafts: z.int().nonnegative(), videoDrafts: z.int().nonnegative(), history: z.int().nonnegative(), media: z.int().nonnegative(),
}).strict();
export type StudioTransferCounts = z.infer<typeof StudioTransferCountsSchema>;
export const StudioTransferPreviewSchema = z.object({
  version: z.literal(1), sourceScope: StudioScopeSchema, targetScope: z.uuidv7(), manifestHash: Hash,
  counts: StudioTransferCountsSchema, excluded: z.array(z.string().max(1000)).max(10_000),
}).strict();
export type StudioTransferPreview = z.infer<typeof StudioTransferPreviewSchema>;
export const StudioTransferReceiptSchema = z.object({
  id: z.uuidv7(), sourceScope: StudioScopeSchema, targetScope: z.uuidv7(), requestId: z.uuid(), manifestHash: Hash,
  copiedAt: z.iso.datetime(), counts: StudioTransferCountsSchema,
  entries: z.array(z.object({ sourceEntryIds: z.array(z.uuidv7()).min(1).max(10_000), targetEntryId: z.uuidv7(),
    revision: z.int().positive(), namespace: StudioNamespaceSchema, key: StudioKeySchema }).strict()).max(10_000),
}).strict();
export type StudioTransferReceipt = z.infer<typeof StudioTransferReceiptSchema>;
export const StudioTransferLookupSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("missing"), request: StudioTransferRequestSchema, receipt: z.null() }).strict(),
  z.object({ status: z.literal("prepared"), request: StudioTransferRequestSchema, receipt: z.null() }).strict(),
  z.object({ status: z.literal("cancelled"), request: StudioTransferRequestSchema, receipt: z.null() }).strict(),
  z.object({ status: z.literal("committed"), request: StudioTransferRequestSchema, receipt: StudioTransferReceiptSchema }).strict(),
]).superRefine((value, context) => {
  if (value.status === "committed" && (value.receipt.sourceScope !== value.request.scope
    || value.receipt.targetScope !== value.request.targetScope || value.receipt.requestId !== value.request.requestId
    || value.receipt.manifestHash !== value.request.manifestHash))
    context.addIssue({ code: "custom", message: "Copy receipt does not belong to the original request" });
});
export type StudioTransferLookup = z.infer<typeof StudioTransferLookupSchema>;
export const StudioTransferPageSchema = z.object({
  items: z.array(StudioTransferLookupSchema).max(50), nextCursor: z.uuidv7().nullable(), unavailableOnPage: z.int().min(0).max(50),
}).strict();
export type StudioTransferPage = z.infer<typeof StudioTransferPageSchema>;
