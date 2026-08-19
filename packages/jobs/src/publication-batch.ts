import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

export const MarketplacePublicationBatchJobPayloadSchema = z.object({
  publicationBatchId: EntityIdSchema,
}).strict();

export type MarketplacePublicationBatchJobPayload = z.infer<typeof MarketplacePublicationBatchJobPayloadSchema>;
