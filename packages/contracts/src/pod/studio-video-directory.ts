import { z } from "zod";
import { StudioKeySchema } from "@yummyai/contracts/pod/studio-address";

export const STUDIO_VIDEO_DIRECTORY_VERSION = 1;
export const STUDIO_VIDEO_DIRECTORY_MAX_ITEMS = 10_000;
export const STUDIO_VIDEO_DIRECTORY_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const StudioVideoSnapshotSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const StudioVideoDiagnosticSchema = z.enum([
  "invalid_document", "invalid_status", "invalid_origin", "invalid_task", "missing_task",
  "untracked_task", "unexpected_asset", "invalid_references", "invalid_media",
]);
export const StudioVideoDirectoryItemSchema = z.object({
  entryId: z.uuidv7(), key: StudioKeySchema, revision: z.int().positive(), valueSha256: StudioVideoSnapshotSchema,
  title: z.string().max(160).nullable(), createdAt: z.number().finite().nonnegative().nullable(),
  nativeStatus: z.enum(["pending", "success", "failed", "unknown"]),
  origin: z.enum(["original", "frozen", "invalid"]),
  task: z.enum(["none", "tracked", "untracked", "invalid"]),
  generationStatus: z.enum(["queued", "running", "completed", "failed"]).nullable(),
  diagnostics: z.array(StudioVideoDiagnosticSchema).max(9),
}).strict();
export type StudioVideoDirectoryItem = z.infer<typeof StudioVideoDirectoryItemSchema>;
export const StudioVideoDirectorySchema = z.object({
  version: z.literal(STUDIO_VIDEO_DIRECTORY_VERSION), snapshotHash: StudioVideoSnapshotSchema,
  total: z.int().nonnegative().max(STUDIO_VIDEO_DIRECTORY_MAX_ITEMS),
  items: z.array(StudioVideoDirectoryItemSchema).max(STUDIO_VIDEO_DIRECTORY_MAX_ITEMS),
}).strict().superRefine((value, context) => {
  if (value.total !== value.items.length || new Set(value.items.map(item => item.entryId)).size !== value.total ||
    new Set(value.items.map(item => item.key)).size !== value.total)
    context.addIssue({ code: "custom", message: "Incomplete or duplicate native video inventory" });
});
export type StudioVideoDirectory = z.infer<typeof StudioVideoDirectorySchema>;
export const StudioVideoPreflightSchema = z.object({
  version: z.literal(STUDIO_VIDEO_DIRECTORY_VERSION), snapshotHash: StudioVideoSnapshotSchema,
  total: z.int().nonnegative().max(STUDIO_VIDEO_DIRECTORY_MAX_ITEMS),
  canOpen: z.boolean(), mode: z.literal("view_only"), execution: z.literal("paused"),
  blockedEntryIds: z.array(z.uuidv7()).max(STUDIO_VIDEO_DIRECTORY_MAX_ITEMS),
}).strict().superRefine((value, context) => {
  if (value.canOpen !== (value.blockedEntryIds.length === 0) || value.blockedEntryIds.length > value.total ||
    new Set(value.blockedEntryIds).size !== value.blockedEntryIds.length)
    context.addIssue({ code: "custom", message: "Invalid native video admission" });
});
export type StudioVideoPreflight = z.infer<typeof StudioVideoPreflightSchema>;
