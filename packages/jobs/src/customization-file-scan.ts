import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

export const CustomizationFileScanJobPayloadSchema = z.object({
  intakeId: EntityIdSchema,
}).strict();

export type CustomizationFileScanJobPayload = z.infer<typeof CustomizationFileScanJobPayloadSchema>;
