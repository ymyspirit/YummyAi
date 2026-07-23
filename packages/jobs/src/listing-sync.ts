import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

export const MarketplaceListingSyncJobPayloadSchema = z.object({
  syncRequestId: EntityIdSchema,
}).strict();

export type MarketplaceListingSyncJobPayload = z.infer<typeof MarketplaceListingSyncJobPayloadSchema>;
