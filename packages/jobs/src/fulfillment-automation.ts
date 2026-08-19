import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

export const FulfillmentAutomationJobPayloadSchema = z.object({ taskId: EntityIdSchema }).strict();
export type FulfillmentAutomationJobPayload = z.infer<typeof FulfillmentAutomationJobPayloadSchema>;
