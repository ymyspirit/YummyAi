import { z } from "zod";

export const WorkflowNodeJobPayloadSchema = z
  .object({
    runId: z.uuidv7(),
    nodeRunId: z.uuidv7(),
  })
  .strict();

export type WorkflowNodeJobPayload = z.infer<typeof WorkflowNodeJobPayloadSchema>;
