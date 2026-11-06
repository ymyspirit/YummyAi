import { z } from "zod";
export const LogisticsJobPayloadSchema=z.object({taskId:z.uuidv7(),mode:z.enum(["quote","purchase","reconcile","retention","track"])}).strict();
export type LogisticsJobPayload=z.infer<typeof LogisticsJobPayloadSchema>;
