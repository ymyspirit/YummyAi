import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

export const OrderIngestionJobPayloadSchema = z.object({
  snapshotId: EntityIdSchema,
  accountId: EntityIdSchema,
}).strict();

export type OrderIngestionJobPayload = z.infer<typeof OrderIngestionJobPayloadSchema>;
