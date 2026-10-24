import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

/** Customer values, source URLs and file bytes must never enter Redis. */
export const AmazonOrderReportProcessingJobPayloadSchema = z.object({ batchId: EntityIdSchema, dispatchId: EntityIdSchema.optional() }).strict();
export type AmazonOrderReportProcessingJobPayload = z.infer<typeof AmazonOrderReportProcessingJobPayloadSchema>;
