import { z } from "zod";
import { CatalogPreparedOperationSchema } from "@yummyai/contracts/catalog/operation";
import { PodPreparedOperationSchema } from "@yummyai/contracts/pod/operation";
import { HarnessExecutionContractSchema } from "@yummyai/contracts/harness";
import { AgentMethodSelectionSchema } from "@yummyai/contracts/harness/methods";

export const WORKFLOW_EXECUTOR_VERSION = "workflow-node-2026-10-16-v1";
export const WorkflowExecutionSnapshotSchema = z
  .object({
    executorVersion: z.literal(WORKFLOW_EXECUTOR_VERSION),
    capabilityKey: z.string().min(1),
    requiredPermissions: z.array(z.string().min(1)).min(1),
    dataScope: z.enum(["self", "team", "tenant"]),
    executionContract: HarnessExecutionContractSchema.optional(),
    methodSelection: AgentMethodSelectionSchema.optional(),
    input: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("catalog"), value: CatalogPreparedOperationSchema }).strict(),
      z.object({ kind: z.literal("pod"), value: PodPreparedOperationSchema }).strict(),
    ]),
  })
  .strict();
export type WorkflowExecutionSnapshot = z.infer<typeof WorkflowExecutionSnapshotSchema>;
