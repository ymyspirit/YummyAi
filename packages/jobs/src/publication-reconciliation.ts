import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

export const MarketplacePublicationReconciliationJobPayloadSchema = z.object({
  publicationRequestId: EntityIdSchema,
}).strict();

export type MarketplacePublicationReconciliationJobPayload = z.infer<
  typeof MarketplacePublicationReconciliationJobPayloadSchema
>;
