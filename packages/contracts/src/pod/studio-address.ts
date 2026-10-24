import { z } from "zod";

export const StudioScopeSchema = z.union([z.literal("unassigned"), z.uuidv7()]);
export const StudioNamespaceSchema = z.enum(["app_state", "image_generation_logs", "video_generation_logs", "image_files", "media_files"]);
export const StudioKeySchema = z.string().min(1).max(180).regex(/^[a-zA-Z0-9:_-]+$/);
export const STUDIO_IMAGE_DRAFT_KEY = "infinite-canvas:image_draft";
export const STUDIO_VIDEO_DRAFT_KEY = "infinite-canvas:video_draft";
