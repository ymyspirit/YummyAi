import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

export const ExportJobPayloadSchema = z.object({
  exportId: EntityIdSchema,
  reviewId: EntityIdSchema,
  listingId: EntityIdSchema,
  listingVersionId: EntityIdSchema,
});

export type ExportJobPayload = z.infer<typeof ExportJobPayloadSchema>;
