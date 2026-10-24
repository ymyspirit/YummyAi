import { z } from "zod";

/** Archiving changes working-list visibility, never the underlying business outcome. */
export const ArchiveRecordInputSchema = z.object({
  archived: z.boolean(),
  reason: z.string().trim().min(1).max(500),
}).strict();
