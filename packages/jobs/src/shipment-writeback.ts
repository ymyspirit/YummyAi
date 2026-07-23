import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

export const ShipmentWritebackJobPayloadSchema = z.object({
  writebackRequestId: EntityIdSchema,
}).strict();

export type ShipmentWritebackJobPayload = z.infer<typeof ShipmentWritebackJobPayloadSchema>;
