import { z } from "zod";

export const OrderPersonalizationRenderJobPayloadSchema = z.object({
  renderTaskId: z.uuidv7(),
}).strict();

export type OrderPersonalizationRenderJobPayload = z.infer<typeof OrderPersonalizationRenderJobPayloadSchema>;
