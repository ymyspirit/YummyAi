import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

export const PersonalizationTemplateSourceInspectionJobPayloadSchema = z.object({
  inspectionId: EntityIdSchema,
}).strict();

export type PersonalizationTemplateSourceInspectionJobPayload = z.infer<typeof PersonalizationTemplateSourceInspectionJobPayloadSchema>;
