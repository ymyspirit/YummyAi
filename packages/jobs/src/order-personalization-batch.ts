import { z } from "zod";

export const OrderPersonalizationBatchJobPayloadSchema = z.object({
  batchId: z.uuidv7(),
}).strict();

export type OrderPersonalizationBatchJobPayload = z.infer<typeof OrderPersonalizationBatchJobPayloadSchema>;
