import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

export const MarketplacePublicationJobPayloadSchema = z.object({
  publicationRequestId: EntityIdSchema,
}).strict();

export type MarketplacePublicationJobPayload = z.infer<typeof MarketplacePublicationJobPayloadSchema>;
