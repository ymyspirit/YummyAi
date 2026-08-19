import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

export const PodArtworkJobPayloadSchema = z.object({
  taskId: EntityIdSchema,
}).strict();

export type PodArtworkJobPayload = z.infer<typeof PodArtworkJobPayloadSchema>;
