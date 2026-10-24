import { EntityIdSchema } from "@yummyai/contracts";
import { z } from "zod";

export const AmazonOrderReportRetentionJobPayloadSchema = z.object({ batchId: EntityIdSchema }).strict();
export type AmazonOrderReportRetentionJobPayload = z.infer<typeof AmazonOrderReportRetentionJobPayloadSchema>;
