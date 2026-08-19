import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

export const WebhookDeliveryJobPayloadSchema = z.object({ deliveryId: EntityIdSchema }).strict();
export type WebhookDeliveryJobPayload = z.infer<typeof WebhookDeliveryJobPayloadSchema>;
