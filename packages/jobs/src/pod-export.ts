import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

export const PodExportJobPayloadSchema = z.object({ exportId: EntityIdSchema }).strict();
export type PodExportJobPayload = z.infer<typeof PodExportJobPayloadSchema>;
